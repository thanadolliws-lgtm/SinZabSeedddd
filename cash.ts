/**
 * Cash ledger.
 *
 * An account balance is never stored; it is always
 *   opening balance + every recorded movement that names the account.
 *
 * Double counting is prevented structurally:
 *   - a transfer debits one account and credits another: it is neither income nor expense
 *   - a share purchase debits the linked cash account and creates a holding: it is not an expense
 *   - expected income and unpaid expenses have NO cash effect until marked received / paid
 */
import { roundCash } from './money'
import { txCashEffect, type LedgerTx } from './portfolio'

export type AccountType = 'cash' | 'bank' | 'brokerage' | 'other_asset'
export type AccountPurpose = 'general' | 'emergency' | 'goal'

export interface AccountRow {
  id: string
  name: string
  type: AccountType
  purpose: AccountPurpose
  goalId: string | null
  currency: string
  openingBalance: number
  openingDate: string
  isArchived: boolean
  note?: string | null
}

export interface IncomeRow {
  id: string
  accountId: string | null
  date: string
  type: string
  source: string | null
  amount: number
  status: 'expected' | 'received'
  note?: string | null
}

export interface ExpenseRow {
  id: string
  accountId: string | null
  recurringId: string | null
  /** date incurred, or due date while unpaid */
  date: string
  paidDate: string | null
  category: string
  description: string | null
  amount: number
  frequency: string
  isEssential: boolean
  status: 'paid' | 'unpaid'
  note?: string | null
}

export interface DebtEventRow {
  id: string
  liabilityId: string
  accountId: string | null
  kind: 'payment' | 'charge'
  date: string
  amount: number
  interestAmount: number | null
  feeAmount: number
  note?: string | null
}

export interface TransferRow {
  id: string
  fromAccountId: string
  toAccountId: string
  date: string
  amountFrom: number
  amountTo: number
  fee: number
  kind: string
  note?: string | null
}

export type CashEventKind =
  | 'opening'
  | 'income'
  | 'expense'
  | 'debt_payment'
  | 'transfer_in'
  | 'transfer_out'
  | 'buy'
  | 'sell'
  | 'dividend'
  | 'investment_fee'

export interface CashEvent {
  accountId: string
  date: string
  /** signed, in the account's currency */
  delta: number
  kind: CashEventKind
  refId: string
}

export interface CashLedgerInput {
  accounts: AccountRow[]
  incomes: IncomeRow[]
  expenses: ExpenseRow[]
  debtEvents: DebtEventRow[]
  transfers: TransferRow[]
  investmentTxs: LedgerTx[]
  baseCurrency: string
}

export function buildCashEvents(input: CashLedgerInput): { events: CashEvent[]; issues: string[] } {
  const events: CashEvent[] = []
  const issues: string[] = []
  const byId = new Map(input.accounts.map((a) => [a.id, a]))

  for (const a of input.accounts) {
    if (a.openingBalance !== 0) events.push({ accountId: a.id, date: a.openingDate, delta: a.openingBalance, kind: 'opening', refId: a.id })
  }
  for (const r of input.incomes) {
    if (r.status === 'received' && r.accountId) events.push({ accountId: r.accountId, date: r.date, delta: r.amount, kind: 'income', refId: r.id })
  }
  for (const r of input.expenses) {
    if (r.status === 'paid' && r.accountId) events.push({ accountId: r.accountId, date: r.paidDate ?? r.date, delta: -r.amount, kind: 'expense', refId: r.id })
  }
  for (const r of input.debtEvents) {
    if (r.kind === 'payment' && r.accountId) events.push({ accountId: r.accountId, date: r.date, delta: -r.amount, kind: 'debt_payment', refId: r.id })
  }
  for (const r of input.transfers) {
    events.push({ accountId: r.fromAccountId, date: r.date, delta: -(r.amountFrom + r.fee), kind: 'transfer_out', refId: r.id })
    events.push({ accountId: r.toAccountId, date: r.date, delta: r.amountTo, kind: 'transfer_in', refId: r.id })
  }
  for (const tx of input.investmentTxs) {
    if (!tx.accountId) continue
    const acct = byId.get(tx.accountId)
    if (!acct) continue
    const delta = txCashEffect(tx, acct.currency, input.baseCurrency)
    if (delta === null) {
      issues.push(`ธุรกรรม ${tx.tradeDate} ใช้บัญชีสกุล ${acct.currency} กับหลักทรัพย์สกุล ${tx.currency}: ไม่สามารถคำนวณผลต่อเงินสดได้`)
      continue
    }
    if (delta === 0) continue
    const kind: CashEventKind = tx.type === 'buy' ? 'buy' : tx.type === 'sell' ? 'sell' : tx.type === 'dividend' ? 'dividend' : 'investment_fee'
    events.push({ accountId: tx.accountId, date: tx.tradeDate, delta, kind, refId: tx.id })
  }
  return { events, issues }
}

/** Balance per account in the account's own currency, optionally as of a date (inclusive). */
export function accountBalances(accounts: AccountRow[], events: CashEvent[], asOf?: string): Map<string, number> {
  const out = new Map<string, number>(accounts.map((a) => [a.id, 0]))
  for (const e of events) {
    if (asOf && e.date > asOf) continue
    if (!out.has(e.accountId)) continue
    out.set(e.accountId, roundCash(out.get(e.accountId)! + e.delta))
  }
  return out
}

export interface CashSummary {
  /** cash + bank + brokerage cash, every purpose */
  totalCashBase: number
  /** cash/bank accounts with purpose = general */
  generalCashBase: number
  /** uninvested cash sitting in brokerage accounts (already moved out of spending money) */
  brokerageCashBase: number
  emergencyFundBase: number
  goalReservedBase: number
  /** manually valued assets (account type other_asset): part of net worth, not of cash */
  otherAssetsBase: number
  /** currencies with no exchange rate: their balances are excluded from the totals above */
  missingFx: string[]
}

export function summarizeCash(
  accounts: AccountRow[],
  balances: Map<string, number>,
  fx: (currency: string) => number | null,
): CashSummary {
  const s: CashSummary = {
    totalCashBase: 0,
    generalCashBase: 0,
    brokerageCashBase: 0,
    emergencyFundBase: 0,
    goalReservedBase: 0,
    otherAssetsBase: 0,
    missingFx: [],
  }
  for (const a of accounts) {
    const bal = balances.get(a.id) ?? 0
    const rate = fx(a.currency)
    if (rate === null) {
      if (bal !== 0 && !s.missingFx.includes(a.currency)) s.missingFx.push(a.currency)
      continue
    }
    const base = bal * rate
    if (a.type === 'other_asset') {
      s.otherAssetsBase += base
      continue
    }
    s.totalCashBase += base
    if (a.purpose === 'emergency') s.emergencyFundBase += base
    else if (a.purpose === 'goal') s.goalReservedBase += base
    else if (a.type === 'brokerage') s.brokerageCashBase += base
    else s.generalCashBase += base
  }
  for (const k of ['totalCashBase', 'generalCashBase', 'brokerageCashBase', 'emergencyFundBase', 'goalReservedBase', 'otherAssetsBase'] as const) {
    s[k] = roundCash(s[k])
  }
  return s
}

export interface EmergencyStatus {
  current: number
  /** essential monthly expense used for the target; null when there is no basis yet */
  essentialMonthly: number | null
  essentialSource: 'setting' | 'average' | 'none'
  targetMonths: number
  /** essentialMonthly x targetMonths */
  target: number | null
  /** positive = shortfall, negative = surplus */
  gap: number | null
  coverageMonths: number | null
}

export function emergencyStatus(current: number, essentialMonthly: number | null, source: EmergencyStatus['essentialSource'], targetMonths: number): EmergencyStatus {
  const has = essentialMonthly !== null && essentialMonthly > 0
  const target = has ? roundCash(essentialMonthly! * targetMonths) : null
  return {
    current,
    essentialMonthly: has ? essentialMonthly : null,
    essentialSource: has ? source : 'none',
    targetMonths,
    target,
    gap: target === null ? null : roundCash(target - current),
    coverageMonths: has ? current / essentialMonthly! : null,
  }
}
