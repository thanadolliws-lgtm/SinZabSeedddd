/**
 * Google Sheets storage mode.
 *
 * The app keeps running every query, constraint and RLS policy on a real
 * PostgreSQL engine (PGlite, in memory). Google Sheets is the durable store:
 *
 *   start      : one tab per table is created if missing, then every tab is read
 *                (one API call) and loaded into the in-memory database
 *   each write : inside the same transaction, the rows that changed are found
 *                (triggers mark dirty tables, then a row-level diff) and written
 *                back to the sheet in ONE API call; only then is the transaction
 *                committed. If the sheet write fails, nothing is committed.
 *   many servers: the `_meta` tab holds a version stamp. Before writing, a server
 *                checks the stamp; if another server wrote meanwhile, the change is
 *                rolled back, the data is reloaded from the sheet, and the operation
 *                is retried. Reads re-check the stamp at most every few seconds.
 *
 * Not persisted (per server instance only): auth_attempts and api_usage
 * (rate-limit counters).
 */
import { createSign } from 'node:crypto'
import type { Driver, Queryable, Tx } from './index'

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://sheets.googleapis.com/v4/spreadsheets'
const META = '_meta'
const EPHEMERAL = new Set(['auth_attempts', 'api_usage', 'schema_migrations', '_sheet_dirty'])
const GROW_ROWS = 1000

type Fetcher = typeof fetch

export interface SheetsCredentials {
  email: string
  privateKey: string
}

/** GOOGLE_SERVICE_ACCOUNT_JSON (raw or base64) or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY. */
/**
 * The key file pasted as-is is valid JSON. Some .env loaders turn the "\n"
 * escapes inside private_key into real line breaks, which JSON.parse rejects:
 * escape line breaks that sit inside string literals and parse again.
 */
function parseServiceAccountJson(raw: string): { client_email?: string; private_key?: string } {
  try {
    return JSON.parse(raw)
  } catch (e) {
    let out = ''
    let inString = false
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]
      if (inString && c === '\\') {
        out += c + (raw[++i] ?? '')
        continue
      }
      if (c === '"') inString = !inString
      out += inString && c === '\n' ? '\\n' : inString && c === '\r' ? '' : c
    }
    try {
      return JSON.parse(out)
    } catch {
      throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON ไม่ใช่ JSON ที่ถูกต้อง (${e instanceof Error ? e.message : e})`)
    }
  }
}

export function sheetsCredentialsFromEnv(env: Record<string, string | undefined> = process.env): SheetsCredentials | null {
  const json = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim().replace(/^'([\s\S]*)'$/, '$1').trim()
  if (json) {
    const raw = json.startsWith('{') ? json : Buffer.from(json, 'base64').toString('utf8')
    const o = parseServiceAccountJson(raw)
    if (!o.client_email || !o.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON ไม่มี client_email หรือ private_key')
    return { email: o.client_email, privateKey: o.private_key.replace(/\\n/g, '\n') }
  }
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim()
  const key = env.GOOGLE_PRIVATE_KEY
  if (!email || !key) return null
  // Vercel / .env files usually store the key on one line with literal "\n"
  return { email, privateKey: key.replace(/\\n/g, '\n').replace(/^"|"$/g, '') }
}

export class SheetConflictError extends Error {
  constructor() {
    super('ข้อมูลใน Google Sheet ถูกแก้ไขโดยเซิร์ฟเวอร์อื่นพร้อมกัน')
  }
}

export class SheetsApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Minimal Google Sheets REST client (service-account JWT, no SDK)
// ---------------------------------------------------------------------------
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')

export function colLetter(n: number): string {
  let s = ''
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s
  return s
}

const q = (title: string) => `'${title.replace(/'/g, "''")}'`

export class SheetsClient {
  private token: { value: string; exp: number } | null = null

  constructor(
    public readonly spreadsheetId: string,
    private creds: SheetsCredentials,
    private fetcher: Fetcher = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.exp - 60_000) return this.token.value
    const now = Math.floor(Date.now() / 1000)
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const body = b64url(JSON.stringify({ iss: this.creds.email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }))
    const signer = createSign('RSA-SHA256')
    signer.update(`${head}.${body}`)
    const jwt = `${head}.${body}.${b64url(signer.sign(this.creds.privateKey))}`
    const res = await this.fetcher(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
      cache: 'no-store',
    })
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string }
    if (!res.ok || !data.access_token) throw new SheetsApiError(res.status, `Google ปฏิเสธการยืนยันตัวตนของ Service Account: ${data.error_description ?? res.status}`)
    this.token = { value: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 }
    return this.token.value
  }

  private async call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetcher(url, {
        method,
        headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      })
      if (res.ok) return (await res.json()) as T
      // quota (60 requests/minute per user) or transient errors: back off and retry
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
        continue
      }
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
      const hint =
        res.status === 403
          ? ' (แชร์ Google Sheet ให้อีเมลของ Service Account เป็น Editor แล้วหรือยัง และเปิดใช้ Google Sheets API ในโปรเจกต์แล้วหรือยัง)'
          : res.status === 404
            ? ' (ตรวจสอบ GOOGLE_SHEETS_ID)'
            : ''
      throw new SheetsApiError(res.status, `Google Sheets API ${res.status}: ${err.error?.message ?? res.statusText}${hint}`)
    }
  }

  metadata() {
    return this.call<{ sheets?: { properties: { sheetId: number; title: string; gridProperties?: { rowCount?: number; columnCount?: number } } }[] }>(
      'GET',
      `${API}/${this.spreadsheetId}?fields=sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))`,
    )
  }

  async batchGet(titles: string[]): Promise<Map<string, unknown[][]>> {
    const qs = titles.map((t) => `ranges=${encodeURIComponent(q(t))}`).join('&')
    const r = await this.call<{ valueRanges?: { values?: unknown[][] }[] }>('GET', `${API}/${this.spreadsheetId}/values:batchGet?${qs}&majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`)
    const out = new Map<string, unknown[][]>()
    titles.forEach((t, i) => out.set(t, r.valueRanges?.[i]?.values ?? []))
    return out
  }

  async getValues(range: string): Promise<unknown[][]> {
    const r = await this.call<{ values?: unknown[][] }>('GET', `${API}/${this.spreadsheetId}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`)
    return r.values ?? []
  }

  updateValues(data: { range: string; values: string[][] }[]) {
    return this.call('POST', `${API}/${this.spreadsheetId}/values:batchUpdate`, { valueInputOption: 'RAW', data })
  }

  batchUpdate(requests: unknown[]) {
    return this.call<{ replies?: { addSheet?: { properties: { sheetId: number; title: string } } }[] }>('POST', `${API}/${this.spreadsheetId}:batchUpdate`, { requests })
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
interface Column {
  name: string
  type: string
  nullable: boolean
}

interface TableInfo {
  name: string
  columns: Column[]
  pk: string[]
}

interface TabState {
  sheetId: number
  gridRows: number
  header: string[]
  /** row key at each data position (index 0 = sheet row 2); null = blank row */
  positions: (string | null)[]
  /** last persisted cells per row key, in header order */
  cells: Map<string, string[]>
}

const TEXT_TYPES = new Set(['text', 'varchar', 'bpchar', 'uuid', 'citext'])
const JSON_TYPES = new Set(['json', 'jsonb'])
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`

export interface SheetsDriverOptions {
  spreadsheetId: string
  credentials: SheetsCredentials
  /** creates the in-memory engine with the app's migrations already applied */
  createEngine: () => Promise<Driver>
  fetcher?: Fetcher
  /** how long a read may trust its copy without re-checking the version stamp */
  freshnessMs?: number
}

export async function createSheetsDriver(opts: SheetsDriverOptions): Promise<Driver & { reloadCount: () => number }> {
  const client = new SheetsClient(opts.spreadsheetId, opts.credentials, opts.fetcher)
  const freshnessMs = opts.freshnessMs ?? Number(process.env.SHEETS_FRESHNESS_MS ?? 2000)
  const engine = await opts.createEngine()
  await engine.exec(`set time zone 'UTC'`)

  // ---- discover the schema the migrations created --------------------------
  const tableNames = (
    await engine.query<{ t: string }>(`select table_name as t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`)
  ).rows
    .map((r) => r.t)
    .filter((t) => !EPHEMERAL.has(t))
  const tables: TableInfo[] = []
  for (const name of tableNames) {
    const cols = await engine.query<{ name: string; type: string; nullable: string }>(
      `select column_name as name, udt_name as type, is_nullable as nullable from information_schema.columns
        where table_schema = 'public' and table_name = $1 order by ordinal_position`,
      [name],
    )
    const pk = await engine.query<{ name: string }>(
      `select a.attname as name from pg_index i
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = $1::regclass and i.indisprimary
        order by array_position(i.indkey::int2[], a.attnum)`,
      [name],
    )
    tables.push({ name, columns: cols.rows.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable === 'YES' })), pk: pk.rows.map((r) => r.name) })
  }
  const byName = new Map(tables.map((t) => [t.name, t]))

  // ---- dirty-table tracking (statement triggers, run as owner) --------------
  await engine.exec(`
    create table if not exists _sheet_dirty (table_name text not null);
    create or replace function _sheet_mark_dirty() returns trigger language plpgsql security definer as $$
    begin insert into _sheet_dirty values (TG_TABLE_NAME); return null; end $$;
  `)
  for (const t of tables) {
    await engine.exec(
      `drop trigger if exists _sheet_dirty_trg on ${ident(t.name)};
       create trigger _sheet_dirty_trg after insert or update or delete or truncate on ${ident(t.name)} for each statement execute function _sheet_mark_dirty();`,
    )
  }

  // ---- make sure every table has a tab with a header row -------------------
  const state = new Map<string, TabState>()
  let version: string | null = null
  let lastCheck = 0
  let forceReload = false
  let reloads = 0
  let inflight: Promise<void> | null = null

  async function ensureTabs(): Promise<Map<string, { sheetId: number; rows: number }>> {
    const meta = await client.metadata()
    const have = new Map((meta.sheets ?? []).map((s) => [s.properties.title, { sheetId: s.properties.sheetId, rows: s.properties.gridProperties?.rowCount ?? 1000 }]))
    const missing = [META, ...tables.map((t) => t.name)].filter((t) => !have.has(t))
    if (missing.length > 0) {
      const res = await client.batchUpdate(
        missing.map((title) => ({
          addSheet: { properties: { title, gridProperties: { rowCount: GROW_ROWS, columnCount: Math.max(26, byName.get(title)?.columns.length ?? 4) } } },
        })),
      )
      res.replies?.forEach((r, i) => {
        if (r.addSheet) have.set(missing[i], { sheetId: r.addSheet.properties.sheetId, rows: GROW_ROWS })
      })
    }
    return have
  }

  /** Reads the whole spreadsheet into the in-memory database. */
  async function loadAll(): Promise<void> {
    const tabs = await ensureTabs()
    const data = await client.batchGet([META, ...tables.map((t) => t.name)])
    const headerWrites: { range: string; values: string[][] }[] = []

    const metaRows = data.get(META) ?? []
    const stamp = metaRows[0]?.[1]
    let loadedVersion: string
    if (stamp === undefined || stamp === '') {
      headerWrites.push({ range: `${q(META)}!A1:B3`, values: [['version', '0'], ['updated_at', new Date().toISOString()], ['note', 'ฐานข้อมูลของแอป Sinsap: อย่าแก้ไข เพิ่ม หรือลบแท็บ/คอลัมน์ด้วยมือ']] })
      loadedVersion = '0'
    } else loadedVersion = String(stamp)

    await engine.transaction(async (tx) => {
      await tx.query(`set local session_replication_role = replica`)
      await tx.exec(`truncate ${tables.map((t) => ident(t.name)).join(', ')} cascade`)
      for (const t of tables) {
        const rows = data.get(t.name) ?? []
        const sheetHeader = (rows[0] ?? []).map((h) => String(h ?? '').trim())
        // keep the sheet's own column order; append any column it does not have yet
        const header = sheetHeader.filter(Boolean).length ? [...sheetHeader] : []
        for (const c of t.columns) if (!header.includes(c.name)) header.push(c.name)
        if (header.length !== sheetHeader.length || header.some((h, i) => h !== sheetHeader[i])) {
          headerWrites.push({ range: `${q(t.name)}!A1:${colLetter(header.length)}1`, values: [header] })
        }
        const records: Record<string, unknown>[] = []
        const positions: (string | null)[] = []
        rows.slice(1).forEach((raw, i) => {
          const cells = header.map((_, j) => (raw[j] === undefined || raw[j] === null ? '' : String(raw[j])))
          if (cells.every((c) => c === '')) {
            positions.push(null)
            return
          }
          const rec: Record<string, unknown> = {}
          for (const c of t.columns) {
            const v = cells[header.indexOf(c.name)]
            if (v === '') {
              if (!c.nullable && TEXT_TYPES.has(c.type)) rec[c.name] = ''
              else if (!c.nullable) throw new Error(`Google Sheet แท็บ "${t.name}" แถวที่ ${i + 2}: คอลัมน์ ${c.name} ว่างแต่จำเป็นต้องมีค่า`)
              else rec[c.name] = null
            } else if (JSON_TYPES.has(c.type)) {
              try {
                rec[c.name] = JSON.parse(v)
              } catch {
                throw new Error(`Google Sheet แท็บ "${t.name}" แถวที่ ${i + 2}: คอลัมน์ ${c.name} ไม่ใช่ JSON ที่ถูกต้อง`)
              }
            } else rec[c.name] = v
          }
          records.push(rec)
          positions.push(t.pk.map((k) => String(rec[k] ?? '')).join('\u0001'))
        })
        if (records.length > 0) {
          await tx.query(`insert into ${ident(t.name)} select * from json_populate_recordset(null::${ident(t.name)}, $1::json)`, [JSON.stringify(records)])
        }
        state.set(t.name, { sheetId: tabs.get(t.name)!.sheetId, gridRows: tabs.get(t.name)!.rows, header, positions, cells: new Map() })
      }
      await tx.exec('delete from _sheet_dirty')
      // the normalised text of what is now in memory is the baseline for diffs
      for (const t of tables) state.get(t.name)!.cells = await exportTable(tx, t, state.get(t.name)!.header)
    })
    if (headerWrites.length) await client.updateValues(headerWrites)
    // only now does the in-memory copy correspond to this version of the sheet
    version = loadedVersion
    lastCheck = Date.now()
    forceReload = false
    reloads++
  }

  async function exportTable(tx: Queryable, t: TableInfo, header: string[]): Promise<Map<string, string[]>> {
    const cols = t.columns.map((c) => `${ident(c.name)}::text as ${ident(c.name)}`).join(', ')
    const r = await tx.query<Record<string, string | null>>(`select ${cols} from ${ident(t.name)}`)
    const types = new Map(t.columns.map((c) => [c.name, c.type]))
    const out = new Map<string, string[]>()
    for (const row of r.rows) {
      const cells = header.map((h) => {
        const v = row[h]
        if (v === null || v === undefined) return ''
        if (types.get(h) === 'bool') return v === 't' ? 'TRUE' : 'FALSE'
        return v
      })
      out.set(t.pk.map((k) => row[k] ?? '').join('\u0001'), cells)
    }
    return out
  }

  async function ensureFresh(): Promise<void> {
    if (!forceReload && Date.now() - lastCheck < freshnessMs) return
    // concurrent requests share one check / one reload
    inflight ??= (async () => {
      const stamp = String((await client.getValues(`${q(META)}!B1`))[0]?.[0] ?? '')
      if (forceReload || stamp !== version) await loadAll()
      lastCheck = Date.now()
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  /** Writes this transaction's changes to the sheet. Throws SheetConflictError if another server wrote first. */
  async function flush(tx: Tx): Promise<void> {
    // back to the owner role: the export must see every user's rows, not just this user's
    await tx.exec('reset role')
    const dirtyRows = (await tx.query<{ t: string }>('select distinct table_name as t from _sheet_dirty')).rows.map((r) => r.t)
    if (dirtyRows.length === 0) return
    await tx.exec('delete from _sheet_dirty')
    // a deleted account cascades into every user table
    const dirty = dirtyRows.includes('users') ? tables.map((t) => t.name) : dirtyRows.filter((t) => byName.has(t))

    const writes: { range: string; values: string[][] }[] = []
    const grow: { sheetId: number; length: number }[] = []
    const next = new Map<string, TabState>()
    for (const name of dirty) {
      const t = byName.get(name)!
      const st = state.get(name)!
      const now = await exportTable(tx, t, st.header)
      const width = st.header.length
      const positions = [...st.positions]
      const changed = new Map<number, string[]>()
      positions.forEach((key, i) => {
        if (key === null) return
        const cells = now.get(key)
        if (!cells) {
          changed.set(i, new Array(width).fill(''))
          positions[i] = null
        } else if (cells.some((c, j) => c !== st.cells.get(key)?.[j])) changed.set(i, cells)
      })
      for (const [key, cells] of now) {
        if (!st.cells.has(key)) {
          positions.push(key)
          changed.set(positions.length - 1, cells)
        }
      }
      // compact when more than half of a large tab is blank rows
      const blanks = positions.filter((p) => p === null).length
      let finalPositions: (string | null)[] = positions
      if (blanks > 200 && blanks * 2 > positions.length) {
        const keys = [...now.keys()]
        finalPositions = keys
        changed.clear()
        for (let i = 0; i < Math.max(positions.length, keys.length); i++) changed.set(i, i < keys.length ? now.get(keys[i])! : new Array(width).fill(''))
      }
      if (changed.size === 0) continue
      // group consecutive rows into one range each
      const idx = [...changed.keys()].sort((a, b) => a - b)
      for (let s = 0; s < idx.length; ) {
        let e = s
        while (e + 1 < idx.length && idx[e + 1] === idx[e] + 1) e++
        writes.push({ range: `${q(name)}!A${idx[s] + 2}:${colLetter(width)}${idx[e] + 2}`, values: idx.slice(s, e + 1).map((i) => changed.get(i)!) })
        s = e + 1
      }
      const needRows = Math.max(finalPositions.length, positions.length) + 1
      const gridRows = needRows > st.gridRows ? needRows + GROW_ROWS : st.gridRows
      if (gridRows > st.gridRows) grow.push({ sheetId: st.sheetId, length: gridRows - st.gridRows })
      next.set(name, { ...st, gridRows, positions: finalPositions, cells: now })
    }
    if (writes.length === 0) return

    // optimistic concurrency: refuse to overwrite a newer sheet
    const stamp = String((await client.getValues(`${q(META)}!B1`))[0]?.[0] ?? '')
    if (stamp !== version) throw new SheetConflictError()
    if (grow.length) await client.batchUpdate(grow.map((g) => ({ appendDimension: { sheetId: g.sheetId, dimension: 'ROWS', length: g.length } })))
    const newVersion = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    await client.updateValues([...writes, { range: `${q(META)}!B1:B2`, values: [[newVersion], [new Date().toISOString()]] }])
    version = newVersion
    lastCheck = Date.now()
    for (const [name, st] of next) state.set(name, st)
  }

  async function transaction<T>(fn: (q: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await ensureFresh()
      try {
        return await engine.transaction(async (tx) => {
          const out = await fn(tx)
          await flush(tx)
          return out
        })
      } catch (e) {
        // our in-memory copy may no longer match the sheet: reload before the next use
        if (e instanceof SheetConflictError || e instanceof SheetsApiError) forceReload = true
        if (e instanceof SheetConflictError && attempt < 2) continue
        if (e instanceof SheetConflictError) throw new Error('มีการบันทึกข้อมูลพร้อมกันหลายรายการ กรุณาลองใหม่อีกครั้ง')
        throw e
      }
    }
  }

  await loadAll()

  return {
    kind: 'sheets',
    query: (sql, params) => transaction((tx) => tx.query(sql, params)),
    transaction,
    exec: (sql) => transaction((tx) => tx.exec(sql)),
    close: () => engine.close(),
    reloadCount: () => reloads,
  }
}
