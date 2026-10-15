'use client'

/**
 * Records the real purchase for one planned DCA slot. The server creates a real
 * 'buy' transaction in the DCA portfolio and links it to the schedule row.
 */
import { useState } from 'react'
import { executeScheduleAction } from '@/actions/app'
import { lookupFxRateAction } from '@/actions/market'
import { estimateFee, type DcaPlanRow } from '@/lib/calc/dca'
import type { Snapshot } from '@/lib/calc/snapshot'
import type { AccountRow, DcaScheduleRow } from '@/lib/calc/types'
import { PriceSource } from '@/components/common'
import { FormFields, newIdempotencyKey, useAction, type FieldDef, type FormValues } from '@/components/forms'
import { Button, Modal, Notice } from '@/components/ui'
import { fmtDate, fmtMoney, fmtNum, fmtQty } from '@/lib/format'
import { convert, rateOf } from './shared'

export function ExecuteForm({ row, plan, s, accounts, today, timezone, onClose }: { row: DcaScheduleRow; plan: DcaPlanRow | undefined; s: Snapshot; accounts: AccountRow[]; today: string; timezone: string; onClose: () => void }) {
  const sec = s.securities.find((x) => x.id === row.securityId)
  const base = s.baseCurrency
  const currency = sec?.currency ?? base
  const foreign = currency !== base
  const [values, setValues] = useState<FormValues>(() => ({
    tradeDate: row.plannedDate <= today ? row.plannedDate : today,
    quantity: '',
    price: '',
    fee: '',
    fxRate: '',
    accountId: '',
    note: row.note ?? '',
  }))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [key] = useState(newIdempotencyKey)
  const [fxNote, setFxNote] = useState<string | null>(null)
  const [fxLoading, setFxLoading] = useState(false)
  const { run, pending } = useAction(executeScheduleAction, { success: 'บันทึกการซื้อจริงแล้ว ธุรกรรมซื้อถูกเพิ่มเข้าพอร์ต DCA และเชื่อมกับตารางลงทุน', onSuccess: onClose })

  const n = (k: string) => (String(values[k] ?? '').trim() === '' ? null : Number(values[k]))
  const qty = n('quantity')
  const price = n('price')
  const fee = n('fee') ?? 0
  const fx = foreign ? n('fxRate') : 1
  const gross = qty !== null && price !== null && Number.isFinite(qty * price) ? qty * price : null
  const total = gross !== null ? gross + fee : null
  const totalBase = total !== null && fx ? total * fx : null
  // actual cost expressed in the plan's currency, to compare with the planned amount
  const totalInPlanCcy = total === null ? null : row.currency === currency ? total : row.currency === base && fx ? total * fx : null

  // suggestion only: planned amount ÷ latest price (converted to the security currency when needed)
  const latest = sec?.price ?? null
  const plannedInSecCcy = convert(s, row.plannedAmount, row.currency, currency)
  const fxCcy = currency === base ? row.currency : currency
  let suggested: number | null = null
  if (latest && latest.price > 0 && plannedInSecCcy !== null) {
    const raw = plannedInSecCcy / latest.price
    suggested = plan && !plan.allowFractional ? Math.floor(raw) : Math.floor(raw * 10_000) / 10_000
  }
  const estFee = plan && row.currency === currency ? estimateFee(row.plannedAmount, plan.feePct, plan.feeMin) : null

  const accountOpts = accounts.filter((a) => !a.isArchived && a.type !== 'other_asset' && (a.currency === currency || a.currency === base)).map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` }))

  const fields: FieldDef[] = [
    { name: 'tradeDate', label: 'วันที่ซื้อจริง', type: 'date', required: true, max: today },
    { name: 'quantity', label: 'จำนวนหุ้นที่ซื้อได้จริง', type: 'number', required: true, min: 0, hint: plan && !plan.allowFractional ? 'แผนนี้ตั้งว่าไม่รองรับเศษหุ้น' : 'รองรับเศษหุ้น (สูงสุด 8 ตำแหน่ง)' },
    { name: 'price', label: `ราคาต่อหุ้นที่ซื้อจริง (${currency})`, type: 'number', required: true, min: 0 },
    { name: 'fee', label: `ค่าธรรมเนียมจริง (${currency})`, type: 'number', min: 0, hint: estFee !== null ? `ประมาณการจากแผน ${fmtMoney(estFee, currency)}: กรอกตามใบยืนยันจริง` : 'กรอกตามใบยืนยันการซื้อ' },
    {
      name: 'fxRate',
      label: `อัตราแลกเปลี่ยน ${base} ต่อ 1 ${currency} ณ วันที่ซื้อ`,
      type: 'number',
      required: true,
      min: 0,
      showIf: () => foreign,
      hint: fxNote ?? 'ใช้อัตราที่ได้รับจริงจากธนาคาร/โบรกเกอร์ เพื่อให้ต้นทุนเป็นบาทถูกต้อง',
    },
    { name: 'accountId', label: 'ตัดเงินจากบัญชี', type: 'select', options: accountOpts, hint: `แสดงเฉพาะบัญชีสกุล ${currency}${foreign ? ` หรือ ${base}` : ''} · ไม่ระบุ = ไม่กระทบยอดเงินสดในระบบ` },
    { name: 'note', label: 'หมายเหตุ', type: 'textarea' },
  ]

  const set = (k: string, v: string | boolean) => {
    setValues((x) => ({ ...x, [k]: v }))
    setErrors((e) => (e[k] ? { ...e, [k]: '' } : e))
  }

  const lookupFx = async () => {
    setFxLoading(true)
    try {
      const res = await lookupFxRateAction({ currency, date: String(values.tradeDate) })
      if (res.ok && res.data) {
        set('fxRate', String(res.data.rate))
        setFxNote(`อัตราอ้างอิง ${fmtDate(res.data.date)} จาก ${res.data.source} (อัตรากลาง ไม่ใช่อัตราที่ธนาคาร/โบรกเกอร์ให้จริง แก้ไขให้ตรงกับใบยืนยันได้)`)
      } else setFxNote(res.ok ? 'ไม่พบอัตราอ้างอิงสำหรับวันที่นี้ กรุณากรอกอัตราที่ได้รับจริง' : res.error)
    } catch {
      setFxNote('ดึงอัตราอ้างอิงไม่สำเร็จ กรุณากรอกอัตราที่ได้รับจริง')
    } finally {
      setFxLoading(false)
    }
  }

  const submit = async () => {
    const e: Record<string, string> = {}
    for (const f of fields) {
      if (f.showIf && !f.showIf(values)) continue
      const v = String(values[f.name] ?? '').trim()
      if (f.required && !v) e[f.name] = 'จำเป็นต้องกรอก'
      else if (v && f.type === 'number' && (!Number.isFinite(Number(v)) || Number(v) < 0)) e[f.name] = 'ต้องเป็นตัวเลขที่ไม่ติดลบ'
    }
    if (!e.quantity && qty !== null && qty <= 0) e.quantity = 'ต้องมากกว่า 0'
    if (!e.fxRate && foreign && fx !== null && fx <= 0) e.fxRate = 'ต้องมากกว่า 0'
    if (String(values.tradeDate) > today) e.tradeDate = 'ต้องไม่เป็นวันในอนาคต'
    if (Object.values(e).some(Boolean)) return setErrors(e)
    const res = await run({
      scheduleId: row.id,
      tradeDate: String(values.tradeDate),
      quantity: values.quantity,
      price: values.price,
      fee: values.fee,
      fxRate: foreign ? values.fxRate : null,
      accountId: values.accountId,
      note: values.note,
      idempotencyKey: key,
    })
    if (!res.ok && res.fields) setErrors(res.fields)
  }

  return (
    <Modal
      open
      wide
      onClose={pending ? () => {} : onClose}
      title={`บันทึกการซื้อจริง: ${sec?.symbol ?? ''}`}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            ยกเลิก
          </Button>
          <Button variant="primary" loading={pending} onClick={() => void submit()}>
            บันทึกการซื้อจริง
          </Button>
        </>
      }
    >
      <form
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault()
          void submit()
        }}
        className="space-y-3"
      >
        <Notice tone="info">บันทึกหลังจากซื้อผ่านโบรกเกอร์แล้วเท่านั้น แอปไม่ได้เชื่อมต่อหรือส่งคำสั่งซื้อไปยังโบรกเกอร์ ระบบจะสร้างธุรกรรมซื้อจริงในพอร์ต DCA และเชื่อมกับรายการในตารางนี้</Notice>

        <div className="grid gap-2 rounded-lg border border-dashed border-line p-3 text-sm sm:grid-cols-2">
          <div>
            <div className="text-xs text-muted">ตามแผน (Plan)</div>
            <div className="num font-medium">{fmtMoney(row.plannedAmount, row.currency)}</div>
            <div className="text-xs text-muted">
              วันที่ตามแผน {fmtDate(row.plannedDate)}
              {plan && ` · ${plan.name}`}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted">ราคาล่าสุดในระบบ (อ้างอิง)</div>
            <div className="num font-medium">{latest ? `${fmtNum(latest.price, 2)} ${currency}` : '—'}</div>
            <PriceSource price={latest} timeZone={timezone} />
          </div>
          <div className="sm:col-span-2">
            {suggested !== null ? (
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  จำนวนหุ้นที่แนะนำ ≈ <span className="num font-semibold">{fmtQty(suggested)}</span> หุ้น
                </span>
                {suggested > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => set('quantity', String(suggested))}>
                    ใช้จำนวนนี้
                  </Button>
                )}
              </div>
            ) : (
              <div className="text-xs text-muted">{latest ? `ไม่มีอัตราแลกเปลี่ยน ${row.currency}/${currency} จึงคำนวณจำนวนหุ้นที่แนะนำไม่ได้` : 'ไม่มีราคาล่าสุด จึงคำนวณจำนวนหุ้นที่แนะนำไม่ได้'}</div>
            )}
            <p className="mt-0.5 text-xs text-muted">
              = ยอดตามแผน ÷ ราคาล่าสุด
              {row.currency !== currency && plannedInSecCcy !== null && ` (แปลง ${fmtMoney(row.plannedAmount, row.currency)} เป็น ≈ ${fmtMoney(plannedInSecCcy, currency)} ด้วยอัตรา ${fxCcy}/${base} ${fmtNum(rateOf(s, fxCcy), 4)}${s.fx[fxCcy] ? ` ณ ${fmtDate(s.fx[fxCcy].date)}` : ''})`}
              {plan && !plan.allowFractional ? ' ปัดลงเป็นหุ้นเต็ม' : ''} ยังไม่หักค่าธรรมเนียม เป็นเพียงตัวเลขแนะนำ ไม่ใช่จำนวนที่ซื้อจริง ราคาตอนซื้อจริงอาจต่างออกไป
              {suggested === 0 && ' · ยอดตามแผนไม่พอซื้อ 1 หุ้นที่ราคาล่าสุด'}
            </p>
          </div>
        </div>

        <FormFields fields={fields} values={values} errors={errors} onChange={set} />
        {foreign && (
          <Button size="sm" onClick={() => void lookupFx()} loading={fxLoading} disabled={!values.tradeDate}>
            ดึงอัตราอ้างอิง {currency}/{base} ของวันที่ซื้อ
          </Button>
        )}

        <div className="rounded-lg bg-surface-2 p-3 text-sm">
          <div className="flex justify-between gap-2">
            <span className="text-muted">ยอดซื้อ (จำนวน × ราคา)</span>
            <span className="num">{fmtMoney(gross, currency)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted">ค่าธรรมเนียม</span>
            <span className="num">{fmtMoney(fee, currency)}</span>
          </div>
          <div className="flex justify-between gap-2 font-medium">
            <span>ต้นทุนจริงรวมค่าธรรมเนียม</span>
            <span className="num">
              {fmtMoney(total, currency)}
              {foreign && totalBase !== null && <span className="ml-2 font-normal text-muted">≈ {fmtMoney(totalBase, base)}</span>}
            </span>
          </div>
          {totalInPlanCcy !== null && (
            <div className="mt-1 text-xs text-muted">
              เทียบกับแผน {fmtMoney(row.plannedAmount, row.currency)}: ต่าง <span className="num">{fmtMoney(totalInPlanCcy - row.plannedAmount, row.currency)}</span>
            </div>
          )}
        </div>
        <button type="submit" className="hidden" tabIndex={-1} aria-hidden="true" />
      </form>
    </Modal>
  )
}
