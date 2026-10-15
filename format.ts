/** Display formatting. Pure and safe for both server and client. */

const DASH = '—'

export function fmtNum(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

/** Share quantities: up to 8 decimals, trailing zeros removed. */
export function fmtQty(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 8 })
}

const SYMBOLS: Record<string, string> = { THB: '฿', USD: '$', EUR: '€', JPY: '¥', GBP: '£' }

export function fmtMoney(n: number | null | undefined, currency = 'THB', dp = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH
  const sym = SYMBOLS[currency]
  const body = fmtNum(Math.abs(n), dp)
  const sign = n < 0 ? '-' : ''
  return sym ? `${sign}${sym}${body}` : `${sign}${body} ${currency}`
}

/** Signed money, e.g. +฿1,200.00 */
export function fmtSigned(n: number | null | undefined, currency = 'THB', dp = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH
  return `${n > 0 ? '+' : ''}${fmtMoney(n, currency, dp)}`
}

export function fmtPct(n: number | null | undefined, dp = 2, signed = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH
  return `${signed && n > 0 ? '+' : ''}${fmtNum(n, dp)}%`
}

/** Compact figures for chart axes: 1.2K, 3.4M */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return DASH
  const a = Math.abs(n)
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`
  return n.toFixed(0)
}

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

/** '2026-10-14' -> '14 ต.ค. 2026' (Gregorian year, to match statements and CSV files) */
export function fmtDate(date: string | null | undefined): string {
  if (!date) return DASH
  const [y, m, d] = date.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return date
  return `${d} ${TH_MONTHS[m - 1]} ${y}`
}

/** '2026-10' -> 'ต.ค. 2026' */
export function fmtMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${TH_MONTHS[m - 1]} ${y}`
}

/** ISO instant -> '14 ต.ค. 2026 09:30' in the given timezone */
export function fmtDateTime(iso: string | null | undefined, timeZone = 'Asia/Bangkok'): string {
  if (!iso) return DASH
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return DASH
  const p = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d)
  const get = (t: string) => p.find((x) => x.type === t)!.value
  return `${Number(get('day'))} ${TH_MONTHS[Number(get('month')) - 1]} ${get('year')} ${get('hour')}:${get('minute')}`
}

/** How long ago, in Thai: 'เมื่อ 5 นาทีที่แล้ว' */
export function fmtAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return DASH
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return 'เมื่อสักครู่'
  if (s < 3600) return `${Math.floor(s / 60)} นาทีที่แล้ว`
  if (s < 86_400) return `${Math.floor(s / 3600)} ชั่วโมงที่แล้ว`
  return `${Math.floor(s / 86_400)} วันที่แล้ว`
}

export type Tone = 'gain' | 'loss' | 'warn' | 'neutral' | 'accent'

/** Green for an increase, red for a decrease, grey for no change or no data. */
export function toneOf(n: number | null | undefined): Tone {
  if (n === null || n === undefined || !Number.isFinite(n) || Math.abs(n) < 0.005) return 'neutral'
  return n > 0 ? 'gain' : 'loss'
}

export const TONE_TEXT: Record<Tone, string> = { gain: 'text-gain', loss: 'text-loss', warn: 'text-warn', neutral: 'text-neutral', accent: 'text-accent' }
export const TONE_BADGE: Record<Tone, string> = {
  gain: 'bg-gain-soft text-gain',
  loss: 'bg-loss-soft text-loss',
  warn: 'bg-warn-soft text-warn',
  neutral: 'bg-neutral-soft text-neutral',
  accent: 'bg-accent-soft text-accent',
}

export const DATA_TYPE_LABELS: Record<string, { label: string; tone: Tone; hint: string }> = {
  realtime: { label: 'Real-time', tone: 'gain', hint: 'ราคาระหว่างตลาดเปิดจากผู้ให้บริการ' },
  delayed: { label: 'Delayed', tone: 'warn', hint: 'ราคาล่าช้า (โดยทั่วไป 15-20 นาที)' },
  eod: { label: 'End-of-day', tone: 'neutral', hint: 'ราคาปิดของวันทำการล่าสุด' },
  manual: { label: 'บันทึกเอง', tone: 'accent', hint: 'ราคาที่ผู้ใช้กรอกเอง ไม่ได้มาจากตลาดโดยตรง' },
  cached: { label: 'Cached', tone: 'warn', hint: 'ข้อมูลเก่าที่เก็บไว้ ยังอัปเดตไม่ได้' },
}
