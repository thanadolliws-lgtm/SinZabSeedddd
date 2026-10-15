import { describe, expect, it } from 'vitest'
import { addMonths, dateInMonth, daysBetween, isValidDate, isoWeekday, monthEnd, monthRange, round, splitAmount, sum, todayInTz } from '@/lib/calc/money'
import { allocateBudget, buildSchedule, businessDays, checkAllocations, estimateFee, monthlyEquivalent, planDates, type DcaPlanRow } from '@/lib/calc/dca'
import { effectiveAnnualPct, futureValue, monthlyRate, simulateGrowth, simulateScenarios, type GrowthInput } from '@/lib/calc/growth'
import { allocationAdvice, computeAllocation, defaultAllocationItems, type AllocationAuto } from '@/lib/calc/allocation'

describe('rounding and dates', () => {
  it('rounds half away from zero despite binary representation', () => {
    expect(round(1.005, 2)).toBe(1.01)
    expect(round(-1.005, 2)).toBe(-1.01)
    expect(round(2.675, 2)).toBe(2.68)
    expect(round(0.1 + 0.2, 2)).toBe(0.3)
    expect(Object.is(round(-0.0001, 2), 0)).toBe(true)
  })
  it('month helpers', () => {
    expect(monthEnd('2024-02')).toBe('2024-02-29')
    expect(monthEnd('2026-02')).toBe('2026-02-28')
    expect(addMonths('2026-11', 3)).toBe('2027-02')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(dateInMonth('2026-02', 31)).toBe('2026-02-28')
    expect(monthRange('2026-11', '2027-01')).toEqual(['2026-11', '2026-12', '2027-01'])
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30)
    expect(isoWeekday('2026-10-14')).toBe(3) // Wednesday
    expect(isValidDate('2026-02-30')).toBe(false)
    expect(isValidDate('2026-02-28')).toBe(true)
  })
  it('today is evaluated in the given timezone', () => {
    // 2026-10-13 18:30 UTC is already 2026-10-14 in Bangkok
    expect(todayInTz('Asia/Bangkok', new Date('2026-10-13T18:30:00Z'))).toBe('2026-10-14')
    expect(todayInTz('America/New_York', new Date('2026-10-13T18:30:00Z'))).toBe('2026-10-13')
  })
})

describe('DCA allocation', () => {
  const allocs = [
    { securityId: 'QQQM', targetPct: 25 },
    { securityId: 'SCHD', targetPct: 20 },
    { securityId: 'MSFT', targetPct: 15 },
    { securityId: 'V', targetPct: 15 },
    { securityId: 'SCHG', targetPct: 10 },
    { securityId: 'KO', targetPct: 8 },
    { securityId: 'MCD', targetPct: 7 },
  ]
  const plan: DcaPlanRow = {
    id: 'p1',
    name: 'Core',
    portfolioId: 'dca',
    budgetAmount: 3000,
    budgetCurrency: 'THB',
    frequency: 'monthly',
    investDay: 5,
    daysPerMonth: null,
    startDate: '2026-01-01',
    durationMonths: null,
    riskLevel: 'medium',
    objective: 'balanced',
    minInvestment: 0,
    feePct: 0,
    feeMin: 0,
    allowFractional: true,
    status: 'active',
  }

  it('3,000 baht across the example weights', () => {
    const out = allocateBudget(3000, allocs, plan)
    expect(out.map((a) => a.amount)).toEqual([750, 600, 450, 450, 300, 240, 210])
    expect(sum(out.map((a) => a.amount))).toBe(3000)
  })

  it('weights must total 100%', () => {
    expect(checkAllocations(allocs)).toMatchObject({ total: 100, ok: true })
    expect(checkAllocations(allocs.slice(0, 6))).toMatchObject({ total: 93, diff: 7, ok: false })
    expect(checkAllocations([])).toMatchObject({ ok: false })
    expect(checkAllocations([{ securityId: 'A', targetPct: 33.3333 }, { securityId: 'B', targetPct: 33.3333 }, { securityId: 'C', targetPct: 33.3334 }]).ok).toBe(true)
  })

  it('rounded parts always add up to the budget', () => {
    const thirds = splitAmount(100, [1, 1, 1])
    expect(thirds).toEqual([33.34, 33.33, 33.33])
    expect(round(sum(thirds), 2)).toBe(100)
    expect(round(sum(splitAmount(2999.99, [25, 20, 15, 15, 10, 8, 7])), 2)).toBe(2999.99)
    expect(splitAmount(100, [0, 0])).toEqual([0, 0])
  })

  it('monthly plan: one business day, moved off the weekend', () => {
    // 5 Sep 2026 is a Saturday -> Monday 7 Sep
    expect(planDates(plan, '2026-09')).toEqual(['2026-09-07'])
    expect(planDates(plan, '2026-10')).toEqual(['2026-10-05'])
    expect(planDates(plan, '2025-12')).toEqual([]) // before start
    expect(planDates({ ...plan, durationMonths: 2 }, '2026-03')).toEqual([])
  })

  it('3,000 baht spread over 20 days is 150 per day', () => {
    const daily: DcaPlanRow = { ...plan, frequency: 'daily', daysPerMonth: 20 }
    const s = buildSchedule(daily, allocs, '2026-10')
    expect(s.dates).toHaveLength(20)
    expect(new Set(s.dates).size).toBe(20)
    expect(s.perDateBudget.every((b) => b === 150)).toBe(true)
    expect(s.monthTotal).toBe(3000)
    expect(round(sum(s.items.map((i) => i.amount)), 2)).toBe(3000)
    // each day's 150 is split by the weights
    expect(s.items.filter((i) => i.date === s.dates[0]).map((i) => i.amount)).toEqual([37.5, 30, 22.5, 22.5, 15, 12, 10.5])
    expect(s.dates.every((d) => isoWeekday(d) <= 5)).toBe(true)
  })

  it('weekly plan invests the full budget each week', () => {
    const weekly: DcaPlanRow = { ...plan, frequency: 'weekly', investDay: 1, budgetAmount: 700 }
    const s = buildSchedule(weekly, allocs, '2026-10')
    expect(s.dates).toEqual(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'])
    expect(s.monthTotal).toBe(2800)
    expect(monthlyEquivalent(weekly)).toBe(3033.33)
  })

  it('warns about minimums and fee drag instead of hiding them', () => {
    const costly: DcaPlanRow = { ...plan, frequency: 'daily', daysPerMonth: 20, minInvestment: 50, feePct: 0.15, feeMin: 1 }
    const s = buildSchedule(costly, allocs, '2026-10')
    expect(s.warnings.some((w) => w.includes('ขั้นต่ำ'))).toBe(true)
    expect(s.warnings.some((w) => w.includes('ค่าธรรมเนียม'))).toBe(true)
    expect(estimateFee(37.5, 0.15, 1)).toBe(1)
    expect(estimateFee(10000, 0.15, 1)).toBe(15)
  })

  it('refuses to build a schedule when weights are not 100%', () => {
    const s = buildSchedule(plan, allocs.slice(0, 3), '2026-10')
    expect(s.items).toHaveLength(0)
    expect(s.warnings[0]).toMatch(/100%/)
  })

  it('business days are Monday to Friday', () => {
    expect(businessDays('2026-10')).toHaveLength(22)
    expect(businessDays('2026-02')).toHaveLength(20)
  })
})

describe('growth simulator', () => {
  const base: GrowthInput = {
    initial: 100_000,
    monthly: 5_000,
    years: 20,
    annualReturnPct: 8,
    feePct: 0,
    inflationPct: 0,
    dividendYieldPct: 0,
    reinvestDividends: true,
    stepUpPct: 0,
    fxChangePct: 0,
  }

  it('monthly rate compounds back to the annual rate', () => {
    expect(Math.pow(1 + monthlyRate(8), 12)).toBeCloseTo(1.08, 12)
    expect(monthlyRate(0)).toBe(0)
  })

  it('matches the closed-form future value', () => {
    const r = Math.pow(1.08, 1 / 12) - 1
    const n = 240
    const expected = 100_000 * Math.pow(1 + r, n) + 5_000 * ((Math.pow(1 + r, n) - 1) / r)
    expect(futureValue(100_000, 5_000, 8, n)).toBeCloseTo(expected, 6)
    expect(simulateGrowth(base).finalValue).toBeCloseTo(expected, 1)
    expect(simulateGrowth(base).contributed).toBe(100_000 + 5_000 * 240)
  })

  it('zero return is principal plus contributions', () => {
    expect(futureValue(1000, 100, 0, 12)).toBe(2200)
    const r = simulateGrowth({ ...base, annualReturnPct: 0 })
    expect(r.finalValue).toBe(100_000 + 5_000 * 240)
    expect(r.gain).toBe(0)
  })

  it('reinvested dividends are added once, not twice', () => {
    const withDiv = simulateGrowth({ ...base, annualReturnPct: 6, dividendYieldPct: 2, reinvestDividends: true })
    const total = simulateGrowth({ ...base, annualReturnPct: 8, dividendYieldPct: 0 })
    expect(withDiv.finalValue).toBeCloseTo(total.finalValue, 6)
    expect(withDiv.dividendsPaidOut).toBe(0)
  })

  it('dividends that are not reinvested are paid out and do not compound', () => {
    const out = simulateGrowth({ ...base, annualReturnPct: 6, dividendYieldPct: 2, reinvestDividends: false })
    const priceOnly = simulateGrowth({ ...base, annualReturnPct: 6 })
    expect(out.finalValue).toBeCloseTo(priceOnly.finalValue, 6)
    expect(out.dividendsPaidOut).toBeGreaterThan(0)
    const reinvested = simulateGrowth({ ...base, annualReturnPct: 6, dividendYieldPct: 2, reinvestDividends: true })
    expect(out.finalValue + out.dividendsPaidOut).toBeLessThan(reinvested.finalValue)
  })

  it('fees, inflation and FX are applied as documented', () => {
    expect(effectiveAnnualPct({ annualReturnPct: 8, feePct: 1, dividendYieldPct: 0, reinvestDividends: true, fxChangePct: 0 })).toBeCloseTo(6.92, 10)
    expect(effectiveAnnualPct({ annualReturnPct: 8, feePct: 0, dividendYieldPct: 0, reinvestDividends: true, fxChangePct: -2 })).toBeCloseTo(5.84, 10)
    const r = simulateGrowth({ ...base, inflationPct: 3 })
    expect(r.realValue).toBeCloseTo(r.finalValue / Math.pow(1.03, 20), 1)
    expect(simulateGrowth({ ...base, feePct: 1 }).finalValue).toBeLessThan(simulateGrowth(base).finalValue)
  })

  it('step-up raises the contribution each year; stopping DCA freezes it', () => {
    const step = simulateGrowth({ ...base, annualReturnPct: 0, stepUpPct: 10, years: 3 })
    expect(step.contributed).toBeCloseTo(100_000 + 12 * (5000 + 5500 + 6050), 2)
    const stop = simulateGrowth({ ...base, annualReturnPct: 0, stopAfterYears: 5 })
    expect(stop.contributed).toBe(100_000 + 5_000 * 60)
    expect(simulateGrowth({ ...base, stopAfterYears: 5 }).finalValue).toBeLessThan(simulateGrowth(base).finalValue)
  })

  it('low / base / high scenarios are ordered', () => {
    const s = simulateScenarios(base, 3)
    expect(s.low.finalValue).toBeLessThan(s.base.finalValue)
    expect(s.base.finalValue).toBeLessThan(s.high.finalValue)
    expect(s.low.contributed).toBe(s.high.contributed)
  })
})

describe('monthly allocation', () => {
  const auto: AllocationAuto = { essentials: 15000, debt_min: 3000, debt_extra: null, emergency: null, upcoming: 1200, goals: 2000, dca: 3000, other_invest: null }

  it('auto rows use recorded data and the remainder is basis minus allocations', () => {
    const r = computeAllocation(40000, defaultAllocationItems(), auto)
    expect(r.allocated).toBe(24200)
    expect(r.remaining).toBe(15800)
    expect(r.remainingPct).toBeCloseTo(39.5, 9)
    expect(r.rows.find((x) => x.key === 'essentials')!.pct).toBeCloseTo(37.5, 9)
    expect(r.overBudget).toBe(false)
  })

  it('percent and fixed-amount rows', () => {
    const items = defaultAllocationItems().map((i) => (i.key === 'emergency' ? { ...i, mode: 'percent' as const, value: 10 } : i.key === 'dca' ? { ...i, mode: 'amount' as const, value: 5000 } : i))
    const r = computeAllocation(40000, items, auto)
    expect(r.rows.find((x) => x.key === 'emergency')!.amount).toBe(4000)
    expect(r.rows.find((x) => x.key === 'dca')!.amount).toBe(5000)
    expect(r.allocated).toBe(15000 + 3000 + 4000 + 1200 + 2000 + 5000)
  })

  it('allocating more than the basis is flagged', () => {
    const items = defaultAllocationItems().map((i) => (i.key === 'other_invest' ? { ...i, mode: 'amount' as const, value: 20000 } : i))
    const r = computeAllocation(40000, items, auto)
    expect(r.overBudget).toBe(true)
    expect(r.remaining).toBe(-4200)
  })

  it('warns about debt and reserves before investing', () => {
    const advice = allocationAdvice({
      overdueDebt: 1500,
      highInterestDebts: [{ name: 'บัตรเครดิต', rate: 18, balance: 40000 }],
      highInterestThreshold: 15,
      emergencyGap: 50000,
      investing: 3000,
      basisIncludesExpected: false,
    })
    expect(advice[0].level).toBe('danger')
    expect(advice.map((a) => a.level)).toEqual(['danger', 'warning', 'warning', 'info'])
    expect(allocationAdvice({ overdueDebt: 0, highInterestDebts: [], highInterestThreshold: 15, emergencyGap: -100, investing: 3000, basisIncludesExpected: false })).toEqual([])
  })
})
