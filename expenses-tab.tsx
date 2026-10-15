'use client'

import { useState } from 'react'
import { CircleCheck, Pencil, Plus, Repeat, Trash2, X } from 'lucide-react'
import { deleteExpenseAction, deleteRecurringAction, saveBudgetAction, saveExpenseAction, saveRecurringAction, setExpensePaidAction } from '@/actions/app'
import type { CategorySpend } from '@/lib/calc/snapshot'
import type { ExpenseRow, RecurringRow } from '@/lib/calc/types'
import { EXPENSE_CATEGORIES } from '@/lib/services/schemas'
import { BarSeriesChart, SEMANTIC } from '@/components/charts'
import { FormModal, useAction } from '@/components/forms'
import { Badge, Button, Card, DataTable, IconButton, Input, Notice, Select, Stat, useFeedback, type Column } from '@/components/ui'
import { fmtDate, fmtMoney, fmtMonth } from '@/lib/format'
import { CATEGORY_OPTIONS, FREQUENCY_LABELS, baseCashAccountOptions, monthsOf, parseAmount, str, type MoneyTabProps } from './shared'

type Dialog = { kind: 'expense'; expense?: ExpenseRow } | { kind: 'paid'; expense: ExpenseRow } | { kind: 'recurring'; recurring?: RecurringRow } | null

const RECURRING_FREQ = ['daily', 'weekly', 'monthly', 'yearly'] as const
/** the fixed list, plus any older category already used by a record */
const categoryOptions = (current?: string) => (current && !(EXPENSE_CATEGORIES as readonly string[]).includes(current) ? [...CATEGORY_OPTIONS, { value: current, label: current }] : CATEGORY_OPTIONS)

export function ExpensesTab({ s, raw, today }: MoneyTabProps) {
  const [dialog, setDialog] = useState<Dialog>(null)
  const close = () => setDialog(null)
  const { confirm } = useFeedback()
  const base = s.baseCurrency
  const x = s.expenses
  const removeExpense = useAction(deleteExpenseAction, { success: 'ลบรายจ่ายแล้ว' })
  const removeRecurring = useAction(deleteRecurringAction, { success: 'ลบรายจ่ายประจำแล้ว บิลที่สร้างไปแล้วยังอยู่' })
  const accountName = (id: string | null) => (id ? (raw.accounts.find((a) => a.id === id)?.name ?? '?') : null)
  const overdueCount = raw.expenses.filter((e) => e.status === 'unpaid' && e.date < today).length
  const spentAll = x.byCategory.reduce((a, c) => a + c.paid + c.unpaid, 0)

  const expenseColumns: Column<ExpenseRow>[] = [
    {
      key: 'date',
      header: 'วันที่ / ครบกำหนด',
      sort: (e) => e.date,
      cell: (e) => <span className="num">{fmtDate(e.date)}</span>,
    },
    { key: 'category', header: 'หมวดหมู่', sort: (e) => e.category, cell: (e) => <span className="text-xs">{e.category}</span> },
    {
      key: 'desc',
      header: 'รายละเอียด',
      cell: (e) => (
        <div className="max-w-56">
          <div className="flex flex-wrap items-center gap-1">
            {e.description ?? <span className="text-muted">—</span>}
            {e.recurringId && (
              <Badge tone="neutral" title="สร้างอัตโนมัติจากรายจ่ายประจำ">
                <Repeat size={10} />
                ประจำ
              </Badge>
            )}
          </div>
          {e.note && <div className="line-clamp-1 text-xs text-muted">{e.note}</div>}
        </div>
      ),
    },
    { key: 'amount', header: 'จำนวนเงิน', align: 'right', sort: (e) => e.amount, cell: (e) => <span className="num font-medium">{fmtMoney(e.amount, base)}</span> },
    { key: 'freq', header: 'ความถี่', cell: (e) => <span className="text-xs text-muted">{FREQUENCY_LABELS[e.frequency] ?? e.frequency}</span> },
    { key: 'essential', header: 'จำเป็น', align: 'center', sort: (e) => (e.isEssential ? 1 : 0), cell: (e) => (e.isEssential ? <Badge tone="accent">จำเป็น</Badge> : <span className="text-muted">—</span>) },
    {
      key: 'status',
      header: 'สถานะ',
      sort: (e) => (e.status === 'unpaid' ? (e.date < today ? 0 : 1) : 2),
      cell: (e) => (e.status === 'paid' ? <Badge tone="gain">จ่ายแล้ว</Badge> : e.date < today ? <Badge tone="loss">เกินกำหนด</Badge> : <Badge tone="warn">ยังไม่จ่าย</Badge>),
    },
    { key: 'paidDate', header: 'วันที่จ่าย', sort: (e) => e.paidDate, cell: (e) => <span className="num text-xs">{e.status === 'paid' ? fmtDate(e.paidDate ?? e.date) : '—'}</span> },
    { key: 'account', header: 'บัญชี', cell: (e) => <span className="text-xs">{accountName(e.accountId) ?? <span className="text-muted">ไม่ระบุ</span>}</span> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (e) => (
        <div className="flex items-center justify-end">
          {e.status === 'unpaid' && (
            <Button size="sm" variant="ghost" icon={<CircleCheck size={14} />} onClick={() => setDialog({ kind: 'paid', expense: e })}>
              จ่ายแล้ว
            </Button>
          )}
          <IconButton label="แก้ไข" onClick={() => setDialog({ kind: 'expense', expense: e })}>
            <Pencil size={15} />
          </IconButton>
          <IconButton
            label="ลบ"
            onClick={async () => {
              const ok = await confirm({
                title: 'ลบรายจ่ายนี้?',
                message: `${e.category}${e.description ? ` · ${e.description}` : ''} ${fmtMoney(e.amount, base)} วันที่ ${fmtDate(e.date)} จะถูกลบ${e.status === 'paid' && e.accountId ? ' และยอดเงินในบัญชีที่จ่ายจะเพิ่มกลับตามจำนวนนี้' : ''}${e.recurringId ? ' (บิลนี้มาจากรายจ่ายประจำ ระบบจะไม่สร้างบิลวันเดียวกันซ้ำ)' : ''}`,
                danger: true,
                confirmLabel: 'ลบรายจ่าย',
              })
              if (ok) await removeExpense.run({ id: e.id })
            }}
          >
            <Trash2 size={15} />
          </IconButton>
        </div>
      ),
    },
  ]

  const recurringColumns: Column<RecurringRow>[] = [
    {
      key: 'name',
      header: 'รายการ',
      sort: (r) => r.name,
      cell: (r) => (
        <div>
          <div className="font-medium">{r.name}</div>
          <div className="text-xs text-muted">{r.category}</div>
        </div>
      ),
    },
    { key: 'amount', header: 'จำนวนเงิน', align: 'right', sort: (r) => r.amount, cell: (r) => <span className="num">{fmtMoney(r.amount, base)}</span> },
    { key: 'freq', header: 'ความถี่', sort: (r) => r.frequency, cell: (r) => <span className="text-xs">{FREQUENCY_LABELS[r.frequency]}</span> },
    { key: 'next', header: 'ครบกำหนดถัดไป', sort: (r) => r.nextDueDate, cell: (r) => <span className="num text-xs">{r.isActive ? fmtDate(r.nextDueDate) : '—'}</span> },
    { key: 'end', header: 'สิ้นสุด', cell: (r) => <span className="num text-xs">{fmtDate(r.endDate)}</span> },
    { key: 'essential', header: 'จำเป็น', align: 'center', cell: (r) => (r.isEssential ? <Badge tone="accent">จำเป็น</Badge> : <span className="text-muted">—</span>) },
    { key: 'active', header: 'สถานะ', sort: (r) => (r.isActive ? 0 : 1), cell: (r) => (r.isActive ? <Badge tone="gain">ใช้งาน</Badge> : <Badge tone="neutral">หยุด / สิ้นสุดแล้ว</Badge>) },
    { key: 'account', header: 'บัญชี', cell: (r) => <span className="text-xs">{accountName(r.accountId) ?? <span className="text-muted">ไม่ระบุ</span>}</span> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <div className="flex justify-end">
          <IconButton label="แก้ไข" onClick={() => setDialog({ kind: 'recurring', recurring: r })}>
            <Pencil size={15} />
          </IconButton>
          <IconButton
            label="ลบ"
            onClick={async () => {
              const ok = await confirm({
                title: `ลบรายจ่ายประจำ "${r.name}"?`,
                message: 'บิลที่ระบบสร้างไปแล้วยังอยู่ในตารางรายจ่าย (แก้ไขหรือลบแยกได้) เฉพาะบิลในอนาคตจะไม่ถูกสร้างอีก ถ้าต้องการหยุดชั่วคราวให้แก้ไขแล้วปิด "ใช้งาน" แทน',
                danger: true,
                confirmLabel: 'ลบรายจ่ายประจำ',
              })
              if (ok) await removeRecurring.run({ id: r.id })
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
      <section aria-label="สรุปรายจ่ายเดือนนี้" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label={`จ่ายแล้วเดือนนี้ (${fmtMonth(s.month)})`}
          value={fmtMoney(x.paidThisMonth)}
          sub={x.essentialThisMonth > 0 ? `ค่าใช้จ่ายจำเป็นของเดือน ${fmtMoney(x.essentialThisMonth)}` : undefined}
          hint="รายจ่ายสถานะ 'จ่ายแล้ว' ที่วันที่จ่ายอยู่ในเดือนนี้"
        />
        <Stat label="ค้างจ่ายถึงสิ้นเดือน" value={fmtMoney(x.unpaidDue)} tone={x.unpaidDue > 0.005 ? 'warn' : 'neutral'} sub="รวมรายการที่เกินกำหนดแล้ว" hint="รายจ่ายที่ยังไม่จ่ายซึ่งครบกำหนดภายในสิ้นเดือนนี้ (รวมที่เกินกำหนดจากเดือนก่อน) ถูกหักออกจากเงินที่พร้อมใช้เดือนนี้" />
        <Stat label="เกินกำหนดชำระ" value={fmtMoney(x.overdueUnpaid)} tone={x.overdueUnpaid > 0.005 ? 'loss' : 'neutral'} sub={overdueCount > 0 ? `${overdueCount} รายการ` : 'ไม่มี'} hint="รายจ่ายที่ยังไม่จ่ายและเลยวันครบกำหนดแล้ว" />
        <Stat
          label="งบรวมทั้งเดือน"
          value={x.totalBudget === null ? 'ยังไม่ตั้ง' : fmtMoney(x.totalBudget)}
          tone={x.totalBudget === null ? 'neutral' : spentAll > x.totalBudget + 0.005 ? 'loss' : undefined}
          sub={x.totalBudget === null ? 'ตั้งได้ในส่วนงบประมาณด้านล่าง' : `ใช้ไป ${fmtMoney(spentAll)} (จ่ายแล้ว + ค้างจ่าย)`}
        />
      </section>

      <Card
        title="รายการรายจ่าย"
        subtitle="รายจ่ายนับในเงินสดเมื่อ 'จ่ายแล้ว' เท่านั้น รายการที่ยังไม่จ่ายถูกกันไว้จากเงินที่พร้อมใช้เมื่อครบกำหนดภายในเดือน"
        actions={
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setDialog({ kind: 'expense' })}>
            เพิ่มรายจ่าย
          </Button>
        }
        pad={false}
      >
        <DataTable
          rows={raw.expenses}
          columns={expenseColumns}
          rowKey={(e) => e.id}
          search={(e) => `${e.category} ${e.description ?? ''} ${e.note ?? ''}`}
          searchPlaceholder="ค้นหาหมวดหมู่ รายละเอียด..."
          filters={[
            { key: 'category', label: 'หมวดหมู่', options: [...new Set([...EXPENSE_CATEGORIES, ...raw.expenses.map((e) => e.category)])].map((c) => ({ value: c, label: c })), get: (e) => e.category },
            {
              key: 'status',
              label: 'สถานะ',
              options: [
                { value: 'paid', label: 'จ่ายแล้ว' },
                { value: 'unpaid', label: 'ยังไม่จ่าย' },
                { value: 'overdue', label: 'เกินกำหนด' },
              ],
              get: (e) => (e.status === 'paid' ? 'paid' : e.date < today ? ['unpaid', 'overdue'] : 'unpaid'),
            },
            {
              key: 'essential',
              label: 'ความจำเป็น',
              options: [
                { value: 'yes', label: 'จำเป็น' },
                { value: 'no', label: 'ไม่จำเป็น' },
              ],
              get: (e) => (e.isEssential ? 'yes' : 'no'),
            },
            { key: 'month', label: 'เดือน', options: monthsOf(raw.expenses.map((e) => e.date)).map((m) => ({ value: m, label: fmtMonth(m) })), get: (e) => e.date.slice(0, 7) },
          ]}
          defaultSort={{ key: 'date', dir: 'desc' }}
          pageSize={20}
          rowClassName={(e) => (e.status === 'unpaid' && e.date < today ? 'bg-loss-soft/40' : undefined)}
          empty="ยังไม่มีรายจ่าย"
        />
      </Card>

      <Card
        title="รายจ่ายประจำ (Recurring Expenses)"
        subtitle="ระบบสร้างบิลสถานะ 'ยังไม่จ่าย' ให้อัตโนมัติตามวันครบกำหนด ล่วงหน้าถึงสิ้นเดือนปัจจุบัน (รายวัน: ถึงวันนี้) บิลจะแสดงในตารางรายจ่ายและในการแจ้งเตือนเมื่อใกล้หรือเกินกำหนด"
        actions={
          <Button size="sm" icon={<Plus size={14} />} onClick={() => setDialog({ kind: 'recurring' })}>
            เพิ่มรายจ่ายประจำ
          </Button>
        }
        pad={false}
      >
        <DataTable rows={raw.recurring} columns={recurringColumns} rowKey={(r) => r.id} defaultSort={{ key: 'next', dir: 'asc' }} pageSize={15} empty="ยังไม่มีรายจ่ายประจำ (เช่น ค่าเช่า ค่าโทรศัพท์ ค่าสมาชิกรายเดือน)" />
      </Card>

      <BudgetSection month={s.month} rows={x.byCategory} totalBudget={x.totalBudget} spentAll={spentAll} />

      {dialog?.kind === 'expense' && <ExpenseForm expense={dialog.expense} raw={raw} base={base} today={today} onClose={close} />}
      {dialog?.kind === 'paid' && (
        <FormModal
          title="บันทึกว่าจ่ายแล้ว"
          intro={
            <Notice tone="info" title={`${dialog.expense.category}${dialog.expense.description ? ` · ${dialog.expense.description}` : ''} ${fmtMoney(dialog.expense.amount, base)}`}>
              ครบกำหนด {fmtDate(dialog.expense.date)} · เมื่อบันทึกแล้วยอดนี้จะถูกหักจากบัญชีที่เลือก
            </Notice>
          }
          fields={[
            { name: 'paidDate', label: 'วันที่จ่ายจริง', type: 'date', required: true, max: today },
            { name: 'accountId', label: 'จ่ายจากบัญชี', type: 'select', options: baseCashAccountOptions(raw.accounts, base, dialog.expense.accountId), hint: 'ไม่ระบุ = ไม่กระทบยอดเงินในบัญชี' },
          ]}
          initial={{ paidDate: today, accountId: dialog.expense.accountId ?? '' }}
          validate={(v): Record<string, string> => (String(v.paidDate) > today ? { paidDate: 'วันที่จ่ายต้องไม่เป็นวันในอนาคต' } : {})}
          action={setExpensePaidAction}
          toInput={(v) => ({ id: dialog.expense.id, paid: true, paidDate: v.paidDate, accountId: v.accountId })}
          onClose={close}
          submitLabel="บันทึกว่าจ่ายแล้ว"
          success="บันทึกการจ่ายแล้ว"
        />
      )}
      {dialog?.kind === 'recurring' && <RecurringForm recurring={dialog.recurring} raw={raw} base={base} today={today} onClose={close} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Budgets for the current month
// ---------------------------------------------------------------------------
function BudgetSection({ month, rows, totalBudget, spentAll }: { month: string; rows: CategorySpend[]; totalBudget: number | null; spentAll: number }) {
  const [newCategory, setNewCategory] = useState('')
  const [newAmount, setNewAmount] = useState('')
  const add = useAction(saveBudgetAction, {
    success: 'ตั้งงบแล้ว',
    onSuccess: () => {
      setNewCategory('')
      setNewAmount('')
    },
  })
  const unused = EXPENSE_CATEGORIES.filter((c) => !rows.some((r) => r.category === c))
  const amount = parseAmount(newAmount)
  const chart = rows.map((c) => ({ category: c.category, paid: c.paid, unpaid: c.unpaid, budget: c.budget }))

  return (
    <Card title={`งบประมาณรายหมวด (${fmtMonth(month)})`} subtitle="เทียบรายจ่ายที่จ่ายแล้ว + ค้างจ่ายของเดือนนี้กับงบที่ตั้งไว้ · ยกเลิกงบได้ด้วยปุ่ม × หรือเว้นช่องว่างแล้วกดบันทึก · &quot;งบรวมทั้งเดือน&quot; คือเพดานค่าใช้จ่ายรวมทุกหมวด">
      <div className="overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-2/60 text-xs text-muted">
              <th className="px-3 py-2 text-left font-medium">หมวดหมู่</th>
              <th className="px-3 py-2 text-right font-medium">จ่ายแล้ว</th>
              <th className="px-3 py-2 text-right font-medium">ค้างจ่าย</th>
              <th className="px-3 py-2 text-left font-medium">งบเดือนนี้</th>
              <th className="px-3 py-2 text-right font-medium">คงเหลือ / เกินงบ</th>
            </tr>
          </thead>
          <tbody>
            <BudgetLine key={`*-${totalBudget}`} month={month} category="*" label="งบรวมทั้งเดือน" paid={null} unpaid={null} spent={spentAll} budget={totalBudget} strong />
            {rows.map((c) => (
              <BudgetLine key={`${c.category}-${c.budget}`} month={month} category={c.category} label={c.category} paid={c.paid} unpaid={c.unpaid} spent={c.paid + c.unpaid} budget={c.budget} />
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="px-3 py-3 text-sm text-muted">เดือนนี้ยังไม่มีรายจ่ายหรืองบรายหมวด</p>}

      {unused.length > 0 && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (newCategory && amount !== null && amount >= 0) void add.run({ month, category: newCategory, amount })
          }}
        >
          <label className="block w-full sm:w-56">
            <span className="mb-1 block text-xs font-medium text-muted">ตั้งงบหมวดใหม่</span>
            <Select value={newCategory} onChange={(e) => setNewCategory(e.target.value)}>
              <option value="">เลือกหมวดหมู่...</option>
              {unused.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </label>
          <label className="block w-36">
            <span className="mb-1 block text-xs font-medium text-muted">งบ (บาท)</span>
            <Input type="number" inputMode="decimal" min={0} step="any" value={newAmount} aria-invalid={newAmount !== '' && (amount === null || amount < 0)} onChange={(e) => setNewAmount(e.target.value)} />
          </label>
          <Button type="submit" size="md" icon={<Plus size={14} />} loading={add.pending} disabled={!newCategory || amount === null || amount < 0}>
            ตั้งงบ
          </Button>
        </form>
      )}

      <div className="mt-4">
        <BarSeriesChart
          data={chart}
          xKey="category"
          height={240}
          series={[
            { key: 'paid', label: 'จ่ายแล้ว', color: SEMANTIC.loss, stack: 'spent' },
            { key: 'unpaid', label: 'ค้างจ่าย', color: SEMANTIC.warn, stack: 'spent' },
            { key: 'budget', label: 'งบ', color: SEMANTIC.neutral },
          ]}
          empty="ยังไม่มีรายจ่ายหรืองบของเดือนนี้"
        />
      </div>
    </Card>
  )
}

function BudgetLine({ month, category, label, paid, unpaid, spent, budget, strong }: { month: string; category: string; label: string; paid: number | null; unpaid: number | null; spent: number; budget: number | null; strong?: boolean }) {
  const [value, setValue] = useState(budget === null ? '' : String(budget))
  const save = useAction(saveBudgetAction, { success: (budget === null ? 'ตั้งงบแล้ว' : 'บันทึกงบแล้ว') })
  const clear = useAction(saveBudgetAction, { success: 'ยกเลิกงบแล้ว' })
  const n = parseAmount(value)
  const invalid = value.trim() !== '' && (n === null || n < 0)
  const changed = value.trim() === '' ? budget !== null : n !== budget
  const left = budget === null ? null : budget - spent
  return (
    <tr className={strong ? 'border-b border-line bg-surface-2/30 font-medium' : 'border-b border-line/70 last:border-0'}>
      <td className="px-3 py-2">{label}</td>
      <td className="num px-3 py-2 text-right">{paid === null ? <span className="text-muted">—</span> : fmtMoney(paid)}</td>
      <td className="num px-3 py-2 text-right">{unpaid === null ? <span className="text-muted">—</span> : unpaid > 0 ? <span className="text-warn">{fmtMoney(unpaid)}</span> : fmtMoney(unpaid)}</td>
      <td className="px-3 py-2">
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            if (!invalid && changed) void save.run({ month, category, amount: value.trim() === '' ? null : n })
          }}
        >
          <Input type="number" inputMode="decimal" min={0} step="any" placeholder="ไม่มีงบ" aria-label={`งบของ ${label}`} aria-invalid={invalid} value={value} onChange={(e) => setValue(e.target.value)} className="w-28" />
          <Button type="submit" size="sm" loading={save.pending} disabled={invalid || !changed}>
            บันทึก
          </Button>
          {budget !== null && (
            <IconButton label={`ยกเลิกงบของ ${label}`} disabled={clear.pending} onClick={() => void clear.run({ month, category, amount: null })}>
              <X size={15} />
            </IconButton>
          )}
        </form>
      </td>
      <td className="num px-3 py-2 text-right">
        {left === null ? (
          <span className="text-xs text-muted">ไม่ได้ตั้งงบ</span>
        ) : left < -0.005 ? (
          <Badge tone="loss">เกินงบ {fmtMoney(-left)}</Badge>
        ) : (
          <span className="text-gain">เหลือ {fmtMoney(left)}</span>
        )}
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------
function ExpenseForm({ expense, raw, base, today, onClose }: { expense?: ExpenseRow; raw: MoneyTabProps['raw']; base: string; today: string; onClose: () => void }) {
  const accounts = baseCashAccountOptions(raw.accounts, base, expense?.accountId)
  return (
    <FormModal
      title={expense ? 'แก้ไขรายจ่าย' : 'เพิ่มรายจ่าย'}
      intro={expense?.recurringId ? <Notice tone="info">บิลนี้สร้างจากรายจ่ายประจำ การแก้ไขมีผลเฉพาะบิลนี้ ไม่เปลี่ยนรายการประจำ</Notice> : undefined}
      fields={[
        { name: 'date', label: 'วันที่', type: 'date', required: true, hint: (v) => (v.status === 'unpaid' ? 'วันครบกำหนดชำระ' : 'วันที่เกิดรายจ่าย') },
        { name: 'category', label: 'หมวดหมู่', type: 'select', required: true, options: categoryOptions(expense?.category) },
        { name: 'description', label: 'รายละเอียด', placeholder: 'เช่น ค่าไฟเดือนนี้, อาหารกลางวัน', full: true },
        { name: 'amount', label: `จำนวนเงิน (${base})`, type: 'number', required: true, min: 0 },
        {
          name: 'status',
          label: 'สถานะ',
          type: 'select',
          required: true,
          options: [
            { value: 'paid', label: 'จ่ายแล้ว' },
            { value: 'unpaid', label: 'ยังไม่จ่าย' },
          ],
          hint: (v) => (v.status === 'unpaid' ? 'ยังไม่ถูกหักจากเงินสด แต่ถูกกันจากเงินที่พร้อมใช้เมื่อครบกำหนดภายในเดือน' : 'หักจากบัญชีที่เลือก'),
        },
        { name: 'paidDate', label: 'วันที่จ่ายจริง', type: 'date', max: today, showIf: (v) => v.status === 'paid', hint: 'เว้นว่าง = ใช้วันที่ของรายจ่าย' },
        {
          name: 'accountId',
          label: 'จ่ายจากบัญชี',
          type: 'select',
          options: accounts,
          full: true,
          hint: `เฉพาะบัญชีเงินสด/ธนาคาร/โบรกเกอร์สกุล ${base} · ไม่ระบุ = บันทึกรายจ่ายแต่ไม่กระทบยอดเงินในบัญชี`,
        },
        { name: 'isEssential', label: 'ค่าใช้จ่ายจำเป็น (Essential)', type: 'checkbox', hint: 'ใช้คำนวณค่าใช้จ่ายจำเป็นต่อเดือน ซึ่งเป็นฐานของเป้าหมายเงินสำรองฉุกเฉิน และค่าอัตโนมัติในแผนแบ่งเงินรายเดือน' },
        { name: 'note', label: 'หมายเหตุ', type: 'textarea' },
      ]}
      initial={{
        date: expense?.date ?? today,
        category: expense?.category ?? '',
        description: expense?.description ?? '',
        amount: str(expense?.amount),
        status: expense?.status ?? 'paid',
        paidDate: expense?.paidDate ?? '',
        accountId: expense?.accountId ?? '',
        isEssential: expense?.isEssential ?? false,
        note: expense?.note ?? '',
      }}
      validate={(v) => {
        const e: Record<string, string> = {}
        const effectivePaid = String(v.paidDate || v.date)
        if (v.status === 'paid' && effectivePaid > today) e[v.paidDate ? 'paidDate' : 'date'] = 'รายจ่ายที่ "จ่ายแล้ว" ต้องไม่เป็นวันในอนาคต ให้ใช้สถานะ "ยังไม่จ่าย"'
        if (v.amount !== '' && Number(v.amount) <= 0) e.amount = 'ต้องมากกว่า 0'
        return e
      }}
      action={saveExpenseAction}
      toInput={(v) => ({ ...v, id: expense?.id, paidDate: v.status === 'paid' ? v.paidDate : '' })}
      onClose={onClose}
      success={expense ? 'บันทึกการแก้ไขรายจ่ายแล้ว' : 'เพิ่มรายจ่ายแล้ว'}
    />
  )
}

function RecurringForm({ recurring, raw, base, today, onClose }: { recurring?: RecurringRow; raw: MoneyTabProps['raw']; base: string; today: string; onClose: () => void }) {
  const accounts = baseCashAccountOptions(raw.accounts, base, recurring?.accountId)
  return (
    <FormModal
      title={recurring ? `แก้ไขรายจ่ายประจำ: ${recurring.name}` : 'เพิ่มรายจ่ายประจำ'}
      intro={
        <Notice tone="info">
          ระบบจะสร้างบิลสถานะ &quot;ยังไม่จ่าย&quot; ให้อัตโนมัติเมื่อถึงรอบ (ล่วงหน้าถึงสิ้นเดือนปัจจุบัน) บิลจะแสดงในการแจ้งเตือนเมื่อใกล้หรือเกินกำหนด กด &quot;จ่ายแล้ว&quot; เมื่อจ่ายจริง การแก้ไขที่นี่ไม่เปลี่ยนบิลที่สร้างไปแล้ว
        </Notice>
      }
      fields={[
        { name: 'name', label: 'ชื่อรายการ', required: true, placeholder: 'เช่น ค่าเช่าห้อง, ค่าโทรศัพท์', full: true },
        { name: 'category', label: 'หมวดหมู่', type: 'select', required: true, options: categoryOptions(recurring?.category) },
        { name: 'amount', label: `จำนวนเงินต่อรอบ (${base})`, type: 'number', required: true, min: 0 },
        { name: 'frequency', label: 'ความถี่', type: 'select', required: true, options: RECURRING_FREQ.map((f) => ({ value: f, label: FREQUENCY_LABELS[f] })) },
        { name: 'nextDueDate', label: 'ครบกำหนดครั้งถัดไป', type: 'date', required: true, hint: 'วันครบกำหนดของบิลถัดไปที่ยังไม่ได้สร้าง' },
        { name: 'endDate', label: 'วันสิ้นสุด', type: 'date', hint: 'เว้นว่าง = ไม่มีกำหนดสิ้นสุด' },
        { name: 'accountId', label: 'จ่ายจากบัญชี', type: 'select', options: accounts, hint: 'ใส่ให้บิลที่สร้างอัตโนมัติ (เปลี่ยนได้ตอนกดจ่ายแล้ว)' },
        { name: 'isEssential', label: 'ค่าใช้จ่ายจำเป็น (Essential)', type: 'checkbox', hint: 'บิลที่สร้างจะถูกนับเป็นค่าใช้จ่ายจำเป็น (ใช้คำนวณเป้าหมายเงินสำรองฉุกเฉิน)' },
        { name: 'isActive', label: 'ใช้งาน (สร้างบิลอัตโนมัติ)', type: 'checkbox', hint: 'ปิดเพื่อหยุดสร้างบิลชั่วคราวโดยไม่ลบรายการ' },
      ]}
      initial={{
        name: recurring?.name ?? '',
        category: recurring?.category ?? '',
        amount: str(recurring?.amount),
        frequency: recurring?.frequency ?? 'monthly',
        nextDueDate: recurring?.nextDueDate ?? today,
        endDate: recurring?.endDate ?? '',
        accountId: recurring?.accountId ?? '',
        isEssential: recurring?.isEssential ?? false,
        isActive: recurring?.isActive ?? true,
      }}
      validate={(v) => {
        const e: Record<string, string> = {}
        if (v.endDate && v.nextDueDate && String(v.endDate) < String(v.nextDueDate)) e.endDate = 'วันสิ้นสุดต้องไม่ก่อนวันครบกำหนดถัดไป'
        if (v.amount !== '' && Number(v.amount) <= 0) e.amount = 'ต้องมากกว่า 0'
        return e
      }}
      action={saveRecurringAction}
      toInput={(v) => ({ ...v, id: recurring?.id })}
      onClose={onClose}
      success={recurring ? 'บันทึกการแก้ไขรายจ่ายประจำแล้ว' : 'เพิ่มรายจ่ายประจำแล้ว'}
    />
  )
}
