/**
 * Exchange registry. Add a market by adding an entry here (and a provider that
 * supports it); nothing else in the app hard-codes an exchange.
 *
 * Trading hours are the REGULAR sessions only. Exchange holidays and half-days
 * are not modelled, so "open" means "inside regular hours on a weekday".
 */
export type MarketCode = 'US' | 'TH'

export interface ExchangeInfo {
  code: string
  name: string
  market: MarketCode
  currency: string
  timezone: string
  /** [open, close] in local exchange time, 'HH:MM' */
  sessions: [string, string][]
}

export const EXCHANGES: Record<string, ExchangeInfo> = {
  NASDAQ: { code: 'NASDAQ', name: 'NASDAQ', market: 'US', currency: 'USD', timezone: 'America/New_York', sessions: [['09:30', '16:00']] },
  NYSE: { code: 'NYSE', name: 'New York Stock Exchange', market: 'US', currency: 'USD', timezone: 'America/New_York', sessions: [['09:30', '16:00']] },
  NYSEARCA: { code: 'NYSEARCA', name: 'NYSE Arca (ETF)', market: 'US', currency: 'USD', timezone: 'America/New_York', sessions: [['09:30', '16:00']] },
  AMEX: { code: 'AMEX', name: 'NYSE American', market: 'US', currency: 'USD', timezone: 'America/New_York', sessions: [['09:30', '16:00']] },
  BATS: { code: 'BATS', name: 'Cboe BZX', market: 'US', currency: 'USD', timezone: 'America/New_York', sessions: [['09:30', '16:00']] },
  SET: {
    code: 'SET',
    name: 'ตลาดหลักทรัพย์แห่งประเทศไทย (SET)',
    market: 'TH',
    currency: 'THB',
    timezone: 'Asia/Bangkok',
    sessions: [
      ['10:00', '12:30'],
      ['14:30', '16:30'],
    ],
  },
}

export const MARKET_LABELS: Record<MarketCode, string> = { US: 'สหรัฐฯ', TH: 'ไทย' }

export const CATEGORIES = ['Technology', 'AI', 'Healthcare', 'Food', 'Banking', 'Consumer', 'Energy', 'Industrial', 'Real Estate', 'ETF', 'Other'] as const

export function exchangeInfo(code: string): ExchangeInfo | null {
  return EXCHANGES[code] ?? null
}

export function marketOf(exchange: string): MarketCode | null {
  return EXCHANGES[exchange]?.market ?? null
}

interface LocalParts {
  date: string
  minutes: number
  weekday: number
}

function localParts(timeZone: string, now: Date): LocalParts {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')), weekday }
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

export type MarketState = 'open' | 'break' | 'off_hours' | 'closed'

export interface MarketStatus {
  state: MarketState
  label: string
  localTime: string
  timezone: string
}

export const MARKET_STATE_LABELS: Record<MarketState, string> = {
  open: 'ตลาดเปิด',
  break: 'พักระหว่างวัน',
  off_hours: 'นอกเวลาซื้อขาย',
  closed: 'ตลาดปิด',
}

export function marketStatus(exchange: string, now: Date = new Date()): MarketStatus | null {
  const ex = EXCHANGES[exchange]
  if (!ex) return null
  const p = localParts(ex.timezone, now)
  let state: MarketState
  if (p.weekday > 5) state = 'closed'
  else if (ex.sessions.some(([o, c]) => p.minutes >= toMin(o) && p.minutes < toMin(c))) state = 'open'
  else if (p.minutes > toMin(ex.sessions[0][0]) && p.minutes < toMin(ex.sessions[ex.sessions.length - 1][1])) state = 'break'
  else state = 'off_hours'
  const hh = String(Math.floor(p.minutes / 60)).padStart(2, '0')
  const mm = String(p.minutes % 60).padStart(2, '0')
  return { state, label: MARKET_STATE_LABELS[state], localTime: `${p.date} ${hh}:${mm}`, timezone: ex.timezone }
}

/** UTC offset of a timezone at a given instant, in minutes (handles DST). */
function offsetMinutes(timeZone: string, at: Date): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  const get = (t: string) => Number(p.find((x) => x.type === t)!.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return Math.round((asUtc - at.getTime()) / 60_000)
}

/** The instant of a local wall-clock time on an exchange, as an ISO string. */
export function exchangeLocalToIso(exchange: string, date: string, hhmm: string): string {
  const tz = EXCHANGES[exchange]?.timezone ?? 'UTC'
  const guess = new Date(`${date}T${hhmm}:00Z`)
  const off = offsetMinutes(tz, guess)
  return new Date(guess.getTime() - off * 60_000).toISOString()
}

/** Closing time of the regular session on a trading date (used to timestamp end-of-day prices). */
export function sessionCloseIso(exchange: string, date: string): string {
  const ex = EXCHANGES[exchange]
  const close = ex ? ex.sessions[ex.sessions.length - 1][1] : '00:00'
  return exchangeLocalToIso(exchange, date, close)
}

/** Most recent regular-session close at or before `now`. */
export function lastSessionClose(exchange: string, now: Date = new Date()): Date | null {
  const ex = EXCHANGES[exchange]
  if (!ex) return null
  for (let back = 0; back < 8; back++) {
    const probe = new Date(now.getTime() - back * 86_400_000)
    const p = localParts(ex.timezone, probe)
    if (p.weekday > 5) continue
    const close = new Date(sessionCloseIso(exchange, p.date))
    if (close.getTime() <= now.getTime()) return close
  }
  return null
}
