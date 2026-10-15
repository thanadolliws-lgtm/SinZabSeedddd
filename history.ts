/**
 * One chronological list of every recorded movement, built from the same rows
 * the calculation engine uses. Used by Transaction History and its CSV export.
 */
import type { RawData } from './types'

export type HistoryKind =
  | 'buy'
  | 'sell'
  | 'dividend'
  | 'fee'
  | 'split'
  | 'adjustment'
  | 'income'
  | 'expense'
  | 'debt_payment'
  | 'debt_charge'
  | 'transfer'
  | 'emergency_allocation'
  | 'goal_allocation'
  | 'investment_funding'

export const HISTORY_KIND_LABELS: Record<HistoryKind, string> = {
  buy: 'ซื้อหุ้น',
  sell: 'ขายหุ้น',
  dividend: 'รับเงินปันผล',
  fee: 'ค่าธรรมเนียม',
  split: 'แตกหุ้น/รวมหุ้น',
  adjustment: 'รายการปรับปรุง',
  income: 'รายรับ',
  expense: 'รายจ่าย',
  debt_payment: 'ชำระหนี้',
  debt_charge: 'ก่อหนี้เพิ่ม',
  transfer: 'โอนเงินระหว่างบัญชี',
  emergency_allocation: 'จัดสรรเงินสำรอง',
  goal_allocation: 'จัดสรรเงินออมตามเป้าหมาย',
  investment_funding: 'โอนเงินเข้าบัญชีลงทุน',
}

export const INCOME_TYPE_LABELS: Record<string, string> = {
  salary: 'เงินเดือน',
  extra: 'รายได้พิเศษ',
  side_job: 'รายได้จากงานเสริม',
  bonus: 'โบนัส',
  dividend: 'เงินปันผล',
  other: 'รายรับอื่น ๆ',
}

export interface HistoryRow {
  /** `${table}:${id}` */
  key: string
  table: 'transactions' | 'income_records' | 'expense_records' | 'debt_payments' | 'transfers'
  id: string
  date: string
  kind: HistoryKind
  description: string
  symbol: string | null
  securityId: string | null
  portfolio: 'main' | 'dca' | null
  account: string | null
  accountId: string | null
  /** signed effect on the user's money in `currency` (+ in, - out); 0 for non-cash rows */
  amount: number
  currency: string
  quantity: number | null
  price: number | null
  fee: number
  fxRate: number | null
  status: string
  source: string
  note: string | null
}

export function buildHistory(raw: RawData): HistoryRow[] {
  const base = raw.settings.baseCurrency
  const acct = new Map(raw.accounts.map((a) => [a.id, a]))
  const sec = new Map(raw.securities.map((s) => [s.id, s]))
  const pf = new Map(raw.portfolios.map((p) => [p.id, p.kind]))
  const liab = new Map(raw.liabilities.map((l) => [l.id, l.name]))
  const out: HistoryRow[] = []

  for (const t of raw.transactions) {
    const s = sec.get(t.securityId)
    const kind = t.type as HistoryKind
    const signed = t.type === 'buy' ? -(t.amount + t.fee) : t.type === 'sell' || t.type === 'dividend' ? t.amount - t.fee : t.type === 'fee' ? -(t.amount + t.fee) : 0
    out.push({
      key: `transactions:${t.id}`,
      table: 'transactions',
      id: t.id,
      date: t.tradeDate,
      kind,
      description: t.type === 'split' ? `${s?.symbol ?? ''} อัตรา ${t.splitRatio}:1` : (s?.name ?? ''),
      symbol: s?.symbol ?? null,
      securityId: t.securityId,
      portfolio: pf.get(t.portfolioId) ?? null,
      account: t.accountId ? (acct.get(t.accountId)?.name ?? null) : null,
      accountId: t.accountId,
      amount: signed,
      currency: t.currency,
      quantity: t.quantity,
      price: t.price,
      fee: t.fee,
      fxRate: t.currency === base ? null : t.fxRate,
      status: 'บันทึกแล้ว',
      source: t.source,
      note: t.note ?? null,
    })
  }
  for (const i of raw.incomes) {
    out.push({
      key: `income_records:${i.id}`,
      table: 'income_records',
      id: i.id,
      date: i.date,
      kind: 'income',
      description: [INCOME_TYPE_LABELS[i.type] ?? i.type, i.source].filter(Boolean).join(' - '),
      symbol: null,
      securityId: null,
      portfolio: null,
      account: i.accountId ? (acct.get(i.accountId)?.name ?? null) : null,
      accountId: i.accountId,
      amount: i.amount,
      currency: base,
      quantity: null,
      price: null,
      fee: 0,
      fxRate: null,
      status: i.status === 'received' ? 'ได้รับจริง' : 'คาดว่าจะได้รับ',
      source: 'manual',
      note: i.note ?? null,
    })
  }
  for (const e of raw.expenses) {
    out.push({
      key: `expense_records:${e.id}`,
      table: 'expense_records',
      id: e.id,
      date: e.status === 'paid' ? (e.paidDate ?? e.date) : e.date,
      kind: 'expense',
      description: [e.category, e.description].filter(Boolean).join(' - '),
      symbol: null,
      securityId: null,
      portfolio: null,
      account: e.accountId ? (acct.get(e.accountId)?.name ?? null) : null,
      accountId: e.accountId,
      amount: -e.amount,
      currency: base,
      quantity: null,
      price: null,
      fee: 0,
      fxRate: null,
      status: e.status === 'paid' ? 'จ่ายแล้ว' : 'ยังไม่จ่าย',
      source: e.recurringId ? 'recurring' : 'manual',
      note: e.note ?? null,
    })
  }
  for (const d of raw.debtEvents) {
    out.push({
      key: `debt_payments:${d.id}`,
      table: 'debt_payments',
      id: d.id,
      date: d.date,
      kind: d.kind === 'payment' ? 'debt_payment' : 'debt_charge',
      description: liab.get(d.liabilityId) ?? '',
      symbol: null,
      securityId: null,
      portfolio: null,
      account: d.accountId ? (acct.get(d.accountId)?.name ?? null) : null,
      accountId: d.accountId,
      amount: d.kind === 'payment' ? -d.amount : 0,
      currency: base,
      quantity: null,
      price: null,
      fee: d.feeAmount,
      fxRate: null,
      status: 'บันทึกแล้ว',
      source: 'manual',
      note: d.note ?? null,
    })
  }
  for (const t of raw.transfers) {
    const from = acct.get(t.fromAccountId)
    const to = acct.get(t.toAccountId)
    const kind = (['transfer', 'emergency_allocation', 'goal_allocation', 'investment_funding'].includes(t.kind) ? t.kind : 'transfer') as HistoryKind
    out.push({
      key: `transfers:${t.id}`,
      table: 'transfers',
      id: t.id,
      date: t.date,
      kind,
      description: `${from?.name ?? '?'} → ${to?.name ?? '?'}`,
      symbol: null,
      securityId: null,
      portfolio: null,
      account: `${from?.name ?? '?'} → ${to?.name ?? '?'}`,
      accountId: t.fromAccountId,
      // a transfer moves money between the user's own accounts: only the fee leaves
      amount: -t.fee,
      currency: from?.currency ?? base,
      quantity: null,
      price: null,
      fee: t.fee,
      fxRate: from && to && from.currency !== to.currency ? t.amountFrom / t.amountTo : null,
      status: `โอน ${t.amountFrom.toLocaleString('th-TH')} ${from?.currency ?? ''}${from && to && from.currency !== to.currency ? ` → ${t.amountTo.toLocaleString('th-TH')} ${to.currency}` : ''}`,
      source: 'manual',
      note: t.note ?? null,
    })
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key))
}
