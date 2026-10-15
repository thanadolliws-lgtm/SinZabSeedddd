/**
 * Exchange rates.
 *
 * Source: Frankfurter (https://frankfurter.dev): free, no API key, daily
 * reference rates published by central banks. These are reference mid rates,
 * NOT the rate a bank or broker will actually give you; each transaction
 * therefore stores the rate the user really got, and these rates are only used
 * to value holdings today and to pre-fill forms.
 * Fallback for the latest rate only: open.er-api.com (keyless, daily).
 *
 * Rates are cached in `exchange_rates` (base = foreign currency, quote = app base currency).
 */
import { sys } from '@/lib/db'
import type { FxRateInfo } from '@/lib/calc/types'

const API = (process.env.FX_API_BASE ?? 'https://api.frankfurter.dev').replace(/\/$/, '')
const LATEST_TTL_HOURS = 6

type Fetcher = typeof fetch

async function fetchJson(url: string, fetcher: Fetcher): Promise<unknown> {
  const res = await fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(12_000), headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

interface RateRow {
  date: string
  rate: number
}

/** Frankfurter v2: /v2/rates?base=usd&quotes=thb[&date=|&from=&to=] -> [{date, base, quote, rate}] */
export async function fetchFrankfurter(base: string, quote: string, range: { date?: string; from?: string; to?: string } = {}, fetcher: Fetcher = fetch): Promise<RateRow[]> {
  const qs = new URLSearchParams({ base: base.toLowerCase(), quotes: quote.toLowerCase() })
  if (range.date) qs.set('date', range.date)
  if (range.from) qs.set('from', range.from)
  if (range.to) qs.set('to', range.to)
  const body = await fetchJson(`${API}/v2/rates?${qs}`, fetcher)
  const list = Array.isArray(body) ? body : [body]
  return list
    .map((r) => ({ date: String((r as Record<string, unknown>).date ?? ''), rate: Number((r as Record<string, unknown>).rate) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.rate) && r.rate > 0)
}

async function fetchFallbackLatest(base: string, quote: string, fetcher: Fetcher): Promise<RateRow | null> {
  const body = (await fetchJson(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`, fetcher)) as { result?: string; rates?: Record<string, number>; time_last_update_unix?: number }
  const rate = body.rates?.[quote]
  if (body.result !== 'success' || !rate || !body.time_last_update_unix) return null
  return { date: new Date(body.time_last_update_unix * 1000).toISOString().slice(0, 10), rate }
}

async function store(base: string, quote: string, rows: RateRow[], source: string): Promise<void> {
  if (rows.length === 0) return
  await sys.query(
    `insert into exchange_rates (base, quote, rate_date, rate, source, fetched_at)
     select $1, $2, d, r, $5, now() from unnest($3::date[], $4::numeric[]) as t(d, r)
     on conflict (base, quote, rate_date) do update set rate = excluded.rate, source = excluded.source, fetched_at = now()`,
    [base, quote, rows.map((r) => r.date), rows.map((r) => r.rate), source],
  )
}

/** Latest stored rate per currency. */
export async function getLatestRates(currencies: string[], baseCurrency: string): Promise<Record<string, FxRateInfo & { fetchedAt: string }>> {
  const out: Record<string, FxRateInfo & { fetchedAt: string }> = {}
  const wanted = [...new Set(currencies.filter((c) => c !== baseCurrency))]
  if (wanted.length === 0) return out
  const r = await sys.query<{ base: string; rate: number; date: string; source: string; fetchedAt: string }>(
    `select distinct on (base) base, rate, rate_date as date, source, fetched_at as "fetchedAt"
       from exchange_rates where quote = $1 and base = any($2::text[]) order by base, rate_date desc`,
    [baseCurrency, wanted],
  )
  for (const row of r.rows) out[row.base] = { rate: row.rate, date: row.date, source: row.source, fetchedAt: row.fetchedAt }
  return out
}

export interface FxRefreshReport {
  refreshed: string[]
  errors: { currency: string; message: string }[]
}

/** Refresh the latest rate of each currency if our copy is older than the TTL. */
export async function refreshFx(currencies: string[], baseCurrency: string, opts: { force?: boolean; fetcher?: Fetcher } = {}): Promise<FxRefreshReport> {
  const fetcher = opts.fetcher ?? fetch
  const report: FxRefreshReport = { refreshed: [], errors: [] }
  const latest = await getLatestRates(currencies, baseCurrency)
  // A rate is "current" only if it is for a recent DATE. Rows fetched minutes ago for an old
  // date (e.g. by a historical lookup for a transaction form) must not count as the latest rate.
  const recentDate = addDays(new Date().toISOString().slice(0, 10), -3)
  for (const ccy of [...new Set(currencies.filter((c) => c !== baseCurrency))]) {
    const have = latest[ccy]
    const fresh = have && have.date >= recentDate && Date.now() - Date.parse(have.fetchedAt) < LATEST_TTL_HOURS * 3_600_000
    if (!opts.force && fresh) continue
    try {
      const rows = await fetchFrankfurter(ccy, baseCurrency, {}, fetcher)
      if (rows.length === 0) throw new Error('ไม่มีข้อมูลอัตราแลกเปลี่ยน')
      await store(ccy, baseCurrency, [rows[rows.length - 1]], 'frankfurter')
      report.refreshed.push(ccy)
    } catch (primary) {
      try {
        const row = await fetchFallbackLatest(ccy, baseCurrency, fetcher)
        if (!row) throw new Error('ไม่มีข้อมูล')
        await store(ccy, baseCurrency, [row], 'open.er-api')
        report.refreshed.push(ccy)
      } catch {
        report.errors.push({ currency: ccy, message: `ดึงอัตราแลกเปลี่ยน ${ccy}/${baseCurrency} ไม่สำเร็จ: ${(primary as Error).message}` })
      }
    }
  }
  return report
}

/**
 * Reference rate on (or just before) a date, for pre-filling a transaction form.
 * Looks in the cache first, then asks the API. Returns null when unavailable:
 * the user must then type the rate themselves.
 */
export async function getRateOn(currency: string, baseCurrency: string, date: string, fetcher: Fetcher = fetch): Promise<FxRateInfo | null> {
  if (currency === baseCurrency) return { rate: 1, date, source: 'base' }
  const cached = async () => {
    const r = await sys.query<{ rate: number; date: string; source: string }>(
      `select rate, rate_date as date, source from exchange_rates
        where base = $1 and quote = $2 and rate_date <= $3::date and rate_date >= $3::date - 7 order by rate_date desc limit 1`,
      [currency, baseCurrency, date],
    )
    return r.rows[0] ?? null
  }
  const hit = await cached()
  if (hit && hit.date === date) return hit
  try {
    const from = new Date(Date.parse(`${date}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10)
    await store(currency, baseCurrency, await fetchFrankfurter(currency, baseCurrency, { from, to: date }, fetcher), 'frankfurter')
  } catch {
    return hit
  }
  return cached()
}

/** Make sure we hold daily rates from `from` to today (one range request, at most once a day per currency). */
export async function ensureFxHistory(currency: string, baseCurrency: string, from: string, fetcher: Fetcher = fetch): Promise<void> {
  if (currency === baseCurrency) return
  const r = await sys.query<{ first: string | null; last: string | null; fetched: string | null }>(
    `select min(rate_date) as first, max(rate_date) as last, max(fetched_at) as fetched from exchange_rates where base = $1 and quote = $2`,
    [currency, baseCurrency],
  )
  const have = r.rows[0]
  const today = new Date().toISOString().slice(0, 10)
  const coversStart = have?.first && have.first <= addDays(from, 5)
  const recent = have?.fetched && Date.now() - Date.parse(have.fetched) < 20 * 3_600_000
  if (coversStart && recent) return
  try {
    const start = coversStart && have?.last ? have.last : from
    await store(currency, baseCurrency, await fetchFrankfurter(currency, baseCurrency, { from: start, to: today }, fetcher), 'frankfurter')
  } catch {
    // history is only used for charts; the chart shows a gap instead of a guess
  }
}

/** Month-end rates: { currency: { 'YYYY-MM': rate } } */
export async function monthEndRates(currencies: string[], baseCurrency: string): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {}
  const wanted = [...new Set(currencies.filter((c) => c !== baseCurrency))]
  if (wanted.length === 0) return out
  const r = await sys.query<{ base: string; month: string; rate: number }>(
    `select distinct on (base, to_char(rate_date, 'YYYY-MM')) base, to_char(rate_date, 'YYYY-MM') as month, rate
       from exchange_rates where quote = $1 and base = any($2::text[])
      order by base, to_char(rate_date, 'YYYY-MM'), rate_date desc`,
    [baseCurrency, wanted],
  )
  for (const row of r.rows) (out[row.base] ??= {})[row.month] = row.rate
  return out
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}
