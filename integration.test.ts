/**
 * Integration tests against a real PostgreSQL engine (PGlite, in memory) with
 * the production migrations applied: auth, row-level security, the mutation
 * services and the snapshot every page renders from.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDb, createTestDriver, runMigrations, setDriverForTests, sys, withUser, type Queryable } from '@/lib/db'
import { AuthError, changePassword, createPasswordReset, createSession, deleteSession, getSessionUser, registerUser, resetPassword, verifyLogin, type AuthUser } from '@/lib/auth/service'
import { buildAppData } from '@/lib/data/app-data'
import { todayInTz, addDays, monthOf } from '@/lib/calc/money'
import { isDuplicateSubmit, UserError } from '@/lib/services/core'
import * as S from '@/lib/services/schemas'
import * as pf from '@/lib/services/portfolio'
import * as dca from '@/lib/services/dca'
import * as money from '@/lib/services/money'
import * as settings from '@/lib/services/settings'
import { refreshQuotes, getStoredQuotes, marketDataStatus } from '@/lib/market/service'
import { getLatestRates, refreshFx } from '@/lib/market/fx'
import { toCsv } from '@/lib/csv'

const today = todayInTz('Asia/Bangkok')
const daysAgo = (n: number) => addDays(today, -n)
let alice: AuthUser
let bob: AuthUser
const PASSWORD = 'correct horse battery'

const as = <T>(user: AuthUser, fn: (q: Queryable) => Promise<T>) => withUser(user.id, fn)

beforeAll(async () => {
  setDriverForTests(await createTestDriver())
  alice = await registerUser({ email: 'Alice@Example.com', password: PASSWORD, displayName: 'Alice', ip: '10.0.0.1' })
  bob = await registerUser({ email: 'bob@example.com', password: PASSWORD, displayName: 'Bob', ip: '10.0.0.2' })
})

afterAll(async () => {
  await closeDb()
})

describe('1. accounts and sessions', () => {
  it('registers, normalises the e-mail and creates the per-user defaults', async () => {
    expect(alice.email).toBe('alice@example.com')
    const data = await buildAppData(alice.id)
    expect(data.raw.portfolios.map((p) => p.kind).sort()).toEqual(['dca', 'main'])
    expect(data.raw.settings.baseCurrency).toBe('THB')
  })

  it('never stores the password itself', async () => {
    const r = await sys.query<{ password_hash: string }>('select password_hash from users where id = $1', [alice.id])
    expect(r.rows[0].password_hash.startsWith('scrypt$')).toBe(true)
    expect(r.rows[0].password_hash).not.toContain(PASSWORD)
  })

  it('logs in with the right password only, without revealing which part was wrong', async () => {
    expect((await verifyLogin({ email: 'ALICE@example.com ', password: PASSWORD, ip: 't1' })).id).toBe(alice.id)
    const wrong = await verifyLogin({ email: 'alice@example.com', password: 'nope-nope-nope', ip: 't1' }).catch((e) => e)
    const unknown = await verifyLogin({ email: 'nobody@example.com', password: PASSWORD, ip: 't1' }).catch((e) => e)
    expect(wrong).toBeInstanceOf(AuthError)
    expect(unknown.message).toBe(wrong.message)
  })

  it('rejects duplicate e-mails and weak passwords', async () => {
    await expect(registerUser({ email: 'alice@example.com', password: PASSWORD, displayName: 'x', ip: 't2' })).rejects.toMatchObject({ code: 'exists' })
    await expect(registerUser({ email: 'c@example.com', password: 'short', displayName: 'x', ip: 't2' })).rejects.toMatchObject({ code: 'weak_password' })
  })

  it('sessions: only the token hash is stored; logout invalidates it', async () => {
    const { token } = await createSession(alice.id, 'vitest')
    expect((await getSessionUser(token))?.id).toBe(alice.id)
    const stored = await sys.query<{ token_hash: string }>('select token_hash from sessions where user_id = $1', [alice.id])
    expect(stored.rows.some((r) => r.token_hash === token)).toBe(false)
    expect(await getSessionUser('forged-token')).toBeNull()
    await deleteSession(token)
    expect(await getSessionUser(token)).toBeNull()
  })

  it('password reset: single-use token, signs out every session', async () => {
    const carol = await registerUser({ email: 'carol@example.com', password: PASSWORD, displayName: 'Carol', ip: '10.0.0.3' })
    const { token: session } = await createSession(carol.id)
    expect(await createPasswordReset('nobody@example.com', 'r1')).toBeNull()
    const reset = await createPasswordReset('carol@example.com', 'r1')
    expect(reset?.token).toBeTruthy()
    await expect(resetPassword('wrong-token', 'a brand new password')).rejects.toMatchObject({ code: 'expired' })
    await resetPassword(reset!.token, 'a brand new password')
    expect(await getSessionUser(session)).toBeNull()
    await expect(resetPassword(reset!.token, 'another new password')).rejects.toMatchObject({ code: 'expired' })
    await expect(verifyLogin({ email: 'carol@example.com', password: PASSWORD, ip: 'r2' })).rejects.toBeInstanceOf(AuthError)
    expect((await verifyLogin({ email: 'carol@example.com', password: 'a brand new password', ip: 'r2' })).id).toBe(carol.id)
    await changePassword(carol.id, 'a brand new password', 'yet another password')
    await expect(changePassword(carol.id, 'wrong current', 'whatever password')).rejects.toBeInstanceOf(AuthError)
  })

  it('locks out repeated failed logins for an e-mail', async () => {
    await registerUser({ email: 'dave@example.com', password: PASSWORD, displayName: 'Dave', ip: '10.0.0.4' })
    for (let i = 0; i < 8; i++) await verifyLogin({ email: 'dave@example.com', password: 'wrong-password-x', ip: `d${i}` }).catch(() => {})
    await expect(verifyLogin({ email: 'dave@example.com', password: PASSWORD, ip: 'd9' })).rejects.toMatchObject({ code: 'rate_limited' })
  })
})

describe('3-5, 16. investment ledger through the services', () => {
  let msft: string
  let ptt: string

  it('adds securities; the currency comes from the exchange', async () => {
    msft = (await as(alice, (q) => pf.saveSecurity(q, alice.id, S.securitySchema.parse({ symbol: 'msft', exchange: 'NASDAQ', name: 'Microsoft', category: 'Technology' })))).id
    ptt = (await as(alice, (q) => pf.saveSecurity(q, alice.id, S.securitySchema.parse({ symbol: 'PTT', exchange: 'SET', name: 'PTT', category: 'Energy' })))).id
    const { raw } = await buildAppData(alice.id)
    expect(raw.securities.find((s) => s.id === msft)).toMatchObject({ symbol: 'MSFT', currency: 'USD' })
    expect(raw.securities.find((s) => s.id === ptt)).toMatchObject({ currency: 'THB' })
    await expect(as(alice, (q) => pf.saveSecurity(q, alice.id, S.securitySchema.parse({ symbol: 'MSFT', exchange: 'NASDAQ', name: 'dup' })))).rejects.toMatchObject({ code: '23505' })
  })

  const buy = (o: Record<string, unknown>) => S.transactionSchema.parse({ portfolio: 'main', type: 'buy', fee: 0, ...o })

  it('several buys at different prices -> weighted average cost', async () => {
    await as(alice, (q) => pf.saveTransaction(q, alice.id, buy({ securityId: msft, tradeDate: daysAgo(40), quantity: 10, price: 100, fee: 5, fxRate: 35 })))
    await as(alice, (q) => pf.saveTransaction(q, alice.id, buy({ securityId: msft, tradeDate: daysAgo(30), quantity: 20, price: 130, fee: 5, fxRate: 36 })))
    const p = (await buildAppData(alice.id)).snapshot.portfolios.main.positions[0]
    expect(p.quantity).toBe(30)
    expect(p.costBasis).toBe(3610)
    expect(p.avgCost).toBeCloseTo(120.333333, 6)
    expect(p.costBasisBase).toBe(1005 * 35 + 2605 * 36)
    expect(p.status).toBe('no_price') // nothing invented when there is no price
  })

  it('a foreign-currency trade without an FX rate is refused', async () => {
    await expect(as(alice, (q) => pf.saveTransaction(q, alice.id, buy({ securityId: msft, tradeDate: daysAgo(5), quantity: 1, price: 100 })))).rejects.toBeInstanceOf(UserError)
  })

  it('future-dated trades and over-selling are refused and leave nothing behind', async () => {
    await expect(as(alice, (q) => pf.saveTransaction(q, alice.id, buy({ securityId: msft, tradeDate: addDays(today, 3), quantity: 1, price: 100, fxRate: 35 })))).rejects.toThrow(/อนาคต/)
    await expect(as(alice, (q) => pf.saveTransaction(q, alice.id, buy({ type: 'sell', securityId: msft, tradeDate: daysAgo(20), quantity: 31, price: 150, fxRate: 36 })))).rejects.toThrow(/ขายเกิน/)
    expect((await buildAppData(alice.id)).raw.transactions).toHaveLength(2)
  })

  it('partial sell -> remaining shares, cost and realised P/L', async () => {
    await as(alice, (q) => pf.saveTransaction(q, alice.id, buy({ type: 'sell', securityId: msft, tradeDate: daysAgo(20), quantity: 12, price: 150, fee: 6, fxRate: 36 })))
    const main = (await buildAppData(alice.id)).snapshot.portfolios.main
    expect(main.positions[0].quantity).toBe(18)
    expect(main.positions[0].costBasis).toBe(2166)
    expect(main.positions[0].realizedPnl).toBe(350)
  })

  it('deleting an earlier buy that a later sell depends on is refused', async () => {
    const { raw } = await buildAppData(alice.id)
    const firstBuy = raw.transactions.find((t) => t.type === 'buy' && t.quantity === 20)!
    await expect(as(alice, (q) => pf.deleteTransaction(q, alice.id, firstBuy.id))).rejects.toThrow(/ขายเกิน/)
    expect((await buildAppData(alice.id)).raw.transactions).toHaveLength(3)
  })

  it('P/L in baht and %, and it follows the price (12)', async () => {
    await as(alice, (q) => pf.setManualPrice(q, alice.id, S.manualPriceSchema.parse({ securityId: msft, price: 140 })))
    await sys.query(`insert into exchange_rates (base, quote, rate_date, rate, source) values ('USD', 'THB', $1, 37, 'test')`, [today])
    let s = (await buildAppData(alice.id)).snapshot
    let p = s.portfolios.main.positions[0]
    expect(p.price?.dataType).toBe('manual')
    expect(p.marketValue).toBe(2520) // 18 x 140
    expect(p.unrealizedPnl).toBe(354)
    expect(p.unrealizedPct).toBeCloseTo((354 / 2166) * 100, 9)
    expect(p.marketValueBase).toBe(2520 * 37)
    const costBase = p.costBasisBase
    expect(p.unrealizedPnlBase).toBeCloseTo(2520 * 37 - costBase, 6)
    expect(s.portfolios.main.complete).toBe(true)
    expect(s.netWorth.assets).toBe(2520 * 37)

    await as(alice, (q) => pf.setManualPrice(q, alice.id, S.manualPriceSchema.parse({ securityId: msft, price: 100 })))
    s = (await buildAppData(alice.id)).snapshot
    p = s.portfolios.main.positions[0]
    expect(p.marketValueBase).toBe(1800 * 37)
    expect(p.status).toBe('loss')
    // 17: the overview total and the portfolio page total are the same number
    expect(s.netWorth.assets).toBe(s.portfolios.combined.marketValueBase)
    expect(s.portfolios.combined.marketValueBase).toBe(s.portfolios.main.marketValueBase)
  })

  it('editing a transaction recomputes the position', async () => {
    const { raw } = await buildAppData(alice.id)
    const first = raw.transactions.find((t) => t.quantity === 10)!
    await as(alice, (q) => pf.saveTransaction(q, alice.id, buy({ id: first.id, securityId: msft, tradeDate: first.tradeDate, quantity: 10, price: 110, fee: 5, fxRate: 35 })))
    const p = (await buildAppData(alice.id)).snapshot.portfolios.main.positions[0]
    // cost before sell = 1105 + 2605 = 3710 ; 18/30 remain
    expect(p.costBasis).toBe(2226)
  })

  it('selling everything closes the position (zero shares, zero cost)', async () => {
    await as(alice, (q) => pf.saveTransaction(q, alice.id, buy({ securityId: ptt, tradeDate: daysAgo(10), quantity: 100, price: 34 })))
    await as(alice, (q) => pf.saveTransaction(q, alice.id, buy({ type: 'sell', securityId: ptt, tradeDate: daysAgo(9), quantity: 100, price: 35 })))
    const main = (await buildAppData(alice.id)).snapshot.portfolios.main
    expect(main.positions.map((p) => p.securityId)).toEqual([msft])
    const closed = main.closedPositions.find((p) => p.securityId === ptt)!
    expect(closed.quantity).toBe(0)
    expect(closed.costBasis).toBe(0)
    expect(closed.realizedPnlBase).toBe(100)
  })

  it('every change is written to the audit log, which the app role cannot rewrite', async () => {
    const log = await as(alice, (q) => settings.loadAuditLog(q))
    expect(log.filter((l) => l.entity === 'transactions').length).toBeGreaterThanOrEqual(5)
    await expect(as(alice, (q) => q.query('delete from audit_log'))).rejects.toThrow(/permission denied/)
    await expect(as(alice, (q) => q.query(`update audit_log set action = 'create'`))).rejects.toThrow(/permission denied/)
  })

  it('a repeated submit with the same idempotency key is rejected by the database', async () => {
    const input = buy({ securityId: ptt, tradeDate: daysAgo(2), quantity: 1, price: 30, idempotencyKey: 'click-0001-abcdef' })
    await as(alice, (q) => pf.saveTransaction(q, alice.id, input))
    const again = await as(alice, (q) => pf.saveTransaction(q, alice.id, input)).catch((e) => e)
    expect(isDuplicateSubmit(again)).toBe(true)
    expect((await buildAppData(alice.id)).raw.transactions.filter((t) => t.securityId === ptt && t.quantity === 1)).toHaveLength(1)
  })
})

describe('2. data isolation (row level security)', () => {
  it("Bob sees none of Alice's data", async () => {
    const b = await buildAppData(bob.id)
    expect(b.raw.securities).toHaveLength(0)
    expect(b.raw.transactions).toHaveLength(0)
    expect(b.snapshot.netWorth.value).toBe(0)
    expect((await as(bob, (q) => q.query('select * from transactions'))).rows).toHaveLength(0)
    expect((await as(bob, (q) => q.query('select * from audit_log'))).rows.every((r) => r.user_id === bob.id)).toBe(true)
  })

  it("Bob cannot read, change, delete or reference Alice's rows even by id", async () => {
    const a = await buildAppData(alice.id)
    const txId = a.raw.transactions[0].id
    const secId = a.raw.securities[0].id
    expect((await as(bob, (q) => q.query('select * from transactions where id = $1', [txId]))).rows).toHaveLength(0)
    expect((await as(bob, (q) => q.query('update transactions set price = 1 where id = $1', [txId]))).rowCount).toBe(0)
    expect((await as(bob, (q) => q.query('delete from transactions where id = $1', [txId]))).rowCount).toBe(0)
    await expect(as(bob, (q) => pf.deleteTransaction(q, bob.id, txId))).rejects.toBeInstanceOf(UserError)
    // inserting a row that claims to be Alice's
    await expect(as(bob, (q) => q.query(`insert into securities (user_id, symbol, exchange, name, currency) values ($1, 'X', 'SET', 'x', 'THB')`, [alice.id]))).rejects.toThrow(/row-level security/)
    // pointing his own transaction at Alice's security
    await expect(as(bob, (q) => pf.saveTransaction(q, bob.id, S.transactionSchema.parse({ portfolio: 'main', type: 'buy', securityId: secId, tradeDate: daysAgo(1), quantity: 1, price: 1, fxRate: 35 })))).rejects.toBeInstanceOf(UserError)
    const bobPortfolio = (await buildAppData(bob.id)).raw.portfolios[0].id
    await expect(
      as(bob, (q) => q.query(`insert into transactions (user_id, portfolio_id, security_id, type, trade_date, quantity, price, amount, currency) values ($1, $2, $3, 'buy', $4, 1, 1, 1, 'USD')`, [bob.id, bobPortfolio, secId, today])),
    ).rejects.toThrow(/foreign key/)
    expect((await buildAppData(alice.id)).raw.transactions).toHaveLength(a.raw.transactions.length)
  })

  it('the app role cannot touch auth tables, and nothing is visible without a user context', async () => {
    await expect(as(bob, (q) => q.query('select * from users'))).rejects.toThrow(/permission denied/)
    await expect(as(bob, (q) => q.query('select * from sessions'))).rejects.toThrow(/permission denied/)
    await expect(withUser('not-a-uuid', async () => 1)).rejects.toThrow(/invalid user id/)
  })
})

describe('6. watchlist never changes the real portfolio by itself', () => {
  it('planned -> confirmed purchase creates exactly one transaction', async () => {
    const koId = (await as(alice, (q) => pf.saveSecurity(q, alice.id, S.securitySchema.parse({ symbol: 'KO', exchange: 'NYSE', name: 'Coca-Cola', category: 'Food' })))).id
    const before = (await buildAppData(alice.id)).snapshot
    await as(alice, (q) => pf.saveWatch(q, alice.id, S.watchSchema.parse({ securityId: koId, targetPrice: 60, budget: 5000, priority: 'high', status: 'waiting', reason: 'ปันผลสม่ำเสมอ' })))
    const mid = await buildAppData(alice.id)
    expect(mid.snapshot.portfolios.main.costBasisBase).toBe(before.portfolios.main.costBasisBase)
    expect(mid.snapshot.portfolios.main.positions).toHaveLength(before.portfolios.main.positions.length)
    expect(mid.raw.transactions).toHaveLength((await buildAppData(alice.id)).raw.transactions.length)
    expect(mid.snapshot.securities.find((s) => s.id === koId)!.watch?.status).toBe('waiting')

    const watchId = mid.raw.watchlist[0].id
    const tx = S.transactionSchema.parse({ portfolio: 'main', type: 'buy', securityId: koId, tradeDate: daysAgo(1), quantity: 2, price: 61, fxRate: 37 })
    await as(alice, (q) => pf.confirmWatchBought(q, alice.id, watchId, tx))
    const after = await buildAppData(alice.id)
    expect(after.snapshot.portfolios.main.positions.some((p) => p.securityId === koId && p.quantity === 2)).toBe(true)
    expect(after.raw.watchlist[0]).toMatchObject({ status: 'bought' })
    expect(after.raw.transactions.find((t) => t.securityId === koId)!.source).toBe('watchlist')
    await expect(as(alice, (q) => pf.confirmWatchBought(q, alice.id, watchId, tx))).rejects.toThrow(/ยืนยันซื้อไปแล้ว/)
  })
})

describe('7-8. DCA plan vs real execution', () => {
  let planId: string
  let qqqm: string
  let schd: string

  it('weights that do not total 100% need explicit confirmation and are saved as a draft', async () => {
    qqqm = (await as(alice, (q) => pf.saveSecurity(q, alice.id, S.securitySchema.parse({ symbol: 'QQQM', exchange: 'NASDAQ', name: 'Invesco NASDAQ 100', assetType: 'etf', category: 'ETF' })))).id
    schd = (await as(alice, (q) => pf.saveSecurity(q, alice.id, S.securitySchema.parse({ symbol: 'SCHD', exchange: 'NYSEARCA', name: 'Schwab US Dividend', assetType: 'etf', category: 'ETF' })))).id
    const plan = { name: 'Core DCA', budgetAmount: 3000, frequency: 'monthly', investDay: 5, startDate: daysAgo(60), allocations: [{ securityId: qqqm, targetPct: 60 }, { securityId: schd, targetPct: 30 }] }
    await expect(as(alice, (q) => dca.saveDcaPlan(q, alice.id, S.dcaPlanSchema.parse(plan)))).rejects.toThrow(/90%.*100%/)
    const draft = await as(alice, (q) => dca.saveDcaPlan(q, alice.id, S.dcaPlanSchema.parse({ ...plan, confirmIncomplete: true })))
    expect(draft.status).toBe('draft')
    planId = draft.id
    await expect(as(alice, (q) => dca.generateSchedule(q, alice.id, { planId, month: monthOf(today), replacePlanned: false }))).rejects.toThrow(/แบบร่าง/)
  })

  it('a valid plan splits the budget exactly', async () => {
    const saved = await as(alice, (q) =>
      dca.saveDcaPlan(q, alice.id, S.dcaPlanSchema.parse({ id: planId, name: 'Core DCA', budgetAmount: 3000, frequency: 'monthly', investDay: 5, startDate: daysAgo(60), allocations: [{ securityId: qqqm, targetPct: 60 }, { securityId: schd, targetPct: 40 }] })),
    )
    expect(saved.status).toBe('active')
    const view = (await buildAppData(alice.id)).snapshot.dcaPlans[0]
    expect(view.check.ok).toBe(true)
    expect(view.amounts.map((a) => a.amount)).toEqual([1800, 1200])
  })

  it('a generated schedule is only a plan: the DCA portfolio stays empty until a purchase is recorded', async () => {
    const gen = await as(alice, (q) => dca.generateSchedule(q, alice.id, { planId, month: monthOf(today), replacePlanned: false }))
    expect(gen.created).toBe(2)
    // generating again must not duplicate
    expect((await as(alice, (q) => dca.generateSchedule(q, alice.id, { planId, month: monthOf(today), replacePlanned: false }))).created).toBe(0)
    const d = await buildAppData(alice.id)
    expect(d.raw.dcaSchedule).toHaveLength(2)
    expect(d.snapshot.portfolios.dca.positions).toHaveLength(0)
    expect(d.snapshot.portfolios.dca.costBasisBase).toBe(0)
    expect(d.snapshot.investedThisMonth.dca).toBe(0)
    expect(d.snapshot.dcaPlans[0]).toMatchObject({ monthPlanned: 3000, monthExecuted: 0, monthPending: 3000 })
  })

  it('recording the real purchase links it to the plan and to the DCA and combined portfolios', async () => {
    const before = await buildAppData(alice.id)
    const slot = before.raw.dcaSchedule.find((s) => s.securityId === qqqm)!
    const tradeDate = slot.plannedDate <= today ? slot.plannedDate : today
    await as(alice, (q) => dca.executeSchedule(q, alice.id, S.scheduleExecuteSchema.parse({ scheduleId: slot.id, tradeDate, quantity: 0.25, price: 200, fee: 1, fxRate: 36 })))
    const after = await buildAppData(alice.id)
    const pos = after.snapshot.portfolios.dca.positions.find((p) => p.securityId === qqqm)!
    expect(pos.quantity).toBe(0.25)
    expect(pos.costBasis).toBe(51)
    expect(after.raw.dcaSchedule.find((s) => s.id === slot.id)).toMatchObject({ status: 'executed' })
    expect(after.raw.transactions.find((t) => t.securityId === qqqm)!.source).toBe('dca')
    expect(after.snapshot.portfolios.combined.costBasisBase).toBeCloseTo(after.snapshot.portfolios.main.costBasisBase + after.snapshot.portfolios.dca.costBasisBase, 4)
    expect(after.snapshot.securities.find((s) => s.id === qqqm)).toMatchObject({ heldDca: 0.25, heldMain: 0 })
    await expect(as(alice, (q) => dca.executeSchedule(q, alice.id, S.scheduleExecuteSchema.parse({ scheduleId: slot.id, tradeDate, quantity: 1, price: 1, fxRate: 36 })))).rejects.toThrow(/ไปแล้ว/)

    // deleting the purchase puts the slot back to "planned"
    const txId = after.raw.transactions.find((t) => t.securityId === qqqm)!.id
    await as(alice, (q) => pf.deleteTransaction(q, alice.id, txId))
    const reverted = await buildAppData(alice.id)
    expect(reverted.raw.dcaSchedule.find((s) => s.id === slot.id)).toMatchObject({ status: 'planned', transactionId: null })
    expect(reverted.snapshot.portfolios.dca.positions).toHaveLength(0)
  })

  it('the same security held in both portfolios appears once in the combined view', async () => {
    const d0 = await buildAppData(alice.id)
    const msft = d0.raw.securities.find((s) => s.symbol === 'MSFT')!.id
    await as(alice, (q) => pf.saveTransaction(q, alice.id, S.transactionSchema.parse({ portfolio: 'dca', type: 'buy', securityId: msft, tradeDate: daysAgo(3), quantity: 2, price: 100, fxRate: 37 })))
    const s = (await buildAppData(alice.id)).snapshot
    expect(s.portfolios.combined.positions.filter((p) => p.securityId === msft)).toHaveLength(1)
    expect(s.portfolios.combined.positions.find((p) => p.securityId === msft)!.quantity).toBe(20)
    expect(s.portfolios.main.positions.find((p) => p.securityId === msft)!.quantity).toBe(18)
    expect(s.portfolios.dca.positions.find((p) => p.securityId === msft)!.quantity).toBe(2)
  })
})

describe('9-10. money: income, expenses, debt, transfers', () => {
  let bank: string
  let reserve: string
  let broker: string

  it('accounts and balances', async () => {
    bank = (await as(bob, (q) => money.saveAccount(q, bob.id, S.accountSchema.parse({ name: 'KBank', type: 'bank', openingBalance: 50000, openingDate: daysAgo(90) })))).id
    reserve = (await as(bob, (q) => money.saveAccount(q, bob.id, S.accountSchema.parse({ name: 'เงินสำรอง', type: 'bank', purpose: 'emergency', openingBalance: 20000, openingDate: daysAgo(90) })))).id
    broker = (await as(bob, (q) => money.saveAccount(q, bob.id, S.accountSchema.parse({ name: 'Broker USD', type: 'brokerage', currency: 'usd', openingBalance: 0, openingDate: daysAgo(90) })))).id
    const s = (await buildAppData(bob.id)).snapshot
    expect(s.cash).toMatchObject({ totalCashBase: 70000, generalCashBase: 50000, emergencyFundBase: 20000 })
  })

  it('received income, paid expenses and debt payments change cash; expected and unpaid ones do not', async () => {
    await as(bob, (q) => money.saveIncome(q, bob.id, S.incomeSchema.parse({ accountId: bank, date: today, type: 'salary', source: 'ACME', amount: 40000, status: 'received' })))
    await as(bob, (q) => money.saveIncome(q, bob.id, S.incomeSchema.parse({ accountId: bank, date: today, type: 'bonus', amount: 10000, status: 'expected' })))
    await as(bob, (q) => money.saveExpense(q, bob.id, S.expenseSchema.parse({ accountId: bank, date: today, category: 'ค่าอาหาร', amount: 2500, status: 'paid', isEssential: true })))
    await as(bob, (q) => money.saveExpense(q, bob.id, S.expenseSchema.parse({ accountId: bank, date: today, category: 'ค่าที่พัก', amount: 9000, status: 'unpaid', isEssential: true })))
    const loan = (await as(bob, (q) => money.saveLiability(q, bob.id, S.liabilitySchema.parse({ name: 'บัตรเครดิต', kind: 'credit_card', openingBalance: 30000, openingDate: today, annualRate: 0, minPayment: 3000, dueDay: 28 })))).id
    await as(bob, (q) => money.saveDebtPayment(q, bob.id, S.debtPaymentSchema.parse({ liabilityId: loan, accountId: bank, date: today, amount: 5000 })))

    const s = (await buildAppData(bob.id)).snapshot
    // 50,000 + 40,000 - 2,500 - 5,000
    expect(s.accounts.find((a) => a.id === bank)!.balance).toBe(82500)
    expect(s.income).toEqual({ receivedThisMonth: 40000, expectedThisMonth: 10000 })
    expect(s.expenses.paidThisMonth).toBe(2500)
    expect(s.expenses.unpaidDue).toBe(9000)
    expect(s.debt.total).toBe(25000)
    expect(s.debt.paidThisMonth).toBe(5000)
    // available = general cash - unpaid bills - minimum debt still owed (already paid 5,000 >= 3,000)
    expect(s.availableThisMonth).toBe(82500 - 9000)
    // net worth = cash - debt (no priced holdings)
    expect(s.netWorth.value).toBe(82500 + 20000 - 25000)
    expect(s.emergency).toMatchObject({ essentialMonthly: 11500, target: 69000, gap: 49000 })
    expect(s.alerts.some((a) => a.type === 'emergency_low')).toBe(true)
  })

  it('marking a bill paid moves cash on the paid date', async () => {
    const { raw } = await buildAppData(bob.id)
    const bill = raw.expenses.find((e) => e.status === 'unpaid')!
    await as(bob, (q) => money.setExpensePaid(q, bob.id, S.expensePaidSchema.parse({ id: bill.id, paid: true })))
    const s = (await buildAppData(bob.id)).snapshot
    expect(s.accounts.find((a) => a.id === bank)!.balance).toBe(73500)
    expect(s.expenses.unpaidDue).toBe(0)
    expect(s.expenses.paidThisMonth).toBe(11500)
  })

  it('transfers between own accounts are never income or expense (10)', async () => {
    const before = (await buildAppData(bob.id)).snapshot
    await as(bob, (q) => money.saveTransfer(q, bob.id, S.transferSchema.parse({ fromAccountId: bank, toAccountId: reserve, date: today, amountFrom: 10000, kind: 'emergency_allocation' })))
    const after = (await buildAppData(bob.id)).snapshot
    expect(after.cash.totalCashBase).toBe(before.cash.totalCashBase)
    expect(after.cash.emergencyFundBase).toBe(30000)
    expect(after.cash.generalCashBase).toBe(63500)
    expect(after.income.receivedThisMonth).toBe(before.income.receivedThisMonth)
    expect(after.expenses.paidThisMonth).toBe(before.expenses.paidThisMonth)
    expect(after.netWorth.value).toBe(before.netWorth.value)
  })

  it('cross-currency funding + a purchase settled from the broker account is counted once (16)', async () => {
    await sys.query(`insert into exchange_rates (base, quote, rate_date, rate, source) values ('USD', 'THB', $1, 37, 'test') on conflict do nothing`, [today])
    await expect(as(bob, (q) => money.saveTransfer(q, bob.id, S.transferSchema.parse({ fromAccountId: bank, toAccountId: broker, date: today, amountFrom: 37000 })))).rejects.toThrow(/ต่างสกุลเงิน/)
    await as(bob, (q) => money.saveTransfer(q, bob.id, S.transferSchema.parse({ fromAccountId: bank, toAccountId: broker, date: today, amountFrom: 37000, amountTo: 1000, kind: 'investment_funding' })))
    const v = (await as(bob, (q) => pf.saveSecurity(q, bob.id, S.securitySchema.parse({ symbol: 'V', exchange: 'NYSE', name: 'Visa', category: 'Banking' })))).id
    await as(bob, (q) => pf.saveTransaction(q, bob.id, S.transactionSchema.parse({ portfolio: 'main', type: 'buy', securityId: v, accountId: broker, tradeDate: today, quantity: 2, price: 300, fee: 1, fxRate: 37 })))
    await as(bob, (q) => pf.setManualPrice(q, bob.id, S.manualPriceSchema.parse({ securityId: v, price: 300 })))
    const s = (await buildAppData(bob.id)).snapshot
    expect(s.accounts.find((a) => a.id === broker)!.balance).toBe(399) // 1000 - 601 USD
    expect(s.accounts.find((a) => a.id === bank)!.balance).toBe(26500)
    expect(s.cash.brokerageCashBase).toBe(399 * 37)
    expect(s.portfolios.main.marketValueBase).toBe(600 * 37)
    // the purchase is not an expense
    expect(s.expenses.paidThisMonth).toBe(11500)
    // net worth moved only by the 1 USD commission
    expect(s.netWorth.value).toBe(26500 + 30000 + 399 * 37 + 600 * 37 - 25000)
    // before the purchase: 63,500 + 30,000 - 25,000 = 68,500
    expect(s.netWorth.value).toBe(68500 - 37)
  })

  it('income/expense in baht cannot be posted to a foreign-currency account', async () => {
    await expect(as(bob, (q) => money.saveIncome(q, bob.id, S.incomeSchema.parse({ accountId: broker, date: today, type: 'other', amount: 1, status: 'received' })))).rejects.toThrow(/สกุล/)
  })

  it('an account with records cannot be deleted', async () => {
    const e = await as(bob, (q) => money.deleteAccount(q, bob.id, bank)).catch((x) => x)
    expect(e.code).toBe('23503')
  })

  it('recurring expenses become unpaid bills exactly once', async () => {
    await as(bob, (q) => money.saveRecurring(q, bob.id, S.recurringSchema.parse({ name: 'Netflix', category: 'ค่าสมาชิก', amount: 419, frequency: 'monthly', nextDueDate: today })))
    const first = await buildAppData(bob.id)
    const second = await buildAppData(bob.id)
    const bills = (d: typeof first) => d.raw.expenses.filter((e) => e.description === 'Netflix')
    expect(bills(first)).toHaveLength(1)
    expect(bills(second)).toHaveLength(1)
    expect(bills(first)[0]).toMatchObject({ status: 'unpaid', amount: 419, date: today })
    expect(second.snapshot.alerts.some((a) => a.type === 'bill_due')).toBe(true)
  })

  it('a monthly allocation plan cannot be confirmed when it exceeds the money received', async () => {
    const { snapshot } = await buildAppData(bob.id)
    const over = S.allocationPlanSchema.parse({ month: snapshot.month, basis: 'received', items: [{ key: 'other_invest', mode: 'amount', value: 999999 }], confirm: true })
    await expect(as(bob, (q) => money.saveAllocationPlan(q, bob.id, over, snapshot))).rejects.toThrow(/เกินเงินที่มี/)
    const ok = S.allocationPlanSchema.parse({ month: snapshot.month, basis: 'received', items: [{ key: 'emergency', mode: 'percent', value: 10 }], confirm: true })
    const saved = await as(bob, (q) => money.saveAllocationPlan(q, bob.id, ok, snapshot))
    expect(saved.status).toBe('confirmed')
    expect(saved.result.rows.find((r) => r.key === 'emergency')!.amount).toBe(4000)
    expect((await buildAppData(bob.id)).raw.allocationPlans[0]).toMatchObject({ status: 'confirmed', basisAmount: 40000 })
  })
})

describe('15. import and export', () => {
  const csv = toCsv(
    ['date', 'type', 'symbol', 'exchange', 'quantity', 'price', 'amount', 'fee', 'fx_rate', 'split_ratio', 'note'],
    [
      [daysAgo(50), 'buy', 'CPALL', 'SET', 100, 60, '', 10, '', '', 'lot 1'],
      [daysAgo(45), 'buy', 'CPALL', 'SET', 100, 62, '', 10, '', '', 'lot 2'],
      [daysAgo(40), 'dividend', 'CPALL', 'SET', '', '', 150, 15, '', '', ''],
      [daysAgo(45), 'buy', 'CPALL', 'SET', 100, 62, '', 10, '', '', 'same line again'],
    ],
  )

  it('preview flags duplicates inside the file and creates nothing', async () => {
    const p = await as(bob, (q) => pf.previewImport(q, { csv, portfolio: 'main' }))
    expect(p.counts).toEqual({ new: 3, duplicate: 1, error: 0 })
    expect(p.rows[0].createsSecurity).toBe(true)
    expect((await buildAppData(bob.id)).raw.securities.some((s) => s.symbol === 'CPALL')).toBe(false)
  })

  it('commit imports the new rows; importing the same file again imports nothing', async () => {
    const r = await as(bob, (q) => pf.commitImport(q, bob.id, { csv, portfolio: 'main', accountId: null }))
    expect(r).toMatchObject({ imported: 3, skippedDuplicates: 1, createdSecurities: ['CPALL'] })
    const d = await buildAppData(bob.id)
    const cpall = d.raw.securities.find((s) => s.symbol === 'CPALL')!
    const pos = d.snapshot.portfolios.main.positions.find((p) => p.securityId === cpall.id)!
    expect(pos.quantity).toBe(200)
    expect(pos.costBasis).toBe(12220)
    expect(pos.dividendsNet).toBe(135)
    const again = await as(bob, (q) => pf.previewImport(q, { csv, portfolio: 'main' }))
    expect(again.counts).toEqual({ new: 0, duplicate: 4, error: 0 })
    await expect(as(bob, (q) => pf.commitImport(q, bob.id, { csv, portfolio: 'main', accountId: null }))).rejects.toThrow(/ไม่มีรายการใหม่/)
  })

  it('a bad row aborts the whole import', async () => {
    const bad = toCsv(['date', 'type', 'symbol', 'exchange', 'quantity', 'price'], [[daysAgo(3), 'buy', 'BBL', 'SET', 10, 150], [daysAgo(2), 'sell', 'BBL', 'SET', 50, 150], ['2026-13-40', 'buy', 'BBL', 'SET', 1, 1]])
    await expect(as(bob, (q) => pf.commitImport(q, bob.id, { csv: bad, portfolio: 'main', accountId: null }))).rejects.toThrow(/ผิดพลาด/)
    const oversell = toCsv(['date', 'type', 'symbol', 'exchange', 'quantity', 'price'], [[daysAgo(3), 'buy', 'BBL', 'SET', 10, 150], [daysAgo(2), 'sell', 'BBL', 'SET', 50, 150]])
    await expect(as(bob, (q) => pf.commitImport(q, bob.id, { csv: oversell, portfolio: 'main', accountId: null }))).rejects.toThrow(/ขายเกิน/)
    expect((await buildAppData(bob.id)).raw.securities.some((s) => s.symbol === 'BBL')).toBe(false)
  })

  it("the JSON export contains the user's own records only", async () => {
    const out = await as(bob, (q) => settings.exportAll(q, bob.email))
    expect(out.format).toBe('sinsap-export')
    expect((out.transactions as unknown[]).length).toBe((await buildAppData(bob.id)).raw.transactions.length)
    const text = JSON.stringify(out)
    expect(text).toContain('CPALL')
    expect(text).not.toContain('Microsoft') // Alice's security
    expect(text).not.toContain('password')
  })
})

describe('13. market data: cache, rate limit and failure handling', () => {
  const okQuote = { symbol: 'V', currency: 'USD', datetime: daysAgo(1), timestamp: 1791898200, open: '300.1', high: '305', low: '299', close: '303.25', volume: '1000', previous_close: '300.00', change: '3.25', percent_change: '1.0833', is_market_open: false }
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('stores a provider quote with its type and both timestamps, then keeps it when the provider fails', async () => {
    vi.stubEnv('TWELVEDATA_API_KEY', 'test-key')
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => respond(okQuote))
    vi.stubGlobal('fetch', fetchMock)
    const ref = { symbol: 'V', exchange: 'NYSE' }

    const first = await refreshQuotes([ref], { force: true })
    expect(first.refreshed).toEqual(['V'])
    const q1 = (await getStoredQuotes([ref])).get('NYSE:V')!
    expect(q1).toMatchObject({ price: 303.25, prevClose: 300, dataType: 'eod', source: 'twelvedata' })
    expect(Date.parse(q1.asOf)).toBeLessThan(Date.parse(q1.fetchedAt))
    expect(String(fetchMock.mock.calls[0][0])).toContain('apikey=test-key')

    // the value now comes from the provider quote where it is newer than the manual price
    const s1 = (await buildAppData(bob.id)).snapshot
    expect(s1.securities.find((x) => x.symbol === 'V')!.price?.dataType).toBe('manual') // manual price was entered today: newer than yesterday's close

    // provider goes down
    fetchMock.mockImplementation(async () => respond({ code: 500, message: 'Internal error', status: 'error' }, 500))
    const second = await refreshQuotes([ref], { force: true })
    expect(second.refreshed).toEqual([])
    expect(second.errors[0].message).toMatch(/Twelve Data/)
    const q2 = (await getStoredQuotes([ref])).get('NYSE:V')!
    expect(q2.price).toBe(303.25) // old quote kept ...
    expect(q2.fetchedAt).toBe(q1.fetchedAt) // ... and NOT re-stamped as fresh
    const status = (await marketDataStatus()).find((p) => p.market === 'US')!
    expect(status.lastError?.message).toMatch(/Twelve Data/)
    const alerts = (await buildAppData(bob.id)).snapshot.alerts
    expect(alerts.some((a) => a.type === 'market_api' && a.severity === 'warning')).toBe(true)
  })

  it('stops calling the provider once the configured quota is used up', async () => {
    vi.stubEnv('TWELVEDATA_PER_MINUTE', '3')
    const fetchMock = vi.fn(async () => respond(okQuote))
    vi.stubGlobal('fetch', fetchMock)
    const refs = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map((symbol) => ({ symbol, exchange: 'NYSE' }))
    const used = (await marketDataStatus()).find((p) => p.market === 'US')!.usage!.lastMinute
    const r = await refreshQuotes(refs, { force: true })
    expect(r.refreshed.length).toBe(Math.max(0, 3 - used))
    expect(r.skippedQuota.length).toBe(5 - r.refreshed.length)
    expect(fetchMock.mock.calls.length).toBe(r.refreshed.length)
  })

  it('an old-dated FX rate fetched recently (historical lookup) does not count as the latest rate', async () => {
    await sys.query(`insert into exchange_rates (base, quote, rate_date, rate, source) values ('EUR', 'THB', $1, 38, 'frankfurter')`, [daysAgo(30)])
    const fx = vi.fn(async () => respond([{ date: today, base: 'EUR', quote: 'THB', rate: 39.5 }]))
    const r = await refreshFx(['EUR'], 'THB', { fetcher: fx as unknown as typeof fetch })
    expect(r.refreshed).toEqual(['EUR'])
    expect(fx).toHaveBeenCalledTimes(1)
    expect((await getLatestRates(['EUR'], 'THB')).EUR).toMatchObject({ rate: 39.5, date: today })
    // now it is current: no second call
    await refreshFx(['EUR'], 'THB', { fetcher: fx as unknown as typeof fetch })
    expect(fx).toHaveBeenCalledTimes(1)
  })

  it('without an API key nothing is fetched and nothing is invented', async () => {
    vi.unstubAllEnvs()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const r = await refreshQuotes([{ symbol: 'ZZZ', exchange: 'SET' }], { force: true })
    expect(r.noProvider).toEqual(['TH'])
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await getStoredQuotes([{ symbol: 'ZZZ', exchange: 'SET' }])).size).toBe(0)
    vi.unstubAllGlobals()
  })
})

describe('14. persistence', () => {
  it('data written to a file-backed database is still there after closing and reopening it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinsap-pg-'))
    const { PGlite } = await import('@electric-sql/pglite')
    const open = async () => {
      const db = new PGlite({ dataDir: dir })
      await db.waitReady
      return db
    }
    let db = await open()
    await db.exec('create table t (v text)')
    await db.query('insert into t values ($1)', ['kept'])
    await db.close()
    db = await open()
    expect((await db.query<{ v: string }>('select v from t')).rows).toEqual([{ v: 'kept' }])
    await db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('migrations are idempotent', async () => {
    const driver = await createTestDriver()
    expect(await runMigrations(driver)).toEqual([])
    await driver.close()
  })
})
