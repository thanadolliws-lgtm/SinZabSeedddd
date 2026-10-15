'use client'

import { useState } from 'react'
import { CircleCheck, Pencil, Plus, Trash2 } from 'lucide-react'
import { deleteIncomeAction, saveIncomeAction, setIncomeReceivedAction } from '@/actions/app'
import type { IncomeRow } from '@/lib/calc/types'
import { INCOME_TYPES } from '@/lib/services/schemas'
import { FormModal, useAction } from '@/components/forms'
import { Badge, Button, Card, DataTable, IconButton, Notice, Stat, useFeedback, type Column } from '@/components/ui'
import { fmtDate, fmtMoney, fmtMonth } from '@/lib/format'
import { INCOME_TYPE_LABELS, baseCashAccountOptions, incomeTypeLabel, monthsOf, str, type MoneyTabProps } from './shared'

type Dialog = { kind: 'income'; income?: IncomeRow } | { kind: 'received'; income: IncomeRow } | null

const TYPE_OPTIONS = INCOME_TYPES.map((t) => ({ value: t, label: INCOME_TYPE_LABELS[t] }))
const STATUS_OPTIONS = [
  { value: 'received', label: 'ได้รับแล้ว' },
  { value: 'expected', label: 'คาดว่าจะได้รับ' },
]

export function IncomeTab({ s, raw, today }: MoneyTabProps) {
  const [dialog, setDialog] = useState<Dialog>(null)
  const close = () => setDialog(null)
  const { confirm } = useFeedback()
  const base = s.baseCurrency
  const remove = useAction(deleteIncomeAction, { success: 'ลบรายรับแล้ว' })
  const accountName = (id: string | null) => (id ? (raw.accounts.find((a) => a.id === id)?.name ?? '?') : null)
  const lateExpected = raw.incomes.filter((i) => i.status === 'expected' && i.date < today)
  const hasAccount = baseCashAccountOptions(raw.accounts, base).length > 0

  const columns: Column<IncomeRow>[] = [
    { key: 'date', header: 'วันที่', sort: (i) => i.date, cell: (i) => <span className="num">{fmtDate(i.date)}</span> },
    { key: 'type', header: 'ประเภท', sort: (i) => incomeTypeLabel(i.type), cell: (i) => incomeTypeLabel(i.type) },
    {
      key: 'source',
      header: 'แหล่งที่มา',
      sort: (i) => i.source ?? '',
      cell: (i) => (
        <div className="max-w-56">
          <div>{i.source ?? <span className="text-muted">—</span>}</div>
          {i.note && <div className="line-clamp-1 text-xs text-muted">{i.note}</div>}
        </div>
      ),
    },
    { key: 'amount', header: 'จำนวนเงิน', align: 'right', sort: (i) => i.amount, cell: (i) => <span className={i.status === 'received' ? 'num font-medium text-gain' : 'num text-muted'}>{fmtMoney(i.amount, base)}</span> },
    {
      key: 'status',
      header: 'สถานะ',
      sort: (i) => i.status,
      cell: (i) =>
        i.status === 'received' ? (
          <Badge tone="gain">ได้รับแล้ว</Badge>
        ) : i.date < today ? (
          <Badge tone="warn" title="เลยวันที่คาดว่าจะได้รับแล้ว แต่ยังไม่ได้ยืนยันว่าได้รับ">
            คาดว่าจะได้รับ · เลยกำหนด
          </Badge>
        ) : (
          <Badge tone="neutral">คาดว่าจะได้รับ</Badge>
        ),
    },
    { key: 'account', header: 'บัญชีที่รับเงิน', cell: (i) => <span className="text-xs">{accountName(i.accountId) ?? <span className="text-muted">ไม่ระบุ</span>}</span> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (i) => (
        <div className="flex items-center justify-end">
          {i.status === 'expected' && (
            <Button size="sm" variant="ghost" icon={<CircleCheck size={14} />} onClick={() => setDialog({ kind: 'received', income: i })}>
              ได้รับแล้ว
            </Button>
          )}
          <IconButton label="แก้ไข" onClick={() => setDialog({ kind: 'income', income: i })}>
            <Pencil size={15} />
          </IconButton>
          <IconButton
            label="ลบ"
            onClick={async () => {
              const ok = await confirm({
                title: 'ลบรายรับนี้?',
                message: `${incomeTypeLabel(i.type)} ${fmtMoney(i.amount, base)} วันที่ ${fmtDate(i.date)}${i.status === 'received' && i.accountId ? ' จะถูกลบ และยอดเงินในบัญชีที่รับเงินจะลดลงตามจำนวนนี้' : ' จะถูกลบ'}`,
                danger: true,
                confirmLabel: 'ลบรายรับ',
              })
              if (ok) await remove.run({ id: i.id })
            }}
          >
            <Trash2 size={15} />
          </IconButton>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-5">
      <section aria-label="สรุปรายรับเดือนนี้" className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label={`รายรับที่ได้รับจริง (${fmtMonth(s.month)})`} value={fmtMoney(s.income.receivedThisMonth)} tone={s.income.receivedThisMonth > 0 ? 'gain' : 'neutral'} hint="รายรับสถานะ 'ได้รับแล้ว' ที่ลงวันที่ในเดือนนี้ นับเข้าเงินสดของบัญชีที่รับเงิน" />
        <Stat label="รายรับที่คาดว่าจะได้รับเดือนนี้" value={fmtMoney(s.income.expectedThisMonth)} tone="neutral" hint="รายรับสถานะ 'คาดว่าจะได้รับ' ที่ลงวันที่ในเดือนนี้ ยังไม่ถูกนับในเงินสดจนกว่าจะยืนยันว่าได้รับแล้ว" />
        <Stat label="จำนวนรายการทั้งหมด" value={raw.incomes.length.toLocaleString('th-TH')} sub={lateExpected.length > 0 ? `${lateExpected.length} รายการเลยกำหนดแต่ยังไม่ยืนยัน` : undefined} className="col-span-2 md:col-span-1" />
      </section>

      <Notice tone="info">
        รายรับ &quot;คาดว่าจะได้รับ&quot; ไม่ถูกนับในเงินสดหรือเงินที่พร้อมใช้ จนกว่าจะกด &quot;ได้รับแล้ว&quot; เพื่อไม่ให้วางแผนใช้เงินที่ยังไม่เข้าบัญชีจริง · รายรับบันทึกเป็น {base} จึงรับเข้าได้เฉพาะบัญชีสกุล {base} ที่ไม่ใช่ทรัพย์สินอื่น
      </Notice>

      {lateExpected.length > 0 && (
        <Notice tone="warning" title={`มีรายรับที่เลยวันที่คาดว่าจะได้รับ ${lateExpected.length} รายการ`}>
          ถ้าได้รับเงินแล้วให้กด &quot;ได้รับแล้ว&quot; ถ้าไม่ได้รับให้แก้ไขวันที่หรือลบรายการ
        </Notice>
      )}

      <Card
        title="รายการรายรับ"
        actions={
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setDialog({ kind: 'income' })}>
            เพิ่มรายรับ
          </Button>
        }
        pad={false}
      >
        <DataTable
          rows={raw.incomes}
          columns={columns}
          rowKey={(i) => i.id}
          search={(i) => `${i.source ?? ''} ${i.note ?? ''} ${incomeTypeLabel(i.type)}`}
          searchPlaceholder="ค้นหาแหล่งที่มา หมายเหตุ..."
          filters={[
            { key: 'type', label: 'ประเภท', options: TYPE_OPTIONS, get: (i) => i.type },
            { key: 'status', label: 'สถานะ', options: STATUS_OPTIONS, get: (i) => i.status },
            { key: 'month', label: 'เดือน', options: monthsOf(raw.incomes.map((i) => i.date)).map((m) => ({ value: m, label: fmtMonth(m) })), get: (i) => i.date.slice(0, 7) },
          ]}
          defaultSort={{ key: 'date', dir: 'desc' }}
          pageSize={20}
          empty={hasAccount ? 'ยังไม่มีรายรับ' : 'ยังไม่มีรายรับ (เพิ่มบัญชีเงินสด/ธนาคารในแท็บเงินสดก่อน เพื่อให้รายรับเข้ายอดเงินในบัญชี)'}
        />
      </Card>

      {dialog?.kind === 'income' && <IncomeForm income={dialog.income} s={s} raw={raw} today={today} onClose={close} />}
      {dialog?.kind === 'received' && (
        <FormModal
          title="ยืนยันว่าได้รับเงินแล้ว"
          intro={
            <Notice tone="info" title={`${incomeTypeLabel(dialog.income.type)}${dialog.income.source ? ` · ${dialog.income.source}` : ''} ${fmtMoney(dialog.income.amount, base)}`}>
              เมื่อยืนยันแล้ว ยอดนี้จะถูกนับเป็นรายรับที่ได้รับจริงและเพิ่มเข้ายอดเงินของบัญชีที่เลือก
            </Notice>
          }
          fields={[
            { name: 'date', label: 'วันที่ได้รับจริง', type: 'date', required: true, max: today },
            { name: 'accountId', label: 'เข้าบัญชี', type: 'select', options: baseCashAccountOptions(raw.accounts, base, dialog.income.accountId), hint: 'ไม่ระบุ = ไม่กระทบยอดเงินในบัญชี' },
          ]}
          initial={{ date: dialog.income.date <= today ? dialog.income.date : today, accountId: dialog.income.accountId ?? '' }}
          validate={(v): Record<string, string> => (String(v.date) > today ? { date: 'วันที่ได้รับต้องไม่เป็นวันในอนาคต' } : {})}
          action={setIncomeReceivedAction}
          toInput={(v) => ({ id: dialog.income.id, received: true, date: v.date, accountId: v.accountId })}
          onClose={close}
          submitLabel="ยืนยันได้รับแล้ว"
          success="บันทึกว่าได้รับเงินแล้ว"
        />
      )}
    </div>
  )
}

function IncomeForm({ income, s, raw, today, onClose }: { income?: IncomeRow; s: MoneyTabProps['s']; raw: MoneyTabProps['raw']; today: string; onClose: () => void }) {
  const base = s.baseCurrency
  const accounts = baseCashAccountOptions(raw.accounts, base, income?.accountId)
  return (
    <FormModal
      title={income ? 'แก้ไขรายรับ' : 'เพิ่มรายรับ'}
      fields={[
        { name: 'date', label: 'วันที่', type: 'date', required: true, hint: (v) => (v.status === 'expected' ? 'วันที่คาดว่าจะได้รับ' : 'วันที่ได้รับจริง (ต้องไม่เป็นวันในอนาคต)') },
        { name: 'type', label: 'ประเภทรายรับ', type: 'select', required: true, options: TYPE_OPTIONS },
        { name: 'source', label: 'แหล่งที่มา', placeholder: 'เช่น บริษัท ABC, ลูกค้างานฟรีแลนซ์' },
        { name: 'amount', label: `จำนวนเงิน (${base})`, type: 'number', required: true, min: 0 },
        {
          name: 'status',
          label: 'สถานะ',
          type: 'select',
          required: true,
          options: STATUS_OPTIONS,
          full: true,
          hint: (v) => (v.status === 'expected' ? 'คาดว่าจะได้รับ: ยังไม่ถูกนับในเงินสดหรือเงินที่พร้อมใช้ จนกว่าจะกด "ได้รับแล้ว"' : 'ได้รับแล้ว: นับเข้าเงินสดของบัญชีที่เลือกทันที'),
        },
        {
          name: 'accountId',
          label: 'บัญชีที่รับเงิน',
          type: 'select',
          options: accounts,
          full: true,
          hint: accounts.length === 0 ? `ยังไม่มีบัญชีสกุล ${base}: เพิ่มบัญชีในแท็บเงินสดก่อน (ไม่ระบุ = ไม่กระทบยอดเงินในบัญชี)` : `เฉพาะบัญชีเงินสด/ธนาคาร/โบรกเกอร์สกุล ${base} · ไม่ระบุ = บันทึกรายรับแต่ไม่กระทบยอดเงินในบัญชี`,
        },
        { name: 'note', label: 'หมายเหตุ', type: 'textarea' },
      ]}
      initial={{
        date: income?.date ?? today,
        type: income?.type ?? 'salary',
        source: income?.source ?? '',
        amount: str(income?.amount),
        status: income?.status ?? 'received',
        accountId: income?.accountId ?? '',
        note: income?.note ?? '',
      }}
      validate={(v) => {
        const e: Record<string, string> = {}
        if (v.status === 'received' && String(v.date) > today) e.date = 'รายรับที่ได้รับจริงต้องไม่เป็นวันในอนาคต ให้ใช้สถานะ "คาดว่าจะได้รับ"'
        if (v.amount !== '' && Number(v.amount) <= 0) e.amount = 'ต้องมากกว่า 0'
        return e
      }}
      action={saveIncomeAction}
      toInput={(v) => ({ ...v, id: income?.id })}
      onClose={onClose}
      success={income ? 'บันทึกการแก้ไขรายรับแล้ว' : 'เพิ่มรายรับแล้ว'}
    />
  )
}
