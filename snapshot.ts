/**
 * The single source of truth for every number shown in the app.
 *
 * buildSnapshot() is a pure function: (rows from the database, market data, today) -> Snapshot.
 * Every page renders from this one object, so two pages can never disagree.
 *
 * Definitions
 *   portfolio value      market value of securities actually held (planned DCA is never included)
 *   unrealised P/L       market value - cost of the shares still held
 *   cash                 opening balances + recorded movements (see cash.ts)
 *   liabilities          ledger balance + estimated interest accrued since the last event
 *   net worth            cash + other assets + portfolio value - liabilities
 *   available this month spendable cash (general cash/bank) - unpaid bills due by month end
 *                        - minimum debt payments still owed this month
 * Missing data (no price, no FX rate) is reported as incomplete, never guessed.
 */
import {
  accountBalances,
  buildCashEvents,
  emergencyStatus,
  summarizeCash,
  type AccountRow,
  type CashEvent,
  type CashSummary,
  type EmergencyStatus,
} from './cash'
import { allocateBudget, checkAllocations, monthlyEquivalent, type AllocatedAmount, type AllocationCheck, type DcaPlanRow } from './dca'
import { dueStatus, liabilityState, projectPayoff, type DueStatus, type LiabilityState, type PayoffProjection } from './debt'
import { EPS, addMonths, monthEnd, monthOf, monthRange, pct, roundCash, roundCost } from './money'
import { buildPositions, mergePositions, valuePositions, type PortfolioSummary, type Position, type PriceInfo } from './portfolio'
import type { DcaScheduleRow, FxRateInfo, GoalRow, RawData, SecurityRow, WatchRow } from './types'

export interface MarketInput {
  /** current price per security id (provider quote or manual price, already resolved) */
  prices: Map<string, PriceInfo>
  /** currency -> rate to the base currency */
  fx: Record<string, FxRateInfo>
  /** security id -> 'YYYY-MM' -> last close of that month */
  monthEndPrices?: Map<string, Record<string, number>>
  /** currency -> 'YYYY-MM' -> rate at month end */
  monthEndFx?: Record<string, Record<string, number>>
}

export interface SecurityView extends SecurityRow {
  price: PriceInfo | null
  heldMain: number
  heldDca: number
  watch: WatchRow | null
  inDcaPlan: boolean
}

export interface AccountView extends AccountRow {
  balance: number
  balanceBase: number | null
}

export interface LiabilityView extends LiabilityState {
  due: DueStatus
  payoff: PayoffProjection
  payoffPayment: number
  highInterest: boolean
}

export interface GoalView extends GoalRow {
  saved: number
  remaining: number
  progressPct: number | null
  accountNames: string[]
}

export interface DcaPlanView {
  plan: DcaPlanRow
  allocations: { id: string; securityId: string; targetPct: number }[]
  check: AllocationCheck
  /** budget for one period split by target % */
  amounts: AllocatedAmount[]
  monthlyEquivalent: number
  monthPlanned: number
  monthExecuted: number
  monthSkipped: number
  monthPending: number
  /** actual weight - target weight inside the DCA portfolio, per security; null when a price is missing */
  drift: { securityId: string; targetPct: number; actualPct: number; diff: number }[] | null
}

export interface CategorySpend {
  category: string
  paid: number
  unpaid: number
  budget: number | null
  over: boolean
}

export interface MonthPoint {
  month: string
  income: number
  expense: number
  invested: number
  debtPaid: number
  cash: number
  emergency: number
  debt: number
  portfolioCost: number
  /** null when a month-end price or FX rate is missing for a held security */
  portfolioValue: number | null
  netWorth: number | null
}

export type AlertSeverity = 'danger' | 'warning' | 'info'

export interface Alert {
  /** stable type id, used for the user's on/off switches */
  type: string
  severity: AlertSeverity
  title: string
  detail: string
  href: string
}

export interface Snapshot {
  today: string
  month: string
  baseCurrency: string
  fx: Record<string, FxRateInfo>
  missingFx: string[]
  securities: SecurityView[]
  portfolios: { main: PortfolioSummary; dca: PortfolioSummary; combined: PortfolioSummary }
  portfolioIds: { main: string | null; dca: string | null }
  investedThisMonth: { main: number; dca: number; combined: number }
  accounts: AccountView[]
  cash: CashSummary
  emergency: EmergencyStatus
  income: { receivedThisMonth: number; expectedThisMonth: number }
  expenses: {
    paidThisMonth: number
    /** unpaid bills due on or before the end of this month (includes overdue ones) */
    unpaidDue: number
    overdueUnpaid: number
    /** unpaid non-essential bills due on or before the end of this month */
    unpaidNonEssentialDue: number
    /** essential spending of the month: paid this month + unpaid bills dated this month */
    essentialThisMonth: number
    byCategory: CategorySpend[]
    totalBudget: number | null
  }
  liabilities: LiabilityView[]
  debt: { total: number; accruedInterest: number; dueThisMonth: number; overdue: number; interestPaid: number; paidThisMonth: number }
  goals: GoalView[]
  savings: number
  availableThisMonth: number
  netWorth: { assets: number; liabilities: number; value: number; complete: boolean }
  dcaPlans: DcaPlanView[]
  months: MonthPoint[]
  alerts: Alert[]
  issues: string[]
}

const inMonth = (date: string | null | undefined, month: string) => !!date && monthOf(date) === month

function essentialMonthly(raw: RawData, month: string): { value: number | null; source: EmergencyStatus['essentialSource'] } {
  if (raw.settings.essentialMonthlyExpense !== null && raw.settings.essentialMonthlyExpense > 0) {
    return { value: raw.settings.essentialMonthlyExpense, source: 'setting' }
  }
  const essential = raw.expenses.filter((e) => e.isEssential)
  const totals: number[] = []
  for (let i = 1; i <= 3; i++) {
    const m = addMonths(month, -i)
    const t = essential.filter((e) => monthOf(e.date) === m).reduce((s, e) => s + e.amount, 0)
    if (t > 0) totals.push(t)
  }
  if (totals.length > 0) return { value: roundCash(totals.reduce((a, b) => a + b, 0) / totals.length), source: 'average' }
  const current = essential.filter((e) => monthOf(e.date) === month).reduce((s, e) => s + e.amount, 0)
  return current > 0 ? { value: roundCash(current), source: 'average' } : { value: null, source: 'none' }
}

export function buildSnapshot(raw: RawData, market: MarketInput, today: string): Snapshot {
  const base = raw.settings.baseCurrency
  const month = monthOf(today)
  const fx = (ccy: string): number | null => (ccy === base ? 1 : (market.fx[ccy]?.rate ?? null))
  const issues: string[] = []

  // ---- portfolios ---------------------------------------------------------
  const mainId = raw.portfolios.find((p) => p.kind === 'main')?.id ?? null
  const dcaId = raw.portfolios.find((p) => p.kind === 'dca')?.id ?? null
  const positions = [...buildPositions(raw.transactions).values()]
  const mainPos = positions.filter((p) => p.portfolioId === mainId)
  const dcaPos = positions.filter((p) => p.portfolioId === dcaId)
  const portfolios = {
    main: valuePositions(mainPos, market.prices, fx),
    dca: valuePositions(dcaPos, market.prices, fx),
    combined: valuePositions(mergePositions(positions), market.prices, fx),
  }
  issues.push(...portfolios.combined.issues)

  const buysIn = (portfolioId: string | null) =>
    roundCash(
      raw.transactions
        .filter((t) => t.type === 'buy' && inMonth(t.tradeDate, month) && (portfolioId === null || t.portfolioId === portfolioId))
        .reduce((s, t) => s + (t.amount + t.fee) * t.fxRate, 0),
    )
  const investedThisMonth = { main: mainId ? buysIn(mainId) : 0, dca: dcaId ? buysIn(dcaId) : 0, combined: buysIn(null) }

  // ---- securities ---------------------------------------------------------
  const qtyBy = (list: Position[]) => new Map(list.map((p) => [p.securityId, p.quantity]))
  const mainQty = qtyBy(mainPos)
  const dcaQty = qtyBy(dcaPos)
  const planSecIds = new Set(raw.dcaAllocations.map((a) => a.securityId))
  const watchBySec = new Map<string, WatchRow>()
  for (const w of [...raw.watchlist].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const cur = watchBySec.get(w.securityId)
    const active = (s: WatchRow) => s.status === 'interested' || s.status === 'waiting'
    if (!cur || active(w)) watchBySec.set(w.securityId, w)
  }
  const securities: SecurityView[] = raw.securities.map((s) => ({
    ...s,
    price: market.prices.get(s.id) ?? null,
    heldMain: mainQty.get(s.id) ?? 0,
    heldDca: dcaQty.get(s.id) ?? 0,
    watch: watchBySec.get(s.id) ?? null,
    inDcaPlan: planSecIds.has(s.id),
  }))

  // ---- cash ---------------------------------------------------------------
  const { events: cashEvents, issues: cashIssues } = buildCashEvents({
    accounts: raw.accounts,
    incomes: raw.incomes,
    expenses: raw.expenses,
    debtEvents: raw.debtEvents,
    transfers: raw.transfers,
    investmentTxs: raw.transactions,
    baseCurrency: base,
  })
  issues.push(...cashIssues)
  const activeAccounts = raw.accounts.filter((a) => !a.isArchived)
  const balances = accountBalances(raw.accounts, cashEvents)
  const accounts: AccountView[] = raw.accounts.map((a) => {
    const balance = balances.get(a.id) ?? 0
    const rate = fx(a.currency)
    return { ...a, balance, balanceBase: rate === null ? null : roundCash(balance * rate) }
  })
  const cash = summarizeCash(activeAccounts, balances, fx)
  const ess = essentialMonthly(raw, month)
  const emergency = emergencyStatus(cash.emergencyFundBase, ess.value, ess.source, raw.settings.emergencyMonths)

  // ---- income & expenses --------------------------------------------------
  const sumAmt = <T extends { amount: number }>(rows: T[]) => roundCash(rows.reduce((s, r) => s + r.amount, 0))
  const income = {
    receivedThisMonth: sumAmt(raw.incomes.filter((i) => i.status === 'received' && inMonth(i.date, month))),
    expectedThisMonth: sumAmt(raw.incomes.filter((i) => i.status === 'expected' && inMonth(i.date, month))),
  }
  const eom = monthEnd(month)
  const paidThisMonthRows = raw.expenses.filter((e) => e.status === 'paid' && inMonth(e.paidDate ?? e.date, month))
  const unpaidDueRows = raw.expenses.filter((e) => e.status === 'unpaid' && e.date <= eom)
  const budgetsThisMonth = raw.budgets.filter((b) => b.month === month)
  const categories = new Set<string>([...paidThisMonthRows, ...unpaidDueRows.filter((e) => inMonth(e.date, month))].map((e) => e.category))
  for (const b of budgetsThisMonth) if (b.category !== '*') categories.add(b.category)
  const byCategory: CategorySpend[] = [...categories]
    .map((category) => {
      const paid = sumAmt(paidThisMonthRows.filter((e) => e.category === category))
      const unpaid = sumAmt(unpaidDueRows.filter((e) => e.category === category && inMonth(e.date, month)))
      const budget = budgetsThisMonth.find((b) => b.category === category)?.amount ?? null
      return { category, paid, unpaid, budget, over: budget !== null && paid + unpaid > budget + 0.005 }
    })
    .sort((a, b) => b.paid + b.unpaid - (a.paid + a.unpaid))
  const expenses = {
    paidThisMonth: sumAmt(paidThisMonthRows),
    unpaidDue: sumAmt(unpaidDueRows),
    overdueUnpaid: sumAmt(unpaidDueRows.filter((e) => e.date < today)),
    unpaidNonEssentialDue: sumAmt(unpaidDueRows.filter((e) => !e.isEssential)),
    essentialThisMonth: sumAmt([...paidThisMonthRows, ...unpaidDueRows.filter((e) => inMonth(e.date, month))].filter((e) => e.isEssential)),
    byCategory,
    totalBudget: budgetsThisMonth.find((b) => b.category === '*')?.amount ?? null,
  }

  // ---- liabilities --------------------------------------------------------
  const liabilities: LiabilityView[] = raw.liabilities.map((l) => {
    const state = liabilityState(l, raw.debtEvents, today)
    if (l.status === 'closed') {
      state.balance = 0
      state.accruedInterest = 0
    }
    issues.push(...state.issues.map((i) => `${l.name}: ${i}`))
    const payoffPayment = l.targetPayment && l.targetPayment > 0 ? l.targetPayment : l.minPayment
    return {
      ...state,
      due: dueStatus(state, raw.debtEvents, today),
      payoff: projectPayoff(state.balance, l.annualRate, payoffPayment),
      payoffPayment,
      highInterest: l.status === 'active' && state.balance > EPS && l.annualRate >= raw.settings.highInterestRate,
    }
  })
  const debt = {
    total: roundCash(liabilities.reduce((s, l) => s + l.balance, 0)),
    accruedInterest: roundCash(liabilities.reduce((s, l) => s + l.accruedInterest, 0)),
    dueThisMonth: roundCash(liabilities.reduce((s, l) => s + l.due.remainingThisMonth, 0)),
    overdue: roundCash(liabilities.reduce((s, l) => s + l.due.overdueAmount, 0)),
    interestPaid: roundCash(liabilities.reduce((s, l) => s + l.interestPaid, 0)),
    paidThisMonth: sumAmt(raw.debtEvents.filter((e) => e.kind === 'payment' && inMonth(e.date, month))),
  }

  // ---- goals --------------------------------------------------------------
  const goals: GoalView[] = raw.goals.map((g) => {
    const linked = accounts.filter((a) => a.goalId === g.id && !a.isArchived)
    const saved = roundCash(linked.reduce((s, a) => s + (a.balanceBase ?? 0), 0))
    return { ...g, saved, remaining: roundCash(Math.max(0, g.targetAmount - saved)), progressPct: pct(saved, g.targetAmount), accountNames: linked.map((a) => a.name) }
  })

  // ---- headline figures ---------------------------------------------------
  const availableThisMonth = roundCash(cash.generalCashBase - expenses.unpaidDue - debt.dueThisMonth)
  const assets = roundCash(cash.totalCashBase + cash.otherAssetsBase + portfolios.combined.marketValueBase)
  const netWorth = {
    assets,
    liabilities: debt.total,
    value: roundCash(assets - debt.total),
    complete: portfolios.combined.complete && cash.missingFx.length === 0,
  }
  const missingFx = [...new Set([...cash.missingFx, ...portfolios.combined.missingFx.map((id) => raw.securities.find((s) => s.id === id)?.currency ?? '?')])]

  // ---- DCA plans ----------------------------------------------------------
  const dcaPlans = raw.dcaPlans.map((plan) => buildPlanView(plan, raw, portfolios.dca, month))

  // ---- history ------------------------------------------------------------
  const months = buildTimeline(raw, market, cashEvents, today, { portfolioValue: portfolios.combined, cash, debtTotal: debt.total })

  const snapshot: Snapshot = {
    today,
    month,
    baseCurrency: base,
    fx: market.fx,
    missingFx,
    securities,
    portfolios,
    portfolioIds: { main: mainId, dca: dcaId },
    investedThisMonth,
    accounts,
    cash,
    emergency,
    income,
    expenses,
    liabilities,
    debt,
    goals,
    savings: roundCash(cash.emergencyFundBase + cash.goalReservedBase),
    availableThisMonth,
    netWorth,
    dcaPlans,
    months,
    alerts: [],
    issues,
  }
  snapshot.alerts = buildAlerts(snapshot, raw)
  return snapshot
}

function buildPlanView(plan: DcaPlanRow, raw: RawData, dca: PortfolioSummary, month: string): DcaPlanView {
  const allocations = raw.dcaAllocations.filter((a) => a.planId === plan.id).map((a) => ({ id: a.id, securityId: a.securityId, targetPct: a.targetPct }))
  const check = checkAllocations(allocations)
  const sched = raw.dcaSchedule.filter((s) => s.planId === plan.id && monthOf(s.plannedDate) === month)
  const total = (status: DcaScheduleRow['status']) => roundCash(sched.filter((s) => s.status === status).reduce((a, s) => a + s.plannedAmount, 0))

  let drift: DcaPlanView['drift'] = null
  if (check.ok) {
    const held = allocations.map((a) => dca.positions.find((p) => p.securityId === a.securityId) ?? null)
    const anyHeld = held.some((p) => p !== null)
    const allValued = held.every((p) => p === null || p.marketValueBase !== null)
    if (anyHeld && allValued) {
      const totalMv = held.reduce((s, p) => s + (p?.marketValueBase ?? 0), 0)
      if (totalMv > EPS) {
        drift = allocations.map((a, i) => {
          const actual = ((held[i]?.marketValueBase ?? 0) / totalMv) * 100
          return { securityId: a.securityId, targetPct: a.targetPct, actualPct: actual, diff: actual - a.targetPct }
        })
      }
    }
  }
  return {
    plan,
    allocations,
    check,
    amounts: allocateBudget(plan.budgetAmount, allocations, plan),
    monthlyEquivalent: monthlyEquivalent(plan),
    monthPlanned: roundCash(sched.reduce((a, s) => a + s.plannedAmount, 0)),
    monthExecuted: total('executed'),
    monthSkipped: total('skipped'),
    monthPending: total('planned'),
    drift,
  }
}

function buildTimeline(
  raw: RawData,
  market: MarketInput,
  cashEvents: CashEvent[],
  today: string,
  current: { portfolioValue: PortfolioSummary; cash: CashSummary; debtTotal: number },
): MonthPoint[] {
  const base = raw.settings.baseCurrency
  const month = monthOf(today)
  const dates: string[] = [
    ...raw.transactions.map((t) => t.tradeDate),
    ...raw.incomes.filter((i) => i.status === 'received').map((i) => i.date),
    ...raw.expenses.filter((e) => e.status === 'paid').map((e) => e.paidDate ?? e.date),
    ...raw.debtEvents.map((e) => e.date),
    ...raw.liabilities.map((l) => l.openingDate),
    ...raw.accounts.map((a) => a.openingDate),
    ...raw.transfers.map((t) => t.date),
  ].filter((d) => d <= today)
  if (dates.length === 0) return []
  let first = monthOf(dates.reduce((a, b) => (a < b ? a : b)))
  const earliest = addMonths(month, -59)
  if (first < earliest) first = earliest

  const secCurrency = new Map(raw.securities.map((s) => [s.id, s.currency]))
  const cashAccounts = raw.accounts.filter((a) => !a.isArchived && a.type !== 'other_asset')
  const otherAssets = raw.accounts.filter((a) => !a.isArchived && a.type === 'other_asset')
  const activeLiabilities = raw.liabilities.filter((l) => l.status === 'active')

  return monthRange(first, month).map((m) => {
    const isCurrent = m === month
    const end = isCurrent ? today : monthEnd(m)
    const fxAt = (ccy: string): number | null => (ccy === base ? 1 : (isCurrent ? undefined : market.monthEndFx?.[ccy]?.[m]) ?? market.fx[ccy]?.rate ?? null)
    const bal = accountBalances(raw.accounts, cashEvents, end)
    const toBase = (list: AccountRow[]) => roundCash(list.reduce((s, a) => s + (bal.get(a.id) ?? 0) * (fxAt(a.currency) ?? 0), 0))
    const cash = isCurrent ? current.cash.totalCashBase : toBase(cashAccounts)
    const emergency = isCurrent ? current.cash.emergencyFundBase : toBase(cashAccounts.filter((a) => a.purpose === 'emergency'))
    const other = isCurrent ? current.cash.otherAssetsBase : toBase(otherAssets)
    const debt = isCurrent ? current.debtTotal : roundCash(activeLiabilities.reduce((s, l) => s + liabilityState(l, raw.debtEvents, end).balance, 0))

    let portfolioCost: number
    let portfolioValue: number | null
    if (isCurrent) {
      portfolioCost = current.portfolioValue.costBasisBase
      portfolioValue = current.portfolioValue.complete ? current.portfolioValue.marketValueBase : null
    } else {
      const open = mergePositions([...buildPositions(raw.transactions, end).values()]).filter((p) => p.quantity > EPS)
      portfolioCost = roundCost(open.reduce((s, p) => s + p.costBasisBase, 0))
      portfolioValue = 0
      for (const p of open) {
        const close = market.monthEndPrices?.get(p.securityId)?.[m]
        const rate = fxAt(secCurrency.get(p.securityId) ?? p.currency)
        if (close === undefined || rate === null) {
          portfolioValue = null
          break
        }
        portfolioValue += p.quantity * close * rate
      }
      if (portfolioValue !== null) portfolioValue = roundCost(portfolioValue)
    }

    const inM = (d: string | null | undefined) => !!d && monthOf(d) === m && d <= today
    return {
      month: m,
      income: roundCash(raw.incomes.filter((i) => i.status === 'received' && inM(i.date)).reduce((s, i) => s + i.amount, 0)),
      expense: roundCash(raw.expenses.filter((e) => e.status === 'paid' && inM(e.paidDate ?? e.date)).reduce((s, e) => s + e.amount, 0)),
      invested: roundCash(raw.transactions.filter((t) => t.type === 'buy' && inM(t.tradeDate)).reduce((s, t) => s + (t.amount + t.fee) * t.fxRate, 0)),
      debtPaid: roundCash(raw.debtEvents.filter((e) => e.kind === 'payment' && inM(e.date)).reduce((s, e) => s + e.amount, 0)),
      cash,
      emergency,
      debt,
      portfolioCost,
      portfolioValue,
      netWorth: portfolioValue === null ? null : roundCash(cash + other + portfolioValue - debt),
    }
  })
}

// ---------------------------------------------------------------------------
// Alerts: every alert is derived from recorded data; nothing is shown without a basis.
// ---------------------------------------------------------------------------
export const ALERT_TYPES: Record<string, string> = {
  emergency_low: 'เงินสำรองฉุกเฉินต่ำกว่าเป้าหมาย',
  debt_due_soon: 'หนี้ใกล้ครบกำหนดชำระ',
  debt_overdue: 'หนี้เกินกำหนดชำระ',
  bill_due: 'รายจ่ายใกล้ครบกำหนดหรือเกินกำหนด',
  over_budget: 'ค่าใช้จ่ายสูงกว่างบ',
  dca_over_cash: 'งบ DCA เกินเงินที่ลงทุนได้',
  allocation_drift: 'สัดส่วนการลงทุนผิดจากเป้าหมาย',
  position_concentration: 'หุ้นรายตัวมีสัดส่วนสูงเกินกำหนด',
  category_concentration: 'หมวดธุรกิจมีสัดส่วนสูงเกินกำหนด',
  stale_price: 'ราคาหุ้นเก่าเกินเกณฑ์หรือไม่มีราคา',
  missing_fx: 'ไม่มีอัตราแลกเปลี่ยน',
  data_issue: 'ข้อมูลไม่สอดคล้องกัน',
  market_api: 'ดึงข้อมูลตลาดไม่สำเร็จ',
}

const fmt = (n: number) => n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function buildAlerts(s: Snapshot, raw: RawData): Alert[] {
  const out: Alert[] = []
  const set = raw.settings
  const secName = (id: string) => s.securities.find((x) => x.id === id)?.symbol ?? '?'

  for (const l of s.liabilities) {
    if (l.due.overdueAmount > 0.005) {
      out.push({ type: 'debt_overdue', severity: 'danger', title: `หนี้ "${l.liability.name}" เกินกำหนดชำระ`, detail: `ยอดขั้นต่ำค้างชำระ ${fmt(l.due.overdueAmount)} บาท`, href: '/money?tab=debts' })
    } else if (l.due.remainingThisMonth > 0.005 && l.due.daysUntilDue !== null && l.due.daysUntilDue >= 0 && l.due.daysUntilDue <= set.dueSoonDays) {
      out.push({
        type: 'debt_due_soon',
        severity: 'warning',
        title: `หนี้ "${l.liability.name}" ครบกำหนดใน ${l.due.daysUntilDue} วัน`,
        detail: `ต้องชำระอย่างน้อย ${fmt(l.due.remainingThisMonth)} บาท ภายใน ${l.due.dueDate}`,
        href: '/money?tab=debts',
      })
    }
  }

  const soon = raw.expenses.filter((e) => e.status === 'unpaid')
  const overdueBills = soon.filter((e) => e.date < s.today)
  const dueBills = soon.filter((e) => e.date >= s.today && e.date <= addDaysSafe(s.today, set.dueSoonDays))
  if (overdueBills.length > 0) {
    out.push({ type: 'bill_due', severity: 'danger', title: `มีรายจ่ายเกินกำหนด ${overdueBills.length} รายการ`, detail: `รวม ${fmt(overdueBills.reduce((a, e) => a + e.amount, 0))} บาท`, href: '/money?tab=expenses' })
  }
  if (dueBills.length > 0) {
    out.push({ type: 'bill_due', severity: 'warning', title: `มีรายจ่ายครบกำหนดภายใน ${set.dueSoonDays} วัน ${dueBills.length} รายการ`, detail: `รวม ${fmt(dueBills.reduce((a, e) => a + e.amount, 0))} บาท`, href: '/money?tab=expenses' })
  }

  if (s.emergency.gap !== null && s.emergency.gap > 0.005) {
    out.push({
      type: 'emergency_low',
      severity: 'warning',
      title: 'เงินสำรองฉุกเฉินยังต่ำกว่าเป้าหมาย',
      detail: `มี ${fmt(s.emergency.current)} บาท จากเป้าหมาย ${fmt(s.emergency.target!)} บาท (ครอบคลุม ${s.emergency.coverageMonths!.toFixed(1)} จาก ${s.emergency.targetMonths} เดือน)`,
      href: '/money?tab=cash',
    })
  }

  for (const c of s.expenses.byCategory.filter((c) => c.over)) {
    out.push({ type: 'over_budget', severity: 'warning', title: `หมวด "${c.category}" เกินงบเดือนนี้`, detail: `ใช้ไป ${fmt(c.paid + c.unpaid)} บาท จากงบ ${fmt(c.budget!)} บาท`, href: '/money?tab=expenses' })
  }
  const spentAll = s.expenses.byCategory.reduce((a, c) => a + c.paid + c.unpaid, 0)
  if (s.expenses.totalBudget !== null && spentAll > s.expenses.totalBudget + 0.005) {
    out.push({ type: 'over_budget', severity: 'warning', title: 'ค่าใช้จ่ายรวมเดือนนี้สูงกว่างบ', detail: `ใช้ไป ${fmt(spentAll)} บาท จากงบรวม ${fmt(s.expenses.totalBudget)} บาท`, href: '/money?tab=expenses' })
  }

  const activePlans = s.dcaPlans.filter((p) => p.plan.status === 'active' && p.check.ok)
  if (activePlans.length > 0) {
    const fxOf = (ccy: string) => (ccy === s.baseCurrency ? 1 : (s.fx[ccy]?.rate ?? null))
    let pending = 0
    let known = true
    for (const p of activePlans) {
      const rate = fxOf(p.plan.budgetCurrency)
      if (rate === null) {
        known = false
        break
      }
      // Without a generated schedule, what is left of this month's budget; with one, what is still planned.
      const left = p.monthPlanned > 0 ? p.monthPending : Math.max(0, p.monthlyEquivalent - p.monthExecuted)
      pending += left * rate
    }
    const investable = s.availableThisMonth + s.cash.brokerageCashBase
    if (known && pending > 0.005 && pending > investable + 0.005) {
      out.push({
        type: 'dca_over_cash',
        severity: 'warning',
        title: 'งบ DCA ที่เหลือของเดือนนี้เกินเงินที่ลงทุนได้',
        detail: `แผน DCA ยังต้องใช้ ${fmt(pending)} บาท แต่เงินที่ลงทุนได้ (เงินพร้อมใช้ + เงินสดในบัญชีโบรกเกอร์) มี ${fmt(investable)} บาท`,
        href: '/dca',
      })
    }
  }

  for (const p of activePlans) {
    for (const d of p.drift ?? []) {
      if (Math.abs(d.diff) > set.allocationDriftPct) {
        out.push({
          type: 'allocation_drift',
          severity: 'info',
          title: `${secName(d.securityId)} ในแผน "${p.plan.name}" ${d.diff > 0 ? 'สูง' : 'ต่ำ'}กว่าเป้าหมาย`,
          detail: `สัดส่วนจริง ${d.actualPct.toFixed(1)}% เทียบเป้าหมาย ${d.targetPct.toFixed(1)}% (ต่างเกิน ${set.allocationDriftPct}%)`,
          href: '/analysis',
        })
      }
    }
  }

  const combined = s.portfolios.combined
  if (combined.positions.length > 1) {
    for (const p of combined.positions) {
      if (p.weight !== null && p.weight > set.maxPositionPct) {
        out.push({ type: 'position_concentration', severity: 'warning', title: `${secName(p.securityId)} มีสัดส่วน ${p.weight.toFixed(1)}% ของพอร์ต`, detail: `เกินเกณฑ์ที่ตั้งไว้ ${set.maxPositionPct}%`, href: '/analysis' })
      }
    }
    const byCat = new Map<string, number>()
    for (const p of combined.positions) {
      if (p.weight === null) continue
      const cat = s.securities.find((x) => x.id === p.securityId)?.category ?? 'Other'
      byCat.set(cat, (byCat.get(cat) ?? 0) + p.weight)
    }
    for (const [cat, w] of byCat) {
      if (w > set.maxCategoryPct && byCat.size > 1) {
        out.push({ type: 'category_concentration', severity: 'warning', title: `หมวด ${cat} มีสัดส่วน ${w.toFixed(1)}% ของพอร์ต`, detail: `เกินเกณฑ์ที่ตั้งไว้ ${set.maxCategoryPct}%`, href: '/analysis' })
      }
    }
  }

  if (combined.missingPrice.length > 0) {
    out.push({
      type: 'stale_price',
      severity: 'warning',
      title: `ไม่มีราคาปัจจุบันของ ${combined.missingPrice.length} หลักทรัพย์ที่ถืออยู่`,
      detail: `${combined.missingPrice.map(secName).join(', ')}: มูลค่าพอร์ตและทรัพย์สินสุทธิยังไม่ครบ`,
      href: '/market',
    })
  }
  const stale = combined.positions.filter((p) => p.price?.stale)
  if (stale.length > 0) {
    out.push({
      type: 'stale_price',
      severity: 'info',
      title: `ราคาของ ${stale.length} หลักทรัพย์เก่าเกิน ${set.staleQuoteHours} ชั่วโมง`,
      detail: `${stale.map((p) => secName(p.securityId)).join(', ')}: มูลค่าที่แสดงคำนวณจากราคาเก่า`,
      href: '/market',
    })
  }
  if (s.missingFx.length > 0) {
    out.push({ type: 'missing_fx', severity: 'warning', title: `ไม่มีอัตราแลกเปลี่ยนของ ${s.missingFx.join(', ')}`, detail: 'ยอดในสกุลเงินนี้ยังไม่ถูกรวมในยอดรวมเงินบาท', href: '/settings' })
  }
  for (const issue of s.issues.slice(0, 5)) {
    out.push({ type: 'data_issue', severity: 'danger', title: 'พบข้อมูลไม่สอดคล้องกัน', detail: issue, href: '/history' })
  }

  const disabled = new Set(set.disabledAlerts)
  const rank: Record<AlertSeverity, number> = { danger: 0, warning: 1, info: 2 }
  return out.filter((a) => !disabled.has(a.type)).sort((a, b) => rank[a.severity] - rank[b.severity])
}

function addDaysSafe(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
