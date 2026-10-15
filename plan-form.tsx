'use client'

/**
 * DCA plan editor: plan fields + allocation editor with a live total and a live
 * per-security split (allocateBudget). A plan whose weights do not total 100% is
 * only saved after an explicit confirmation, and then as a draft.
 */
import { useRef, useState } from 'react'
import { CircleAlert, CircleCheck, Divide, Plus, Trash2 } from 'lucide-react'
import { saveDcaPlanAction } from '@/actions/app'
import { allocateBudget, checkAllocations, monthlyEquivalent, type DcaPlanRow } from '@/lib/calc/dca'
import { splitAmount } from '@/lib/calc/money'
import type { DcaPlanView, Snapshot } from '@/lib/calc/snapshot'
import type { SecurityRow } from '@/lib/calc/types'
import { FormFields, useAction, type FieldDef, type FormValues } from '@/components/forms'
import { Badge, Button, IconButton, Input, Modal, Notice, Select, cx, useFeedback } from '@/components/ui'
import { fmtMoney, fmtMonth, fmtNum, fmtPct } from '@/lib/format'
import { WEEKDAY, convert, orderSplit, referenceMonth, str } from './shared'

interface AllocDraft {
  key: string
  securityId: string
  targetPct: string
}

const num = (v: string | boolean | undefined) => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)

export function PlanForm({ plan, securities, s, today, onClose }: { plan?: DcaPlanView; securities: SecurityRow[]; s: Snapshot; today: string; onClose: () => void }) {
  const p = plan?.plan
  const base = s.baseCurrency
  const { confirm } = useFeedback()
  const [values, setValues] = useState<FormValues>(() => ({
    name: p?.name ?? '',
    frequency: p?.frequency ?? 'monthly',
    budgetAmount: str(p?.budgetAmount),
    budgetCurrency: p?.budgetCurrency ?? base,
    investDay: str(p?.investDay ?? 1),
    daysPerMonth: str(p?.daysPerMonth),
    startDate: p?.startDate ?? today,
    durationMonths: str(p?.durationMonths),
    riskLevel: p?.riskLevel ?? 'medium',
    objective: p?.objective ?? 'balanced',
    minInvestment: str(p?.minInvestment ?? 0),
    feePct: str(p?.feePct ?? 0),
    feeMin: str(p?.feeMin ?? 0),
    allowFractional: p?.allowFractional ?? true,
    paused: p?.status === 'paused',
    note: p?.note ?? '',
  }))
  const [rows, setRows] = useState<AllocDraft[]>(() =>
    plan && plan.allocations.length > 0 ? plan.allocations.map((a, i) => ({ key: `a${i}`, securityId: a.securityId, targetPct: String(a.targetPct) })) : [{ key: 'a0', securityId: '', targetPct: '' }],
  )
  const nextKey = useRef(rows.length)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const { run, pending } = useAction(saveDcaPlanAction, {
    success: (d) => (d?.status === 'draft' ? 'บันทึกเป็นแบบร่างแล้ว (สัดส่วนรวมยังไม่เท่ากับ 100%)' : 'บันทึกแผน DCA แล้ว'),
    onSuccess: onClose,
  })

  const ccy = String(values.budgetCurrency)
  const freq = String(values.frequency) as DcaPlanRow['frequency']
  const budget = num(values.budgetAmount) ?? 0
  const feeCfg = { minInvestment: num(values.minInvestment) ?? 0, feePct: num(values.feePct) ?? 0, feeMin: num(values.feeMin) ?? 0 }
  const allowFractional = values.allowFractional === true

  // ---- live allocation -------------------------------------------------------
  const filled = rows.filter((r) => r.securityId)
  const allocs = filled.map((r) => ({ securityId: r.securityId, targetPct: num(r.targetPct) ?? 0 }))
  const check = checkAllocations(allocs)
  const refMonth = referenceMonth({ startDate: String(values.startDate || today) }, s.month)
  const split = orderSplit({ frequency: freq, budgetAmount: budget, daysPerMonth: num(values.daysPerMonth), ...feeCfg }, allocs, refMonth)
  const perPeriod = allocateBudget(budget, allocs, feeCfg)
  const amountFor = (key: string) => {
    const i = filled.findIndex((r) => r.key === key)
    return i < 0 ? null : { order: split.amounts[i], period: perPeriod[i] }
  }
  const totalFee = split.amounts.reduce((a, x) => a + x.estFee, 0)
  const sec = (id: string) => s.securities.find((x) => x.id === id)

  const currencyOpts = [...new Set([base, 'USD', ...Object.keys(s.fx), ccy])].map((c) => ({ value: c, label: c }))
  const fields: FieldDef[] = [
    { name: 'name', label: 'ชื่อแผน', required: true, full: true, placeholder: 'เช่น DCA ETF สหรัฐฯ รายเดือน' },
    {
      name: 'frequency',
      label: 'ความถี่ (Frequency)',
      type: 'select',
      required: true,
      options: [
        { value: 'monthly', label: 'รายเดือน (Monthly)' },
        { value: 'weekly', label: 'รายสัปดาห์ (Weekly)' },
        { value: 'daily', label: 'รายวัน (Daily)' },
      ],
    },
    {
      name: 'budgetAmount',
      label: freq === 'weekly' ? `งบต่อสัปดาห์ (${ccy})` : `งบต่อเดือน (${ccy})`,
      type: 'number',
      required: true,
      min: 0,
      hint: freq === 'weekly' && budget > 0 ? `เทียบเป็นรายเดือน ≈ ${fmtMoney(monthlyEquivalent({ frequency: 'weekly', budgetAmount: budget }), ccy)} (× 52 ÷ 12)` : freq === 'daily' ? 'งบทั้งเดือน ระบบจะกระจายเป็นรายวัน' : undefined,
    },
    { name: 'budgetCurrency', label: 'สกุลเงินของงบ', type: 'select', required: true, options: currencyOpts },
    { name: 'investDay', label: 'วันที่ลงทุนของเดือน (1-31)', type: 'number', required: true, min: 1, max: 31, step: '1', showIf: (v) => v.frequency === 'monthly', hint: 'ตรงเสาร์-อาทิตย์จะเลื่อนเป็นวันทำการถัดไป (ระบบไม่ได้ตัดวันหยุดตลาด)' },
    { name: 'investDay', label: 'วันที่ลงทุนของสัปดาห์', type: 'select', required: true, showIf: (v) => v.frequency === 'weekly', options: [1, 2, 3, 4, 5].map((d) => ({ value: String(d), label: `วัน${WEEKDAY[d]}` })) },
    { name: 'daysPerMonth', label: 'จำนวนวันลงทุนต่อเดือน', type: 'number', min: 1, max: 31, step: '1', showIf: (v) => v.frequency === 'daily', hint: 'เว้นว่าง = ทุกวันทำการ (จันทร์-ศุกร์)' },
    { name: 'startDate', label: 'วันที่เริ่มแผน', type: 'date', required: true },
    { name: 'durationMonths', label: 'ระยะเวลา (เดือน)', type: 'number', min: 1, max: 1200, step: '1', hint: 'เว้นว่าง = ไม่กำหนดวันสิ้นสุด' },
    {
      name: 'riskLevel',
      label: 'ระดับความเสี่ยงที่รับได้ (Risk level)',
      type: 'select',
      required: true,
      options: [
        { value: 'low', label: 'ต่ำ' },
        { value: 'medium', label: 'ปานกลาง' },
        { value: 'high', label: 'สูง' },
      ],
    },
    {
      name: 'objective',
      label: 'เป้าหมายของแผน (Objective)',
      type: 'select',
      required: true,
      options: [
        { value: 'growth', label: 'เน้นเติบโต (Growth)' },
        { value: 'dividend', label: 'เน้นเงินปันผล (Dividend)' },
        { value: 'balanced', label: 'สมดุล (Balanced)' },
      ],
    },
    { name: 'minInvestment', label: `เงินลงทุนขั้นต่ำต่อรายการ (${ccy})`, type: 'number', min: 0, hint: '0 = ไม่มีขั้นต่ำ ใช้ตรวจรายการที่ยอดเล็กเกินไป' },
    { name: 'feePct', label: 'ค่าธรรมเนียมซื้อ (% ของยอดซื้อ)', type: 'number', min: 0, max: 100, hint: 'ตามอัตราของโบรกเกอร์ที่ใช้' },
    { name: 'feeMin', label: `ค่าธรรมเนียมขั้นต่ำต่อคำสั่ง (${ccy})`, type: 'number', min: 0, hint: 'ค่าธรรมเนียม = ค่าที่มากกว่าระหว่าง % × ยอดซื้อ กับขั้นต่ำนี้' },
    { name: 'allowFractional', label: 'โบรกเกอร์รองรับการซื้อเศษหุ้น (Fractional shares)', type: 'checkbox', hint: 'ถ้าไม่รองรับ ต้องซื้อเป็นจำนวนหุ้นเต็ม ยอดที่ซื้อจริงจึงอาจต่างจากแผน' },
    { name: 'paused', label: 'หยุดพักแผนนี้ชั่วคราว (Paused)', type: 'checkbox', hint: 'แผนที่หยุดพักไม่ถูกนับในงบเดือนนี้และสร้างตารางลงทุนไม่ได้' },
    { name: 'note', label: 'หมายเหตุ', type: 'textarea' },
  ]

  const onChange = (name: string, value: string | boolean) => {
    setValues((v) => {
      const next = { ...v, [name]: value }
      // the weekly investing day is Monday-Friday (1-5)
      if (name === 'frequency' && value === 'weekly') {
        const d = Number(v.investDay)
        if (!(d >= 1 && d <= 5)) next.investDay = '1'
      }
      return next
    })
    setErrors((e) => (e[name] ? { ...e, [name]: '' } : e))
  }

  const setRow = (key: string, patch: Partial<AllocDraft>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
    setErrors((e) => (e[`alloc.${key}`] || e.allocations ? { ...e, [`alloc.${key}`]: '', allocations: '' } : e))
  }
  const addRow = () => {
    const key = `a${nextKey.current++}`
    setRows((rs) => [...rs, { key, securityId: '', targetPct: '' }])
  }
  const removeRow = (key: string) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : [{ ...rs[0], securityId: '', targetPct: '' }]))
  const splitEvenly = () => {
    const parts = splitAmount(100, filled.map(() => 1))
    setRows((rs) => {
      let i = 0
      return rs.map((r) => (r.securityId ? { ...r, targetPct: String(parts[i++]) } : r))
    })
  }

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {}
    for (const f of fields) {
      if (f.showIf && !f.showIf(values)) continue
      if (f.type === 'checkbox') continue
      const raw = String(values[f.name] ?? '').trim()
      if (f.required && raw === '') {
        e[f.name] = 'จำเป็นต้องกรอก'
        continue
      }
      if (raw === '' || f.type !== 'number') continue
      const n = Number(raw)
      if (!Number.isFinite(n)) e[f.name] = 'ต้องเป็นตัวเลข'
      else if (f.min !== undefined && n < f.min) e[f.name] = `ต้องไม่น้อยกว่า ${f.min}`
      else if (typeof f.max === 'number' && n > f.max) e[f.name] = `ต้องไม่เกิน ${f.max}`
      else if (f.step === '1' && !Number.isInteger(n)) e[f.name] = 'ต้องเป็นจำนวนเต็ม'
    }
    if (!e.budgetAmount && budget <= 0) e.budgetAmount = 'ต้องมากกว่า 0'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(values.startDate))) e.startDate = 'วันที่ไม่ถูกต้อง'
    for (const r of rows) {
      const pct = r.targetPct.trim()
      if (!r.securityId && pct) e[`alloc.${r.key}`] = 'เลือกหลักทรัพย์'
      else if (r.securityId && !pct) e[`alloc.${r.key}`] = 'กรอกสัดส่วน %'
      else if (r.securityId) {
        const n = Number(pct)
        if (!Number.isFinite(n) || n < 0 || n > 100) e[`alloc.${r.key}`] = 'สัดส่วนต้องอยู่ระหว่าง 0-100'
      }
    }
    return e
  }

  const submit = async () => {
    const found = validate()
    if (Object.values(found).some(Boolean)) return setErrors(found)
    if (!check.ok) {
      const ok = await confirm({
        title: 'บันทึกเป็นแบบร่าง (Draft)?',
        message: (
          <>
            {allocs.length === 0 ? 'แผนนี้ยังไม่มีหลักทรัพย์' : `สัดส่วนรวม ${fmtNum(check.total, 2)}% ไม่เท่ากับ 100% (${check.diff > 0 ? `ขาดอีก ${fmtNum(check.diff, 2)}%` : `เกิน ${fmtNum(-check.diff, 2)}%`})`}
            <br />
            แผนจะถูกบันทึกเป็น &quot;แบบร่าง&quot; ไม่ถูกนับในงบเดือนนี้ และสร้างตารางลงทุนไม่ได้จนกว่าจะปรับสัดส่วนรวมให้เท่ากับ 100%
          </>
        ),
        confirmLabel: 'ยืนยัน บันทึกเป็นแบบร่าง',
      })
      if (!ok) return
    }
    const daily = freq === 'daily'
    const res = await run({
      id: p?.id,
      name: String(values.name),
      budgetAmount: values.budgetAmount,
      budgetCurrency: ccy,
      frequency: freq,
      investDay: daily ? null : values.investDay,
      daysPerMonth: daily ? values.daysPerMonth : null,
      startDate: String(values.startDate),
      durationMonths: values.durationMonths,
      riskLevel: values.riskLevel as DcaPlanRow['riskLevel'],
      objective: values.objective as DcaPlanRow['objective'],
      minInvestment: values.minInvestment,
      feePct: values.feePct,
      feeMin: values.feeMin,
      allowFractional,
      paused: values.paused === true,
      note: values.note,
      allocations: allocs,
      confirmIncomplete: !check.ok,
    })
    if (!res.ok && res.fields) setErrors(res.fields)
  }

  const allocError = Object.entries(errors).find(([k, v]) => v && k.startsWith('allocations'))?.[1]
  const usedIds = new Set(filled.map((r) => r.securityId))
  const secOptions = (current: string) => securities.filter((x) => (!x.isArchived || x.id === current) && (x.id === current || !usedIds.has(x.id)))

  return (
    <Modal
      open
      wide
      onClose={pending ? () => {} : onClose}
      title={p ? `แก้ไขแผน DCA: ${p.name}` : 'สร้างแผน DCA'}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            ยกเลิก
          </Button>
          <Button variant="primary" loading={pending} onClick={() => void submit()}>
            บันทึกแผน
          </Button>
        </>
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="space-y-4"
      >
        <Notice tone="info">แผน DCA เป็นแผนเท่านั้น ไม่ได้ซื้อหุ้นให้ และไม่ถูกนับเป็นเงินที่ลงทุนจริง พอร์ตจะเปลี่ยนเมื่อบันทึกการซื้อจริงเท่านั้น</Notice>
        <FormFields fields={fields} values={values} errors={errors} onChange={onChange} />

        {freq === 'daily' && (
          <div className="rounded-lg border border-dashed border-line bg-surface-2/50 p-3 text-sm">
            <div className="font-medium">งบเฉลี่ยต่อวัน = งบรายเดือน ÷ จำนวนวัน</div>
            <div className="num mt-1">
              {split.days && budget > 0 ? (
                <>
                  = {fmtNum(budget, 2)} ÷ {split.days} = <span className="font-semibold">{fmtMoney(split.perOrder, ccy)}</span> ต่อวัน
                </>
              ) : (
                <span className="text-muted">กรอกงบต่อเดือนเพื่อดูตัวอย่าง</span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted">
              จำนวนวัน: {num(values.daysPerMonth) ? 'ตามที่กำหนด (ไม่เกินจำนวนวันทำการ)' : 'ทุกวันทำการ'} · เดือน {fmtMonth(refMonth)} มีวันทำการจันทร์-ศุกร์ {split.businessDays} วัน (ไม่ได้ตัดวันหยุดตลาด) วันจริงอาจต่างกันในแต่ละเดือน
            </p>
            <p className="mt-1 text-xs text-muted">การกระจายรายวันเป็นแผนจัดสรรเงินเท่านั้น ไม่ได้บังคับให้ต้องซื้อทุกวัน สามารถรวมซื้อเป็นรอบใหญ่หรือข้ามบางวันได้ ยอดต่อวันที่เล็กอาจทำให้ค่าธรรมเนียมขั้นต่ำกินสัดส่วนสูง</p>
          </div>
        )}

        <section aria-label="สัดส่วนการลงทุน" className="rounded-lg border border-line p-3">
          <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">สัดส่วนการลงทุน (Allocation)</h3>
              <p className="text-xs text-muted">
                ยอดต่อหุ้น = {freq === 'daily' ? 'งบเฉลี่ยต่อวัน' : `งบต่อ${freq === 'weekly' ? 'สัปดาห์' : 'เดือน'}`} × สัดส่วน % (ปัดให้รวมเท่างบพอดี)
              </p>
            </div>
            <div aria-live="polite" className={cx('num flex items-center gap-1 text-sm font-semibold', check.ok ? 'text-gain' : 'text-loss')}>
              {check.ok ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
              รวม {fmtNum(check.total, 2)}%
              {!check.ok && allocs.length > 0 && <span className="font-normal">({check.diff > 0 ? `ขาดอีก ${fmtNum(check.diff, 2)}%` : `เกิน ${fmtNum(-check.diff, 2)}%`})</span>}
            </div>
          </div>
          {securities.length === 0 && <Notice tone="warning">ยังไม่มีหลักทรัพย์ในระบบ เพิ่มหลักทรัพย์ก่อน (ปุ่ม &quot;เพิ่มหลักทรัพย์&quot; บนหน้านี้) หรือบันทึกแผนเป็นแบบร่างไว้ก่อน</Notice>}
          <ul className="space-y-2">
            {rows.map((r) => {
              const a = amountFor(r.key)
              const sv = r.securityId ? sec(r.securityId) : undefined
              const price = sv?.price?.price ?? null
              const inSecCcy = a && sv ? convert(s, a.order.amount, ccy, sv.currency) : null
              const belowOneShare = !allowFractional && price !== null && inSecCcy !== null && a !== null && a.order.amount > 0 && inSecCcy < price
              const err = errors[`alloc.${r.key}`]
              return (
                <li key={r.key} className="rounded-lg bg-surface-2/50 p-2">
                  <div className="grid grid-cols-[minmax(0,1fr)_5.5rem_2rem] items-center gap-2">
                    <Select aria-label="หลักทรัพย์" value={r.securityId} aria-invalid={!!err} onChange={(e) => setRow(r.key, { securityId: e.target.value })}>
                      <option value="">เลือกหลักทรัพย์...</option>
                      {secOptions(r.securityId).map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.symbol} · {x.name} ({x.currency})
                        </option>
                      ))}
                    </Select>
                    <div className="relative">
                      <Input type="number" inputMode="decimal" step="any" min={0} max={100} aria-label="สัดส่วนเป้าหมาย %" aria-invalid={!!err} value={r.targetPct} placeholder="0" className="pr-7 text-right" onChange={(e) => setRow(r.key, { targetPct: e.target.value })} />
                      <span className="pointer-events-none absolute right-2.5 top-2 text-xs text-muted">%</span>
                    </div>
                    <IconButton label="ลบแถวนี้" onClick={() => removeRow(r.key)}>
                      <Trash2 size={15} />
                    </IconButton>
                  </div>
                  {err && <p className="mt-1 text-xs text-loss">{err}</p>}
                  {a && budget > 0 && (
                    <div className={cx('mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs', !check.ok && 'opacity-70')}>
                      {freq === 'daily' ? (
                        <span>
                          เดือนละ <span className="num">{fmtMoney(a.period.amount, ccy)}</span> · เฉลี่ยวันละ <span className="num font-medium">{fmtMoney(a.order.amount, ccy)}</span>
                        </span>
                      ) : (
                        <span>
                          ต่อ{freq === 'weekly' ? 'สัปดาห์' : 'เดือน'} <span className="num font-medium">{fmtMoney(a.order.amount, ccy)}</span>
                        </span>
                      )}
                      <span className="text-muted">
                        ค่าธรรมเนียมประมาณ <span className="num">{fmtMoney(a.order.estFee, ccy)}</span>
                        {a.order.feeDragPct !== null && <span className="num"> ({fmtPct(a.order.feeDragPct, 2)} ของยอดซื้อ)</span>}
                        {freq === 'daily' && ' ต่อวัน'}
                      </span>
                      {a.order.belowMinimum && <Badge tone="warn">ต่ำกว่าขั้นต่ำ {fmtMoney(feeCfg.minInvestment, ccy)}</Badge>}
                      {a.order.feeDragPct !== null && a.order.feeDragPct > 1 && <Badge tone="warn">ค่าธรรมเนียมเกิน 1%</Badge>}
                      {belowOneShare && <Badge tone="warn">ไม่พอซื้อ 1 หุ้น (ราคา {fmtNum(price, 2)} {sv?.currency})</Badge>}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          {allocError && <p className="mt-2 text-xs text-loss">{allocError}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" icon={<Plus size={14} />} onClick={addRow} disabled={rows.length >= 50}>
              เพิ่มหลักทรัพย์ในแผน
            </Button>
            <Button size="sm" variant="ghost" icon={<Divide size={14} />} onClick={splitEvenly} disabled={filled.length === 0}>
              แบ่งสัดส่วนเท่า ๆ กัน
            </Button>
          </div>
          {allocs.length > 0 && budget > 0 && (
            <div className="mt-3 rounded-lg border border-line p-2 text-xs">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="text-muted">{freq === 'daily' ? 'รวมต่อวัน (เฉลี่ย)' : `รวมต่อ${freq === 'weekly' ? 'สัปดาห์' : 'เดือน'}`}</span>
                <span className="num font-medium">{fmtMoney(split.perOrder, ccy)}</span>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <span className="text-muted">ค่าธรรมเนียมรวมโดยประมาณ (แยกคำสั่งซื้อทีละหุ้น)</span>
                <span className="num">
                  {fmtMoney(totalFee, ccy)}
                  {split.perOrder > 0 && ` (${fmtPct((totalFee / split.perOrder) * 100, 2)})`}
                </span>
              </div>
              {!check.ok && <p className="mt-1 text-warn">สัดส่วนรวมยังไม่เท่ากับ 100%: ยอดด้านบนเป็นเพียงการเทียบสัดส่วนที่กรอก แผนจะสร้างตารางลงทุนไม่ได้จนกว่าจะรวมได้ 100%</p>}
            </div>
          )}
        </section>

        <Notice tone="warning" title="ข้อจำกัดของโบรกเกอร์ที่ควรรู้">
          ค่าธรรมเนียมขั้นต่ำต่อคำสั่ง (Minimum fee) ทำให้การซื้อยอดเล็กบ่อย ๆ มีต้นทุนเป็นสัดส่วนสูง และถ้าโบรกเกอร์ไม่รองรับเศษหุ้น (No fractional shares) ต้องซื้อเป็นจำนวนหุ้นเต็ม ยอดที่ซื้อจริงจึงอาจไม่ตรงกับแผน ค่าธรรมเนียมที่แสดงเป็นการประมาณจากค่าที่กรอกในแผนเท่านั้น
        </Notice>
        <button type="submit" className="hidden" tabIndex={-1} aria-hidden="true" />
      </form>
    </Modal>
  )
}
