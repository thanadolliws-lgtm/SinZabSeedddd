import { describe, expect, it } from 'vitest'
import { buildPositions, mergePositions, txCashEffect, validateLedger, valuePositions, type LedgerTx, type PriceInfo } from '@/lib/calc/portfolio'

let seq = 0
function tx(p: Partial<LedgerTx> & Pick<LedgerTx, 'type' | 'tradeDate'>): LedgerTx {
  seq++
  const quantity = p.quantity ?? null
  const price = p.price ?? null
  return {
    id: `t${String(seq).padStart(4, '0')}`,
    portfolioId: 'main',
    securityId: 'MSFT',
    accountId: null,
    createdAt: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    quantity,
    price,
    amount: p.amount ?? (quantity !== null && price !== null ? quantity * price : 0),
    fee: 0,
    splitRatio: null,
    currency: 'USD',
    fxRate: 35,
    source: 'manual',
    ...p,
  }
}
const price = (p: number, stale = false): PriceInfo => ({ price: p, prevClose: null, asOf: '2026-10-13T20:00:00.000Z', fetchedAt: '2026-10-14T01:00:00.000Z', dataType: 'eod', source: 'test', stale })
const only = (txs: LedgerTx[]) => [...buildPositions(txs).values()][0]

describe('weighted average cost', () => {
  const buys = [
    tx({ type: 'buy', tradeDate: '2026-01-05', quantity: 10, price: 100, fee: 5 }),
    tx({ type: 'buy', tradeDate: '2026-02-05', quantity: 20, price: 130, fee: 5 }),
  ]

  it('averages several buys at different prices, fees included in cost', () => {
    const p = only(buys)
    expect(p.quantity).toBe(30)
    expect(p.costBasis).toBe(3610) // 1000 + 5 + 2600 + 5
    expect(p.avgCost).toBeCloseTo(120.333333, 6)
    expect(p.costBasisBase).toBe(3610 * 35)
    expect(p.buyFees).toBe(10)
  })

  it('partial sell keeps the average cost and books realised P/L', () => {
    const p = only([...buys, tx({ type: 'sell', tradeDate: '2026-03-01', quantity: 12, price: 150, fee: 6, fxRate: 36 })])
    expect(p.quantity).toBe(18)
    expect(p.costBasis).toBe(2166) // 3610 * 18/30
    expect(p.avgCost).toBeCloseTo(120.333333, 6)
    // proceeds 12*150 - 6 = 1794 ; cost out 3610 * 12/30 = 1444
    expect(p.realizedPnl).toBe(350)
    // base: proceeds 1794*36 = 64584 ; cost out 126350 * 0.4 = 50540
    expect(p.realizedPnlBase).toBe(14044)
    expect(p.costBasisBase).toBe(75810)
  })

  it('selling everything leaves exactly zero quantity and zero cost', () => {
    const p = only([
      ...buys,
      tx({ type: 'sell', tradeDate: '2026-03-01', quantity: 12, price: 150 }),
      tx({ type: 'sell', tradeDate: '2026-04-01', quantity: 18, price: 110 }),
    ])
    expect(p.quantity).toBe(0)
    expect(p.costBasis).toBe(0)
    expect(p.costBasisBase).toBe(0)
    expect(p.avgCost).toBeNull()
    // total proceeds 1800 + 1980 = 3780 ; total cost 3610
    expect(p.realizedPnl).toBe(170)
  })

  it('fractional shares do not leave dust after a full sell', () => {
    const p = only([
      tx({ type: 'buy', tradeDate: '2026-01-05', quantity: 0.1, price: 333.33 }),
      tx({ type: 'buy', tradeDate: '2026-01-06', quantity: 0.2, price: 111.11 }),
      tx({ type: 'sell', tradeDate: '2026-01-07', quantity: 0.3, price: 200 }),
    ])
    expect(p.quantity).toBe(0)
    expect(p.costBasis).toBe(0)
  })

  it('rejects selling more than is held at that point in time', () => {
    const ledger = [tx({ type: 'sell', tradeDate: '2026-01-01', quantity: 5, price: 100 }), ...buys]
    expect(validateLedger(ledger)).toMatch(/ขายเกิน/)
    expect(validateLedger(buys)).toBeNull()
  })

  it('order is by trade date, not by insertion order', () => {
    const late = tx({ type: 'sell', tradeDate: '2026-03-01', quantity: 30, price: 100 })
    expect(validateLedger([late, ...buys])).toBeNull()
  })
})

describe('corporate actions, dividends and fees', () => {
  it('a 4-for-1 split multiplies shares and leaves total cost unchanged', () => {
    const p = only([tx({ type: 'buy', tradeDate: '2026-01-05', quantity: 10, price: 400 }), tx({ type: 'split', tradeDate: '2026-02-01', splitRatio: 4 })])
    expect(p.quantity).toBe(40)
    expect(p.costBasis).toBe(4000)
    expect(p.avgCost).toBe(100)
  })

  it('a reverse split (1-for-10) divides shares', () => {
    const p = only([tx({ type: 'buy', tradeDate: '2026-01-05', quantity: 100, price: 2 }), tx({ type: 'split', tradeDate: '2026-02-01', splitRatio: 0.1 })])
    expect(p.quantity).toBe(10)
    expect(p.avgCost).toBe(20)
  })

  it('dividends and standalone fees are kept apart from price P/L', () => {
    const p = only([
      tx({ type: 'buy', tradeDate: '2026-01-05', quantity: 10, price: 100 }),
      tx({ type: 'dividend', tradeDate: '2026-03-05', amount: 20, fee: 3 }),
      tx({ type: 'fee', tradeDate: '2026-03-06', amount: 2 }),
    ])
    expect(p.costBasis).toBe(1000)
    expect(p.realizedPnl).toBe(0)
    expect(p.dividendsGross).toBe(20)
    expect(p.dividendsNet).toBe(17)
    expect(p.dividendsNetBase).toBe(17 * 35)
    expect(p.otherFees).toBe(2)
  })

  it('adjustment changes shares and cost by signed deltas', () => {
    const p = only([tx({ type: 'buy', tradeDate: '2026-01-05', quantity: 10, price: 100 }), tx({ type: 'adjustment', tradeDate: '2026-02-01', quantity: 1, amount: 0 })])
    expect(p.quantity).toBe(11)
    expect(p.costBasis).toBe(1000)
  })
})

describe('valuation', () => {
  const buys = [tx({ type: 'buy', tradeDate: '2026-01-05', quantity: 10, price: 100, fxRate: 35 })]

  it('market value, P/L and % in native and base currency', () => {
    const s = valuePositions([...buildPositions(buys).values()], new Map([['MSFT', price(120)]]), () => 36)
    const p = s.positions[0]
    expect(p.marketValue).toBe(1200)
    expect(p.unrealizedPnl).toBe(200)
    expect(p.unrealizedPct).toBeCloseTo(20, 9)
    expect(p.marketValueBase).toBe(43200) // 1200 * 36
    expect(p.unrealizedPnlBase).toBe(8200) // 43200 - 35000 : price gain + currency gain
    expect(p.unrealizedPctBase).toBeCloseTo(23.428571, 5)
    expect(p.weight).toBe(100)
    expect(p.status).toBe('profit')
    expect(s.complete).toBe(true)
    expect(s.totalReturnBase).toBe(8200)
  })

  it('a missing price is reported, not guessed', () => {
    const txs = [...buys, tx({ type: 'buy', tradeDate: '2026-01-06', securityId: 'KO', quantity: 5, price: 60 })]
    const s = valuePositions([...buildPositions(txs).values()], new Map([['MSFT', price(120)]]), () => 36)
    expect(s.complete).toBe(false)
    expect(s.missingPrice).toEqual(['KO'])
    expect(s.marketValueBase).toBe(43200)
    expect(s.costBasisBase).toBe(35000 + 300 * 35)
    // P/L only over what could be valued
    expect(s.unrealizedPnlBase).toBe(8200)
    expect(s.positions.find((p) => p.securityId === 'KO')!.status).toBe('no_price')
  })

  it('a missing FX rate is reported', () => {
    const s = valuePositions([...buildPositions(buys).values()], new Map([['MSFT', price(120)]]), () => null)
    expect(s.complete).toBe(false)
    expect(s.missingFx).toEqual(['MSFT'])
    expect(s.positions[0].status).toBe('no_fx')
    expect(s.positions[0].marketValue).toBe(1200)
    expect(s.positions[0].marketValueBase).toBeNull()
  })

  it('an empty portfolio is complete and worth zero', () => {
    const s = valuePositions([], new Map(), () => 1)
    expect(s.marketValueBase).toBe(0)
    expect(s.unrealizedPnlBase).toBe(0)
    expect(s.complete).toBe(true)
  })

  it('a fully sold position is closed, not listed as a holding', () => {
    const txs = [...buys, tx({ type: 'sell', tradeDate: '2026-02-01', quantity: 10, price: 90, fxRate: 35 })]
    const s = valuePositions([...buildPositions(txs).values()], new Map(), () => 36)
    expect(s.positions).toHaveLength(0)
    expect(s.closedPositions).toHaveLength(1)
    expect(s.realizedPnlBase).toBe(-3500)
    expect(s.complete).toBe(true)
  })
})

describe('combined view', () => {
  it('the same security in two portfolios is merged into one row', () => {
    const txs = [
      tx({ type: 'buy', tradeDate: '2026-01-05', portfolioId: 'main', quantity: 10, price: 100 }),
      tx({ type: 'buy', tradeDate: '2026-01-06', portfolioId: 'dca', quantity: 5, price: 130 }),
    ]
    const all = [...buildPositions(txs).values()]
    expect(all).toHaveLength(2)
    const merged = mergePositions(all)
    expect(merged).toHaveLength(1)
    expect(merged[0].quantity).toBe(15)
    expect(merged[0].costBasis).toBe(1650)
    expect(merged[0].avgCost).toBe(110)
  })
})

describe('cash effect of a trade', () => {
  const buy = tx({ type: 'buy', tradeDate: '2026-01-05', quantity: 10, price: 100, fee: 5, fxRate: 35 })
  it('same-currency account', () => expect(txCashEffect(buy, 'USD', 'THB')).toBe(-1005))
  it('base-currency account converts at the trade FX rate', () => expect(txCashEffect(buy, 'THB', 'THB')).toBe(-35175))
  it('unrelated currency cannot be converted', () => expect(txCashEffect(buy, 'EUR', 'THB')).toBeNull())
  it('splits have no cash effect', () => expect(txCashEffect(tx({ type: 'split', tradeDate: '2026-01-05', splitRatio: 2 }), 'USD', 'THB')).toBe(0))
})
