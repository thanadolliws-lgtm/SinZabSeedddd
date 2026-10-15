'use client'

import { useState } from 'react'
import { effectiveAnnualPct, monthlyRate, simulateGrowth, simulateScenarios, type GrowthInput } from '@/lib/calc/growth'
import type { FxRateInfo } from '@/lib/calc/types'
import { AreaSeriesChart, LineSeriesChart, PALETTE, SEMANTIC } from '@/components/charts'
import { Button, Card, Checkbox, DataTable, Field, Input, Notice, PageHeader, Stat, type Column } from '@/components/ui'
import { fmtMoney, fmtNum, fmtPct } from '@/lib/format'

type Inputs = Record<keyof Omit<GrowthInput, 'reinvestDividends' | 'stopAfterYears'> | 'spread' | 'stopAfter' | 'extraMonthly', string>

const num = (s: string, fallback = 0) => {
  const n = Number(s)
  return s.trim() === '' || !Number.isFinite(n) ? fallback : n
}

export function SimulatorView({ portfolioValue, monthlyDca, usdThb }: { portfolioValue: number | null; monthlyDca: number | null; usdThb: FxRateInfo | null }) {
  const [v, setV] = useState<Inputs>({
    initial: portfolioValue !== null ? String(Math.round(portfolioValue)) : '100000',
    monthly: monthlyDca ? String(Math.round(monthlyDca)) : '3000',
    years: '20',
    annualReturnPct: '7',
    feePct: '0.2',
    inflationPct: '2.5',
    dividendYieldPct: '0',
    stepUpPct: '0',
    fxChangePct: '0',
    spread: '3',
    stopAfter: '',
    extraMonthly: '1000',
  })
  const [reinvest, setReinvest] = useState(true)
  const set = (k: keyof Inputs) => (e: React.ChangeEvent<HTMLInputElement>) => setV((x) => ({ ...x, [k]: e.target.value }))

  const input: GrowthInput = {
    initial: Math.max(0, num(v.initial)),
    monthly: Math.max(0, num(v.monthly)),
    years: Math.min(60, Math.max(1, Math.round(num(v.years, 20)))),
    annualReturnPct: num(v.annualReturnPct),
    feePct: Math.max(0, num(v.feePct)),
    inflationPct: num(v.inflationPct),
    dividendYieldPct: Math.max(0, num(v.dividendYieldPct)),
    reinvestDividends: reinvest,
    stepUpPct: num(v.stepUpPct),
    fxChangePct: num(v.fxChangePct),
  }
  const spread = Math.max(0, num(v.spread, 3))
  const stopAfter = v.stopAfter.trim() === '' ? null : Math.max(0, Math.round(num(v.stopAfter)))
  const extra = Math.max(0, num(v.extraMonthly))

  // A few thousand arithmetic steps: cheap enough to recompute on every keystroke.
  const result = simulateGrowth(input)
  const scenarios = simulateScenarios(input, spread)
  const stopped = stopAfter === null ? null : simulateGrowth({ ...input, stopAfterYears: stopAfter })
  const more = extra > 0 ? simulateGrowth({ ...input, monthly: input.monthly + extra }) : null

  const eff = effectiveAnnualPct(input)
  const r = monthlyRate(eff)
  const growthData = result.rows.map((row) => ({ year: `ปี ${row.year}`, contributed: row.contributed, gain: Math.max(0, row.gain), loss: Math.min(0, row.gain), value: row.value, real: row.realValue }))
  const scenarioData = scenarios.base.rows.map((row, i) => ({
    year: `ปี ${row.year}`,
    low: scenarios.low.rows[i].value,
    base: row.value,
    high: scenarios.high.rows[i].value,
    contributed: row.contributed,
    ...(stopped ? { stopped: stopped.rows[i].value } : {}),
    ...(more ? { more: more.rows[i].value } : {}),
  }))

  const columns: Column<(typeof result.rows)[number]>[] = [
    { key: 'year', header: 'ปีที่', cell: (x) => x.year, sort: (x) => x.year },
    { key: 'monthly', header: 'ลงทุนต่อเดือน', align: 'right', cell: (x) => <span className="num">{fmtMoney(x.monthlyContribution, 'THB', 0)}</span> },
    { key: 'contributed', header: 'เงินต้นสะสม', align: 'right', cell: (x) => <span className="num">{fmtMoney(x.contributed, 'THB', 0)}</span> },
    { key: 'gain', header: 'ผลตอบแทนสะสม', align: 'right', cell: (x) => <span className={`num ${x.gain >= 0 ? 'text-gain' : 'text-loss'}`}>{fmtMoney(x.gain, 'THB', 0)}</span> },
    { key: 'value', header: 'มูลค่าพอร์ต', align: 'right', cell: (x) => <span className="num font-medium">{fmtMoney(x.value, 'THB', 0)}</span> },
    { key: 'real', header: 'หลังหักเงินเฟ้อ', align: 'right', cell: (x) => <span className="num text-muted">{fmtMoney(x.realValue, 'THB', 0)}</span> },
    ...(input.reinvestDividends ? [] : [{ key: 'div', header: 'ปันผลรับเป็นเงินสดสะสม', align: 'right' as const, cell: (x: (typeof result.rows)[number]) => <span className="num">{fmtMoney(x.dividendsPaidOut, 'THB', 0)}</span> }]),
  ]

  const field = (k: keyof Inputs, label: string, hint?: string, unit?: string) => (
    <Field label={unit ? `${label} (${unit})` : label} hint={hint}>
      <Input type="number" inputMode="decimal" step="any" value={v[k]} onChange={set(k)} />
    </Field>
  )

  return (
    <div className="space-y-5">
      <PageHeader title="จำลองการเติบโตของพอร์ต (Growth Simulator)" subtitle="แบบจำลองภายใต้สมมติฐานคงที่ ไม่ใช่การคาดการณ์หรือการรับประกันผลตอบแทน" />
      <Notice tone="warning" title="ข้อควรทราบ">
        ผลตอบแทนจริงของหุ้นผันผวนและอาจติดลบได้ในบางปี ตัวเลขด้านล่างคำนวณจากอัตราคงที่ที่คุณกรอกเพื่อช่วยวางแผนเท่านั้น
      </Notice>

      <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Card title="สมมติฐาน">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 flex flex-wrap gap-2">
              {portfolioValue !== null && (
                <Button size="sm" onClick={() => setV((x) => ({ ...x, initial: String(Math.round(portfolioValue)) }))}>
                  ใช้มูลค่าพอร์ตปัจจุบัน {fmtMoney(portfolioValue, 'THB', 0)}
                </Button>
              )}
              {monthlyDca !== null && monthlyDca > 0 && (
                <Button size="sm" onClick={() => setV((x) => ({ ...x, monthly: String(Math.round(monthlyDca)) }))}>
                  ใช้งบ DCA ปัจจุบัน {fmtMoney(monthlyDca, 'THB', 0)}/เดือน
                </Button>
              )}
            </div>
            {field('initial', 'เงินต้นเริ่มต้น', undefined, 'บาท')}
            {field('monthly', 'ลงทุนเพิ่มต่อเดือน', 'ลงทุนปลายเดือน', 'บาท')}
            {field('years', 'ระยะเวลา', '1-60 ปี', 'ปี')}
            {field('annualReturnPct', 'ผลตอบแทนจากราคาต่อปี', 'ไม่รวมปันผล', '%')}
            {field('dividendYieldPct', 'อัตราเงินปันผลต่อปี', 'ถ้าตัวเลขด้านบนเป็นผลตอบแทนรวม (Total Return) แล้ว ให้ใส่ 0', '%')}
            {field('feePct', 'ค่าธรรมเนียมต่อปี', 'เช่น ค่าบริหารกองทุน/ETF', '%')}
            {field('inflationPct', 'อัตราเงินเฟ้อ', undefined, '%')}
            {field('fxChangePct', 'ค่าเงินต่างประเทศเทียบบาทต่อปี', usdThb ? `USD/THB ล่าสุด ${usdThb.rate} (${usdThb.date}) · + = บาทอ่อน` : '+ = บาทอ่อนค่า, − = บาทแข็งค่า', '%')}
            {field('stepUpPct', 'เพิ่มเงิน DCA ทุกปี', '0 = ลงทุนคงที่', '%')}
            {field('spread', 'ช่วงกรณีต่ำ/สูง', '± จุดเปอร์เซ็นต์จากผลตอบแทนที่กรอก', '%')}
            {field('stopAfter', 'หยุด DCA หลังปีที่', 'เว้นว่าง = ไม่หยุด', 'ปี')}
            {field('extraMonthly', 'เปรียบเทียบ: ลงทุนเพิ่มต่อเดือน', undefined, 'บาท')}
            <div className="col-span-2">
              <Checkbox label="นำเงินปันผลกลับไปลงทุน" hint={reinvest ? 'ปันผลทบต้นอยู่ในพอร์ต' : 'ปันผลจ่ายออกเป็นเงินสด ไม่ทบต้น และไม่รวมในมูลค่าพอร์ต'} checked={reinvest} onChange={setReinvest} />
            </div>
          </div>
        </Card>

        <div className="space-y-5">
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Stat label="เงินต้นเริ่มต้น" value={fmtMoney(result.initial, 'THB', 0)} />
            <Stat label="เงินลงทุนสะสม (รวมเงินต้น)" value={fmtMoney(result.contributed, 'THB', 0)} />
            <Stat label="ผลตอบแทนสะสมโดยประมาณ" value={fmtMoney(result.gain, 'THB', 0)} tone={result.gain >= 0 ? 'gain' : 'loss'} />
            <Stat label={`มูลค่าพอร์ตปลายปีที่ ${input.years}`} value={fmtMoney(result.finalValue, 'THB', 0)} sub={`กรณีต่ำ ${fmtMoney(scenarios.low.finalValue, 'THB', 0)} · สูง ${fmtMoney(scenarios.high.finalValue, 'THB', 0)}`} />
            <Stat label="มูลค่าหลังหักเงินเฟ้อ" value={fmtMoney(result.realValue, 'THB', 0)} sub="เทียบเป็นเงินในวันนี้" />
            <Stat label="ผลตอบแทนสุทธิที่ใช้คำนวณ" value={fmtPct(eff, 2)} sub={`ต่อเดือน ${fmtPct(r * 100, 4)}`} hint="(1 + ผลตอบแทนจากราคา + ปันผลที่นำกลับไปลงทุน) × (1 − ค่าธรรมเนียม) × (1 + การเปลี่ยนแปลงค่าเงิน) − 1" />
          </section>
          {!input.reinvestDividends && result.dividendsPaidOut > 0 && <Notice tone="info">เงินปันผลที่รับเป็นเงินสดสะสม {fmtMoney(result.dividendsPaidOut, 'THB', 0)} (ไม่รวมในมูลค่าพอร์ต)</Notice>}

          <Card title="เงินต้นที่ลงทุนเทียบผลตอบแทนจากสมมติฐาน">
            <AreaSeriesChart
              data={growthData}
              xKey="year"
              series={[
                { key: 'contributed', label: 'เงินต้นสะสม', color: SEMANTIC.neutral, stack: 'a' },
                { key: 'gain', label: 'ผลตอบแทน', color: SEMANTIC.gain, stack: 'a' },
                ...(growthData.some((d) => d.loss < 0) ? [{ key: 'loss', label: 'ขาดทุน', color: SEMANTIC.loss }] : []),
              ]}
            />
          </Card>

          <Card title="กรณีผลตอบแทนต่ำ / ปานกลาง / สูง และผลของการปรับ DCA">
            <LineSeriesChart
              data={scenarioData}
              xKey="year"
              series={[
                { key: 'contributed', label: 'เงินต้นสะสม', color: SEMANTIC.neutral, dashed: true },
                { key: 'low', label: `ต่ำ (${fmtNum(input.annualReturnPct - spread, 1)}%)`, color: SEMANTIC.loss },
                { key: 'base', label: `ปานกลาง (${fmtNum(input.annualReturnPct, 1)}%)`, color: SEMANTIC.accent },
                { key: 'high', label: `สูง (${fmtNum(input.annualReturnPct + spread, 1)}%)`, color: SEMANTIC.gain },
                ...(stopped ? [{ key: 'stopped', label: `หยุด DCA หลังปีที่ ${stopAfter}`, color: PALETTE[1], dashed: true }] : []),
                ...(more ? [{ key: 'more', label: `เพิ่ม ${fmtMoney(extra, 'THB', 0)}/เดือน`, color: PALETTE[2], dashed: true }] : []),
              ]}
            />
            <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
              {stopped && (
                <div className="rounded-lg bg-surface-2 p-3">
                  หยุด DCA หลังปีที่ {stopAfter}: มูลค่าปลายงวด <span className="num font-medium">{fmtMoney(stopped.finalValue, 'THB', 0)}</span> ({fmtMoney(stopped.finalValue - result.finalValue, 'THB', 0)} เทียบกับไม่หยุด) เงินต้น {fmtMoney(stopped.contributed, 'THB', 0)}
                </div>
              )}
              {more && (
                <div className="rounded-lg bg-surface-2 p-3">
                  ลงทุนเพิ่ม {fmtMoney(extra, 'THB', 0)}/เดือน: มูลค่าปลายงวด <span className="num font-medium">{fmtMoney(more.finalValue, 'THB', 0)}</span> (+{fmtMoney(more.finalValue - result.finalValue, 'THB', 0)} จากเงินต้นเพิ่ม {fmtMoney(more.contributed - result.contributed, 'THB', 0)})
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      <Card title="ตารางแยกตามปี" pad={false}>
        <DataTable rows={result.rows} columns={columns} rowKey={(x) => String(x.year)} pageSize={61} />
      </Card>

      <Card title="สูตรที่ใช้">
        <div className="space-y-2 text-sm leading-relaxed">
          <p>
            อัตราผลตอบแทนรายเดือน: <code className="rounded bg-surface-2 px-1">r = (1 + R)^(1/12) − 1</code> โดย R คือผลตอบแทนสุทธิต่อปีด้านบน
          </p>
          <p>
            ลงทุนปลายเดือน เงินต้น P เงินลงทุนรายเดือน C จำนวน n เดือน: <code className="rounded bg-surface-2 px-1">FV = P(1+r)^n + C × [((1+r)^n − 1) / r]</code> และกรณี r = 0: FV = P + C × n
          </p>
          <p>ระบบคำนวณทีละเดือนจึงรองรับการเพิ่มเงิน DCA รายปีและการหยุด DCA กรณีลงทุนคงที่ผลลัพธ์ตรงกับสูตรปิดข้างต้น (มี Unit Test ยืนยัน)</p>
          <p>ไม่นับเงินปันผลซ้ำ: ถ้านำกลับไปลงทุน ปันผลถูกบวกเข้าอัตราเติบโตครั้งเดียว ถ้าไม่นำกลับไปลงทุน ปันผลถูกแยกเป็นเงินสดและไม่ทบต้น</p>
          <p>มูลค่าหลังหักเงินเฟ้อ = มูลค่า ÷ (1 + อัตราเงินเฟ้อ)^จำนวนปี</p>
        </div>
      </Card>
    </div>
  )
}
