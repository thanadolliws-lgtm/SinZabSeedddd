/**
 * Google Sheets storage mode, tested against an in-process fake of the Google
 * Sheets REST API that enforces the real behaviours the driver depends on
 * (grid limits, RAW strings, trailing-empty trimming, service-account token).
 */
import { generateKeyPairSync } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { createTestDriver, setDriverForTests, withUser } from '@/lib/db'
import { colLetter, createSheetsDriver, sheetsCredentialsFromEnv } from '@/lib/db/sheets'
import { registerUser, verifyLogin } from '@/lib/auth/service'
import { buildAppData } from '@/lib/data/app-data'
import { addDays, todayInTz } from '@/lib/calc/money'
import * as S from '@/lib/services/schemas'
import * as pf from '@/lib/services/portfolio'
import * as money from '@/lib/services/money'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const credentials = { email: 'sinsap@test-project.iam.gserviceaccount.com', privateKey }
const today = todayInTz('Asia/Bangkok')

interface Tab {
  sheetId: number
  rows: number
  cols: number
  data: string[][]
}

const colIndex = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1

/** Just enough of the Sheets v4 API, with its real constraints. */
class FakeSheets {
  tabs = new Map<string, Tab>()
  reads = 0
  writes = 0
  failWritesWith: number | null = null
  private nextId = 100

  private parse(range: string) {
    const m = /^(?:'((?:[^']|'')+)'|([^!]+))(?:!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?)?$/.exec(range)
    if (!m) throw new Error(`bad range ${range}`)
    const title = (m[1] ?? m[2]).replace(/''/g, "'")
    return { title, col: m[3] ? colIndex(m[3]) : 0, row: m[4] ? Number(m[4]) - 1 : 0 }
  }

  private json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }

  private trimmed(t: Tab): string[][] {
    const rows = t.data.map((r) => {
      const out = [...r]
      while (out.length && (out[out.length - 1] ?? '') === '') out.pop()
      return out
    })
    while (rows.length && rows[rows.length - 1].length === 0) rows.pop()
    return rows
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    if (url.hostname === 'oauth2.googleapis.com') {
      const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
      expect(assertion.split('.')).toHaveLength(3)
      return this.json({ access_token: 'fake-token', expires_in: 3600 })
    }
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fake-token')
    const path = decodeURIComponent(url.pathname)
    if (method === 'GET' && /\/spreadsheets\/[^/]+$/.test(path)) {
      this.reads++
      return this.json({ sheets: [...this.tabs].map(([title, t]) => ({ properties: { sheetId: t.sheetId, title, gridProperties: { rowCount: t.rows, columnCount: t.cols } } })) })
    }
    if (method === 'GET' && path.endsWith('/values:batchGet')) {
      this.reads++
      return this.json({
        valueRanges: url.searchParams.getAll('ranges').map((r) => {
          const tab = this.tabs.get(this.parse(r).title)
          const values = tab ? this.trimmed(tab) : []
          return values.length ? { range: r, values } : { range: r }
        }),
      })
    }
    if (method === 'GET' && path.includes('/values/')) {
      this.reads++
      const { title, col, row } = this.parse(path.split('/values/')[1])
      const v = this.tabs.get(title)?.data[row]?.[col]
      return this.json(v === undefined || v === '' ? {} : { values: [[v]] })
    }
    if (method === 'POST' && path.endsWith('/values:batchUpdate')) {
      this.writes++
      if (this.failWritesWith) return this.json({ error: { message: 'simulated failure' } }, this.failWritesWith)
      const body = JSON.parse(String(init?.body)) as { valueInputOption: string; data: { range: string; values: string[][] }[] }
      expect(body.valueInputOption).toBe('RAW')
      for (const d of body.data) {
        const { title, col, row } = this.parse(d.range)
        const tab = this.tabs.get(title)
        if (!tab) return this.json({ error: { message: `Unable to parse range: ${d.range}` } }, 400)
        if (row + d.values.length > tab.rows) return this.json({ error: { message: `Range (${d.range}) exceeds grid limits. Max rows: ${tab.rows}` } }, 400)
        d.values.forEach((cells, i) =>
          cells.forEach((v, j) => {
            expect(typeof v).toBe('string')
            const r = (tab.data[row + i] ??= [])
            r[col + j] = v
          }),
        )
      }
      return this.json({})
    }
    if (method === 'POST' && path.endsWith(':batchUpdate')) {
      this.writes++
      const body = JSON.parse(String(init?.body)) as { requests: Record<string, { properties?: { title: string; gridProperties: { rowCount: number; columnCount: number } }; sheetId?: number; length?: number }>[] }
      const replies = body.requests.map((req) => {
        if (req.addSheet) {
          const p = req.addSheet.properties!
          const sheetId = this.nextId++
          this.tabs.set(p.title, { sheetId, rows: p.gridProperties.rowCount, cols: p.gridProperties.columnCount, data: [] })
          return { addSheet: { properties: { sheetId, title: p.title } } }
        }
        if (req.appendDimension) {
          const tab = [...this.tabs.values()].find((t) => t.sheetId === req.appendDimension.sheetId)!
          tab.rows += req.appendDimension.length!
          return {}
        }
        throw new Error('unsupported request')
      })
      return this.json({ replies })
    }
    return this.json({ error: { message: `unhandled ${method} ${path}` } }, 500)
  }

  header(title: string) {
    return this.tabs.get(title)?.data[0] ?? []
  }

  /** non-blank data rows of a tab, as objects keyed by header */
  records(title: string) {
    const [header, ...rows] = this.trimmed(this.tabs.get(title)!)
    return rows.filter((r) => r.some((c) => c !== '')).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))
  }
}

const open = (fake: FakeSheets, freshnessMs = 0) => createSheetsDriver({ spreadsheetId: 'sheet-1', credentials, fetcher: fake.fetch as typeof fetch, createEngine: createTestDriver, freshnessMs })

afterAll(() => {
  // each test closes the drivers it opened
  setDriverForTests(undefined)
})

describe('service-account key from environment variables', () => {
  // what Google's downloaded key file looks like: pretty-printed, "\n" escapes inside private_key
  const keyFile = JSON.stringify({ type: 'service_account', project_id: 'sinsap-123', private_key_id: 'abc', private_key: privateKey, client_email: credentials.email }, null, 2)
  const expected = { email: credentials.email, privateKey }

  it('accepts the whole key file pasted as-is (Vercel value box)', () => {
    expect(sheetsCredentialsFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: `\n${keyFile}\n` })).toEqual(expected)
  })
  it('accepts base64 of the key file', () => {
    expect(sheetsCredentialsFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(keyFile).toString('base64') })).toEqual(expected)
  })
  it('accepts the key file wrapped in quotes and with the \\n escapes already turned into line breaks', () => {
    expect(sheetsCredentialsFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: `'${keyFile}'` })).toEqual(expected)
    const expanded = keyFile.replace(/\\n/g, '\n')
    expect(() => JSON.parse(expanded)).toThrow()
    expect(sheetsCredentialsFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: expanded })).toEqual(expected)
  })
  it('accepts e-mail + key as two variables with literal \\n', () => {
    expect(sheetsCredentialsFromEnv({ GOOGLE_SERVICE_ACCOUNT_EMAIL: credentials.email, GOOGLE_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n') })).toEqual(expected)
  })
  it('explains a broken value instead of failing later', () => {
    expect(() => sheetsCredentialsFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email": "x@y"' })).toThrow(/ไม่ใช่ JSON/)
    expect(() => sheetsCredentialsFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email": "x@y"}' })).toThrow(/private_key/)
  })
})

describe('Google Sheets storage', () => {
  const fake = new FakeSheets()

  it('creates one tab per table with a header row, plus _meta; rate-limit counters stay in memory', async () => {
    const d = await open(fake)
    expect(fake.tabs.has('_meta')).toBe(true)
    expect(fake.tabs.get('_meta')!.data[0]).toEqual(['version', '0'])
    for (const t of ['users', 'sessions', 'transactions', 'securities', 'accounts', 'audit_log', 'market_quotes']) expect(fake.tabs.has(t)).toBe(true)
    expect(fake.tabs.has('auth_attempts')).toBe(false)
    expect(fake.tabs.has('api_usage')).toBe(false)
    expect(fake.header('users')).toEqual(['id', 'email', 'password_hash', 'created_at', 'password_changed_at'])
    expect(colLetter(1)).toBe('A')
    expect(colLetter(27)).toBe('AA')
    await d.close()
  })

  it('app writes land in the sheet and a fresh server (another instance) sees exactly the same data', async () => {
    const a = await open(fake)
    setDriverForTests(a)
    const user = await registerUser({ email: 'sheet@example.com', password: 'sheet password 1', displayName: 'Sheet', ip: 's1' })
    const sec = await withUser(user.id, (q) => pf.saveSecurity(q, user.id, S.securitySchema.parse({ symbol: 'PTT', exchange: 'SET', name: 'PTT ปตท.', category: 'Energy', note: "it's \"quoted\", =1+1" })))
    await withUser(user.id, (q) => pf.saveTransaction(q, user.id, S.transactionSchema.parse({ portfolio: 'main', type: 'buy', securityId: sec.id, tradeDate: addDays(today, -3), quantity: 100.5, price: 34.25, fee: 10 })))
    await withUser(user.id, (q) => money.saveAccount(q, user.id, S.accountSchema.parse({ name: 'บัญชีหลัก', type: 'bank', openingBalance: 12345.67, openingDate: addDays(today, -30) })))
    const before = await buildAppData(user.id)

    // the sheet is the source of truth: values are plain strings, exact numeric text
    expect(fake.records('users').map((u) => u.email)).toContain('sheet@example.com')
    const tx = fake.records('transactions')[0]
    expect(tx).toMatchObject({ quantity: '100.50000000', price: '34.250000', amount: '3442.1250', fee: '10.0000', type: 'buy' })
    expect(fake.records('securities')[0].note).toBe("it's \"quoted\", =1+1")
    expect(fake.records('audit_log').length).toBeGreaterThanOrEqual(3)
    expect(fake.records('user_settings')[0].disabled_alerts).toBe('[]')
    expect(fake.records('accounts')[0].is_archived).toBe('FALSE')

    // a second server starts from the sheet alone
    const b = await open(fake)
    setDriverForTests(b)
    const after = await buildAppData(user.id)
    expect(after.snapshot.portfolios.main.positions[0]).toMatchObject({ quantity: 100.5, costBasis: before.snapshot.portfolios.main.positions[0].costBasis })
    expect(after.snapshot.cash.totalCashBase).toBe(12345.67)
    expect(after.raw.securities[0].note).toBe("it's \"quoted\", =1+1")
    expect((await verifyLogin({ email: 'sheet@example.com', password: 'sheet password 1', ip: 's2' })).id).toBe(user.id)
    await a.close()
    await b.close()
  })

  it('row level security is still enforced between users', async () => {
    const d = await open(fake)
    setDriverForTests(d)
    const other = await registerUser({ email: 'other@example.com', password: 'other password 1', displayName: 'Other', ip: 's3' })
    const mine = await buildAppData(other.id)
    expect(mine.raw.securities).toHaveLength(0)
    expect(mine.raw.transactions).toHaveLength(0)
    expect((await withUser(other.id, (q) => q.query('select * from transactions'))).rows).toHaveLength(0)
    await d.close()
  })

  it('two servers writing at the same time: the stale one reloads, retries, and nothing is lost', async () => {
    const a = await open(fake, 60_000)
    const b = await open(fake, 60_000)
    await a.query(`insert into exchange_rates (base, quote, rate_date, rate, source) values ('EUR', 'THB', '2026-10-01', 38.5, 'test')`)
    const reloadsBefore = b.reloadCount()
    // b still believes its copy is current (long freshness window) and writes on top of it
    await b.query(`insert into exchange_rates (base, quote, rate_date, rate, source) values ('JPY', 'THB', '2026-10-01', 0.22, 'test')`)
    expect(b.reloadCount()).toBe(reloadsBefore + 1)
    const c = await open(fake)
    const rows = (await c.query<{ base: string }>(`select base from exchange_rates order by base`)).rows.map((r) => r.base)
    expect(rows).toEqual(['EUR', 'JPY'])
    for (const d of [a, b, c]) await d.close()
  })

  it('grows the tab when it runs out of rows, and blanks deleted rows (skipped on reload)', async () => {
    const d = await open(fake)
    await d.query(`insert into price_history (symbol, exchange, price_date, close, source)
                   select 'BIG', 'SET', date '2020-01-01' + g, 10 + g * 0.01, 'test' from generate_series(0, 1499) g`)
    expect(fake.tabs.get('price_history')!.rows).toBeGreaterThan(1500)
    expect(fake.records('price_history')).toHaveLength(1500)
    await d.query(`delete from price_history where price_date < date '2020-01-11'`)
    expect(fake.records('price_history')).toHaveLength(1490)
    const e = await open(fake)
    expect((await e.query<{ n: number }>(`select count(*)::int as n from price_history`)).rows[0].n).toBe(1490)
    await d.close()
    await e.close()
  })

  it('compacts a tab that has become mostly blank rows', async () => {
    const d = await open(fake)
    await d.query(`delete from price_history`)
    await d.query(`insert into price_history (symbol, exchange, price_date, close, source)
                   select 'CMP', 'SET', date '2021-01-01' + g, 1, 'test' from generate_series(0, 499) g`)
    await d.query(`delete from price_history where price_date >= date '2021-01-01' + 100`)
    const tab = fake.tabs.get('price_history')!
    // 100 live rows packed at the top, nothing but blanks below
    expect(fake.records('price_history')).toHaveLength(100)
    expect(tab.data.slice(1, 101).every((r) => r.some((c) => c !== ''))).toBe(true)
    expect(tab.data.slice(101).every((r) => r.every((c) => c === ''))).toBe(true)
    const e = await open(fake)
    expect((await e.query<{ n: number }>(`select count(*)::int as n from price_history`)).rows[0].n).toBe(100)
    await d.close()
    await e.close()
  })

  it('if the sheet write fails, the change is not kept in memory either', async () => {
    const d = await open(fake)
    fake.failWritesWith = 400
    await expect(d.query(`insert into exchange_rates (base, quote, rate_date, rate, source) values ('GBP', 'THB', '2026-10-01', 44, 'test')`)).rejects.toThrow(/Google Sheets API 400/)
    fake.failWritesWith = null
    expect((await d.query(`select 1 from exchange_rates where base = 'GBP'`)).rows).toHaveLength(0)
    expect(fake.records('exchange_rates').some((r) => r.base === 'GBP')).toBe(false)
    await d.close()
  })

  it('reads do not call the API on every query (freshness window)', async () => {
    const d = await open(fake, 60_000)
    const reads = fake.reads
    for (let i = 0; i < 20; i++) await d.query('select count(*) from users')
    expect(fake.reads).toBe(reads)
    await d.close()
  })
})
