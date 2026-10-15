/**
 * Market-data provider adapters. Server-side only: API keys come from
 * environment variables and never reach the browser.
 *
 * Each adapter turns a provider's response into the same shape and labels how
 * fresh the price is (realtime / delayed / eod). Nothing here invents a price:
 * a failure throws ProviderError and the caller falls back to the last stored
 * quote, clearly labelled as cached.
 */
import { EXCHANGES, sessionCloseIso, type MarketCode } from './exchanges'

export type QuoteDataType = 'realtime' | 'delayed' | 'eod'

export interface ProviderQuote {
  price: number
  prevClose: number | null
  open: number | null
  high: number | null
  low: number | null
  volume: number | null
  change: number | null
  changePct: number | null
  currency: string | null
  /** instant the price refers to, per the provider */
  asOf: string
  dataType: QuoteDataType
}

export interface ProviderBar {
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number
  volume: number | null
}

export interface ProviderSearchResult {
  symbol: string
  exchange: string
  name: string
  currency: string | null
  type: string | null
  country: string | null
}

export interface ProviderFundamentals {
  sector: string | null
  industry: string | null
  peRatio: number | null
  eps: number | null
  dividendYieldPct: number | null
  marketCap: number | null
  description: string | null
}

export type ProviderErrorKind = 'rate_limit' | 'auth' | 'not_found' | 'unsupported' | 'network' | 'bad_response'

export class ProviderError extends Error {
  constructor(
    public kind: ProviderErrorKind,
    message: string,
  ) {
    super(message)
  }
}

export interface MarketProvider {
  id: string
  label: string
  markets: MarketCode[]
  /** default request budget; override with <ID>_PER_MINUTE / <ID>_PER_DAY */
  limits: { perMinute: number; perDay: number }
  /** what the plan behind this key normally delivers, shown to the user */
  freshnessNote: string
  quote(symbol: string, exchange: string): Promise<ProviderQuote>
  history(symbol: string, exchange: string): Promise<ProviderBar[]>
  search?(query: string): Promise<ProviderSearchResult[]>
  fundamentals?(symbol: string, exchange: string): Promise<ProviderFundamentals>
}

type Fetcher = typeof fetch

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace('%', ''))
  return Number.isFinite(n) ? n : null
}

async function getJson(fetcher: Fetcher, url: string, provider: string): Promise<{ status: number; body: unknown }> {
  let res: Response
  try {
    res = await fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } })
  } catch (e) {
    throw new ProviderError('network', `${provider}: เชื่อมต่อไม่ได้ (${(e as Error).message})`)
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    if (res.ok) throw new ProviderError('bad_response', `${provider}: รูปแบบข้อมูลตอบกลับไม่ถูกต้อง`)
  }
  return { status: res.status, body }
}

function httpError(provider: string, status: number, detail?: string): ProviderError {
  const d = detail ? `: ${detail.slice(0, 200)}` : ''
  if (status === 401 || status === 403) return new ProviderError('auth', `${provider}: API key ไม่ถูกต้องหรือแพ็กเกจไม่ครอบคลุมข้อมูลนี้ (HTTP ${status})${d}`)
  if (status === 402 || status === 429) return new ProviderError('rate_limit', `${provider}: เกินโควตาการเรียกใช้ (HTTP ${status})${d}`)
  if (status === 404) return new ProviderError('not_found', `${provider}: ไม่พบสัญลักษณ์นี้ (HTTP 404)${d}`)
  return new ProviderError('bad_response', `${provider}: HTTP ${status}${d}`)
}

// ---------------------------------------------------------------------------
// Alpha Vantage: US only. Free key: 25 requests/day, end-of-day prices, 100 daily bars.
// ---------------------------------------------------------------------------
export function alphaVantage(apiKey: string, fetcher: Fetcher = fetch): MarketProvider {
  const base = 'https://www.alphavantage.co/query'
  const entitlement = process.env.ALPHAVANTAGE_ENTITLEMENT // 'realtime' | 'delayed' (premium plans only)
  const call = async (params: Record<string, string>) => {
    const qs = new URLSearchParams({ ...params, apikey: apiKey, ...(entitlement ? { entitlement } : {}) })
    const { status, body } = await getJson(fetcher, `${base}?${qs}`, 'Alpha Vantage')
    if (status !== 200) throw httpError('Alpha Vantage', status)
    const b = (body ?? {}) as Record<string, unknown>
    // Alpha Vantage reports problems with HTTP 200 and one of these keys.
    if (typeof b['Error Message'] === 'string') throw new ProviderError('not_found', `Alpha Vantage: ${b['Error Message']}`)
    const note = (b['Note'] ?? b['Information']) as string | undefined
    if (typeof note === 'string') {
      const kind: ProviderErrorKind = /premium|demo|api key/i.test(note) && !/rate limit|requests per/i.test(note) ? 'auth' : 'rate_limit'
      throw new ProviderError(kind, `Alpha Vantage: ${note.slice(0, 220)}`)
    }
    return b
  }
  return {
    id: 'alphavantage',
    label: 'Alpha Vantage',
    markets: ['US'],
    limits: { perMinute: 5, perDay: 25 },
    freshnessNote: entitlement ? `ตามสิทธิ์ ${entitlement} ของแพ็กเกจ` : 'คีย์ฟรี: ราคาปิดสิ้นวัน (End-of-day) อัปเดตหลังตลาดปิด',
    async quote(symbol, exchange) {
      const b = await call({ function: 'GLOBAL_QUOTE', symbol })
      const q = (b['Global Quote'] ?? {}) as Record<string, string>
      const price = num(q['05. price'])
      const day = q['07. latest trading day']
      if (price === null || !day) throw new ProviderError('not_found', `Alpha Vantage: ไม่มีข้อมูลราคาของ ${symbol}`)
      return {
        price,
        prevClose: num(q['08. previous close']),
        open: num(q['02. open']),
        high: num(q['03. high']),
        low: num(q['04. low']),
        volume: num(q['06. volume']),
        change: num(q['09. change']),
        changePct: num(q['10. change percent']),
        currency: EXCHANGES[exchange]?.currency ?? null,
        asOf: entitlement === 'realtime' ? new Date().toISOString() : sessionCloseIso(exchange, day),
        dataType: entitlement === 'realtime' ? 'realtime' : entitlement === 'delayed' ? 'delayed' : 'eod',
      }
    },
    async history(symbol) {
      // compact (latest 100 bars) is the default; 'full' needs a premium key
      const b = await call({ function: 'TIME_SERIES_DAILY', symbol, ...(process.env.ALPHAVANTAGE_PREMIUM === 'true' ? { outputsize: 'full' } : {}) })
      const series = (b['Time Series (Daily)'] ?? {}) as Record<string, Record<string, string>>
      return Object.entries(series)
        .map(([date, v]) => ({ date, open: num(v['1. open']), high: num(v['2. high']), low: num(v['3. low']), close: num(v['4. close']) ?? NaN, volume: num(v['5. volume']) }))
        .filter((x) => Number.isFinite(x.close))
        .sort((a, b2) => a.date.localeCompare(b2.date))
    },
    async search(query) {
      const b = await call({ function: 'SYMBOL_SEARCH', keywords: query })
      const list = (b['bestMatches'] ?? []) as Record<string, string>[]
      return list.map((m) => ({ symbol: m['1. symbol'], exchange: '', name: m['2. name'], currency: m['8. currency'] ?? null, type: m['3. type'] ?? null, country: m['4. region'] ?? null }))
    },
    async fundamentals(symbol) {
      const b = (await call({ function: 'OVERVIEW', symbol })) as Record<string, string>
      if (!b['Symbol']) throw new ProviderError('not_found', `Alpha Vantage: ไม่มีข้อมูลพื้นฐานของ ${symbol}`)
      const dy = num(b['DividendYield'])
      return { sector: b['Sector'] ?? null, industry: b['Industry'] ?? null, peRatio: num(b['PERatio']), eps: num(b['EPS']), dividendYieldPct: dy === null ? null : dy * 100, marketCap: num(b['MarketCapitalization']), description: b['Description'] ?? null }
    },
  }
}

// ---------------------------------------------------------------------------
// Twelve Data: US on the free plan (8 credits/min, 800/day). SET requires a paid plan.
// ---------------------------------------------------------------------------
export function twelveData(apiKey: string, fetcher: Fetcher = fetch): MarketProvider {
  const base = 'https://api.twelvedata.com'
  const venue = (exchange: string): Record<string, string> => (EXCHANGES[exchange]?.market === 'TH' ? { mic_code: 'XBKK' } : { country: 'United States' })
  const call = async (path: string, params: Record<string, string>) => {
    const { status, body } = await getJson(fetcher, `${base}${path}?${new URLSearchParams({ ...params, apikey: apiKey })}`, 'Twelve Data')
    const b = (body ?? {}) as Record<string, unknown>
    const code = typeof b.code === 'number' ? b.code : status
    if (b.status === 'error' || status !== 200) throw httpError('Twelve Data', code, typeof b.message === 'string' ? b.message : undefined)
    return b
  }
  const realtimeLabel = (process.env.TWELVEDATA_DATA_TYPE as QuoteDataType | undefined) ?? 'realtime'
  return {
    id: 'twelvedata',
    label: 'Twelve Data',
    markets: ['US', 'TH'],
    limits: { perMinute: 8, perDay: 800 },
    freshnessNote: 'แพ็กเกจฟรี: หุ้นสหรัฐฯ ระหว่างตลาดเปิด ส่วนหุ้นไทย (SET) ต้องใช้แพ็กเกจ Pro ขึ้นไป',
    async quote(symbol, exchange) {
      const b = await call('/quote', { symbol, ...venue(exchange) })
      const price = num(b.close)
      if (price === null) throw new ProviderError('not_found', `Twelve Data: ไม่มีข้อมูลราคาของ ${symbol}`)
      const open = b.is_market_open === true
      const ts = num(b.last_quote_at) ?? num(b.timestamp)
      const day = typeof b.datetime === 'string' ? b.datetime.slice(0, 10) : null
      return {
        price,
        prevClose: num(b.previous_close),
        open: num(b.open),
        high: num(b.high),
        low: num(b.low),
        volume: num(b.volume),
        change: num(b.change),
        changePct: num(b.percent_change),
        currency: typeof b.currency === 'string' ? b.currency : null,
        asOf: open && ts ? new Date(ts * 1000).toISOString() : day ? sessionCloseIso(exchange, day) : ts ? new Date(ts * 1000).toISOString() : new Date().toISOString(),
        dataType: open ? realtimeLabel : 'eod',
      }
    },
    async history(symbol, exchange) {
      const b = await call('/time_series', { symbol, interval: '1day', outputsize: '1500', ...venue(exchange) })
      const values = (b.values ?? []) as Record<string, string>[]
      return values
        .map((v) => ({ date: v.datetime.slice(0, 10), open: num(v.open), high: num(v.high), low: num(v.low), close: num(v.close) ?? NaN, volume: num(v.volume) }))
        .filter((x) => Number.isFinite(x.close))
        .sort((a, b2) => a.date.localeCompare(b2.date))
    },
    async search(query) {
      const b = await call('/symbol_search', { symbol: query, outputsize: '20' })
      const list = (b.data ?? []) as Record<string, string>[]
      return list.map((m) => ({ symbol: m.symbol, exchange: m.exchange, name: m.instrument_name, currency: m.currency ?? null, type: m.instrument_type ?? null, country: m.country ?? null }))
    },
  }
}

// ---------------------------------------------------------------------------
// EODHD: US (.US) and SET (.BK). Live quotes are 15-20 minutes delayed.
// ---------------------------------------------------------------------------
export function eodhd(apiKey: string, fetcher: Fetcher = fetch): MarketProvider {
  const base = 'https://eodhd.com/api'
  const code = (symbol: string, exchange: string) => `${symbol}.${EXCHANGES[exchange]?.market === 'TH' ? 'BK' : 'US'}`
  const call = async (path: string, params: Record<string, string> = {}) => {
    const { status, body } = await getJson(fetcher, `${base}${path}?${new URLSearchParams({ ...params, api_token: apiKey, fmt: 'json' })}`, 'EODHD')
    if (status !== 200) throw httpError('EODHD', status)
    return body
  }
  return {
    id: 'eodhd',
    label: 'EODHD',
    markets: ['US', 'TH'],
    limits: { perMinute: 20, perDay: 20 },
    freshnessNote: 'ราคาล่าช้า 15-20 นาที (Delayed) คีย์ฟรีจำกัด 20 ครั้ง/วัน หุ้นไทย (.BK) โดยทั่วไปต้องใช้แพ็กเกจเสียเงิน',
    async quote(symbol, exchange) {
      const b = ((await call(`/real-time/${encodeURIComponent(code(symbol, exchange))}`)) ?? {}) as Record<string, unknown>
      const price = num(b.close)
      const ts = num(b.timestamp)
      if (price === null || !ts) throw new ProviderError('not_found', `EODHD: ไม่มีข้อมูลราคาของ ${symbol}`)
      return {
        price,
        prevClose: num(b.previousClose),
        open: num(b.open),
        high: num(b.high),
        low: num(b.low),
        volume: num(b.volume),
        change: num(b.change),
        changePct: num(b.change_p),
        currency: EXCHANGES[exchange]?.currency ?? null,
        asOf: new Date(ts * 1000).toISOString(),
        dataType: 'delayed',
      }
    },
    async history(symbol, exchange) {
      const from = new Date(Date.now() - 6 * 365 * 86_400_000).toISOString().slice(0, 10)
      const list = ((await call(`/eod/${encodeURIComponent(code(symbol, exchange))}`, { from, period: 'd' })) ?? []) as Record<string, unknown>[]
      if (!Array.isArray(list)) throw new ProviderError('bad_response', 'EODHD: รูปแบบข้อมูลย้อนหลังไม่ถูกต้อง')
      return list
        .map((v) => ({ date: String(v.date), open: num(v.open), high: num(v.high), low: num(v.low), close: num(v.close) ?? NaN, volume: num(v.volume) }))
        .filter((x) => Number.isFinite(x.close))
        .sort((a, b2) => a.date.localeCompare(b2.date))
    },
    async search(query) {
      const list = ((await call(`/search/${encodeURIComponent(query)}`, { limit: '20' })) ?? []) as Record<string, string>[]
      if (!Array.isArray(list)) return []
      return list.map((m) => ({ symbol: m.Code, exchange: m.Exchange === 'BK' ? 'SET' : m.Exchange, name: m.Name, currency: m.Currency ?? null, type: m.Type ?? null, country: m.Country ?? null }))
    },
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const FACTORIES: Record<string, { env: string; make: (key: string) => MarketProvider }> = {
  twelvedata: { env: 'TWELVEDATA_API_KEY', make: twelveData },
  eodhd: { env: 'EODHD_API_KEY', make: eodhd },
  alphavantage: { env: 'ALPHAVANTAGE_API_KEY', make: alphaVantage },
}
const DEFAULT_ORDER: Record<MarketCode, string[]> = { US: ['twelvedata', 'eodhd', 'alphavantage'], TH: ['eodhd', 'twelvedata'] }

function withLimitOverrides(p: MarketProvider): MarketProvider {
  const up = p.id.toUpperCase()
  const perMinute = Number(process.env[`${up}_PER_MINUTE`])
  const perDay = Number(process.env[`${up}_PER_DAY`])
  return { ...p, limits: { perMinute: perMinute > 0 ? perMinute : p.limits.perMinute, perDay: perDay > 0 ? perDay : p.limits.perDay } }
}

/** The provider configured for a market, or null when no usable API key is set. */
export function providerFor(market: MarketCode): MarketProvider | null {
  const forced = process.env[`MARKET_PROVIDER_${market}`]?.toLowerCase()
  const order = forced ? [forced] : DEFAULT_ORDER[market]
  for (const id of order) {
    const f = FACTORIES[id]
    const key = f ? process.env[f.env] : undefined
    if (!f || !key) continue
    const p = f.make(key)
    if (p.markets.includes(market)) return withLimitOverrides(p)
  }
  return null
}

export function providerSummary(): Record<MarketCode, { id: string; label: string; freshnessNote: string; limits: { perMinute: number; perDay: number } } | null> {
  const pick = (m: MarketCode) => {
    const p = providerFor(m)
    return p ? { id: p.id, label: p.label, freshnessNote: p.freshnessNote, limits: p.limits } : null
  }
  return { US: pick('US'), TH: pick('TH') }
}
