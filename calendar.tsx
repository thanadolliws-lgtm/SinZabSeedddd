'use client'

/**
 * DCA calendar (6.4): the schedule of one month, grouped by date. Planned rows are
 * intentions; executed rows show the real linked transaction.
 */
import { useState } from 'react'
import { CalendarClock, CalendarPlus, ChevronLeft, ChevronRight, CircleCheck, RotateCcw, SkipForward, Trash2 } from 'lucide-react'
import { deleteScheduleRowAction, generateScheduleAction, setScheduleStatusAction } from '@/actions/app'
import { buildSchedule, type ScheduleBuild } from '@/lib/calc/dca'
import { addMonths, isoWeekday, monthOf } from '@/lib/calc/money'
import type { DcaPlanView, Snapshot } from '@/lib/calc/snapshot'
import type { DcaScheduleRow, LedgerTx, RawData } from '@/lib/calc/types'
import { useAction } from '@/components/forms'
import { Badge, Button, Card, Checkbox, EmptyState, IconButton, Input, Notice, Select, cx, useFeedback } from '@/components/ui'
import { fmtDate, fmtMoney, fmtMonth, fmtNum, fmtQty } from '@/lib/format'
import { PLAN_STATUS, SCHEDULE_STATUS, WEEKDAY_SHORT, fmtByCurrency, sumByCurrency } from './shared'

export function DcaCalendar({ s, raw, today, onExecute }: { s: Snapshot; raw: RawData; today: string; onExecute: (row: DcaScheduleRow) => void }) {
  const [month, setMonth] = useState(s.month)
  const [planFilter, setPlanFilter] = useState('')
  const [replace, setReplace] = useState<Record<string, boolean>>({})
  const [warnings, setWarnings] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const { confirm } = useFeedback()
  const gen = useAction(generateScheduleAction, {
    success: (d) => (!d ? 'สร้างตารางแล้ว' : d.created > 0 ? `สร้างตาราง ${d.created} รายการ จาก ${d.dates} วันลงทุน (เป็นแผน ยังไม่ใช่การซื้อจริง)` : 'ไม่มีรายการใหม่: วันและหุ้นเหล่านี้มีในตารางอยู่แล้ว'),
  })
  const skip = useAction(setScheduleStatusAction, { success: 'ข้ามรายการนี้แล้ว (ไม่มีการซื้อ)' })
  const restore = useAction(setScheduleStatusAction, { success: 'คืนสถานะเป็นรอซื้อแล้ว' })
  const remove = useAction(deleteScheduleRowAction, { success: 'ลบรายการออกจากตารางแล้ว' })

  const sym = (id: string) => s.securities.find((x) => x.id === id)?.symbol ?? '?'
  const planOf = (id: string) => s.dcaPlans.find((p) => p.plan.id === id)
  const txById = new Map<string, LedgerTx>(raw.transactions.map((t) => [t.id, t]))
  const plans = planFilter ? s.dcaPlans.filter((p) => p.plan.id === planFilter) : s.dcaPlans
  const monthRows = raw.dcaSchedule.filter((r) => monthOf(r.plannedDate) === month)
  const rows = planFilter ? monthRows.filter((r) => r.planId === planFilter) : monthRows
  const dates = [...new Set(rows.map((r) => r.plannedDate))].sort()
  const multiPlan = new Set(rows.map((r) => r.planId)).size > 1

  const money = (list: DcaScheduleRow[]) => sumByCurrency(list.map((r) => ({ amount: r.plannedAmount, currency: r.currency })))
  const executed = rows.filter((r) => r.status === 'executed')
  const linked = executed.map((r) => (r.transactionId ? txById.get(r.transactionId) : undefined)).filter((t): t is LedgerTx => !!t)
  const actualBase = linked.reduce((a, t) => a + (t.amount + t.fee) * t.fxRate, 0)

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id)
    try {
      await fn()
    } finally {
      setBusy(null)
    }
  }

  const generate = async (pv: DcaPlanView, plannedCount: number) => {
    const id = pv.plan.id
    const replacePlanned = !!replace[id] && plannedCount > 0
    if (replacePlanned) {
      const ok = await confirm({
        title: 'สร้างตารางใหม่แทนรายการที่รอซื้อ?',
        message: `รายการที่ยังรอซื้อ ${plannedCount} รายการของแผน "${pv.plan.name}" ในเดือน ${fmtMonth(month)} จะถูกลบและสร้างใหม่ตามแผนปัจจุบัน รายการที่ซื้อจริงแล้วหรือข้ามไว้จะไม่ถูกแตะ`,
        confirmLabel: 'สร้างใหม่',
      })
      if (!ok) return
    }
    await run(`gen:${id}`, async () => {
      const res = await gen.run({ planId: id, month, replacePlanned })
      if (res.ok) setWarnings((w) => ({ ...w, [`${id}:${month}`]: res.data?.warnings ?? [] }))
    })
  }

  const monthPicker = (
    <div className="flex flex-wrap items-center gap-1">
      <IconButton label="เดือนก่อนหน้า" onClick={() => setMonth(addMonths(month, -1))}>
        <ChevronLeft size={16} />
      </IconButton>
      <Input type="month" aria-label="เลือกเดือน" value={month} className="w-40" onChange={(e) => /^\d{4}-\d{2}$/.test(e.target.value) && setMonth(e.target.value)} />
      <IconButton label="เดือนถัดไป" onClick={() => setMonth(addMonths(month, 1))}>
        <ChevronRight size={16} />
      </IconButton>
      {month !== s.month && (
        <Button size="sm" variant="ghost" onClick={() => setMonth(s.month)}>
          เดือนนี้
        </Button>
      )}
      {s.dcaPlans.length > 1 && (
        <Select aria-label="กรองตามแผน" value={planFilter} className="w-auto min-w-36" onChange={(e) => setPlanFilter(e.target.value)}>
          <option value="">ทุกแผน</option>
          {s.dcaPlans.map((p) => (
            <option key={p.plan.id} value={p.plan.id}>
              {p.plan.name}
            </option>
          ))}
        </Select>
      )}
    </div>
  )

  return (
    <div className="space-y-4">
      <Card title={`ปฏิทิน DCA: ${fmtMonth(month)}`} subtitle="ตารางลงทุนคือแผน (Plan) · เงินถูกนับว่าลงทุนแล้วเมื่อบันทึกการซื้อจริงเท่านั้น" actions={monthPicker}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryBox label="แผนทั้งเดือน (Plan)" value={fmtByCurrency(money(rows), '฿0.00')} sub={`${rows.length} รายการ`} dashed />
          <SummaryBox label="รอซื้อ (Plan)" value={fmtByCurrency(money(rows.filter((r) => r.status === 'planned')), '฿0.00')} sub={`${rows.filter((r) => r.status === 'planned').length} รายการ`} dashed />
          <SummaryBox label="ข้าม (Skipped)" value={fmtByCurrency(money(rows.filter((r) => r.status === 'skipped')), '฿0.00')} sub={`${rows.filter((r) => r.status === 'skipped').length} รายการ`} dashed />
          <SummaryBox
            label="ซื้อจริงตามตาราง (Actual)"
            value={fmtMoney(actualBase, s.baseCurrency)}
            sub={`${executed.length} รายการ · ต้นทุนจริงรวมค่าธรรมเนียม${executed.length ? ` (ยอดตามแผน ${fmtByCurrency(money(executed))})` : ''}`}
          />
        </div>
      </Card>

      <Card title="สร้างตารางลงทุนจากแผน" subtitle="สร้างรายการรอซื้อของเดือนที่เลือกจากแผนที่ใช้งาน รายการที่ซื้อแล้วหรือข้ามไว้จะไม่ถูกเขียนทับ" pad={false}>
        {plans.length === 0 ? (
          <EmptyState icon={<CalendarClock size={28} />} title="ยังไม่มีแผน DCA" description="สร้างแผนที่แท็บ &quot;แผน DCA&quot; ก่อน แล้วกลับมาสร้างตารางของเดือนนี้" />
        ) : (
          <ul className="divide-y divide-line">
            {plans.map((pv) => {
              const id = pv.plan.id
              const own = monthRows.filter((r) => r.planId === id)
              const plannedCount = own.filter((r) => r.status === 'planned').length
              const active = pv.plan.status === 'active'
              const build = buildSchedule(pv.plan, pv.allocations, month)
              const canGen = active && build.items.length > 0
              const warn = warnings[`${id}:${month}`] ?? []
              return (
                <li key={id} className="space-y-2 px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{pv.plan.name}</span>
                        <Badge tone={PLAN_STATUS[pv.plan.status].tone}>{PLAN_STATUS[pv.plan.status].label}</Badge>
                      </div>
                      <div className="text-xs text-muted">
                        {own.length > 0
                          ? `ตารางเดือนนี้: รอซื้อ ${plannedCount} · ซื้อจริงแล้ว ${own.filter((r) => r.status === 'executed').length} · ข้าม ${own.filter((r) => r.status === 'skipped').length} รายการ`
                          : 'ยังไม่ได้สร้างตารางของเดือนนี้'}
                      </div>
                    </div>
                    {active ? (
                      <div className="flex flex-wrap items-center gap-3">
                        {plannedCount > 0 && <Checkbox label="แทนที่รายการที่ยังรอซื้อ" checked={!!replace[id]} onChange={(c) => setReplace((r) => ({ ...r, [id]: c }))} />}
                        <Button size="sm" variant={own.length ? 'secondary' : 'primary'} icon={<CalendarPlus size={14} />} loading={busy === `gen:${id}`} disabled={!canGen || (busy !== null && busy !== `gen:${id}`)} onClick={() => void generate(pv, plannedCount)}>
                          สร้างตารางของเดือนนี้
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted">{pv.plan.status === 'draft' ? 'แบบร่าง: ปรับสัดส่วนรวมให้เท่ากับ 100% ก่อนจึงจะสร้างตารางได้' : 'หยุดพัก: เปิดใช้งานแผนก่อนจึงจะสร้างตารางได้'}</span>
                    )}
                  </div>
                  {active && !canGen && build.warnings[0] && <p className="text-xs text-warn">{build.warnings[0]}</p>}
                  {active && own.length > 0 && !replace[id] && canGen && <p className="text-xs text-muted">กดสร้างอีกครั้งจะเพิ่มเฉพาะวันและหุ้นที่ยังไม่มีในตาราง</p>}
                  {warn.length > 0 && (
                    <Notice tone="warning" title="ข้อสังเกตจากการสร้างตาราง">
                      <ul className="list-disc pl-4">
                        {warn.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    </Notice>
                  )}
                  {canGen && own.length === 0 && <SchedulePreview build={build} currency={pv.plan.budgetCurrency} sym={sym} />}
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Card title={`รายการในตารางเดือน ${fmtMonth(month)}`} subtitle="จัดกลุ่มตามวันที่ตามแผน · รายการที่ซื้อจริงแสดงข้อมูลจากธุรกรรมที่เชื่อมไว้" pad={false}>
        {rows.length === 0 ? (
          <EmptyState icon={<CalendarClock size={28} />} title="ยังไม่มีรายการในตารางของเดือนนี้" description="ดูตัวอย่างตารางและกด &quot;สร้างตารางของเดือนนี้&quot; ในส่วนด้านบน" />
        ) : (
          <div>
            {dates.map((date) => {
              const list = rows.filter((r) => r.plannedDate === date)
              return (
                <section key={date} aria-label={fmtDate(date)} className="border-b border-line last:border-0">
                  <div className="flex flex-wrap items-center justify-between gap-2 bg-surface-2/60 px-4 py-2 text-xs">
                    <span className="flex items-center gap-2 font-medium">
                      {WEEKDAY_SHORT[isoWeekday(date)]} {fmtDate(date)}
                      {date === today && <Badge tone="accent">วันนี้</Badge>}
                    </span>
                    <span className="text-muted">
                      งบของวันนี้ (แผน) <span className="num font-medium text-text">{fmtByCurrency(money(list))}</span>
                    </span>
                  </div>
                  <ul className="divide-y divide-line/70">
                    {list.map((r) => (
                      <ScheduleItem
                        key={r.id}
                        row={r}
                        tx={r.transactionId ? txById.get(r.transactionId) : undefined}
                        symbol={sym(r.securityId)}
                        planName={multiPlan ? planOf(r.planId)?.plan.name : undefined}
                        overdue={r.status === 'planned' && r.plannedDate < today}
                        busy={busy}
                        onExecute={() => onExecute(r)}
                        onSkip={() => void run(`skip:${r.id}`, () => skip.run({ id: r.id, status: 'skipped', note: r.note }))}
                        onRestore={() => void run(`restore:${r.id}`, () => restore.run({ id: r.id, status: 'planned', note: r.note }))}
                        onDelete={async () => {
                          const ok = await confirm({
                            title: 'ลบรายการนี้ออกจากตาราง?',
                            message: `${sym(r.securityId)} ${fmtMoney(r.plannedAmount, r.currency)} วันที่ ${fmtDate(r.plannedDate)}: ลบเฉพาะแผนของวันนั้น ไม่กระทบพอร์ตที่ถือจริง`,
                            confirmLabel: 'ลบรายการ',
                            danger: true,
                          })
                          if (ok) await run(`del:${r.id}`, () => remove.run({ id: r.id }))
                        }}
                      />
                    ))}
                  </ul>
                </section>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}

function SummaryBox({ label, value, sub, dashed }: { label: string; value: string; sub?: string; dashed?: boolean }) {
  return (
    <div className={cx('rounded-lg border p-3', dashed ? 'border-dashed border-line' : 'border-line bg-surface-2/40')}>
      <div className="text-xs text-muted">{label}</div>
      <div className="num mt-0.5 font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  )
}

function SchedulePreview({ build, currency, sym }: { build: ScheduleBuild; currency: string; sym: (id: string) => string }) {
  return (
    <div className="rounded-lg border border-dashed border-line p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <Badge tone="neutral">ตัวอย่าง (Preview)</Badge>
        <span className="text-muted">
          ยังไม่ได้บันทึก · รวมทั้งเดือน <span className="num">{fmtMoney(build.monthTotal, currency)}</span> จาก {build.dates.length} วันลงทุน
        </span>
      </div>
      <ul className="space-y-1 text-xs">
        {build.dates.map((d, i) => (
          <li key={d} className="flex flex-wrap gap-x-3 gap-y-0.5">
            <span className="num min-w-[7.5rem] font-medium">
              {WEEKDAY_SHORT[isoWeekday(d)]} {fmtDate(d)}
            </span>
            <span className="num text-muted">{fmtMoney(build.perDateBudget[i], currency)}</span>
            {build.items
              .filter((it) => it.date === d)
              .map((it) => (
                <span key={it.securityId} className="num">
                  {sym(it.securityId)} {fmtMoney(it.amount, currency)}
                </span>
              ))}
          </li>
        ))}
      </ul>
      {build.warnings.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-warn">
          {build.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ScheduleItem({
  row,
  tx,
  symbol,
  planName,
  overdue,
  busy,
  onExecute,
  onSkip,
  onRestore,
  onDelete,
}: {
  row: DcaScheduleRow
  tx: LedgerTx | undefined
  symbol: string
  planName?: string
  overdue: boolean
  busy: string | null
  onExecute: () => void
  onSkip: () => void
  onRestore: () => void
  onDelete: () => void
}) {
  const st = SCHEDULE_STATUS[row.status]
  const disabled = busy !== null
  return (
    <li className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{symbol}</span>
          <Badge tone={st.tone}>{st.label}</Badge>
          {overdue && <Badge tone="warn">เลยวันตามแผน</Badge>}
          {planName && <span className="text-xs text-muted">{planName}</span>}
        </div>
        <div className="text-xs text-muted">
          ตามแผน <span className={cx('num', row.status === 'skipped' && 'line-through')}>{fmtMoney(row.plannedAmount, row.currency)}</span>
          {row.note && <> · {row.note}</>}
        </div>
        {row.status === 'executed' &&
          (tx ? (
            <div className="mt-0.5 text-xs">
              <span className="font-medium text-accent">ซื้อจริง:</span> {fmtDate(tx.tradeDate)} · <span className="num">{fmtQty(tx.quantity)}</span> หุ้น @ <span className="num">{fmtNum(tx.price, 4)}</span> {tx.currency} · ค่าธรรมเนียม <span className="num">{fmtMoney(tx.fee, tx.currency)}</span> · รวม{' '}
              <span className="num font-medium">{fmtMoney(tx.amount + tx.fee, tx.currency)}</span>
            </div>
          ) : (
            <div className="mt-0.5 text-xs text-warn">ไม่พบธุรกรรมที่เชื่อมไว้ (อาจถูกลบไปแล้ว)</div>
          ))}
      </div>
      <div className="flex flex-wrap items-center gap-1 sm:justify-end">
        {row.status === 'planned' && (
          <>
            <Button size="sm" variant="primary" icon={<CircleCheck size={14} />} disabled={disabled} onClick={onExecute}>
              บันทึกการซื้อจริง
            </Button>
            <Button size="sm" variant="ghost" icon={<SkipForward size={14} />} loading={busy === `skip:${row.id}`} disabled={disabled} onClick={onSkip}>
              ข้าม
            </Button>
          </>
        )}
        {row.status === 'skipped' && (
          <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} loading={busy === `restore:${row.id}`} disabled={disabled} onClick={onRestore}>
            คืนสถานะ
          </Button>
        )}
        {row.status !== 'executed' ? (
          <IconButton label="ลบรายการนี้ออกจากตาราง" disabled={disabled} onClick={onDelete}>
            <Trash2 size={15} />
          </IconButton>
        ) : (
          <span className="text-xs text-muted">ยกเลิกได้โดยลบธุรกรรมที่แท็บพอร์ต DCA</span>
        )}
      </div>
    </li>
  )
}
