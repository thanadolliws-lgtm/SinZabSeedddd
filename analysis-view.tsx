'use client'

import Link from 'next/link'
import { CircleAlert, Lightbulb, Minus, ShieldCheck, TrendingDown, TrendingUp, Layers, Info } from 'lucide-react'
import { RECOMMENDATION_LABELS, type Analysis, type Recommendation, type RecommendationKind } from '@/lib/calc/analysis'
import type { Snapshot } from '@/lib/calc/snapshot'
import type { SettingsRow } from '@/lib/calc/types'
import { DonutChart } from '@/components/charts'
import { Badge, Card, EmptyState, Notice, PageHeader, ProgressBar, Stat } from '@/components/ui'
import { fmtMoney, fmtNum, fmtPct } from '@/lib/format'

const KIND: Record<RecommendationKind, { tone: 'loss' | 'warn' | 'gain' | 'accent' | 'neutral'; icon: React.ReactNode }> = {
  fix_first: { tone: 'loss', icon: <CircleAlert size={16} className="text-loss" /> },
  reduce: { tone: 'warn', icon: <TrendingDown size={16} className="text-warn" /> },
  increase: { tone: 'gain', icon: <TrendingUp size={16} className="text-gain" /> },
  diversify: { tone: 'accent', icon: <Layers size={16} className="text-accent" /> },
  hold: { tone: 'neutral', icon: <Minus size={16} className="text-neutral" /> },
  info: { tone: 'neutral', icon: <Info size={16} className="text-muted" /> },
}

function RecCard({ r }: { r: Recommendation }) {
  return (
    <article className="rounded-xl border border-line bg-surface p-4">
      <header className="flex items-start gap-2">
        <span className="mt-0.5">{KIND[r.kind].icon}</span>
        <div className="min-w-0">
          <Badge tone={KIND[r.kind].tone}>{RECOMMENDATION_LABELS[r.kind]}</Badge>
          <h3 className="mt-1 font-medium">{r.title}</h3>
        </div>
      </header>
      <p className="mt-2 text-sm leading-relaxed">{r.reason}</p>
      <div className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
        {[
          ['ข้อมูลที่ใช้', r.data],
          ['สมมติฐาน', r.assumptions],
          ['ความเสี่ยง / ข้อควรพิจารณา', r.risks],
        ].map(([label, items]) => (
          <div key={label as string}>
            <div className="mb-1 font-medium text-muted">{label as string}</div>
            {(items as string[]).length === 0 ? (
              <div className="text-muted">—</div>
            ) : (
              <ul className="list-disc space-y-0.5 pl-4">
                {(items as string[]).map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </article>
  )
}

export function AnalysisView({ s, analysis, settings }: { s: Snapshot; analysis: Analysis; settings: SettingsRow }) {
  const sym = (id: string) => s.securities.find((x) => x.id === id)?.symbol ?? '?'
  const held = s.portfolios.combined.positions.length
  const foreign = analysis.byCurrency.filter((c) => c.key !== s.baseCurrency).reduce((a, c) => a + c.weight, 0)
  const top = analysis.byPosition[0]

  return (
    <div className="space-y-5">
      <PageHeader title="วิเคราะห์และแนะนำการปรับพอร์ต" subtitle="ข้อสังเกตจากข้อมูลจริงที่คุณบันทึกและข้อมูลตลาดที่ระบบมี เพื่อช่วยตัดสินใจ ไม่ใช่คำสั่งซื้อขาย" />
      <Notice tone="warning" title="ไม่ใช่คำแนะนำการลงทุนรายบุคคล">
        ระบบไม่ทำนายราคาหุ้น ไม่รับประกันการเติบโตของพอร์ต และไม่ซื้อหรือขายให้อัตโนมัติ ทุกข้อด้านล่างแสดงเหตุผล ข้อมูลที่ใช้ สมมติฐาน และความเสี่ยง เพื่อให้คุณพิจารณาเอง
      </Notice>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="จำนวนหลักทรัพย์ที่ถือ" value={String(held)} sub={analysis.complete ? 'ข้อมูลราคาครบ' : 'ข้อมูลราคาไม่ครบ'} tone={analysis.complete ? undefined : 'warn'} />
        <Stat label="สัดส่วนสูงสุดรายตัว" value={top ? `${top.label} ${fmtPct(top.weight, 1)}` : '—'} tone={top && top.weight > settings.maxPositionPct ? 'warn' : undefined} sub={`เกณฑ์ ${settings.maxPositionPct}%`} />
        <Stat label="สัดส่วนสกุลเงินต่างประเทศ" value={fmtPct(foreign, 1)} sub="ความเสี่ยงอัตราแลกเปลี่ยน" />
        <Stat label="ค่าธรรมเนียมสะสม / เงินลงทุน" value={analysis.feeRatioPct === null ? '—' : fmtPct(analysis.feeRatioPct, 2)} tone={analysis.feeRatioPct !== null && analysis.feeRatioPct > 1 ? 'warn' : undefined} />
      </section>

      <Card title="ความพร้อมก่อนลงทุนเพิ่ม" subtitle="เงินสำรองและภาระหนี้">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1 flex justify-between text-sm">
              <span>เงินสำรองฉุกเฉิน</span>
              <span className="num">{s.emergency.target ? `${fmtMoney(s.emergency.current)} / ${fmtMoney(s.emergency.target)}` : 'ยังไม่มีเป้าหมาย'}</span>
            </div>
            <ProgressBar value={s.emergency.current} max={s.emergency.target ?? 0} tone={s.emergency.gap !== null && s.emergency.gap > 0 ? 'warn' : 'gain'} />
            <p className="mt-1 text-xs text-muted">{s.emergency.coverageMonths !== null ? `ครอบคลุมค่าใช้จ่ายจำเป็น ${fmtNum(s.emergency.coverageMonths, 1)} เดือน จากเป้าหมาย ${s.emergency.targetMonths} เดือน` : 'ต้องมีข้อมูลค่าใช้จ่ายจำเป็นก่อน'}</p>
          </div>
          <div className="text-sm">
            <div className="flex justify-between">
              <span>หนี้คงเหลือ</span>
              <span className="num">{fmtMoney(s.debt.total)}</span>
            </div>
            <div className="flex justify-between">
              <span>หนี้เกินกำหนด</span>
              <span className={`num ${s.debt.overdue > 0 ? 'text-loss' : ''}`}>{fmtMoney(s.debt.overdue)}</span>
            </div>
            <div className="flex justify-between">
              <span>หนี้ดอกเบี้ยตั้งแต่ {settings.highInterestRate}%</span>
              <span className="num">{s.liabilities.filter((l) => l.highInterest).length} รายการ</span>
            </div>
            {s.debt.overdue <= 0 && !s.liabilities.some((l) => l.highInterest) && (s.emergency.gap === null || s.emergency.gap <= 0) && s.emergency.target !== null && (
              <p className="mt-2 flex items-center gap-1 text-xs text-gain">
                <ShieldCheck size={14} /> ไม่มีหนี้ค้างหรือหนี้ดอกเบี้ยสูง และเงินสำรองถึงเป้าหมาย
              </p>
            )}
          </div>
        </div>
      </Card>

      <section aria-label="ข้อเสนอแนะ" className="space-y-3">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Lightbulb size={18} /> ข้อเสนอแนะ ({analysis.recommendations.length})
        </h2>
        {analysis.recommendations.length === 0 ? (
          <Card>
            <EmptyState title="ยังไม่มีข้อมูลเพียงพอสำหรับการวิเคราะห์" description="บันทึกหุ้นที่ถือ ราคา และข้อมูลการเงินก่อน แล้วระบบจะตรวจตามเกณฑ์ที่ตั้งไว้" action={<Link href="/portfolio" className="text-sm text-accent hover:underline">ไปที่พอร์ตหุ้น</Link>} />
          </Card>
        ) : (
          analysis.recommendations.map((r, i) => <RecCard key={`${r.kind}-${i}`} r={r} />)
        )}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="สัดส่วนรายหุ้น">
          <DonutChart data={analysis.byPosition.map((x) => ({ label: x.label, value: x.valueBase }))} empty="ยังไม่มีหุ้นที่มีราคา" />
        </Card>
        <Card title="สัดส่วนรายหมวดธุรกิจ">
          <DonutChart data={analysis.byCategory.map((x) => ({ label: x.label, value: x.valueBase }))} empty="ยังไม่มีหุ้นที่มีราคา" />
        </Card>
        <Card title="สัดส่วนตามสกุลเงิน">
          <DonutChart data={analysis.byCurrency.map((x) => ({ label: x.label, value: x.valueBase }))} empty="ยังไม่มีหุ้นที่มีราคา" />
        </Card>
        <Card title="กลุ่มสินทรัพย์ (ที่ผู้ใช้กำหนด)" subtitle="ใช้ตรวจการถือสินทรัพย์ซ้ำซ้อน: กำหนดได้ในหน้าแก้ไขหลักทรัพย์">
          <DonutChart data={analysis.byGroup.map((x) => ({ label: x.label, value: x.valueBase }))} empty="ยังไม่ได้กำหนดกลุ่มสินทรัพย์ให้หลักทรัพย์ที่ถือ" />
        </Card>
      </div>

      <Card title="ความสัมพันธ์ของผลตอบแทน (Correlation)" subtitle={analysis.correlationNote}>
        {analysis.correlations.length === 0 ? (
          <p className="text-sm text-muted">ยังไม่มีคู่ที่คำนวณได้ ข้อมูลราคาย้อนหลังจะถูกเก็บเมื่อระบบอัปเดตราคา (ต้องตั้งค่า Market Data API)</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-1 text-left font-medium">คู่หลักทรัพย์</th>
                  <th className="py-1 text-right font-medium">Correlation</th>
                  <th className="py-1 text-right font-medium">จำนวนวันที่ใช้</th>
                </tr>
              </thead>
              <tbody>
                {analysis.correlations.slice(0, 15).map((c) => (
                  <tr key={`${c.a}-${c.b}`} className="border-t border-line">
                    <td className="py-1.5">
                      {sym(c.a)} · {sym(c.b)}
                    </td>
                    <td className={`num py-1.5 text-right ${c.correlation >= 0.85 ? 'text-warn' : ''}`}>{fmtNum(c.correlation, 2)}</td>
                    <td className="num py-1.5 text-right text-muted">{c.observations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted">ค่าใกล้ 1 = เคลื่อนไหวไปทางเดียวกันมาก ค่าใกล้ 0 = ไม่สัมพันธ์กัน คำนวณจากผลตอบแทนรายวันในอดีต ซึ่งอาจเปลี่ยนแปลงได้</p>
          </div>
        )}
      </Card>
    </div>
  )
}
