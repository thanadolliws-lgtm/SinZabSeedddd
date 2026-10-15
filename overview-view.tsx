'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { BriefcaseBusiness, Wallet } from 'lucide-react'
import type { Snapshot } from '@/lib/calc/snapshot'
import type { PortfolioSummary } from '@/lib/calc/portfolio'
import { AlertList, DefinitionList } from '@/components/common'
import { BarSeriesChart, DonutChart, LineSeriesChart, SEMANTIC } from '@/components/charts'
import { Badge, Card, EmptyState, Notice, PageHeader, PnL, ProgressBar, Stat, Tabs, cx } from '@/components/ui'
import { fmtDateTime, fmtMoney, fmtMonth, fmtPct, toneOf } from '@/lib/format'

type View = 'main' | 'dca' | 'combined'
const VIEW_LABEL: Record<View, string> = { main: 'My Portfolio (หุ้นที่ถือจริง)', dca: 'DCA Portfolio', combined: 'รวมทุกพอร์ต (Combined)' }

const DEFINITIONS = [
  { term: 'มูลค่าพอร์ต', detail: 'จำนวนหุ้นที่ถืออยู่จริง × ราคาตลาดล่าสุด × อัตราแลกเปลี่ยนล่าสุด แผน DCA ที่ยังไม่ได้ซื้อจริงไม่ถูกนับ' },
  { term: 'กำไร/ขาดทุนที่ยังไม่รับรู้', detail: 'มูลค่าตลาด − ต้นทุนของหุ้นที่ยังถืออยู่ (Weighted Average Cost รวมค่าธรรมเนียมซื้อ) เป็นเงินบาทจึงรวมผลของอัตราแลกเปลี่ยน' },
  { term: 'ผลตอบแทนรวม', detail: 'กำไรที่ยังไม่รับรู้ + กำไรที่รับรู้แล้วจากการขาย + เงินปันผลสุทธิหลังภาษี − ค่าธรรมเนียมอื่น (ค่าคอมซื้อขายอยู่ในต้นทุนและยอดขายแล้ว)' },
  { term: 'เงินสดและเงินในบัญชี', detail: 'ยอดยกมา + รายรับที่ได้รับจริง − รายจ่ายที่จ่ายจริง − ชำระหนี้ ± โอนเงิน ± ซื้อขายหุ้นที่ผูกบัญชี รายการ "คาดว่าจะได้รับ" และ "ยังไม่จ่าย" ไม่ถูกนับ' },
  { term: 'หนี้สินคงเหลือ', detail: 'ยอดหนี้หลังรวมดอกเบี้ยและหักการชำระจริง รวมดอกเบี้ยค้างจ่ายโดยประมาณตั้งแต่รายการล่าสุดถึงวันนี้' },
  { term: 'ทรัพย์สินสุทธิ', detail: 'เงินสดทุกบัญชี + ทรัพย์สินอื่นที่กรอกเอง + มูลค่าพอร์ต − หนี้สินทั้งหมด' },
  { term: 'เงินที่พร้อมใช้เดือนนี้', detail: 'เงินในบัญชีเงินสด/ธนาคารที่ไม่ได้กันไว้ − รายจ่ายที่ยังไม่จ่ายซึ่งครบกำหนดภายในสิ้นเดือน − ยอดชำระหนี้ขั้นต่ำที่ยังค้างเดือนนี้ (ไม่รวมเงินสำรอง เงินออมตามเป้าหมาย และเงินในบัญชีโบรกเกอร์)' },
  { term: 'เงินสำรองฉุกเฉิน', detail: 'ยอดในบัญชีที่ตั้งวัตถุประสงค์เป็นเงินสำรอง เป้าหมาย = ค่าใช้จ่ายจำเป็นต่อเดือน × จำนวนเดือนที่ตั้งไว้ เงินลงทุนไม่ถูกนับเป็นเงินสำรอง' },
]

function PortfolioBlock({ p, s, invested, name }: { p: PortfolioSummary; s: Snapshot; invested: number; name: string }) {
  const sym = (id: string) => s.securities.find((x) => x.id === id)?.symbol ?? '?'
  const priced = p.positions.filter((x) => x.unrealizedPctBase !== null)
  const best = [...priced].sort((a, b) => b.unrealizedPctBase! - a.unrealizedPctBase!)[0]
  const worst = [...priced].sort((a, b) => a.unrealizedPctBase! - b.unrealizedPctBase!)[0]
  const total = s.portfolios.combined.marketValueBase
  if (p.positions.length === 0 && p.closedPositions.length === 0) {
    return <EmptyState icon={<BriefcaseBusiness size={28} />} title={`ยังไม่มีธุรกรรมใน ${name}`} description="บันทึกการซื้อหุ้นจริงเพื่อเริ่มติดตามต้นทุนและกำไร/ขาดทุน" action={<Link className="text-sm text-accent hover:underline" href="/portfolio">ไปที่พอร์ตหุ้น</Link>} />
  }
  const rows: [string, React.ReactNode][] = [
    ['ต้นทุนหุ้นที่ยังถืออยู่', fmtMoney(p.costBasisBase)],
    ['มูลค่าตลาด', <span key="mv">{fmtMoney(p.marketValueBase)}{!p.complete && <Badge tone="warn">ไม่ครบ</Badge>}</span>],
    ['กำไร/ขาดทุนที่ยังไม่รับรู้', <PnL key="u" value={p.unrealizedPnlBase} pct={p.unrealizedPct} />],
    ['กำไร/ขาดทุนที่รับรู้แล้ว', <PnL key="r" value={p.realizedPnlBase} />],
    ['เงินปันผลสุทธิ', fmtMoney(p.dividendsNetBase)],
    ['ผลตอบแทนรวม', <PnL key="t" value={p.totalReturnBase} />],
    ['สัดส่วนของพอร์ตรวม', total > 0 ? fmtPct((p.marketValueBase / total) * 100, 1) : '—'],
    ['ลงทุนจริงเดือนนี้', fmtMoney(invested)],
    ['กำไรสูงสุด', best ? <span key="b" className={cx('num', best.unrealizedPctBase! >= 0 ? 'text-gain' : 'text-loss')}>{sym(best.securityId)} {fmtPct(best.unrealizedPctBase, 2, true)}</span> : '—'],
    ['ขาดทุนสูงสุด', worst && worst !== best ? <span key="w" className={cx('num', worst.unrealizedPctBase! >= 0 ? 'text-gain' : 'text-loss')}>{sym(worst.securityId)} {fmtPct(worst.unrealizedPctBase, 2, true)}</span> : '—'],
  ]
  return (
    <div>
      <dl className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3 border-b border-line/70 py-2 text-sm">
            <dt className="text-muted">{k}</dt>
            <dd className="num text-right font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      {p.missingPrice.length > 0 && (
        <Notice tone="warning" className="mt-3" title={`ไม่มีราคาล่าสุด ${p.missingPrice.length} หลักทรัพย์: ${p.missingPrice.map(sym).join(', ')}`}>
          มูลค่าตลาดและกำไร/ขาดทุนด้านบนคำนวณเฉพาะหลักทรัพย์ที่มีราคา ตั้งค่า Market Data API หรือบันทึกราคาเองได้ที่หน้าตลาดหุ้น
        </Notice>
      )}
    </div>
  )
}

export function OverviewView({ s, timezone, generatedAt, name }: { s: Snapshot; timezone: string; generatedAt: string; name: string }) {
  const [view, setView] = useState<View>('combined')
  const sym = (id: string) => s.securities.find((x) => x.id === id)?.symbol ?? '?'
  const c = s.portfolios.combined
  const months = s.months.slice(-24)

  const byCategory = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of c.positions) {
      if (p.marketValueBase === null) continue
      const cat = s.securities.find((x) => x.id === p.securityId)?.category ?? 'Other'
      m.set(cat, (m.get(cat) ?? 0) + p.marketValueBase)
    }
    return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)
  }, [c.positions, s.securities])

  const pricesAsOf = c.positions.map((p) => p.price?.asOf).filter(Boolean).sort().pop()
  const isEmpty = s.securities.length === 0 && s.accounts.length === 0 && s.liabilities.length === 0 && s.months.length === 0

  return (
    <div className="space-y-5">
      <PageHeader
        title={name ? `ภาพรวมการเงินของ ${name}` : 'ภาพรวมการเงิน'}
        subtitle={
          <>
            คำนวณจากฐานข้อมูลเมื่อ {fmtDateTime(generatedAt, timezone)}
            {pricesAsOf && <> · ราคาหุ้นล่าสุด ณ {fmtDateTime(pricesAsOf, timezone)}</>}
            {s.fx.USD && <> · USD/THB {s.fx.USD.rate} ({s.fx.USD.date})</>}
          </>
        }
      />

      {isEmpty && (
        <Notice tone="info" title="เริ่มต้นใช้งาน">
          1) เพิ่มบัญชีเงินสด/ธนาคารและยอดยกมาที่หน้า <Link className="text-accent underline" href="/money?tab=cash">บริหารเงิน</Link> · 2) เพิ่มหุ้นที่ถือและบันทึกการซื้อที่หน้า{' '}
          <Link className="text-accent underline" href="/portfolio">พอร์ตหุ้น</Link> · 3) บันทึกรายรับ รายจ่าย และหนี้สิน แล้วตัวเลขทุกหน้าจะคำนวณจากข้อมูลชุดเดียวกัน
        </Notice>
      )}

      {s.alerts.length > 0 && (
        <Card title={`การแจ้งเตือน (${s.alerts.length})`} subtitle="ปิด/เปิดการแจ้งเตือนแต่ละประเภทได้ที่หน้า Settings" pad={false}>
          <AlertList alerts={s.alerts} limit={8} />
        </Card>
      )}

      <section aria-label="สรุปตัวเลขสำคัญ" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="มูลค่าพอร์ตหุ้นที่ถือจริง" value={fmtMoney(c.marketValueBase)} sub={c.complete ? `${c.positions.length} หลักทรัพย์` : `ไม่รวม ${c.missingPrice.length + c.missingFx.length} รายการที่ไม่มีราคา`} tone={c.complete ? undefined : 'warn'} hint={DEFINITIONS[0].detail} />
        <Stat label="ต้นทุนหุ้นที่ยังถืออยู่" value={fmtMoney(c.costBasisBase)} sub="Weighted Average Cost" hint="ต้นทุนเฉลี่ยถ่วงน้ำหนักของหุ้นที่ยังถืออยู่ รวมค่าธรรมเนียมซื้อ คิดเป็นบาทตามอัตราแลกเปลี่ยน ณ วันที่ซื้อ" />
        <Stat label="กำไร/ขาดทุนที่ยังไม่รับรู้" value={<PnL value={c.unrealizedPnlBase} />} tone={toneOf(c.unrealizedPnlBase)} sub={c.complete ? undefined : 'เฉพาะหลักทรัพย์ที่มีราคา'} hint={DEFINITIONS[1].detail} />
        <Stat label="ผลตอบแทน (%)" value={fmtPct(c.unrealizedPct, 2, true)} tone={toneOf(c.unrealizedPct)} sub={<>ผลตอบแทนรวม <PnL value={c.totalReturnBase} /></>} hint="กำไร/ขาดทุนที่ยังไม่รับรู้ ÷ ต้นทุนของหุ้นที่ยังถืออยู่ × 100 (ไม่รวมเงินปันผล) ส่วน 'ผลตอบแทนรวม' รวมกำไรที่รับรู้แล้วและเงินปันผลสุทธิ" />
        <Stat label="เงินปันผลที่ได้รับ" value={fmtMoney(c.dividendsNetBase)} sub="สุทธิหลังภาษีหัก ณ ที่จ่าย" hint="แสดงแยกจากกำไร/ขาดทุนของราคาหุ้น" />
        <Stat label="เงินสดและเงินในบัญชี" value={fmtMoney(s.cash.totalCashBase)} sub={`พร้อมใช้ ${fmtMoney(s.cash.generalCashBase)} · โบรกเกอร์ ${fmtMoney(s.cash.brokerageCashBase)}`} hint={DEFINITIONS[3].detail} />
        <Stat
          label="เงินสำรองฉุกเฉิน"
          value={fmtMoney(s.emergency.current)}
          tone={s.emergency.gap !== null && s.emergency.gap > 0 ? 'warn' : undefined}
          sub={s.emergency.target === null ? 'ยังไม่มีข้อมูลค่าใช้จ่ายจำเป็น' : `เป้าหมาย ${fmtMoney(s.emergency.target)} · ${s.emergency.coverageMonths!.toFixed(1)} เดือน`}
          hint={DEFINITIONS[7].detail}
        />
        <Stat label="หนี้สินคงเหลือ" value={fmtMoney(s.debt.total)} tone={s.debt.overdue > 0 ? 'loss' : undefined} sub={s.debt.overdue > 0 ? `เกินกำหนด ${fmtMoney(s.debt.overdue)}` : s.debt.accruedInterest > 0 ? `รวมดอกเบี้ยค้างโดยประมาณ ${fmtMoney(s.debt.accruedInterest)}` : undefined} hint={DEFINITIONS[4].detail} />
        <Stat label="ทรัพย์สินสุทธิ" value={fmtMoney(s.netWorth.value)} tone={s.netWorth.complete ? toneOf(s.netWorth.value) : 'warn'} sub={s.netWorth.complete ? `ทรัพย์สิน ${fmtMoney(s.netWorth.assets)} − หนี้ ${fmtMoney(s.netWorth.liabilities)}` : 'ไม่ครบ: บางรายการไม่มีราคาหรืออัตราแลกเปลี่ยน'} hint={DEFINITIONS[5].detail} />
        <Stat label="เงินที่พร้อมใช้เดือนนี้" value={fmtMoney(s.availableThisMonth)} tone={s.availableThisMonth < 0 ? 'loss' : undefined} sub={`หลังหักบิลค้าง ${fmtMoney(s.expenses.unpaidDue)} และหนี้ขั้นต่ำ ${fmtMoney(s.debt.dueThisMonth)}`} hint={DEFINITIONS[6].detail} />
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card title="พอร์ตการลงทุน" subtitle="DCA ที่ยังเป็นแผนไม่ถูกนับจนกว่าจะบันทึกการซื้อจริง · มุมมองรวมไม่นับหุ้นตัวเดียวกันซ้ำ">
          <Tabs<View> tabs={(['combined', 'main', 'dca'] as View[]).map((id) => ({ id, label: VIEW_LABEL[id] }))} value={view} onChange={setView} />
          <PortfolioBlock p={s.portfolios[view]} s={s} invested={s.investedThisMonth[view]} name={VIEW_LABEL[view]} />
        </Card>

        <Card title={`การเงินเดือนนี้ (${fmtMonth(s.month)})`}>
          <dl className="space-y-2 text-sm">
            {[
              ['รายรับที่ได้รับจริง', fmtMoney(s.income.receivedThisMonth), s.income.expectedThisMonth > 0 ? `+ คาดว่าจะได้รับ ${fmtMoney(s.income.expectedThisMonth)}` : null],
              ['รายจ่ายที่จ่ายแล้ว', fmtMoney(s.expenses.paidThisMonth), s.expenses.unpaidDue > 0 ? `ค้างจ่าย ${fmtMoney(s.expenses.unpaidDue)}` : null],
              ['หนี้ที่ต้องชำระเดือนนี้ (คงเหลือ)', fmtMoney(s.debt.dueThisMonth), s.debt.paidThisMonth > 0 ? `ชำระแล้ว ${fmtMoney(s.debt.paidThisMonth)}` : null],
              ['เงินที่ลงทุนจริงเดือนนี้', fmtMoney(s.investedThisMonth.combined), null],
              ['เงินออมสะสม (สำรอง + เป้าหมาย)', fmtMoney(s.savings), null],
              ['เงินคงเหลือที่ใช้ได้', fmtMoney(s.availableThisMonth), null],
            ].map(([k, v, sub]) => (
              <div key={k as string} className="flex items-start justify-between gap-3 border-b border-line/70 pb-2">
                <dt className="text-muted">{k}</dt>
                <dd className="text-right">
                  <span className="num font-medium">{v}</span>
                  {sub && <span className="block text-xs text-muted">{sub}</span>}
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-4 space-y-3">
            <div>
              <div className="mb-1 flex justify-between text-xs text-muted">
                <span>เงินสำรองเทียบเป้าหมาย</span>
                <span className="num">{s.emergency.target ? fmtPct((s.emergency.current / s.emergency.target) * 100, 0) : 'ยังไม่มีเป้าหมาย'}</span>
              </div>
              <ProgressBar value={s.emergency.current} max={s.emergency.target ?? 0} tone={s.emergency.gap !== null && s.emergency.gap > 0 ? 'warn' : 'gain'} />
            </div>
            {s.goals
              .filter((g) => g.status === 'active')
              .map((g) => (
                <div key={g.id}>
                  <div className="mb-1 flex justify-between text-xs text-muted">
                    <span>เป้าหมาย: {g.name}</span>
                    <span className="num">
                      {fmtMoney(g.saved)} / {fmtMoney(g.targetAmount)}
                    </span>
                  </div>
                  <ProgressBar value={g.saved} max={g.targetAmount} tone={g.saved >= g.targetAmount ? 'gain' : 'accent'} />
                </div>
              ))}
            {s.goals.length === 0 && (
              <p className="text-xs text-muted">
                ยังไม่มีเป้าหมายการออม <Link href="/money?tab=cash" className="text-accent hover:underline">เพิ่มเป้าหมาย</Link>
              </p>
            )}
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="มูลค่าพอร์ตตามเวลา" subtitle="ต้นทุนคำนวณจากธุรกรรม · มูลค่าใช้ราคาปิดสิ้นเดือนที่ระบบมี (ช่องว่าง = ไม่มีราคาครบทุกตัว)">
          <LineSeriesChart
            data={months}
            xKey="month"
            xFormat={fmtMonth}
            series={[
              { key: 'portfolioCost', label: 'ต้นทุน', color: SEMANTIC.neutral, dashed: true },
              { key: 'portfolioValue', label: 'มูลค่าตลาด', color: SEMANTIC.accent },
            ]}
            empty="ยังไม่มีธุรกรรมการลงทุน"
          />
        </Card>
        <Card title="ทรัพย์สินสุทธิรายเดือน" subtitle="เงินสด + ทรัพย์สินอื่น + มูลค่าพอร์ต − หนี้สิน ณ สิ้นเดือน">
          <LineSeriesChart data={months} xKey="month" xFormat={fmtMonth} series={[{ key: 'netWorth', label: 'ทรัพย์สินสุทธิ', color: SEMANTIC.accent }]} empty="ยังไม่มีข้อมูลเพียงพอ" />
        </Card>
        <Card title="สัดส่วนการลงทุนรายหุ้น" subtitle="ตามมูลค่าตลาด (เฉพาะที่มีราคา)">
          <DonutChart data={c.positions.filter((p) => p.marketValueBase !== null).map((p) => ({ label: sym(p.securityId), value: p.marketValueBase! }))} empty="ยังไม่มีหุ้นที่มีราคาตลาด" />
        </Card>
        <Card title="สัดส่วนรายหมวดธุรกิจ">
          <DonutChart data={byCategory} empty="ยังไม่มีหุ้นที่มีราคาตลาด" />
        </Card>
        <Card title="รายรับเทียบรายจ่ายรายเดือน" subtitle="เฉพาะรายการที่ได้รับ/จ่ายจริง">
          <BarSeriesChart
            data={months}
            xKey="month"
            xFormat={fmtMonth}
            series={[
              { key: 'income', label: 'รายรับ', color: SEMANTIC.gain },
              { key: 'expense', label: 'รายจ่าย', color: SEMANTIC.loss },
            ]}
            empty="ยังไม่มีรายรับหรือรายจ่าย"
          />
        </Card>
        <Card title="เงินลงทุนรายเดือน" subtitle="ยอดซื้อจริงรวมค่าธรรมเนียม (บาท ณ อัตราวันที่ซื้อ)">
          <BarSeriesChart data={months} xKey="month" xFormat={fmtMonth} series={[{ key: 'invested', label: 'เงินลงทุน', color: SEMANTIC.accent }]} empty="ยังไม่มีการซื้อหุ้น" />
        </Card>
        <Card title="หนี้สินคงเหลือตามเวลา">
          <LineSeriesChart data={months} xKey="month" xFormat={fmtMonth} series={[{ key: 'debt', label: 'หนี้คงเหลือ', color: SEMANTIC.loss }]} empty="ไม่มีหนี้สินที่บันทึกไว้" />
        </Card>
        <Card title="เงินสำรองเทียบเป้าหมาย">
          <LineSeriesChart
            data={months}
            xKey="month"
            xFormat={fmtMonth}
            series={[{ key: 'emergency', label: 'เงินสำรองฉุกเฉิน', color: SEMANTIC.gain }]}
            reference={s.emergency.target ? { value: s.emergency.target, label: `เป้าหมาย ${fmtMoney(s.emergency.target, 'THB', 0)}` } : undefined}
            empty="ยังไม่มีบัญชีเงินสำรอง"
          />
        </Card>
      </div>

      <Card title="วิธีคำนวณตัวเลข" subtitle="ทุกหน้าใช้สูตรกลางชุดเดียวกันจากฐานข้อมูลเดียวกัน">
        <DefinitionList items={DEFINITIONS} />
        {s.cash.missingFx.length > 0 && (
          <Notice tone="warning" className="mt-3">
            <Wallet size={14} className="mr-1 inline" />
            ยอดในสกุล {s.cash.missingFx.join(', ')} ยังไม่ถูกรวมเพราะไม่มีอัตราแลกเปลี่ยน
          </Notice>
        )}
      </Card>
    </div>
  )
}
