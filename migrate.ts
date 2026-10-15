/**
 * Prepares the configured database:
 *   - PostgreSQL (DATABASE_URL / POSTGRES_URL): applies pending SQL migrations
 *   - Google Sheets (GOOGLE_SHEETS_ID): creates missing tabs and header rows,
 *     and checks the service account can read and write the spreadsheet
 *   - neither: the local embedded database (.data/pglite)
 *
 *   npm run db:migrate      (alias: npm run sheets:setup)
 *
 * Prefers a direct (non-pooled) Postgres connection when the host provides one
 * (Neon: DATABASE_URL_UNPOOLED, Supabase via Vercel: POSTGRES_URL_NON_POOLING).
 */
const direct = process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING
if (direct) process.env.DATABASE_URL = direct

async function main() {
  const { closeDb, databaseMode, getDriver, runMigrations } = await import('../src/lib/db')
  const mode = databaseMode()
  const label = { postgres: 'PostgreSQL', sheets: `Google Sheets (${process.env.GOOGLE_SHEETS_ID})`, pglite: 'embedded PGlite (.data/pglite)' }[mode]
  console.log(`[setup] target: ${label}`)
  try {
    const driver = await getDriver()
    if (mode === 'sheets') {
      // opening the driver already created the tabs/headers and loaded every row
      const r = await driver.query<{ n: number }>('select count(*)::int as n from users')
      console.log(`[setup] Google Sheet is ready (read + write OK). Accounts stored: ${r.rows[0].n}`)
    } else {
      // getDriver() already migrates the embedded database on open; running again is a no-op.
      const ran = await runMigrations(driver)
      console.log(ran.length ? `[setup] applied: ${ran.join(', ')}` : '[setup] database is up to date')
    }
  } finally {
    await closeDb().catch(() => {})
  }
}

main().catch((e) => {
  console.error('[setup] failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
