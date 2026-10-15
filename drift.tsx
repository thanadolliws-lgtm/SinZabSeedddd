'use client'

/** Allocation drift: target % of each active plan vs the actual % held in the DCA portfolio (from Snapshot.dcaPlans[].drift). */
import { Scale } from 'lucide-react'
import type { DcaPlanView, Snapshot } from '@/lib/calc/snapshot'
import { Badge, Card, EmptyState, Notice, cx } from '@/components/ui'
import { fmtNum, fmtPct } from '@/lib/format'

/** Why drift is null, mirroring the conditions the snapshot uses. */
function driftReason(pv: DcaPlanView, s: Snapshot): string {
  if (!pv.check.ok) return `สัดส่วนเป้าหมายรวม ${fmtNum(pv.check.total, 2)}% ไม่เท่ากับ 100%`
  const sym = (id: string) => s.securities.find((x) => x.id === id)?.symbol ?? '?'
  const held = pv.allocations.map((a) => s.portfolios.dca.positions.find((p) => p.securityId === a.securityId) ?? null)
  if (!held.some(Boolean)) return 'ยังไม่มีหุ้นของแผนนี้ในพอร์ต DCA (ยังไม่ได้บันทึกการซื้อจริง) จึงยังไม่มีสัดส่วนจริงให้เทียบ'
  const unpriced = held.filter((p) => p !== null && p.marketValueBase === null).map((p) => `${sym(p!.securityId)} (${p!.status === 'no_fx' ? 'ไม่มีอัตราแลกเปลี่ยน' : 'ไม่มีราคาปัจจุบัน'})`)
  if (unpriced.length) return `ขาดข้อมูลมูลค่าตลาดของ ${unpriced.join(', ')} จึงคำนวณสัดส่วนจริงไม่ได้ (ระบบไม่เดาราคา) บันทึกราคาเองหรืออัปเดตข้อมูลตลาดก่อน`
  return 'มูลค่าตลาดรวมของหุ้นในแผนเป็นศูนย์ จึงคำนวณสัดส่วนไม่ได้'
}

export function DriftSection({ s, threshold }: { s: Snapshot; threshold: number }) {
  const active = s.dcaPlans.filter((p) => p.plan.status === 'active')
  const sym = (id: string) => s.securities.find((x) => x.id === id)?.symbol ?? '?'
  if (active.length === 0) {
    return (
      <Card>
        <EmptyState icon={<Scale size={28} />} title="ยังไม่มีแผน DCA ที่ใช้งาน" description="สัดส่วนเทียบเป้าหมายคำนวณเฉพาะแผนที่ใช้งาน (Active) และมีการซื้อจริงในพอร์ต DCA แล้ว" />
      </Card>
    )
  }
  return (
    <div className="space-y-4">
      <Notice tone="info">
        สัดส่วนจริง = มูลค่าตลาดของหุ้นแต่ละตัวในแผน ÷ มูลค่าตลาดรวมของหุ้นในแผนนั้นที่ถืออยู่ในพอร์ต DCA (คิดเป็นบาทตามราคาและอัตราแลกเปลี่ยนล่าสุด) คำนวณจากการซื้อจริงเท่านั้น ไม่รวมรายการที่ยังเป็นแผน · เกณฑ์แจ้งเตือน ±{fmtNum(threshold, 1)}% ตั้งค่าได้ที่หน้า Settings
      </Notice>
      {active.map((pv) => (
        <Card key={pv.plan.id} title={pv.plan.name} subtitle="เป้าหมาย (Target) เทียบสัดส่วนจริง (Actual)">
          {pv.drift ? (
            <ul className="space-y-3">
              {pv.drift.map((d) => {
                const over = Math.abs(d.diff) > threshold
                return (
                  <li key={d.securityId}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
                      <span className="font-medium">{sym(d.securityId)}</span>
                      <span className="num flex flex-wrap items-center gap-x-3 text-xs">
                        <span className="text-muted">เป้าหมาย {fmtPct(d.targetPct, 1)}</span>
                        <span>จริง {fmtPct(d.actualPct, 1)}</span>
                        <span className={cx('font-semibold', over ? 'text-warn' : 'text-muted')}>ต่าง {fmtPct(d.diff, 1, true)}</span>
                        {over && <Badge tone="warn">{d.diff > 0 ? 'สูงกว่าเป้าหมาย' : 'ต่ำกว่าเป้าหมาย'}เกิน {fmtNum(threshold, 1)}%</Badge>}
                      </span>
                    </div>
                    <div className="mt-1 space-y-1" aria-hidden="true">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                        <div className="h-full rounded-full bg-neutral" style={{ width: `${Math.min(100, Math.max(0, d.targetPct))}%` }} />
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
                        <div className={cx('h-full rounded-full', over ? 'bg-warn' : 'bg-accent')} style={{ width: `${Math.min(100, Math.max(0, d.actualPct))}%` }} />
                      </div>
                    </div>
                  </li>
                )
              })}
              <li className="flex flex-wrap gap-4 pt-1 text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-1.5 w-4 rounded-full bg-neutral" /> เป้าหมาย (แผน)
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-4 rounded-full bg-accent" /> สัดส่วนจริงในพอร์ต DCA
                </span>
              </li>
            </ul>
          ) : (
            <p className="text-sm text-muted">ยังคำนวณไม่ได้: {driftReason(pv, s)}</p>
          )}
        </Card>
      ))}
    </div>
  )
}
