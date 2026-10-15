/**
 * Rule-based portfolio review.
 *
 * These are observations computed from the user's own records and the market
 * data on hand. They are prompts for the user's own judgement: nothing here
 * predicts prices, and nothing is executed automatically.
 * Every item states its reason, the data it used, its assumptions and its risks.
 */
import { EPS } from './money'
import type { Snapshot } from './snapshot'
import type { RawData } from './types'

export type RecommendationKind = 'fix_first' | 'reduce' | 'increase' | 'diversify' | 'hold' | 'info'

export const RECOMMENDATION_LABELS: Record<RecommendationKind, string> = {
  fix_first: 'ควรจัดการหนี้หรือเพิ่มเงินสำรองก่อนลงทุนเพิ่ม',
  reduce: 'พิจารณาลดสัดส่วน',
  increase: 'พิจารณาเพิ่มสัดส่วน',
  diversify: 'ศึกษาสินทรัพย์ประเภทอื่นเพิ่มเติม',
  hold: 'คงสัดส่วน',
  info: 'ข้อสังเกต',
}

export interface Recommendation {
  kind: RecommendationKind
  title: string
  reason: string
  data: string[]
  assumptions: string[]
  risks: string[]
}

export interface WeightSlice {
  key: string
  label: string
  valueBase: number
  weight: number
}

export interface CorrelationPair {
  a: string
  b: string
  correlation: number
  observations: number
}

export interface Analysis {
  recommendations: Recommendation[]
  byPosition: WeightSlice[]
  byCategory: WeightSlice[]
  byCurrency: WeightSlice[]
  byGroup: WeightSlice[]
  feeRatioPct: number | null
  correlations: CorrelationPair[]
  correlationNote: string
  complete: boolean
}

/** Pearson correlation of daily returns on the dates both series have. */
export function returnCorrelation(a: Record<string, number>, b: Record<string, number>): { correlation: number; observations: number } | null {
  const dates = Object.keys(a).filter((d) => d in b).sort()
  const ra: number[] = []
  const rb: number[] = []
  for (let i = 1; i < dates.length; i++) {
    const pa = a[dates[i - 1]]
    const pb = b[dates[i - 1]]
    if (pa > 0 && pb > 0) {
      ra.push(a[dates[i]] / pa - 1)
      rb.push(b[dates[i]] / pb - 1)
    }
  }
  const n = ra.length
  if (n < 2) return null
  const ma = ra.reduce((s, x) => s + x, 0) / n
  const mb = rb.reduce((s, x) => s + x, 0) / n
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < n; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb)
    va += (ra[i] - ma) ** 2
    vb += (rb[i] - mb) ** 2
  }
  if (va < 1e-18 || vb < 1e-18) return null
  return { correlation: cov / Math.sqrt(va * vb), observations: n }
}

const MIN_CORRELATION_DAYS = 60
const HIGH_CORRELATION = 0.85
const f2 = (n: number) => n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const f1 = (n: number) => n.toFixed(1)

function slices(entries: Map<string, { label: string; value: number }>, total: number): WeightSlice[] {
  return [...entries.entries()]
    .map(([key, v]) => ({ key, label: v.label, valueBase: v.value, weight: total > EPS ? (v.value / total) * 100 : 0 }))
    .sort((x, y) => y.valueBase - x.valueBase)
}

export function buildAnalysis(s: Snapshot, raw: RawData, dailyCloses: Map<string, Record<string, number>> = new Map()): Analysis {
  const set = raw.settings
  const sec = new Map(s.securities.map((x) => [x.id, x]))
  const combined = s.portfolios.combined
  const valued = combined.positions.filter((p) => p.marketValueBase !== null)
  const total = combined.marketValueBase
  const recs: Recommendation[] = []
  const commonAssumption = 'ใช้ราคาตลาดและอัตราแลกเปลี่ยนล่าสุดที่ระบบมี ณ เวลาที่แสดง'

  const pos = new Map<string, { label: string; value: number }>()
  const cat = new Map<string, { label: string; value: number }>()
  const cur = new Map<string, { label: string; value: number }>()
  const grp = new Map<string, { label: string; value: number }>()
  const add = (m: Map<string, { label: string; value: number }>, key: string, label: string, v: number) => m.set(key, { label, value: (m.get(key)?.value ?? 0) + v })
  for (const p of valued) {
    const x = sec.get(p.securityId)
    const mv = p.marketValueBase!
    add(pos, p.securityId, x?.symbol ?? '?', mv)
    add(cat, x?.category ?? 'Other', x?.category ?? 'Other', mv)
    add(cur, p.currency, p.currency, mv)
    if (x?.assetGroup) add(grp, x.assetGroup, x.assetGroup, mv)
  }
  const byPosition = slices(pos, total)
  const byCategory = slices(cat, total)
  const byCurrency = slices(cur, total)
  const byGroup = slices(grp, total)

  // 1. Safety first ---------------------------------------------------------
  if (s.debt.overdue > 0.005) {
    recs.push({
      kind: 'fix_first',
      title: 'มีหนี้เกินกำหนดชำระ',
      reason: 'หนี้ค้างชำระมีค่าปรับและดอกเบี้ยที่เกิดขึ้นแน่นอน ควรจัดการก่อนนำเงินไปลงทุนเพิ่ม',
      data: [`ยอดขั้นต่ำค้างชำระ ${f2(s.debt.overdue)} บาท`, `หนี้คงเหลือรวม ${f2(s.debt.total)} บาท`],
      assumptions: ['คำนวณจากยอดขั้นต่ำและวันครบกำหนดที่บันทึกไว้'],
      risks: ['การค้างชำระอาจกระทบประวัติเครดิตและมีค่าธรรมเนียมเพิ่ม'],
    })
  }
  const highDebts = s.liabilities.filter((l) => l.highInterest)
  if (highDebts.length > 0) {
    recs.push({
      kind: 'fix_first',
      title: 'มีหนี้ดอกเบี้ยสูง',
      reason: `การชำระหนี้ที่ดอกเบี้ยตั้งแต่ ${set.highInterestRate}% ต่อปี ให้ผลที่แน่นอนเท่ากับดอกเบี้ยที่ไม่ต้องจ่าย ขณะที่ผลตอบแทนจากการลงทุนไม่แน่นอน`,
      data: highDebts.map((l) => `${l.liability.name}: ${l.liability.annualRate}% ต่อปี คงเหลือ ${f2(l.balance)} บาท`),
      assumptions: [`เกณฑ์ดอกเบี้ยสูง ${set.highInterestRate}% มาจากค่าที่ตั้งไว้ในหน้า Settings`],
      risks: ['หากโปะหนี้จนเงินสดตึงเกินไปอาจต้องกู้ใหม่เมื่อมีเหตุฉุกเฉิน'],
    })
  }
  if (s.emergency.gap !== null && s.emergency.gap > 0.005) {
    recs.push({
      kind: 'fix_first',
      title: 'เงินสำรองฉุกเฉินยังไม่ถึงเป้าหมาย',
      reason: 'เงินลงทุนมีความผันผวน หากต้องขายตอนตลาดลงเพื่อใช้จ่ายฉุกเฉินอาจขาดทุนจริง จึงไม่ควรนับเงินลงทุนเป็นเงินสำรอง',
      data: [
        `เงินสำรองปัจจุบัน ${f2(s.emergency.current)} บาท`,
        `เป้าหมาย ${f2(s.emergency.target!)} บาท (${f2(s.emergency.essentialMonthly!)} บาท/เดือน x ${s.emergency.targetMonths} เดือน)`,
        `ยังขาด ${f2(s.emergency.gap)} บาท`,
      ],
      assumptions: [s.emergency.essentialSource === 'setting' ? 'ค่าใช้จ่ายจำเป็นต่อเดือนมาจากค่าที่ตั้งไว้' : 'ค่าใช้จ่ายจำเป็นต่อเดือนเฉลี่ยจากรายจ่ายจำเป็นที่บันทึกไว้'],
      risks: ['ค่าใช้จ่ายจริงยามฉุกเฉินอาจสูงกว่าค่าเฉลี่ยปกติ'],
    })
  } else if (s.emergency.target === null && valued.length > 0) {
    recs.push({
      kind: 'info',
      title: 'ยังประเมินเงินสำรองฉุกเฉินไม่ได้',
      reason: 'ยังไม่มีข้อมูลค่าใช้จ่ายจำเป็นต่อเดือน จึงคำนวณเป้าหมายเงินสำรองไม่ได้',
      data: ['ไม่มีรายจ่ายที่ระบุว่าจำเป็น และไม่ได้ตั้งค่าค่าใช้จ่ายจำเป็นต่อเดือน'],
      assumptions: [],
      risks: ['การประเมินความพร้อมก่อนลงทุนเพิ่มยังไม่ครบถ้วน'],
    })
  }

  // 2. Concentration --------------------------------------------------------
  if (byPosition.length > 1) {
    for (const p of byPosition.filter((x) => x.weight > set.maxPositionPct)) {
      const x = sec.get(p.key)
      const isFund = x?.assetType === 'etf' || x?.assetType === 'fund'
      recs.push({
        kind: 'reduce',
        title: `${p.label} มีสัดส่วน ${f1(p.weight)}% ของพอร์ต`,
        reason: isFund
          ? `สูงกว่าเกณฑ์ ${set.maxPositionPct}% ที่ตั้งไว้ แต่เป็น${x?.assetType === 'etf' ? ' ETF' : 'กองทุน'}ซึ่งกระจายการลงทุนภายในอยู่แล้ว ความเสี่ยงกระจุกตัวจึงขึ้นกับสินทรัพย์ที่กองถือ`
          : `สูงกว่าเกณฑ์ ${set.maxPositionPct}% ที่ตั้งไว้ ผลลัพธ์ของพอร์ตจะขึ้นกับหุ้นตัวเดียวมาก`,
        data: [`มูลค่า ${f2(p.valueBase)} บาท จากพอร์ตรวม ${f2(total)} บาท`],
        assumptions: [commonAssumption, 'เกณฑ์สัดส่วนสูงสุดต่อหลักทรัพย์มาจากหน้า Settings'],
        risks: ['การขายเพื่อลดสัดส่วนอาจมีค่าธรรมเนียมและภาระภาษี', 'อีกทางเลือกคือเติมเงินใหม่ไปยังหลักทรัพย์อื่นแทนการขาย'],
      })
    }
  }
  if (byCategory.length > 1) {
    for (const c of byCategory.filter((x) => x.weight > set.maxCategoryPct)) {
      recs.push({
        kind: 'diversify',
        title: `หมวด ${c.label} มีสัดส่วน ${f1(c.weight)}% ของพอร์ต`,
        reason: `สูงกว่าเกณฑ์ ${set.maxCategoryPct}% ที่ตั้งไว้ หุ้นในหมวดเดียวกันมักได้รับผลกระทบจากปัจจัยเดียวกันพร้อมกัน`,
        data: valued.filter((p) => (sec.get(p.securityId)?.category ?? 'Other') === c.key).map((p) => `${sec.get(p.securityId)?.symbol}: ${f1(p.weight ?? 0)}%`),
        assumptions: [commonAssumption, 'หมวดธุรกิจเป็นค่าที่ผู้ใช้กำหนดให้แต่ละหลักทรัพย์'],
        risks: ['การจัดหมวดด้วยตนเองอาจไม่สะท้อนรายได้จริงของบริษัท'],
      })
    }
  } else if (byCategory.length === 1 && byPosition.length > 1) {
    recs.push({
      kind: 'diversify',
      title: `ทั้งพอร์ตอยู่ในหมวด ${byCategory[0].label} หมวดเดียว`,
      reason: 'พอร์ตไม่มีการกระจายข้ามหมวดธุรกิจ',
      data: byPosition.map((p) => `${p.label}: ${f1(p.weight)}%`),
      assumptions: [commonAssumption],
      risks: ['ปัจจัยลบเฉพาะหมวดจะกระทบทั้งพอร์ตพร้อมกัน'],
    })
  }

  // 3. Overlap --------------------------------------------------------------
  for (const g of byGroup) {
    const members = valued.filter((p) => sec.get(p.securityId)?.assetGroup === g.key)
    if (members.length >= 2) {
      recs.push({
        kind: 'diversify',
        title: `ถือ ${members.length} หลักทรัพย์ในกลุ่ม "${g.label}" รวม ${f1(g.weight)}%`,
        reason: 'หลักทรัพย์ในกลุ่มสินทรัพย์เดียวกันมีแนวโน้มถือสินทรัพย์ซ้ำกัน การถือหลายตัวจึงอาจไม่ได้เพิ่มการกระจายความเสี่ยงเท่าที่เห็น',
        data: members.map((p) => `${sec.get(p.securityId)?.symbol}: ${f1(p.weight ?? 0)}%`),
        assumptions: ['กลุ่มสินทรัพย์เป็นค่าที่ผู้ใช้กำหนดเอง ระบบไม่มีข้อมูลองค์ประกอบภายในของ ETF/กองทุน'],
        risks: ['ระดับการซ้ำซ้อนจริงต้องตรวจจากรายการถือครองของแต่ละกองทุน'],
      })
    }
  }
  const etfs = valued.filter((p) => sec.get(p.securityId)?.assetType === 'etf')
  const stocks = valued.filter((p) => sec.get(p.securityId)?.assetType === 'stock')
  if (etfs.length > 0 && stocks.length > 0) {
    recs.push({
      kind: 'info',
      title: 'ถือทั้ง ETF และหุ้นรายตัว: อาจมีการถือซ้ำซ้อน',
      reason: 'ETF ดัชนีกว้างมักถือหุ้นขนาดใหญ่อยู่แล้ว สัดส่วนจริงของหุ้นบางตัวจึงอาจสูงกว่าที่แสดง',
      data: [`ETF: ${etfs.map((p) => sec.get(p.securityId)?.symbol).join(', ')}`, `หุ้นรายตัว: ${stocks.map((p) => sec.get(p.securityId)?.symbol).join(', ')}`],
      assumptions: ['ระบบไม่มีข้อมูลรายการถือครองของ ETF จึงคำนวณสัดส่วนซ้ำซ้อนที่แท้จริงไม่ได้'],
      risks: ['ควรตรวจรายการถือครอง (Holdings) ของ ETF จากผู้ออกกองทุนโดยตรง'],
    })
  }

  // 4. Currency -------------------------------------------------------------
  const foreign = byCurrency.filter((c) => c.key !== s.baseCurrency)
  const foreignWeight = foreign.reduce((a, c) => a + c.weight, 0)
  if (foreignWeight > 0.05) {
    recs.push({
      kind: foreignWeight > 80 ? 'diversify' : 'info',
      title: `${f1(foreignWeight)}% ของพอร์ตอยู่ในสกุลเงินต่างประเทศ`,
      reason: `มูลค่าเป็นเงิน${s.baseCurrency === 'THB' ? 'บาท' : s.baseCurrency}จะเปลี่ยนตามอัตราแลกเปลี่ยน แม้ราคาหุ้นไม่เปลี่ยน`,
      data: byCurrency.map((c) => `${c.label}: ${f1(c.weight)}%${s.fx[c.key] ? ` (อัตรา ${s.fx[c.key].rate} ณ ${s.fx[c.key].date})` : ''}`),
      assumptions: ['กำไร/ขาดทุนเป็นเงินบาทรวมผลจากอัตราแลกเปลี่ยนตั้งแต่วันที่ซื้อ'],
      risks: ['เงินบาทแข็งค่าจะลดมูลค่าเป็นบาทของสินทรัพย์ต่างประเทศ และกลับกัน'],
    })
  }

  // 5. Correlation ----------------------------------------------------------
  const correlations: CorrelationPair[] = []
  let insufficient = 0
  for (let i = 0; i < valued.length; i++) {
    for (let j = i + 1; j < valued.length; j++) {
      const a = dailyCloses.get(valued[i].securityId)
      const b = dailyCloses.get(valued[j].securityId)
      const r = a && b ? returnCorrelation(a, b) : null
      if (!r || r.observations < MIN_CORRELATION_DAYS) {
        insufficient++
        continue
      }
      correlations.push({ a: valued[i].securityId, b: valued[j].securityId, correlation: r.correlation, observations: r.observations })
    }
  }
  correlations.sort((x, y) => y.correlation - x.correlation)
  for (const c of correlations.filter((x) => x.correlation >= HIGH_CORRELATION)) {
    recs.push({
      kind: 'diversify',
      title: `${sec.get(c.a)?.symbol} และ ${sec.get(c.b)?.symbol} เคลื่อนไหวไปทางเดียวกันสูง`,
      reason: 'ผลตอบแทนรายวันมีความสัมพันธ์กันสูง การถือทั้งสองตัวช่วยกระจายความเสี่ยงได้จำกัด',
      data: [`ค่าสหสัมพันธ์ (correlation) ${c.correlation.toFixed(2)} จาก ${c.observations} วันทำการ`],
      assumptions: ['คำนวณจากราคาปิดรายวันย้อนหลังที่ระบบเก็บไว้ ความสัมพันธ์ในอดีตอาจเปลี่ยนได้'],
      risks: ['ช่วงตลาดผันผวนสูง ความสัมพันธ์ระหว่างหุ้นมักเพิ่มขึ้น'],
    })
  }
  const pairs = (valued.length * (valued.length - 1)) / 2
  const correlationNote =
    pairs === 0
      ? 'ต้องถืออย่างน้อย 2 หลักทรัพย์จึงจะคำนวณความสัมพันธ์ได้'
      : insufficient === pairs
        ? `ข้อมูลราคาย้อนหลังไม่เพียงพอ (ต้องมีอย่างน้อย ${MIN_CORRELATION_DAYS} วันทำการที่ตรงกัน) จึงยังไม่คำนวณความสัมพันธ์`
        : insufficient > 0
          ? `คำนวณได้ ${pairs - insufficient} จาก ${pairs} คู่ คู่ที่เหลือข้อมูลราคาย้อนหลังไม่พอ`
          : `คำนวณจากผลตอบแทนรายวันครบทั้ง ${pairs} คู่`

  // 6. Costs ----------------------------------------------------------------
  const feeRatioPct = combined.investedBase > EPS ? (combined.feesBase / combined.investedBase) * 100 : null
  if (feeRatioPct !== null && feeRatioPct > 1) {
    recs.push({
      kind: 'info',
      title: `ค่าธรรมเนียมสะสมคิดเป็น ${feeRatioPct.toFixed(2)}% ของเงินที่ลงทุน`,
      reason: 'ค่าธรรมเนียมลดผลตอบแทนโดยตรง การซื้อถี่ด้วยยอดเล็กมักทำให้สัดส่วนค่าธรรมเนียมสูง',
      data: [`ค่าธรรมเนียมและภาษีหัก ณ ที่จ่ายสะสม ${f2(combined.feesBase)} บาท`, `เงินลงทุนสะสม (ยอดซื้อ) ${f2(combined.investedBase)} บาท`],
      assumptions: ['รวมค่าคอมมิชชันซื้อขาย ค่าธรรมเนียมอื่น และภาษีเงินปันผลที่บันทึกไว้'],
      risks: ['การรวมคำสั่งซื้อให้ใหญ่ขึ้นช่วยลดสัดส่วนค่าธรรมเนียม แต่ลดความถี่ของการเฉลี่ยต้นทุน'],
    })
  }

  // 7. DCA targets ----------------------------------------------------------
  for (const p of s.dcaPlans.filter((x) => x.plan.status === 'active' && x.drift)) {
    for (const d of p.drift!) {
      if (Math.abs(d.diff) <= set.allocationDriftPct) continue
      const sym = sec.get(d.securityId)?.symbol ?? '?'
      recs.push({
        kind: d.diff < 0 ? 'increase' : 'reduce',
        title: `${sym}: สัดส่วนจริง ${f1(d.actualPct)}% เทียบเป้าหมาย ${f1(d.targetPct)}% ในแผน "${p.plan.name}"`,
        reason:
          d.diff < 0
            ? 'ต่ำกว่าเป้าหมายที่ตั้งไว้เอง สามารถปรับเงิน DCA งวดถัดไปให้ตัวนี้มากขึ้นเพื่อกลับเข้าเป้าโดยไม่ต้องขาย'
            : 'สูงกว่าเป้าหมายที่ตั้งไว้เอง สามารถชะลอการซื้อตัวนี้ในงวดถัดไปเพื่อให้สัดส่วนกลับเข้าเป้าโดยไม่ต้องขาย',
        data: [`ส่วนต่าง ${d.diff > 0 ? '+' : ''}${f1(d.diff)}% (เกณฑ์แจ้งเตือน ${set.allocationDriftPct}%)`],
        assumptions: [commonAssumption, 'เป้าหมายคือสัดส่วนที่ผู้ใช้ตั้งไว้ในแผน DCA ไม่ใช่คำแนะนำของระบบ'],
        risks: ['การปรับสัดส่วนบ่อยเกินไปเพิ่มค่าธรรมเนียม'],
      })
    }
  }
  for (const p of s.dcaPlans.filter((x) => x.plan.status === 'active')) {
    if (p.plan.durationMonths !== null && p.plan.durationMonths < 36 && p.allocations.length > 0) {
      recs.push({
        kind: 'info',
        title: `แผน "${p.plan.name}" มีระยะเวลา ${p.plan.durationMonths} เดือน`,
        reason: 'หุ้นและ ETF หุ้นผันผวนสูงในระยะสั้น ระยะเวลาลงทุนต่ำกว่า 3 ปีมีโอกาสที่มูลค่าต่ำกว่าเงินต้นเมื่อครบกำหนดได้',
        data: [`ระดับความเสี่ยงที่ตั้งไว้: ${p.plan.riskLevel}`, `เป้าหมาย: ${p.plan.objective}`],
        assumptions: ['เป็นข้อสังเกตทั่วไปเกี่ยวกับสินทรัพย์ประเภทหุ้น ไม่ใช่การคาดการณ์ผลตอบแทนของแผนนี้'],
        risks: ['หากต้องใช้เงินตามกำหนด ควรพิจารณาสินทรัพย์ที่ผันผวนต่ำกว่าสำหรับเงินส่วนนั้น'],
      })
    }
  }

  // 8. Nothing flagged ------------------------------------------------------
  const flagged = recs.some((r) => r.kind !== 'info')
  if (valued.length > 0 && !flagged) {
    recs.push({
      kind: 'hold',
      title: 'ไม่พบประเด็นที่เกินเกณฑ์ที่ตั้งไว้',
      reason: 'สัดส่วนรายตัว รายหมวด หนี้ และเงินสำรอง อยู่ภายในเกณฑ์ที่ผู้ใช้กำหนด',
      data: [`จำนวนหลักทรัพย์ ${valued.length}`, `สัดส่วนสูงสุดรายตัว ${f1(byPosition[0]?.weight ?? 0)}%`],
      assumptions: [commonAssumption, 'ประเมินตามเกณฑ์ในหน้า Settings เท่านั้น ไม่ได้ประเมินคุณภาพธุรกิจของแต่ละบริษัท'],
      risks: ['การอยู่ในเกณฑ์ไม่ได้หมายความว่าพอร์ตจะไม่ขาดทุน'],
    })
  }
  if (!combined.complete) {
    recs.unshift({
      kind: 'info',
      title: 'ข้อมูลราคาไม่ครบ: ผลวิเคราะห์เป็นเพียงบางส่วน',
      reason: 'มีหลักทรัพย์ที่ถืออยู่แต่ไม่มีราคาหรืออัตราแลกเปลี่ยน จึงไม่ถูกรวมในสัดส่วนด้านล่าง',
      data: [...combined.missingPrice, ...combined.missingFx].map((id) => sec.get(id)?.symbol ?? '?'),
      assumptions: [],
      risks: ['สัดส่วนจริงของพอร์ตอาจต่างจากที่แสดง'],
    })
  }

  const order: Record<RecommendationKind, number> = { fix_first: 0, reduce: 1, increase: 2, diversify: 3, hold: 4, info: 5 }
  recs.sort((a, b) => order[a.kind] - order[b.kind])
  return { recommendations: recs, byPosition, byCategory, byCurrency, byGroup, feeRatioPct, correlations, correlationNote, complete: combined.complete }
}
