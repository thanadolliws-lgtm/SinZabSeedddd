'use client'

import { useState } from 'react'
import { CircleCheck, Save } from 'lucide-react'
import { saveAllocationPlanAction } from '@/actions/app'
import { ALLOCATION_KEYS, ALLOCATION_LABELS, allocationAdviceFor, allocationAuto, allocationBasis, computeAllocation, defaultAllocationItems, type AllocationItem, type AllocationKey } from '@/lib/calc/allocation'
import { pct, round } from '@/lib/calc/money'
import { useAction } from '@/components/forms'
import { Badge, Button, Card, Field, Input, Notice, Select, Stat, cx } from '@/components/ui'
import { fmtDateTime, fmtMoney, fmtMonth, fmtPct } from '@/lib/format'
import { parseAmount, type MoneyTabProps } from './shared'

type Basis = 'received' | 'received_and_expected'
type Mode = AllocationItem['mode']
type Draft = Record<AllocationKey, { mode: Mode; value: string }>

/** Where the "auto" figure comes from; null = the system has nothing to derive it from. */
const AUTO_SOURCE: Record<AllocationKey, string | null> = {
  essentials: 'ค่าใช้จ่ายจำเป็นที่บันทึกในเดือนนี้ (จ่ายแล้ว + ค้างจ่าย) ถ้ายังไม่มี ใช้ค่าใช้จ่ายจำเป็นต่อเดือนที่ใช้คำนวณเงินสำรอง',
  debt_min: 'ยอดชำระขั้นต่ำของเดือนนี้ของหนี้ทุกก้อน',
  debt_extra: null,
  emergency: null,
  upcoming: 'รายจ่ายไม่จำเป็นที่ยังไม่จ่ายซึ่งครบกำหนดภายในสิ้นเดือน',
  goals: 'ยอดออมต่อเดือนของเป้าหมายที่กำลังออม',
  dca: 'งบ DCA ต่อเดือนของแผนที่ใช้งานอยู่ (แปลงเป็นบาท)',
  other_invest: null,
}

const MODE_LABELS: Record<Mode, string> = { auto: 'อัตโนมัติ', amount: 'จำนวนเงิน (บาท)', percent: '% ของฐานเงิน' }

function toDraft(items: AllocationItem[]): Draft {
  const out = {} as Draft
  for (const key of ALLOCATION_KEYS) {
    const it = items.find((i) => i.key === key)
    out[key] = { mode: it?.mode ?? 'auto', value: it && it.mode !== 'auto' && it.value > 0 ? String(it.value) : '' }
  }
  return out
}

function toItems(d: Draft): AllocationItem[] {
  return ALLOCATION_KEYS.map((key) => {
    const n = d[key].mode === 'auto' ? null : parseAmount(d[key].value)
    return { key, mode: d[key].mode, value: n !== null && n > 0 ? n : 0 }
  })
}

const sameItems = (a: AllocationItem[], b: AllocationItem[]) => JSON.stringify(toItems(toDraft(a))) === JSON.stringify(toItems(toDraft(b)))

export function AllocationTab({ s, raw, timezone }: MoneyTabProps) {
  const month = s.month
  const plan = raw.allocationPlans.find((p) => p.month === month) ?? null
  const [basis, setBasis] = useState<Basis>(plan?.basis ?? 'received')
  const [draft, setDraft] = useState<Draft>(() => toDraft(plan?.items ?? defaultAllocationItems()))
  const saveDraft = useAction(saveAllocationPlanAction, { success: 'บันทึกแผนเป็นร่างแล้ว' })
  const saveConfirm = useAction(saveAllocationPlanAction, { success: 'ยืนยันแผนแบ่งเงินของเดือนนี้แล้ว' })
  const busy = saveDraft.pending || saveConfirm.pending

  const basisAmount = allocationBasis(s, basis)
  const auto = allocationAuto(s)
  const items = toItems(draft)
  const result = computeAllocation(basisAmount, items, auto)
  const investing = result.rows.filter((r) => r.key === 'dca' || r.key === 'other_invest').reduce((a, r) => a + r.amount, 0)
  const advice = allocationAdviceFor(s, investing, basis === 'received_and_expected', raw.settings.highInterestRate)
  const invalid = ALLOCATION_KEYS.filter((k) => {
    const v = draft[k]
    if (v.mode === 'auto' || v.value.trim() === '') return false
    const n = parseAmount(v.value)
    return n === null || n < 0
  })
  const dirty = !plan || plan.basis !== basis || !sameItems(plan.items, items)
  const savedBasisNow = plan ? allocationBasis(s, plan.basis) : null
  const confirmBlocker = basisAmount <= 0 ? 'ยังไม่มีรายรับในฐานเงินของเดือนนี้ จึงยืนยันแผนไม่ได้ (บันทึกเป็นร่างได้)' : result.overBudget ? `ยอดจัดสรรเกินฐานเงิน ${fmtMoney(-result.remaining)} ปรับยอดให้ไม่เกินก่อนจึงจะยืนยันได้` : invalid.length > 0 ? 'มีช่องที่กรอกไม่ถูกต้อง' : null

  const setMode = (key: AllocationKey, mode: Mode) => {
    const row = result.rows.find((r) => r.key === key)
    setDraft((d) => {
      // start the new mode from the amount the row currently shows, so switching does not jump
      let value = ''
      if (row && row.amount > 0) {
        if (mode === 'amount') value = String(round(row.amount, 2))
        if (mode === 'percent' && row.pct !== null) value = String(round(row.pct, 2))
      }
      return { ...d, [key]: { mode, value } }
    })
  }
  const setValue = (key: AllocationKey, value: string) => setDraft((d) => ({ ...d, [key]: { ...d[key], value } }))
  const save = (confirm: boolean) => (confirm ? saveConfirm : saveDraft).run({ month, basis, items, confirm })

  return (
    <div className="space-y-5">
      <section aria-label="ฐานเงินของแผน" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="รายรับที่ได้รับจริงเดือนนี้" value={fmtMoney(s.income.receivedThisMonth)} tone={s.income.receivedThisMonth > 0 ? 'gain' : 'neutral'} />
        <Stat label="รายรับที่คาดว่าจะได้รับ" value={fmtMoney(s.income.expectedThisMonth)} tone="neutral" hint="ยังไม่เข้าบัญชีจริง นับในฐานเงินเฉพาะเมื่อเลือกฐาน 'รวมรายรับที่คาดว่าจะได้รับ'" />
        <Stat label="จัดสรรแล้ว" value={fmtMoney(result.allocated)} sub={fmtPct(pct(result.allocated, result.basis), 1)} />
        <Stat label="เงินคงเหลือหลังจัดสรร" value={fmtMoney(result.remaining)} tone={result.overBudget ? 'loss' : result.remaining > 0.005 ? 'gain' : 'neutral'} sub={result.overBudget ? 'จัดสรรเกินฐานเงิน' : fmtPct(result.remainingPct, 1)} hint="ฐานเงิน − ยอดที่จัดสรรทั้งหมด" />
      </section>

      <Card
        title={`แผนแบ่งเงินรายเดือน (Monthly Allocation) ${fmtMonth(month)}`}
        subtitle="เรียงตามลำดับความสำคัญ: ค่าใช้จ่ายจำเป็น → หนี้ขั้นต่ำ → โปะหนี้ / เงินสำรอง → บิลที่จะถึง → เงินออม → การลงทุน"
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            {plan ? (
              plan.status === 'confirmed' ? (
                <Badge tone="gain">
                  <CircleCheck size={12} />
                  ยืนยันแล้ว {plan.confirmedAt ? fmtDateTime(plan.confirmedAt, timezone) : ''}
                </Badge>
              ) : (
                <Badge tone="warn">ร่าง</Badge>
              )
            ) : (
              <Badge tone="neutral">ยังไม่ได้บันทึก</Badge>
            )}
            {plan && dirty && <Badge tone="warn">มีการแก้ไขที่ยังไม่บันทึก</Badge>}
          </div>
        }
        pad={false}
      >
        <div className="space-y-3 border-b border-line px-4 py-3">
          <Field label="ฐานเงินของแผน (Basis)" hint={basis === 'received' ? 'ใช้เฉพาะเงินที่เข้าบัญชีแล้วจริง (ปลอดภัยที่สุด)' : 'รวมรายรับที่ยังไม่เข้าบัญชี: ถ้าไม่ได้รับตามคาด แผนจะเกินเงินที่มีจริง'} className="max-w-md">
            <Select value={basis} onChange={(e) => setBasis(e.target.value as Basis)}>
              <option value="received">รายรับที่ได้รับจริง</option>
              <option value="received_and_expected">รายรับที่ได้รับจริง + คาดว่าจะได้รับ</option>
            </Select>
          </Field>
          <div className="text-sm">
            ฐานเงิน: <span className="num text-base font-semibold">{fmtMoney(basisAmount)}</span>
            {basis === 'received_and_expected' && (
              <span className="ml-1 text-xs text-muted">
                (ได้รับจริง {fmtMoney(s.income.receivedThisMonth)} + คาดว่าจะได้รับ {fmtMoney(s.income.expectedThisMonth)})
              </span>
            )}
          </div>
          {basisAmount <= 0 && (
            <Notice tone="warning" title="ยังไม่มีรายรับในฐานเงินของเดือนนี้">
              บันทึกรายรับที่ได้รับจริงในแท็บรายรับก่อน หรือเลือกฐานที่รวมรายรับที่คาดว่าจะได้รับ แผนที่ไม่มีฐานเงินบันทึกเป็นร่างได้แต่ยืนยันไม่ได้
            </Notice>
          )}
          {plan && savedBasisNow !== null && Math.abs(plan.basisAmount - savedBasisNow) > 0.005 && (
            <Notice tone="info">
              ตอนบันทึกแผน ฐานเงินคือ {fmtMoney(plan.basisAmount)} ตอนนี้เป็น {fmtMoney(savedBasisNow)} (รายรับมีการเปลี่ยนแปลง) บันทึกอีกครั้งเพื่ออัปเดตแผน
            </Notice>
          )}
          {advice.map((a, i) => (
            <Notice key={i} tone={a.level === 'danger' ? 'danger' : a.level === 'warning' ? 'warning' : 'info'}>
              {a.text}
            </Notice>
          ))}
        </div>

        <div className="hidden grid-cols-[minmax(0,1.7fr)_10rem_9rem_minmax(0,1fr)] gap-3 border-b border-line bg-surface-2/60 px-4 py-2 text-xs font-medium text-muted md:grid">
          <span>รายการ</span>
          <span>วิธีกำหนด</span>
          <span>ค่า</span>
          <span className="text-right">จำนวนเงิน · % ของฐานเงิน</span>
        </div>
        <ol className="divide-y divide-line">
          {result.rows.map((r, i) => {
            const d = draft[r.key]
            const bad = invalid.includes(r.key)
            return (
              <li key={r.key} className="grid grid-cols-2 items-center gap-2 px-4 py-3 md:grid-cols-[minmax(0,1.7fr)_10rem_9rem_minmax(0,1fr)] md:gap-3">
                <div className="col-span-2 min-w-0 md:col-span-1">
                  <div className="text-sm font-medium">
                    <span className="num mr-1.5 text-xs text-muted">{i + 1}.</span>
                    {ALLOCATION_LABELS[r.key]}
                  </div>
                  <div className="text-xs text-muted">{AUTO_SOURCE[r.key] ? `อัตโนมัติ: ${AUTO_SOURCE[r.key]}` : 'ระบบไม่มีข้อมูลสำหรับคำนวณอัตโนมัติ กรอกจำนวนเงินหรือ % เอง'}</div>
                </div>
                <Select aria-label={`วิธีกำหนด ${ALLOCATION_LABELS[r.key]}`} value={d.mode} onChange={(e) => setMode(r.key, e.target.value as Mode)}>
                  {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
                    <option key={m} value={m}>
                      {MODE_LABELS[m]}
                    </option>
                  ))}
                </Select>
                <div>
                  {d.mode === 'auto' ? (
                    r.auto === null ? (
                      <span className="text-xs text-muted">ไม่มีข้อมูล</span>
                    ) : (
                      <span className="num text-sm">{fmtMoney(r.auto)}</span>
                    )
                  ) : (
                    <div className="relative">
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="any"
                        aria-label={`ค่า ${ALLOCATION_LABELS[r.key]}`}
                        aria-invalid={bad}
                        value={d.value}
                        placeholder="0"
                        onChange={(e) => setValue(r.key, e.target.value)}
                        className="pr-7"
                      />
                      <span className="pointer-events-none absolute right-2.5 top-2 text-xs text-muted">{d.mode === 'percent' ? '%' : '฿'}</span>
                    </div>
                  )}
                </div>
                <div className="col-span-2 flex items-baseline justify-end gap-2 text-right md:col-span-1">
                  <span className={cx('num font-medium', r.amount <= 0 && 'text-muted')}>{fmtMoney(r.amount)}</span>
                  <span className="num w-14 text-xs text-muted">{fmtPct(r.pct, 1)}</span>
                </div>
              </li>
            )
          })}
        </ol>
        <dl className="space-y-1 border-t border-line bg-surface-2/40 px-4 py-3 text-sm">
          <div className="flex justify-between gap-3">
            <dt>รวมที่จัดสรร</dt>
            <dd className="num font-medium">
              {fmtMoney(result.allocated)} <span className="text-xs text-muted">{fmtPct(pct(result.allocated, result.basis), 1)}</span>
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>เงินคงเหลือหลังจัดสรร</dt>
            <dd className={cx('num font-semibold', result.overBudget ? 'text-loss' : result.remaining > 0.005 ? 'text-gain' : 'text-muted')}>
              {fmtMoney(result.remaining)} <span className="text-xs font-normal">{fmtPct(result.remainingPct, 1)}</span>
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">
          {confirmBlocker && <p className="mr-auto text-xs text-warn">{confirmBlocker}</p>}
          {!confirmBlocker && plan?.status === 'confirmed' && dirty && <p className="mr-auto text-xs text-muted">บันทึกร่างจะเปลี่ยนแผนที่ยืนยันแล้วกลับเป็นร่าง</p>}
          <Button icon={<Save size={15} />} loading={saveDraft.pending} disabled={busy || invalid.length > 0} onClick={() => void save(false)}>
            บันทึกร่าง
          </Button>
          <Button variant="primary" icon={<CircleCheck size={15} />} loading={saveConfirm.pending} disabled={busy || !!confirmBlocker} title={confirmBlocker ?? undefined} onClick={() => void save(true)}>
            ยืนยันแผน
          </Button>
        </div>
      </Card>

      <Card title="วิธีคิดเงินคงเหลือ" subtitle="ตัวเลขทุกตัวมาจากข้อมูลชุดเดียวกับทุกหน้า">
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm font-medium leading-relaxed">
          เงินคงเหลือ = เงินสดเริ่มต้น + รายรับที่ได้รับจริง − รายจ่ายที่จ่ายจริง − เงินที่กันไว้สำหรับภาระผูกพัน − เงินที่โอนหรือจัดสรรออกไปแล้ว
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted">
          <li>แผนนี้วัดกับ &quot;ฐานเงิน&quot; ของเดือน: รายรับที่ได้รับจริง (เลือกให้รวมรายรับที่คาดว่าจะได้รับได้) · เงินคงเหลือหลังจัดสรร = ฐานเงิน − ยอดที่จัดสรรทั้งหมด ถ้าติดลบแปลว่าจัดสรรเกินเงินที่มี จึงยืนยันแผนไม่ได้</li>
          <li>การโอนเงินเข้าบัญชีโบรกเกอร์ไม่ใช่รายจ่าย: เงินยังเป็นของเรา เมื่อนำไปซื้อหุ้นก็กลายเป็นหลักทรัพย์ เงินจึงถูกนับครั้งเดียว ไม่ซ้ำซ้อน</li>
          <li>แผนเป็นเพียงการวางแผน ไม่ได้ย้ายเงินจริง ทำตามแผนด้วยการโอนเงินเข้าบัญชีเงินสำรอง/เงินออม จ่ายบิล ชำระหนี้ และบันทึกการซื้อหุ้นจริง</li>
          <li>
            ตอนนี้: เงินที่ใช้ได้จริง {fmtMoney(s.cash.generalCashBase)} · เงินที่พร้อมใช้หลังหักบิลค้างและหนี้ขั้นต่ำ {fmtMoney(s.availableThisMonth)} · ลงทุนจริงเดือนนี้ {fmtMoney(s.investedThisMonth.combined)}
          </li>
        </ul>
      </Card>
    </div>
  )
}
