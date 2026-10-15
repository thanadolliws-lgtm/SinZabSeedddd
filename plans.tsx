'use client'

/** DCA plan cards (6.1 / 6.2). Plan figures and actual purchases are shown in separate boxes. */
import type { ReactNode } from 'react'
import { CalendarClock, Pencil, Plus, Trash2 } from 'lucide-react'
import { deleteDcaPlanAction } from '@/actions/app'
import { addMonths, monthOf } from '@/lib/calc/money'
import type { DcaPlanView, Snapshot } from '@/lib/calc/snapshot'
import type { LedgerTx, RawData } from '@/lib/calc/types'
import { useAction } from '@/components/forms'
import { Badge, Button, Card, EmptyState, IconButton, Notice, cx, useFeedback } from '@/components/ui'
import { fmtDate, fmtMoney, fmtMonth, fmtNum, fmtPct } from '@/lib/format'
import { FREQUENCY, OBJECTIVE, PLAN_STATUS, RISK, orderSplit, periodLabel, referenceMonth, scheduleText } from './shared'

export function PlansSection({ s, raw, onNew, onEdit }: { s: Snapshot; raw: RawData; onNew: () => void; onEdit: (pv: DcaPlanView) => void }) {
  const { confirm } = useFeedback()
  const remove = useAction(deleteDcaPlanAction, { success: 'ลบแผนแล้ว ธุรกรรมที่ซื้อจริงยังอยู่ในพอร์ต DCA' })
  const txById = new Map<string, LedgerTx>(raw.transactions.map((t) => [t.id, t]))

  if (s.dcaPlans.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<CalendarClock size={28} />}
          title="ยังไม่มีแผน DCA"
          description="กำหนดงบต่อเดือน/สัปดาห์ ความถี่ และสัดส่วนของแต่ละหลักทรัพย์ ระบบจะคำนวณยอดต่อหุ้นและค่าธรรมเนียมโดยประมาณให้ แผนไม่ถูกนับเป็นเงินลงทุนจนกว่าจะบันทึกการซื้อจริง"
          action={
            <Button variant="primary" icon={<Plus size={15} />} onClick={onNew}>
              สร้างแผน DCA
            </Button>
          }
        />
      </Card>
    )
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {s.dcaPlans.map((pv) => {
        const p = pv.plan
        const ccy = p.budgetCurrency
        const sym = (id: string) => s.securities.find((x) => x.id === id)?.symbol ?? '?'
        const split = orderSplit(p, pv.allocations, referenceMonth(p, s.month))
        const linked = raw.dcaSchedule
          .filter((r) => r.planId === p.id && r.status === 'executed' && r.transactionId)
          .map((r) => txById.get(r.transactionId!))
          .filter((t): t is LedgerTx => !!t)
        const costBase = (list: LedgerTx[]) => list.reduce((a, t) => a + (t.amount + t.fee) * t.fxRate, 0)
        const linkedThisMonth = linked.filter((t) => monthOf(t.tradeDate) === s.month)
        const startMonth = monthOf(p.startDate)
        return (
          <Card
            key={p.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {p.name}
                <Badge tone={PLAN_STATUS[p.status].tone}>{PLAN_STATUS[p.status].label}</Badge>
              </span>
            }
            subtitle={`${FREQUENCY[p.frequency]} · ${scheduleText(p)}`}
            actions={
              <div className="flex">
                <IconButton label="แก้ไขแผน" onClick={() => onEdit(pv)}>
                  <Pencil size={15} />
                </IconButton>
                <IconButton
                  label="ลบแผน"
                  disabled={remove.pending}
                  onClick={async () => {
                    const ok = await confirm({
                      title: `ลบแผน "${p.name}"?`,
                      message: 'แผนและตารางลงทุนของแผนนี้ (รวมรายการที่ยังรอซื้อ) จะถูกลบ ส่วนธุรกรรมที่บันทึกการซื้อจริงไปแล้วยังอยู่ในพอร์ต DCA ตามเดิม ต้นทุนและกำไร/ขาดทุนไม่เปลี่ยน',
                      confirmLabel: 'ลบแผน',
                      danger: true,
                    })
                    if (ok) await remove.run({ id: p.id })
                  }}
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
            }
          >
            <div className="space-y-4">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
                <Item
                  label={`งบต่อ${periodLabel(p.frequency)} (แผน)`}
                  value={fmtMoney(p.budgetAmount, ccy)}
                  sub={p.frequency === 'weekly' ? `≈ ${fmtMoney(pv.monthlyEquivalent, ccy)} ต่อเดือน` : p.frequency === 'daily' && split.days ? `เฉลี่ยวันละ ≈ ${fmtMoney(split.perOrder, ccy)} (${split.days} วัน)` : undefined}
                />
                <Item label="เริ่ม / ระยะเวลา" value={fmtDate(p.startDate)} sub={p.durationMonths ? `${p.durationMonths} เดือน (ถึง ${fmtMonth(addMonths(startMonth, p.durationMonths - 1))})` : 'ไม่กำหนดวันสิ้นสุด'} />
                <Item label="ความเสี่ยงที่รับได้" value={RISK[p.riskLevel]} />
                <Item label="เป้าหมาย" value={OBJECTIVE[p.objective]} />
                <Item label="ขั้นต่ำต่อรายการ" value={p.minInvestment > 0 ? fmtMoney(p.minInvestment, ccy) : 'ไม่มี'} />
                <Item label="ค่าธรรมเนียม" value={`${fmtNum(p.feePct, 2)}%`} sub={`ขั้นต่ำ ${fmtMoney(p.feeMin, ccy)} ต่อคำสั่ง`} />
                <Item label="เศษหุ้น (Fractional)" value={p.allowFractional ? 'ซื้อได้' : 'ไม่ได้ ซื้อหุ้นเต็มเท่านั้น'} />
              </dl>

              <div>
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-muted">สัดส่วนและยอด{p.frequency === 'daily' ? 'เฉลี่ยต่อวัน' : `ต่อ${periodLabel(p.frequency)}`} (แผน)</h3>
                  <span className={cx('num text-xs font-semibold', pv.check.ok ? 'text-gain' : 'text-loss')}>
                    รวม {fmtNum(pv.check.total, 2)}%{!pv.check.ok && pv.allocations.length > 0 && ` (${pv.check.diff > 0 ? `ขาด ${fmtNum(pv.check.diff, 2)}%` : `เกิน ${fmtNum(-pv.check.diff, 2)}%`})`}
                  </span>
                </div>
                {pv.allocations.length === 0 ? (
                  <p className="text-xs text-muted">ยังไม่มีหลักทรัพย์ในแผน</p>
                ) : (
                  <ul className="divide-y divide-line/70 rounded-lg border border-line text-sm">
                    {split.amounts.map((a) => (
                      <li key={a.securityId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-1.5">
                        <span className="flex items-center gap-2">
                          <span className="font-medium">{sym(a.securityId)}</span>
                          <span className="num text-xs text-muted">{fmtPct(a.targetPct, 2)}</span>
                        </span>
                        <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs">
                          <span className="num font-medium">{fmtMoney(a.amount, ccy)}</span>
                          <span className="num text-muted">
                            ค่าธรรมเนียม ≈ {fmtMoney(a.estFee, ccy)}
                            {a.feeDragPct !== null && ` (${fmtPct(a.feeDragPct, 2)})`}
                          </span>
                          {a.belowMinimum && <Badge tone="warn">ต่ำกว่าขั้นต่ำ</Badge>}
                          {a.feeDragPct !== null && a.feeDragPct > 1 && <Badge tone="warn">ค่าธรรมเนียมเกิน 1%</Badge>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {!pv.check.ok && (
                  <Notice tone="warning" className="mt-2">
                    แผนเป็นแบบร่างเพราะสัดส่วนรวมไม่เท่ากับ 100% ยอดด้านบนเป็นเพียงการเทียบสัดส่วน และยังสร้างตารางลงทุนไม่ได้ กดแก้ไขเพื่อปรับสัดส่วน
                  </Notice>
                )}
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-dashed border-line p-3 text-xs">
                  <div className="mb-1 flex items-center gap-1.5 font-medium">
                    <Badge tone="neutral">แผน</Badge> ตารางเดือน {fmtMonth(s.month)}
                  </div>
                  {pv.monthPlanned > 0 ? (
                    <div className="num space-y-0.5 text-muted">
                      <div>
                        ตามตาราง <span className="text-text">{fmtMoney(pv.monthPlanned, ccy)}</span>
                      </div>
                      <div>
                        รอซื้อ <span className="text-text">{fmtMoney(pv.monthPending, ccy)}</span> · ข้าม {fmtMoney(pv.monthSkipped, ccy)}
                      </div>
                      <div>ซื้อแล้วตามยอดแผน {fmtMoney(pv.monthExecuted, ccy)}</div>
                    </div>
                  ) : (
                    <div className="text-muted">ยังไม่ได้สร้างตารางของเดือนนี้ (ดูแท็บปฏิทิน DCA)</div>
                  )}
                </div>
                <div className="rounded-lg border border-line bg-surface-2/40 p-3 text-xs">
                  <div className="mb-1 flex items-center gap-1.5 font-medium">
                    <Badge tone="accent">ซื้อจริง</Badge> ผ่านตารางของแผนนี้
                  </div>
                  <div className="num space-y-0.5 text-muted">
                    <div>
                      เดือนนี้ <span className="text-text">{fmtMoney(costBase(linkedThisMonth), s.baseCurrency)}</span> ({linkedThisMonth.length} รายการ)
                    </div>
                    <div>
                      ทั้งหมด <span className="text-text">{fmtMoney(costBase(linked), s.baseCurrency)}</span> ({linked.length} รายการ)
                    </div>
                    <div>ต้นทุนจริงรวมค่าธรรมเนียม คิดเป็น {s.baseCurrency} ณ วันที่ซื้อ</div>
                  </div>
                </div>
              </div>
              {p.note && <p className="text-xs text-muted">หมายเหตุ: {p.note}</p>}
            </div>
          </Card>
        )
      })}
    </div>
  )
}

function Item({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-medium">{value}</dd>
      {sub && <dd className="text-xs text-muted">{sub}</dd>}
    </div>
  )
}
