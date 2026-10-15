/**
 * Growth simulator. A MODEL under fixed assumptions, never a forecast or a guarantee.
 *
 * Monthly compounding with contributions at the END of each month:
 *   r  = (1 + R)^(1/12) - 1
 *   FV = P(1+r)^n + C x [((1+r)^n - 1) / r]         (r = 0  ->  FV = P + C x n)
 *
 * R (effective annual growth of the invested balance) is assembled so that
 * nothing is counted twice:
 *   R = (1 + price return + reinvested dividend yield) x (1 - annual fee) x (1 + fx change) - 1
 * Dividends that are NOT reinvested do not compound; they are paid out and
 * reported separately as cash, and are not part of the portfolio value.
 * If the return figure you enter is already a total return, set dividend yield to 0.
 */
import { round } from './money'

export interface GrowthInput {
  initial: number
  monthly: number
  years: number
  /** annual price return, % */
  annualReturnPct: number
  /** annual fee on assets, % */
  feePct: number
  inflationPct: number
  dividendYieldPct: number
  reinvestDividends: boolean
  /** yearly increase of the monthly contribution, % (0 = fixed DCA) */
  stepUpPct: number
  /** assumed yearly change of the foreign currency against the base currency, % */
  fxChangePct: number
  /** stop contributing after this many years (null = contribute to the end) */
  stopAfterYears?: number | null
}

export function monthlyRate(annualPct: number): number {
  return Math.pow(1 + annualPct / 100, 1 / 12) - 1
}

/** Effective annual growth rate of the invested balance, in %. */
export function effectiveAnnualPct(i: Pick<GrowthInput, 'annualReturnPct' | 'feePct' | 'dividendYieldPct' | 'reinvestDividends' | 'fxChangePct'>): number {
  const gross = i.annualReturnPct + (i.reinvestDividends ? i.dividendYieldPct : 0)
  return ((1 + gross / 100) * (1 - i.feePct / 100) * (1 + i.fxChangePct / 100) - 1) * 100
}

/** Closed-form future value (level contributions at month end). */
export function futureValue(principal: number, monthly: number, annualPct: number, months: number): number {
  const r = monthlyRate(annualPct)
  if (Math.abs(r) < 1e-12) return principal + monthly * months
  const g = Math.pow(1 + r, months)
  return principal * g + monthly * ((g - 1) / r)
}

export interface GrowthYear {
  year: number
  /** initial + all contributions so far */
  contributed: number
  value: number
  /** value - contributed */
  gain: number
  /** value in today's money */
  realValue: number
  /** cumulative dividends paid out as cash (only when not reinvesting) */
  dividendsPaidOut: number
  monthlyContribution: number
}

export interface GrowthResult {
  rows: GrowthYear[]
  initial: number
  contributed: number
  finalValue: number
  gain: number
  realValue: number
  dividendsPaidOut: number
  effectiveAnnualPct: number
}

export function simulateGrowth(input: GrowthInput): GrowthResult {
  const years = Math.max(0, Math.min(100, Math.floor(input.years)))
  const eff = effectiveAnnualPct(input)
  const r = monthlyRate(eff)
  const divMonthly = input.reinvestDividends ? 0 : input.dividendYieldPct / 100 / 12
  let value = input.initial
  let contributed = input.initial
  let dividends = 0
  let monthly = input.monthly
  const rows: GrowthYear[] = [
    { year: 0, contributed: round(contributed), value: round(value), gain: 0, realValue: round(value), dividendsPaidOut: 0, monthlyContribution: round(monthly) },
  ]
  for (let y = 1; y <= years; y++) {
    const contributing = input.stopAfterYears == null || y <= input.stopAfterYears
    if (y > 1 && contributing) monthly *= 1 + input.stepUpPct / 100
    const c = contributing ? monthly : 0
    for (let m = 0; m < 12; m++) {
      dividends += value * divMonthly
      value = value * (1 + r) + c
      contributed += c
    }
    rows.push({
      year: y,
      contributed: round(contributed),
      value: round(value),
      gain: round(value - contributed),
      realValue: round(value / Math.pow(1 + input.inflationPct / 100, y)),
      dividendsPaidOut: round(dividends),
      monthlyContribution: round(c),
    })
  }
  const last = rows[rows.length - 1]
  return {
    rows,
    initial: round(input.initial),
    contributed: last.contributed,
    finalValue: last.value,
    gain: last.gain,
    realValue: last.realValue,
    dividendsPaidOut: last.dividendsPaidOut,
    effectiveAnnualPct: eff,
  }
}

export interface ScenarioSet {
  low: GrowthResult
  base: GrowthResult
  high: GrowthResult
}

/** Low / base / high cases: the same plan with the annual return shifted by -spread / 0 / +spread points. */
export function simulateScenarios(input: GrowthInput, spreadPct: number): ScenarioSet {
  return {
    low: simulateGrowth({ ...input, annualReturnPct: input.annualReturnPct - spreadPct }),
    base: simulateGrowth(input),
    high: simulateGrowth({ ...input, annualReturnPct: input.annualReturnPct + spreadPct }),
  }
}
