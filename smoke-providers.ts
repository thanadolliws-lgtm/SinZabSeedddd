/**
 * Live smoke test of the provider adapters against the providers' PUBLIC demo
 * endpoints (no account needed): Alpha Vantage `demo` key (IBM only), EODHD
 * `demo` token (AAPL.US only) and Frankfurter (no key).
 *
 *   npx tsx scripts/smoke-providers.ts
 *
 * Confirms the response parsing works on real responses, not just on fixtures.
 */
import { alphaVantage, eodhd } from '../src/lib/market/providers'
import { fetchFrankfurter } from '../src/lib/market/fx'

async function check(name: string, fn: () => Promise<unknown>) {
  try {
    const out = await fn()
    console.log(`OK   ${name}:`, JSON.stringify(out).slice(0, 300))
  } catch (e) {
    console.log(`FAIL ${name}: ${(e as Error).message}`)
    process.exitCode = 1
  }
}

async function main() {
  const av = alphaVantage('demo')
  await check('Alpha Vantage GLOBAL_QUOTE IBM', () => av.quote('IBM', 'NYSE'))
  await check('Alpha Vantage TIME_SERIES_DAILY IBM (last 2 bars)', async () => (await av.history('IBM', 'NYSE')).slice(-2))
  const eo = eodhd('demo')
  await check('EODHD real-time AAPL.US', () => eo.quote('AAPL', 'NASDAQ'))
  await check('EODHD eod AAPL.US (last 2 bars)', async () => (await eo.history('AAPL', 'NASDAQ')).slice(-2))
  await check('Frankfurter v2 latest USD/THB', () => fetchFrankfurter('USD', 'THB'))
  await check('Frankfurter v2 range USD/THB', async () => (await fetchFrankfurter('USD', 'THB', { from: '2026-10-01', to: '2026-10-10' })).slice(0, 3))
}

void main()
