/**
 * Liabilities.
 *
 * Balance after each event:
 *   payment : balance + interest charged + fee - amount paid
 *   charge  : balance + amount + fee (+ interest if the statement amount was entered)
 *
 * "Interest charged" is the actual figure when the user entered it from a
 * statement; otherwise it is ESTIMATED with simple daily accrual
 *   balance x annual rate / 365 x days since the previous event
 * and flagged as an estimate everywhere it is shown.
 */
import { EPS, addMonths, dateInMonth, daysBetween, monthOf, roundCash } from './money'
import type { DebtEventRow } from './cash'

export interface LiabilityRow {
  id: string
  name: string
  kind: string
  openingBalance: number
  openingDate: string
  annualRate: number
  minPayment: number
  dueDay: number | null
  targetPayment: number | null
  status: 'active' | 'closed'
  note?: string | null
}

export interface DebtLedgerRow {
  eventId: string
  date: string
  kind: 'payment' | 'charge'
  amount: number
  interest: number
  interestEstimated: boolean
  fee: number
  /** negative = balance went down */
  balanceChange: number
  balanceAfter: number
}

export interface LiabilityState {
  liability: LiabilityRow
  /** balance after the last recorded event (interest up to that event included) */
  ledgerBalance: number
  /** estimated interest accrued since the last event up to `asOf` (not yet charged) */
  accruedInterest: number
  /** ledgerBalance + accruedInterest */
  balance: number
  interestPaid: number
  interestEstimatedPortion: number
  feesPaid: number
  totalPaid: number
  ledger: DebtLedgerRow[]
  issues: string[]
}

const dailyInterest = (balance: number, annualRate: number, days: number) => (balance > 0 && days > 0 ? (balance * (annualRate / 100) * days) / 365 : 0)

export function liabilityState(liability: LiabilityRow, events: DebtEventRow[], asOf: string): LiabilityState {
  const rows = events
    .filter((e) => e.liabilityId === liability.id && e.date <= asOf)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
  const ledger: DebtLedgerRow[] = []
  const issues: string[] = []
  const started = liability.openingDate <= asOf
  let balance = started ? liability.openingBalance : 0
  let last = liability.openingDate
  let accrued = 0
  let interestPaid = 0
  let estimatedPortion = 0
  let feesPaid = 0
  let totalPaid = 0

  for (const e of rows) {
    const days = Math.max(0, daysBetween(last, e.date))
    accrued += dailyInterest(balance, liability.annualRate, days)
    if (e.date > last) last = e.date
    const before = balance
    let interest = 0
    let estimated = false
    if (e.interestAmount !== null) {
      interest = e.interestAmount
      accrued = 0
    } else if (e.kind === 'payment') {
      interest = roundCash(accrued)
      estimated = interest > 0
      accrued = 0
    }
    if (e.kind === 'payment') {
      balance = roundCash(balance + interest + e.feeAmount - e.amount)
      totalPaid = roundCash(totalPaid + e.amount)
      if (balance < -0.005) {
        issues.push(`ชำระเกินยอดหนี้ ${roundCash(-balance)} บาท (${e.date})`)
        balance = 0
      }
    } else {
      balance = roundCash(balance + e.amount + e.feeAmount + interest)
    }
    interestPaid = roundCash(interestPaid + interest)
    if (estimated) estimatedPortion = roundCash(estimatedPortion + interest)
    feesPaid = roundCash(feesPaid + e.feeAmount)
    ledger.push({
      eventId: e.id,
      date: e.date,
      kind: e.kind,
      amount: e.amount,
      interest,
      interestEstimated: estimated,
      fee: e.feeAmount,
      balanceChange: roundCash(balance - before),
      balanceAfter: balance,
    })
  }

  if (started) accrued += dailyInterest(balance, liability.annualRate, Math.max(0, daysBetween(last, asOf)))
  accrued = roundCash(accrued)
  if (balance < EPS) accrued = 0
  return {
    liability,
    ledgerBalance: balance,
    accruedInterest: accrued,
    balance: roundCash(balance + accrued),
    interestPaid,
    interestEstimatedPortion: estimatedPortion,
    feesPaid,
    totalPaid,
    ledger,
    issues,
  }
}

export interface DueStatus {
  liabilityId: string
  /** minimum required this month (capped at the balance) */
  requiredThisMonth: number
  paidThisMonth: number
  remainingThisMonth: number
  dueDate: string | null
  /** unpaid minimum that is already past its due date (last month's shortfall + this month's if past due) */
  overdueAmount: number
  daysUntilDue: number | null
}

export function dueStatus(state: LiabilityState, events: DebtEventRow[], today: string): DueStatus {
  const l = state.liability
  const month = monthOf(today)
  const prev = addMonths(month, -1)
  const paidIn = (m: string) =>
    roundCash(events.filter((e) => e.liabilityId === l.id && e.kind === 'payment' && monthOf(e.date) === m).reduce((s, e) => s + e.amount, 0))
  const paidThis = paidIn(month)
  const none: DueStatus = { liabilityId: l.id, requiredThisMonth: 0, paidThisMonth: paidThis, remainingThisMonth: 0, dueDate: null, overdueAmount: 0, daysUntilDue: null }
  if (l.status !== 'active' || l.minPayment <= 0 || l.openingDate > today) return none

  const dueDate = l.dueDay ? dateInMonth(month, l.dueDay) : null
  const outstanding = state.balance
  // Did last month have a due date after the debt started? Then its minimum was owed too.
  const prevDue = l.dueDay ? dateInMonth(prev, l.dueDay) : null
  const prevRequired = prevDue && l.openingDate <= prevDue ? l.minPayment : 0
  const prevShort = Math.max(0, prevRequired - paidIn(prev))
  const coverPrev = Math.min(paidThis, prevShort)
  const prevStillShort = roundCash(Math.min(prevShort - coverPrev, outstanding))

  const required = roundCash(Math.min(l.minPayment, outstanding + paidThis))
  const remaining = roundCash(Math.max(0, Math.min(required - (paidThis - coverPrev), outstanding)))
  const pastDue = dueDate !== null && today > dueDate
  return {
    liabilityId: l.id,
    requiredThisMonth: outstanding <= EPS && paidThis === 0 ? 0 : required,
    paidThisMonth: paidThis,
    remainingThisMonth: remaining,
    dueDate,
    overdueAmount: roundCash(prevStillShort + (pastDue ? remaining : 0)),
    daysUntilDue: dueDate ? daysBetween(today, dueDate) : null,
  }
}

// ---------------------------------------------------------------------------
// Projections (assumption: fixed rate, monthly compounding, level payment)
// ---------------------------------------------------------------------------
export interface PayoffProjection {
  months: number | null
  totalInterest: number | null
  /** payment does not even cover the monthly interest */
  neverPaysOff: boolean
}

export function projectPayoff(balance: number, annualRate: number, monthlyPayment: number, maxMonths = 1200): PayoffProjection {
  if (balance <= EPS) return { months: 0, totalInterest: 0, neverPaysOff: false }
  if (monthlyPayment <= 0) return { months: null, totalInterest: null, neverPaysOff: true }
  const r = annualRate / 100 / 12
  if (monthlyPayment <= balance * r + EPS) return { months: null, totalInterest: null, neverPaysOff: true }
  let b = balance
  let interest = 0
  for (let m = 1; m <= maxMonths; m++) {
    const i = b * r
    interest += i
    b = b + i - Math.min(monthlyPayment, b + i)
    if (b <= 0.005) return { months: m, totalInterest: roundCash(interest), neverPaysOff: false }
  }
  return { months: null, totalInterest: null, neverPaysOff: true }
}

export interface StrategyDebt {
  id: string
  name: string
  balance: number
  annualRate: number
  minPayment: number
}

export interface StrategyResult {
  strategy: 'avalanche' | 'snowball'
  feasible: boolean
  reason?: string
  months: number | null
  totalInterest: number | null
  /** order in which the debts are attacked */
  order: string[]
  payoffMonth: Record<string, number>
  /** total remaining balance at the end of each month, starting with month 0 */
  timeline: number[]
}

/**
 * Avalanche: extra money to the highest interest rate first.
 * Snowball : extra money to the smallest balance first.
 * Minimums are always paid on every debt; a cleared debt's payment rolls to the next target.
 */
export function simulateStrategy(debts: StrategyDebt[], monthlyBudget: number, strategy: 'avalanche' | 'snowball', maxMonths = 1200): StrategyResult {
  const live = debts.filter((d) => d.balance > EPS).map((d) => ({ ...d }))
  const order = [...live]
    .sort((a, b) => (strategy === 'avalanche' ? b.annualRate - a.annualRate || a.balance - b.balance : a.balance - b.balance || b.annualRate - a.annualRate))
    .map((d) => d.id)
  const base: StrategyResult = { strategy, feasible: true, months: 0, totalInterest: 0, order, payoffMonth: {}, timeline: [roundCash(live.reduce((s, d) => s + d.balance, 0))] }
  if (live.length === 0) return base
  const minTotal = live.reduce((s, d) => s + Math.min(d.minPayment, d.balance), 0)
  if (monthlyBudget + EPS < minTotal) {
    return { ...base, feasible: false, reason: 'งบชำระต่อเดือนน้อยกว่ายอดขั้นต่ำรวม', months: null, totalInterest: null }
  }
  const byId = new Map(live.map((d) => [d.id, d]))
  let interestTotal = 0
  for (let m = 1; m <= maxMonths; m++) {
    let budget = monthlyBudget
    for (const d of live) {
      if (d.balance <= EPS) continue
      const i = d.balance * (d.annualRate / 100 / 12)
      interestTotal += i
      d.balance += i
    }
    for (const d of live) {
      if (d.balance <= EPS) continue
      const pay = Math.min(d.minPayment, d.balance, budget)
      d.balance -= pay
      budget -= pay
    }
    for (const id of order) {
      if (budget <= EPS) break
      const d = byId.get(id)!
      if (d.balance <= EPS) continue
      const pay = Math.min(d.balance, budget)
      d.balance -= pay
      budget -= pay
    }
    for (const d of live) {
      if (d.balance <= 0.005 && base.payoffMonth[d.id] === undefined) {
        d.balance = 0
        base.payoffMonth[d.id] = m
      }
    }
    const total = live.reduce((s, d) => s + d.balance, 0)
    base.timeline.push(roundCash(total))
    if (total <= 0.005) {
      return { ...base, months: m, totalInterest: roundCash(interestTotal) }
    }
    // Balance not shrinking: the budget never beats the interest.
    if (m > 12 && total >= base.timeline[m - 12] - 0.005) {
      return { ...base, feasible: false, reason: 'งบชำระไม่พอครอบคลุมดอกเบี้ย ยอดหนี้ไม่ลดลง', months: null, totalInterest: null }
    }
  }
  return { ...base, feasible: false, reason: 'ใช้เวลาเกิน 100 ปี', months: null, totalInterest: null }
}
