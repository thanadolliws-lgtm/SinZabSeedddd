/**
 * Database access layer.
 *
 * Interchangeable drivers behind one interface:
 *   - DATABASE_URL set     -> node-postgres Pool (Supabase / Neon / any PostgreSQL 15+)
 *   - GOOGLE_SHEETS_ID set -> in-memory PGlite whose data is stored in a Google Sheet (see sheets.ts)
 *   - neither              -> embedded PGlite persisted in ./.data/pglite (local use, zero setup)
 *
 * All run the same SQL migrations, so RLS behaves identically.
 *
 *   withUser(userId, fn) -> runs fn in a transaction as the restricted `app_user`
 *                           role with app.user_id set; RLS limits every statement
 *                           to that user's rows.
 *   sys.query / sysTx    -> owner-level access for auth + shared market data only.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface QueryResult<T> {
  rows: T[]
  rowCount: number
}

export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>
}

/** A transaction handle; `exec` runs a multi-statement script without parameters. */
export interface Tx extends Queryable {
  exec(sql: string): Promise<void>
}

interface Driver extends Queryable {
  kind: 'postgres' | 'pglite' | 'sheets'
  transaction<T>(fn: (q: Tx) => Promise<T>): Promise<T>
  exec(sql: string): Promise<void>
  close(): Promise<void>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** '2026-10-14 09:20:50.205+07' -> ISO-8601 UTC string. */
export function pgTimestampToIso(v: string): string {
  let s = v.replace(' ', 'T')
  if (/[+-]\d{2}$/.test(s)) s += ':00'
  else if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += 'Z'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? v : d.toISOString()
}

// PostgreSQL type OIDs
const OID = { INT8: 20, NUMERIC: 1700, DATE: 1082, TIMESTAMP: 1114, TIMESTAMPTZ: 1184 }

export async function createPgliteDriver(dataDir: string | undefined): Promise<Driver> {
  const { PGlite } = await import('@electric-sql/pglite')
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true })
  const db = new PGlite({
    dataDir,
    parsers: {
      [OID.NUMERIC]: (v: string) => parseFloat(v),
      [OID.INT8]: (v: string) => Number(v),
      [OID.DATE]: (v: string) => v,
      [OID.TIMESTAMP]: (v: string) => pgTimestampToIso(v),
      [OID.TIMESTAMPTZ]: (v: string) => pgTimestampToIso(v),
    },
  })
  await db.waitReady
  const wrap = (q: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }> }): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) {
      const r = await q.query(sql, params as unknown[])
      return { rows: r.rows as T[], rowCount: r.affectedRows ?? r.rows.length }
    },
  })
  return {
    kind: 'pglite',
    ...wrap(db as never),
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          ...wrap(tx as never),
          exec: async (sql) => {
            await tx.exec(sql)
          },
        }),
      ) as Promise<never>,
    exec: async (sql) => {
      await db.exec(sql)
    },
    close: () => db.close(),
  }
}

async function createPostgresDriver(url: string): Promise<Driver> {
  const pg = (await import('pg')).default
  pg.types.setTypeParser(OID.NUMERIC, (v: string) => parseFloat(v))
  pg.types.setTypeParser(OID.INT8, (v: string) => Number(v))
  pg.types.setTypeParser(OID.DATE, (v: string) => v)
  pg.types.setTypeParser(OID.TIMESTAMP, (v: string) => pgTimestampToIso(v))
  pg.types.setTypeParser(OID.TIMESTAMPTZ, (v: string) => pgTimestampToIso(v))
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    ssl: isLocal || process.env.DATABASE_SSL === 'disable' ? undefined : { rejectUnauthorized: process.env.DATABASE_SSL !== 'no-verify' },
  })
  const wrap = (q: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> }): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) {
      const r = await q.query(sql, params)
      return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length }
    },
  })
  return {
    kind: 'postgres',
    ...wrap(pool as never),
    async transaction(fn) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const out = await fn({
          ...wrap(client as never),
          exec: async (sql) => {
            await client.query(sql)
          },
        })
        await client.query('commit')
        return out
      } catch (e) {
        await client.query('rollback').catch(() => {})
        throw e
      } finally {
        client.release()
      }
    },
    exec: async (sql) => {
      await pool.query(sql)
    },
    close: () => pool.end(),
  }
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------
// Read at runtime from the project folder (local / self-hosted). The turbopackIgnore hints stop the
// bundler from tracing the whole project; on Vercel migrations run at build time (npm run vercel-build).
export function migrationsDir(): string {
  return path.join(/*turbopackIgnore: true*/ process.cwd(), 'db', 'migrations')
}

export async function runMigrations(driver: Driver, dir = migrationsDir()): Promise<string[]> {
  await driver.exec(
    `create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now());
     alter table schema_migrations enable row level security;`,
  )
  const applied = new Set((await driver.query<{ version: string }>('select version from schema_migrations')).rows.map((r) => r.version))
  const files = fs.readdirSync(/*turbopackIgnore: true*/ dir).filter((f) => f.endsWith('.sql')).sort()
  const ran: string[] = []
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = fs.readFileSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dir, file), 'utf8')
    // One transaction per migration file: either the whole file applies or none of it.
    try {
      await driver.transaction(async (tx) => {
        await tx.exec(sql)
        await tx.query('insert into schema_migrations (version) values ($1)', [file])
      })
    } catch (e) {
      throw new Error(`Migration ${file} failed: ${(e as Error).message}`)
    }
    ran.push(file)
  }
  return ran
}

// ---------------------------------------------------------------------------
// Singleton (survives Next.js dev hot reloads)
// ---------------------------------------------------------------------------
type GlobalWithDb = typeof globalThis & { __sinsapDb?: Promise<Driver> }
const g = globalThis as GlobalWithDb

/**
 * Connection string: DATABASE_URL, or POSTGRES_URL as set by the Vercel
 * Marketplace Postgres integrations (Neon sets both, Supabase sets POSTGRES_URL).
 */
export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || undefined
}

export function databaseMode(): 'postgres' | 'sheets' | 'pglite' {
  return databaseUrl() ? 'postgres' : process.env.GOOGLE_SHEETS_ID ? 'sheets' : 'pglite'
}

/** In-memory engine with every migration applied (Google Sheets mode, tests). */
async function migratedMemoryEngine(): Promise<Driver> {
  const driver = await createPgliteDriver(undefined)
  await runMigrations(driver)
  return driver
}

async function init(): Promise<Driver> {
  const url = databaseUrl()
  if (url) {
    const driver = await createPostgresDriver(url)
    if (process.env.AUTO_MIGRATE === 'true') await runMigrations(driver)
    return driver
  }
  if (process.env.GOOGLE_SHEETS_ID) {
    const { createSheetsDriver, sheetsCredentialsFromEnv } = await import('./sheets')
    const credentials = sheetsCredentialsFromEnv()
    if (!credentials) throw new Error('GOOGLE_SHEETS_ID is set but the service account is not: set GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY (or GOOGLE_SERVICE_ACCOUNT_JSON).')
    return createSheetsDriver({ spreadsheetId: process.env.GOOGLE_SHEETS_ID.trim(), credentials, createEngine: migratedMemoryEngine })
  }
  if (process.env.VERCEL || process.env.REQUIRE_DATABASE_URL === 'true') {
    throw new Error('A persistent database is required in this environment: set GOOGLE_SHEETS_ID (+ service account) or DATABASE_URL. The embedded local database cannot persist on serverless hosting.')
  }
  const dataDir = process.env.PGLITE_DATA_DIR === 'memory' ? undefined : path.resolve(/*turbopackIgnore: true*/ process.env.PGLITE_DATA_DIR ?? '.data/pglite')
  const driver = await createPgliteDriver(dataDir)
  await runMigrations(driver)
  return driver
}

export function getDriver(): Promise<Driver> {
  if (!g.__sinsapDb) {
    g.__sinsapDb = init().catch((e) => {
      g.__sinsapDb = undefined
      throw e
    })
  }
  return g.__sinsapDb
}

/** Test helper: fresh in-memory database with all migrations applied. */
export async function createTestDriver(): Promise<Driver> {
  const driver = await createPgliteDriver(undefined)
  await runMigrations(driver)
  return driver
}

export function setDriverForTests(driver: Driver | undefined) {
  g.__sinsapDb = driver ? Promise.resolve(driver) : undefined
}

export async function closeDb() {
  if (!g.__sinsapDb) return
  const d = await g.__sinsapDb
  g.__sinsapDb = undefined
  await d.close()
}

/** Owner-level access. Use ONLY for auth tables and shared market data. */
export const sys: Queryable = {
  async query(sql, params) {
    return (await getDriver()).query(sql, params)
  },
}

export async function sysTx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
  return (await getDriver()).transaction(fn)
}

/**
 * Run `fn` as the given user. Every statement inside is subject to RLS:
 * rows of other users are invisible and cannot be written.
 */
export async function withUser<T>(userId: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(userId)) throw new Error('withUser: invalid user id')
  const driver = await getDriver()
  return driver.transaction(async (q) => {
    await q.query(`select set_config('app.user_id', $1, true)`, [userId])
    await q.query('set local role app_user')
    return fn(q)
  })
}

export type { Driver }
