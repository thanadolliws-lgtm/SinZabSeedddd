import { describe, expect, it } from 'vitest'
import { accountBalances, buildCashEvents, emergencyStatus, summarizeCash, type AccountRow, type CashLedgerInput, type DebtEventRow } from '@/lib/calc/cash'
import { dueStatus, liabilityState, projectPayoff, simulateStrategy, type LiabilityRow } from '@/lib/calc/debt'
import type { LedgerTx } from '@/lib/calc/portfolio'

const acct = (p: Partial<AccountRow> & Pick<AccountRow, 'id'>): AccountRow => ({
  name: p.id,
  type: 'bank',
  purpose: 'general',
  goalId: null,
  currency: 'THB',
  openingBalance: 0,
  openingDate: '2026-01-01',
  isArchived: false,
  ...p,
})
const accounts = [
  acct({ id: 'bank', openingBalance: 50_000 }),
  acct({ id: 'wallet', type: 'cash', openingBalance: 2_000 }),
  acct({ id: 'emergency', purpose: 'emergency', openingBalance: 30_000 }),
  acct({ id: 'broker', type: 'brokerage' }),
  acct({ id: 'brokerUsd', type: 'brokerage', currency: 'USD' }),
  acct({ id: 'gold', type: 'other_asset', openingBalance: 40_000 }),
]
const empty: CashLedgerInput = { accounts, incomes: [], expenses: [], debtEvents: [], transfers: [], investmentTxs: [], baseCurrency: 'THB' }
const fx = (c: string) => (c === 'THB' ? 1 : c === 'USD' ? 35 : null)
const run = (input: Partial<CashLedgerInput>) => {
  const full = { ...empty, ...input }
  const { events, issues } = buildCashEvents(full)
  const balances = accountBalances(full.accounts, events)
  return { balances, issues, summary: summarizeCash(full.accounts, balances, fx), events }
}
const buy = (p: Partial<LedgerTx>): LedgerTx => ({
  id: 't1',
  portfolioId: 'main',
  securityId: 'MSFT',
  accountId: null,
  type: 'buy',
  tradeDate: '2026-02-01',
  createdAt: '2026-02-01T00:00:00.000Z',
  quantity: 2,
  price: 100,
  amount: 200,
  fee: 1,
  splitRatio: null,
  currency: 'USD',
  fxRate: 35,
  source: 'manual',
  ...p,
})

describe('cash ledger', () => {
  it('opening balances only', () => {
    const { summary } = run({})
    expect(summary.totalCashBase).toBe(82_000)
    expect(summary.generalCashBase).toBe(52_000)
    expect(summary.emergencyFundBase).toBe(30_000)
    expect(summary.otherAssetsBase).toBe(40_000) // net worth only, never cash
  })

  it('income, expenses and debt payments move the right account', () => {
    const { balances, summary } = run({
      incomes: [{ id: 'i1', accountId: 'bank', date: '2026-02-25', type: 'salary', source: 'ACME', amount: 40_000, status: 'received' }],
      expenses: [{ id: 'e1', accountId: 'wallet', recurringId: null, date: '2026-02-26', paidDate: '2026-02-26', category: 'ค่าอาหาร', description: null, amount: 350, frequency: 'once', isEssential: true, status: 'paid' }],
      debtEvents: [{ id: 'd1', liabilityId: 'L', accountId: 'bank', kind: 'payment', date: '2026-02-27', amount: 3_000, interestAmount: null, feeAmount: 0 }],
    })
    expect(balances.get('bank')).toBe(87_000)
    expect(balances.get('wallet')).toBe(1_650)
    expect(summary.totalCashBase).toBe(82_000 + 40_000 - 350 - 3_000)
  })

  it('expected income and unpaid bills have no cash effect', () => {
    const { summary } = run({
      incomes: [{ id: 'i1', accountId: 'bank', date: '2026-02-25', type: 'bonus', source: null, amount: 99_999, status: 'expected' }],
      expenses: [{ id: 'e1', accountId: 'bank', recurringId: null, date: '2026-02-28', paidDate: null, category: 'ค่าที่พัก', description: null, amount: 8_000, frequency: 'monthly', isEssential: true, status: 'unpaid' }],
    })
    expect(summary.totalCashBase).toBe(82_000)
  })

  it('a transfer between own accounts never changes total cash (minus an explicit fee)', () => {
    const t = { id: 'x1', fromAccountId: 'bank', toAccountId: 'emergency', date: '2026-02-01', amountFrom: 10_000, amountTo: 10_000, fee: 0, kind: 'emergency_allocation' }
    const a = run({ transfers: [t] })
    expect(a.summary.totalCashBase).toBe(82_000)
    expect(a.summary.generalCashBase).toBe(42_000)
    expect(a.summary.emergencyFundBase).toBe(40_000)
    const b = run({ transfers: [{ ...t, fee: 25 }] })
    expect(b.summary.totalCashBase).toBe(81_975)
  })

  it('funding a broker then buying shares is counted once: cash becomes a holding, not an expense', () => {
    const { balances, summary } = run({
      transfers: [{ id: 'x1', fromAccountId: 'bank', toAccountId: 'broker', date: '2026-02-01', amountFrom: 10_000, amountTo: 10_000, fee: 0, kind: 'investment_funding' }],
      investmentTxs: [buy({ accountId: 'broker' })],
    })
    expect(balances.get('bank')).toBe(40_000)
    // (200 + 1) USD x 35 = 7,035 THB leaves the THB broker account
    expect(balances.get('broker')).toBe(2_965)
    expect(summary.brokerageCashBase).toBe(2_965)
    // total cash fell by exactly the purchase cost, nothing else
    expect(summary.totalCashBase).toBe(82_000 - 7_035)
  })

  it('cross-currency transfer and a trade settled in the foreign-currency account', () => {
    const { balances, summary } = run({
      transfers: [{ id: 'x1', fromAccountId: 'bank', toAccountId: 'brokerUsd', date: '2026-02-01', amountFrom: 35_000, amountTo: 1_000, fee: 0, kind: 'investment_funding' }],
      investmentTxs: [buy({ accountId: 'brokerUsd' }), buy({ id: 't2', type: 'dividend', accountId: 'brokerUsd', quantity: null, price: null, amount: 10, fee: 1.5 })],
    })
    expect(balances.get('brokerUsd')).toBe(1_000 - 201 + 8.5)
    expect(summary.brokerageCashBase).toBe(807.5 * 35)
  })

  it('a trade with no linked account leaves cash untouched', () => {
    expect(run({ investmentTxs: [buy({})] }).summary.totalCashBase).toBe(82_000)
  })

  it('balances can be replayed as of a past date', () => {
    const input = { ...empty, incomes: [{ id: 'i1', accountId: 'bank', date: '2026-03-25', type: 'salary', source: null, amount: 40_000, status: 'received' as const }] }
    const { events } = buildCashEvents(input)
    expect(accountBalances(accounts, events, '2026-02-28').get('bank')).toBe(50_000)
    expect(accountBalances(accounts, events, '2026-03-31').get('bank')).toBe(90_000)
  })

  it('a currency without an FX rate is reported instead of being silently dropped', () => {
    const withEur = [...accounts, acct({ id: 'eur', currency: 'EUR', openingBalance: 100 })]
    const { summary } = run({ accounts: withEur })
    expect(summary.missingFx).toEqual(['EUR'])
    expect(summary.totalCashBase).toBe(82_000)
  })
})

describe('emergency fund', () => {
  it('target = essential monthly expense x months', () => {
    const e = emergencyStatus(30_000, 15_000, 'setting', 6)
    expect(e.target).toBe(90_000)
    expect(e.gap).toBe(60_000)
    expect(e.coverageMonths).toBe(2)
  })
  it('surplus is a negative gap', () => expect(emergencyStatus(100_000, 15_000, 'average', 6).gap).toBe(-10_000))
  it('no basis -> no target rather than an invented one', () => {
    const e = emergencyStatus(30_000, null, 'none', 6)
    expect(e.target).toBeNull()
    expect(e.gap).toBeNull()
    expect(e.coverageMonths).toBeNull()
  })
})

describe('liabilities', () => {
  const card: LiabilityRow = { id: 'L', name: 'บัตรเครดิต', kind: 'credit_card', openingBalance: 10_000, openingDate: '2026-01-01', annualRate: 18, minPayment: 1_000, dueDay: 15, targetPayment: null, status: 'active' }
  const pay = (p: Partial<DebtEventRow> & Pick<DebtEventRow, 'id' | 'date' | 'amount'>): DebtEventRow => ({ liabilityId: 'L', accountId: null, kind: 'payment', interestAmount: null, feeAmount: 0, ...p })

  it('estimates interest by simple daily accrual when the statement figure is not entered', () => {
    const s = liabilityState(card, [pay({ id: 'p1', date: '2026-01-31', amount: 1_000 })], '2026-01-31')
    // 10,000 x 18% x 30/365 = 147.9452
    expect(s.ledger[0].interest).toBe(147.9452)
    expect(s.ledger[0].interestEstimated).toBe(true)
    expect(s.balance).toBe(9_147.9452)
    expect(s.interestPaid).toBe(147.9452)
  })

  it('uses the actual interest when the user enters it', () => {
    const s = liabilityState(card, [pay({ id: 'p1', date: '2026-01-31', amount: 1_000, interestAmount: 150, feeAmount: 20 })], '2026-01-31')
    expect(s.balance).toBe(9_170)
    expect(s.ledger[0].interestEstimated).toBe(false)
    expect(s.feesPaid).toBe(20)
  })

  it('accrues interest after the last payment up to today', () => {
    const s = liabilityState(card, [pay({ id: 'p1', date: '2026-01-31', amount: 1_000, interestAmount: 0 })], '2026-03-02')
    expect(s.ledgerBalance).toBe(9_000)
    // 9,000 x 18% x 30/365 = 133.1507
    expect(s.accruedInterest).toBe(133.1507)
    expect(s.balance).toBe(9_133.1507)
  })

  it('new charges increase the balance', () => {
    const s = liabilityState({ ...card, annualRate: 0 }, [pay({ id: 'c1', kind: 'charge', date: '2026-01-10', amount: 2_500 }), pay({ id: 'p1', date: '2026-01-20', amount: 4_000 })], '2026-01-31')
    expect(s.balance).toBe(8_500)
  })

  it('paying it off closes the balance; overpaying is reported', () => {
    const s = liabilityState({ ...card, annualRate: 0 }, [pay({ id: 'p1', date: '2026-01-20', amount: 10_000 })], '2026-02-28')
    expect(s.balance).toBe(0)
    const over = liabilityState({ ...card, annualRate: 0 }, [pay({ id: 'p1', date: '2026-01-20', amount: 10_500 })], '2026-02-28')
    expect(over.balance).toBe(0)
    expect(over.issues[0]).toMatch(/ชำระเกิน/)
  })

  it('due / overdue status for the month', () => {
    const zero = { ...card, annualRate: 0 }
    const before = dueStatus(liabilityState(zero, [], '2026-01-10'), [], '2026-01-10')
    expect(before).toMatchObject({ requiredThisMonth: 1_000, remainingThisMonth: 1_000, overdueAmount: 0, daysUntilDue: 5, dueDate: '2026-01-15' })
    const late = dueStatus(liabilityState(zero, [], '2026-01-20'), [], '2026-01-20')
    expect(late.overdueAmount).toBe(1_000)
    const paid = [pay({ id: 'p1', date: '2026-01-12', amount: 1_000 })]
    expect(dueStatus(liabilityState(zero, paid, '2026-01-20'), paid, '2026-01-20')).toMatchObject({ remainingThisMonth: 0, overdueAmount: 0, paidThisMonth: 1_000 })
    // January missed entirely: still overdue in early February, before February's own due date
    expect(dueStatus(liabilityState(zero, [], '2026-02-03'), [], '2026-02-03').overdueAmount).toBe(1_000)
  })

  it('payoff projection matches the amortisation formula', () => {
    const p = projectPayoff(100_000, 12, 5_000)
    const r = 0.01
    const n = Math.ceil(-Math.log(1 - (r * 100_000) / 5_000) / Math.log(1 + r))
    expect(p.months).toBe(n)
    expect(p.neverPaysOff).toBe(false)
    expect(p.totalInterest).toBeGreaterThan(0)
    expect(projectPayoff(100_000, 12, 1_000).neverPaysOff).toBe(true) // payment == interest
    expect(projectPayoff(0, 12, 1_000).months).toBe(0)
    expect(projectPayoff(12_000, 0, 1_000)).toMatchObject({ months: 12, totalInterest: 0 })
  })

  it('avalanche never costs more interest than snowball', () => {
    const debts = [
      { id: 'card', name: 'card', balance: 60_000, annualRate: 18, minPayment: 2_000 },
      { id: 'small', name: 'small', balance: 8_000, annualRate: 6, minPayment: 500 },
      { id: 'car', name: 'car', balance: 200_000, annualRate: 4, minPayment: 5_000 },
    ]
    const a = simulateStrategy(debts, 12_000, 'avalanche')
    const s = simulateStrategy(debts, 12_000, 'snowball')
    expect(a.feasible && s.feasible).toBe(true)
    expect(a.order).toEqual(['card', 'small', 'car'])
    expect(s.order).toEqual(['small', 'card', 'car'])
    expect(a.totalInterest!).toBeLessThanOrEqual(s.totalInterest!)
    expect(s.payoffMonth.small).toBeLessThan(a.payoffMonth.small)
    expect(a.timeline[a.timeline.length - 1]).toBe(0)
    expect(simulateStrategy(debts, 5_000, 'avalanche').feasible).toBe(false)
  })
})
