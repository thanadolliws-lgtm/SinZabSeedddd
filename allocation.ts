/**
 * Monthly allocation ("where does this month's money go").
 *
 * Priority order shown to the user:
 *   essentials -> minimum debt payments -> extra debt / emergency fund
 *   -> upcoming bills -> savings goals -> DCA & other investing -> what is left
 *
 * remaining = basis - sum(allocated). A plan whose allocations exceed the basis
 * cannot be confirmed.
 */
import { pct, round, roundCash } from './money'
import type { Snapshot } from './snapshot'

export const ALLOCATION_KEYS = ['essentials', 'debt_min', 'debt_extra', 'emergency', 'upcoming', 'goals', 'dca', 'other_invest'] as const
export type AllocationKey = (typeof ALLOCATION_KEYS)[number]

export const ALLOCATION_LABELS: Record<AllocationKey, string> = {
  essentials: 'ค่าใช้จ่ายจำเป็น',
  debt_min: 'ชำระหนี้ (ยอดขั้นต่ำ)',
  debt_extra: 'ชำระหนี้เพิ่ม (โปะ)',
  emergency: 'เงินสำรองฉุกเฉิน',
  upcoming: 'รายจ่ายที่จะถึงกำหนด',
  goals: 'เงินออมตามเป้าหมาย',
  dca: 'เงินลงทุน DCA',
  other_invest: 'การลงทุนอื่น',
}

export interface AllocationItem {
  key: AllocationKey
  /** auto = use the figure the system derives from recorded data */
  mode: 'auto' | 'amount' | 'percent'
  value: number
}

/** System-derived figures for the month; null = nothing recorded to derive it from. */
export type AllocationAuto = Record<AllocationKey, number | null>

export interface AllocationRow {
  key: AllocationKey
  label: string
  mode: AllocationItem['mode']
  value: number
  auto: number | null
  amount: number
  pct: number | null
}

export interface AllocationResult {
  basis: number
  rows: AllocationRow[]
  allocated: number
  remaining: number
  remainingPct: number | null
  overBudget: boolean
}

export function defaultAllocationItems(): AllocationItem[] {
  return ALLOCATION_KEYS.map((key) => ({ key, mode: 'auto', value: 0 }))
}

export function computeAllocation(basis: number, items: AllocationItem[], auto: AllocationAuto): AllocationResult {
  const byKey = new Map(items.map((i) => [i.key, i]))
  const rows: AllocationRow[] = ALLOCATION_KEYS.map((key) => {
    const item = byKey.get(key) ?? { key, mode: 'auto' as const, value: 0 }
    const value = Number.isFinite(item.value) && item.value > 0 ? item.value : 0
    const amount = item.mode === 'auto' ? (auto[key] ?? 0) : item.mode === 'percent' ? (basis * value) / 100 : value
    return { key, label: ALLOCATION_LABELS[key], mode: item.mode, value, auto: auto[key], amount: round(Math.max(0, amount), 2), pct: null }
  })
  for (const r of rows) r.pct = pct(r.amount, basis)
  const allocated = roundCash(rows.reduce((s, r) => s + r.amount, 0))
  const remaining = roundCash(basis - allocated)
  return { basis: roundCash(basis), rows, allocated, remaining, remainingPct: pct(remaining, basis), overBudget: remaining < -0.005 }
}

export interface AllocationAdviceInput {
  overdueDebt: number
  highInterestDebts: { name: string; rate: number; balance: number }[]
  highInterestThreshold: number
  emergencyGap: number | null
  investing: number
  basisIncludesExpected: boolean
}

export interface AllocationAdvice {
  level: 'danger' | 'warning' | 'info'
  text: string
}

/** Warnings shown BEFORE the user is invited to put more money into investing. */
export function allocationAdvice(i: AllocationAdviceInput): AllocationAdvice[] {
  const out: AllocationAdvice[] = []
  if (i.overdueDebt > 0.005) out.push({ level: 'danger', text: `มีหนี้เกินกำหนดชำระ ${round(i.overdueDebt, 2).toLocaleString('th-TH')} บาท ควรชำระก่อนจัดสรรเงินไปลงทุน` })
  for (const d of i.highInterestDebts) {
    out.push({
      level: 'warning',
      text: `หนี้ "${d.name}" ดอกเบี้ย ${d.rate}% ต่อปี (ตั้งแต่ ${i.highInterestThreshold}% ถือว่าสูงตามค่าที่ตั้งไว้): การโปะหนี้ก้อนนี้ลดดอกเบี้ยที่ต้องจ่ายแน่นอน ขณะที่ผลตอบแทนจากการลงทุนไม่แน่นอน`,
    })
  }
  if (i.emergencyGap !== null && i.emergencyGap > 0.005) {
    out.push({ level: 'warning', text: `เงินสำรองฉุกเฉินยังขาดจากเป้าหมาย ${round(i.emergencyGap, 2).toLocaleString('th-TH')} บาท พิจารณาเติมเงินสำรองก่อนเพิ่มเงินลงทุน` })
  }
  if (i.investing > 0.005 && out.some((a) => a.level !== 'info')) {
    out.push({ level: 'info', text: 'แผนนี้ยังจัดสรรเงินไปลงทุนขณะที่มีประเด็นด้านหนี้หรือเงินสำรองข้างต้น ระบบไม่ห้าม แต่ควรทบทวนลำดับความสำคัญ' })
  }
  if (i.basisIncludesExpected) out.push({ level: 'info', text: 'ฐานเงินของแผนนี้รวมรายรับที่ "คาดว่าจะได้รับ" ซึ่งยังไม่เข้าบัญชีจริง' })
  return out
}

/** System-derived figures for the allocation table, from the same snapshot every page uses. */
export function allocationAuto(s: Snapshot): AllocationAuto {
  const fx = (ccy: string) => (ccy === s.baseCurrency ? 1 : (s.fx[ccy]?.rate ?? null))
  const debtMin = roundCash(s.liabilities.reduce((a, l) => a + l.due.requiredThisMonth, 0))
  const goals = roundCash(s.goals.filter((g) => g.status === 'active').reduce((a, g) => a + g.monthlyContribution, 0))
  let dca: number | null = 0
  for (const p of s.dcaPlans.filter((x) => x.plan.status === 'active')) {
    const rate = fx(p.plan.budgetCurrency)
    if (rate === null) {
      dca = null
      break
    }
    dca += p.monthlyEquivalent * rate
  }
  return {
    // recorded essential spending of this month, else the monthly essential figure used for the emergency fund
    essentials: s.expenses.essentialThisMonth > 0 ? s.expenses.essentialThisMonth : s.emergency.essentialMonthly,
    debt_min: debtMin > 0 ? debtMin : null,
    debt_extra: null,
    emergency: null,
    upcoming: s.expenses.unpaidNonEssentialDue > 0 ? s.expenses.unpaidNonEssentialDue : null,
    goals: goals > 0 ? goals : null,
    dca: dca !== null && dca > 0 ? roundCash(dca) : null,
    other_invest: null,
  }
}

/** The money a plan is measured against: income actually received this month, optionally plus expected income. */
export function allocationBasis(s: Snapshot, basis: 'received' | 'received_and_expected'): number {
  return roundCash(s.income.receivedThisMonth + (basis === 'received_and_expected' ? s.income.expectedThisMonth : 0))
}

export function allocationAdviceFor(s: Snapshot, investing: number, basisIncludesExpected: boolean, highInterestThreshold: number): AllocationAdvice[] {
  return allocationAdvice({
    overdueDebt: s.debt.overdue,
    highInterestDebts: s.liabilities.filter((l) => l.highInterest).map((l) => ({ name: l.liability.name, rate: l.liability.annualRate, balance: l.balance })),
    highInterestThreshold,
    emergencyGap: s.emergency.gap,
    investing,
    basisIncludesExpected,
  })
}