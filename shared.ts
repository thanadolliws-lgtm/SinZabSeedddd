/** Labels and small helpers shared by the tabs of the Money Management page. */
import type { Snapshot } from '@/lib/calc/snapshot'
import type { AccountRow, GoalRow, RawData } from '@/lib/calc/types'
import type { Tone } from '@/lib/format'
import { EXPENSE_CATEGORIES, INCOME_TYPES, LIABILITY_KINDS } from '@/lib/services/schemas'

export type MoneyTab = 'cash' | 'income' | 'expenses' | 'debts' | 'allocation'
export const MONEY_TABS: MoneyTab[] = ['cash', 'income', 'expenses', 'debts', 'allocation']

/** Serializable props every tab receives from the server page. */
export interface MoneyTabProps {
  s: Snapshot
  raw: RawData
  today: string
  timezone: string
}

/** Form values are strings; null / undefined become an empty input. */
export const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))

export const ACCOUNT_TYPE_LABELS: Record<AccountRow['type'], string> = {
  cash: 'เงินสด (Cash)',
  bank: 'บัญชีธนาคาร (Bank)',
  brokerage: 'บัญชีโบรกเกอร์ (Brokerage)',
  other_asset: 'ทรัพย์สินอื่น (ประเมินมูลค่าเอง)',
}

export const ACCOUNT_PURPOSE_LABELS: Record<AccountRow['purpose'], string> = {
  general: 'ใช้จ่ายทั่วไป',
  emergency: 'เงินสำรองฉุกเฉิน',
  goal: 'เงินออมตามเป้าหมาย',
}

export const TRANSFER_KINDS = ['transfer', 'emergency_allocation', 'goal_allocation', 'investment_funding'] as const
export const TRANSFER_KIND_LABELS: Record<string, string> = {
  transfer: 'โอนระหว่างบัญชี',
  emergency_allocation: 'กันเป็นเงินสำรองฉุกเฉิน',
  goal_allocation: 'กันเป็นเงินออมตามเป้าหมาย',
  investment_funding: 'โอนเข้าบัญชีลงทุน',
}

export const INCOME_TYPE_LABELS: Record<(typeof INCOME_TYPES)[number], string> = {
  salary: 'เงินเดือน',
  extra: 'รายได้พิเศษ',
  side_job: 'รายได้จากงานเสริม',
  bonus: 'โบนัส',
  dividend: 'เงินปันผล',
  other: 'รายรับอื่น ๆ',
}
export const incomeTypeLabel = (t: string) => INCOME_TYPE_LABELS[t as (typeof INCOME_TYPES)[number]] ?? t

export const FREQUENCY_LABELS: Record<string, string> = { once: 'ครั้งเดียว', daily: 'รายวัน', weekly: 'รายสัปดาห์', monthly: 'รายเดือน', yearly: 'รายปี' }

export const LIABILITY_KIND_LABELS: Record<(typeof LIABILITY_KINDS)[number], string> = {
  credit_card: 'บัตรเครดิต',
  personal_loan: 'สินเชื่อส่วนบุคคล',
  mortgage: 'สินเชื่อบ้าน',
  auto_loan: 'สินเชื่อรถยนต์',
  student_loan: 'เงินกู้เพื่อการศึกษา',
  informal: 'หนี้นอกระบบ / ยืมคนรู้จัก',
  other: 'หนี้อื่น ๆ',
}
export const liabilityKindLabel = (k: string) => LIABILITY_KIND_LABELS[k as (typeof LIABILITY_KINDS)[number]] ?? k

export const GOAL_STATUS: Record<GoalRow['status'], { label: string; tone: Tone }> = {
  active: { label: 'กำลังออม', tone: 'accent' },
  achieved: { label: 'สำเร็จแล้ว', tone: 'gain' },
  paused: { label: 'พักไว้', tone: 'neutral' },
}

export const CATEGORY_OPTIONS = EXPENSE_CATEGORIES.map((c) => ({ value: c, label: c }))

/**
 * Accounts that can receive income / pay expenses and debts: cash, bank or
 * brokerage accounts in the base currency (the server refuses anything else).
 * An archived account stays selectable only when the record already uses it.
 */
export function baseCashAccountOptions(accounts: AccountRow[], baseCurrency: string, keepId?: string | null) {
  return accounts
    .filter((a) => a.type !== 'other_asset' && a.currency === baseCurrency && (!a.isArchived || a.id === keepId))
    .map((a) => ({ value: a.id, label: `${a.name}${a.isArchived ? ' (เก็บถาวร)' : ''}` }))
}

/** Months (YYYY-MM) that appear in a list of dates, newest first. */
export function monthsOf(dates: string[]): string[] {
  return [...new Set(dates.map((d) => d.slice(0, 7)))].sort().reverse()
}

/** Parse a user-typed amount; null when blank or not a finite number. */
export function parseAmount(v: string): number | null {
  if (v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
