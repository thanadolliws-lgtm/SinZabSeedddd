'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowRightLeft, Landmark, Pencil, Plus, Target, Trash2 } from 'lucide-react'
import { deleteAccountRowAction, deleteGoalAction, deleteTransferAction, saveAccountAction, saveGoalAction, saveTransferAction } from '@/actions/app'
import type { AccountView, GoalView } from '@/lib/calc/snapshot'
import type { AccountRow, GoalRow, TransferRow } from '@/lib/calc/types'
import { FormModal, useAction, type FieldDef, type FormValues } from '@/components/forms'
import { Badge, Button, Card, DataTable, EmptyState, IconButton, Notice, ProgressBar, Stat, useFeedback, type Column } from '@/components/ui'
import { fmtDate, fmtMoney, fmtNum, fmtPct } from '@/lib/format'
import { ACCOUNT_PURPOSE_LABELS, ACCOUNT_TYPE_LABELS, GOAL_STATUS, TRANSFER_KINDS, TRANSFER_KIND_LABELS, str, type MoneyTabProps } from './shared'

type Dialog = { kind: 'account'; account?: AccountRow } | { kind: 'transfer'; transfer?: TransferRow } | { kind: 'goal'; goal?: GoalRow } | null

const accountInput = (a: AccountRow, patch: Partial<AccountRow> = {}) => {
  const x = { ...a, ...patch }
  return { id: x.id, name: x.name, type: x.type, purpose: x.purpose, goalId: x.goalId ?? '', currency: x.currency, openingBalance: x.openingBalance, openingDate: x.openingDate, note: x.note ?? '', isArchived: x.isArchived }
}

export function CashTab({ s, raw, today }: MoneyTabProps) {
  const [dialog, setDialog] = useState<Dialog>(null)
  const close = () => setDialog(null)
  const { confirm, toast } = useFeedback()
  const base = s.baseCurrency
  const e = s.emergency
  const removeAccount = useAction(deleteAccountRowAction, { success: 'ลบบัญชีแล้ว' })
  const archiveAccount = useAction(saveAccountAction, { success: 'เก็บบัญชีถาวรแล้ว ประวัติรายการยังอยู่ครบ' })
  const removeTransfer = useAction(deleteTransferAction, { success: 'ลบรายการโอนแล้ว ยอดเงินในบัญชีถูกคำนวณใหม่' })
  const removeGoal = useAction(deleteGoalAction, { success: 'ลบเป้าหมายแล้ว' })

  const account = (id: string) => s.accounts.find((a) => a.id === id)
  const goalName = (id: string | null) => (id ? (raw.goals.find((g) => g.id === id)?.name ?? '?') : null)
  /** records that name the account: the database refuses to delete it while any exist */
  const references = (id: string) =>
    raw.incomes.filter((r) => r.accountId === id).length +
    raw.expenses.filter((r) => r.accountId === id).length +
    raw.recurring.filter((r) => r.accountId === id).length +
    raw.debtEvents.filter((r) => r.accountId === id).length +
    raw.transfers.filter((t) => t.fromAccountId === id || t.toAccountId === id).length +
    raw.transactions.filter((t) => t.accountId === id).length

  const deleteAccount = async (a: AccountView) => {
    const refs = references(a.id)
    if (refs === 0) {
      if (await confirm({ title: `ลบบัญชี "${a.name}"?`, message: 'บัญชีนี้ยังไม่มีรายการใดอ้างอิง ลบแล้วยอดยกมาของบัญชีจะหายจากยอดรวมทั้งหมด การลบถูกบันทึกใน Audit Log', danger: true, confirmLabel: 'ลบบัญชี' })) {
        await removeAccount.run({ id: a.id })
      }
      return
    }
    if (a.isArchived) {
      toast('info', `บัญชี "${a.name}" ถูกใช้ใน ${refs} รายการ จึงลบไม่ได้ และถูกเก็บถาวรอยู่แล้ว (ไม่นับในยอดรวม ประวัติยังอยู่ครบ)`)
      return
    }
    const ok = await confirm({
      title: `ลบบัญชี "${a.name}" ไม่ได้`,
      message: (
        <>
          <p>
            บัญชีนี้ถูกใช้ใน {refs} รายการ (รายรับ รายจ่าย รายจ่ายประจำ การโอน การชำระหนี้ หรือธุรกรรมหุ้น) ฐานข้อมูลจึงไม่อนุญาตให้ลบ เพื่อไม่ให้ประวัติและยอดเงินผิดเพี้ยน
          </p>
          <p className="mt-2">แนะนำให้ &quot;เก็บถาวร&quot; แทน: บัญชีจะถูกซ่อนจากตัวเลือก และไม่ถูกนับในยอดรวมอีก แต่ประวัติทั้งหมดยังอยู่</p>
          {Math.abs(a.balance) > 0.005 && (
            <p className="mt-2 text-warn">
              บัญชีนี้ยังมียอดคงเหลือ {fmtMoney(a.balance, a.currency)} ซึ่งจะไม่ถูกนับในยอดเงินสดรวมหลังเก็บถาวร ควรโอนเงินออกให้เหลือ 0 ก่อน
            </p>
          )}
        </>
      ),
      confirmLabel: 'เก็บถาวรแทน',
    })
    if (ok) await archiveAccount.run(accountInput(a, { isArchived: true }))
  }

  // ---- accounts table ------------------------------------------------------
  const accountColumns: Column<AccountView>[] = [
    {
      key: 'name',
      header: 'บัญชี',
      sort: (a) => a.name,
      cell: (a) => (
        <div className="max-w-56">
          <div className="flex flex-wrap items-center gap-1.5 font-medium">
            {a.name}
            {a.isArchived && <Badge tone="neutral">เก็บถาวร</Badge>}
          </div>
          {a.note && <div className="line-clamp-1 text-xs text-muted">{a.note}</div>}
        </div>
      ),
    },
    { key: 'type', header: 'ประเภท', sort: (a) => a.type, cell: (a) => <span className="text-xs">{ACCOUNT_TYPE_LABELS[a.type]}</span> },
    {
      key: 'purpose',
      header: 'วัตถุประสงค์',
      sort: (a) => a.purpose,
      cell: (a) =>
        a.type === 'other_asset' ? (
          <span className="text-xs text-muted">ไม่ใช่เงินสด</span>
        ) : (
          <div>
            <Badge tone={a.purpose === 'general' ? 'neutral' : 'accent'}>{ACCOUNT_PURPOSE_LABELS[a.purpose]}</Badge>
            {a.purpose === 'goal' && <div className="mt-0.5 text-xs text-muted">{goalName(a.goalId)}</div>}
          </div>
        ),
    },
    { key: 'ccy', header: 'สกุลเงิน', sort: (a) => a.currency, cell: (a) => <span className="num text-xs">{a.currency}</span> },
    {
      key: 'opening',
      header: 'ยอดยกมา',
      align: 'right',
      title: 'ยอดเงินก่อนเริ่มบันทึกรายการในระบบ',
      cell: (a) => (
        <div className="num">
          <div>{fmtMoney(a.openingBalance, a.currency)}</div>
          <div className="text-xs text-muted">{fmtDate(a.openingDate)}</div>
        </div>
      ),
    },
    {
      key: 'balance',
      header: 'ยอดคงเหลือปัจจุบัน',
      align: 'right',
      sort: (a) => a.balanceBase,
      cell: (a) => (
        <div className="num">
          <div className="font-medium">{fmtMoney(a.balance, a.currency)}</div>
          {a.currency !== base &&
            (a.balanceBase === null ? (
              <Badge tone="warn" title="ยอดนี้ยังไม่ถูกรวมในยอดรวมเงินบาท">
                ไม่มีอัตราแลกเปลี่ยน
              </Badge>
            ) : (
              <div className="text-xs text-muted">≈ {fmtMoney(a.balanceBase, base)}</div>
            ))}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (a) => (
        <div className="flex justify-end">
          <IconButton label="แก้ไข" onClick={() => setDialog({ kind: 'account', account: a })}>
            <Pencil size={15} />
          </IconButton>
          <IconButton label="ลบ" onClick={() => void deleteAccount(a)}>
            <Trash2 size={15} />
          </IconButton>
        </div>
      ),
    },
  ]

  // ---- transfers table -----------------------------------------------------
  const transferColumns: Column<TransferRow>[] = [
    { key: 'date', header: 'วันที่', sort: (t) => t.date, cell: (t) => <span className="num">{fmtDate(t.date)}</span> },
    { key: 'kind', header: 'ประเภท', sort: (t) => t.kind, cell: (t) => <Badge tone={t.kind === 'transfer' ? 'neutral' : 'accent'}>{TRANSFER_KIND_LABELS[t.kind] ?? t.kind}</Badge> },
    {
      key: 'route',
      header: 'จากบัญชี → ไปบัญชี',
      cell: (t) => (
        <span className="text-xs">
          {account(t.fromAccountId)?.name ?? '?'} <span className="text-muted">→</span> {account(t.toAccountId)?.name ?? '?'}
        </span>
      ),
    },
    {
      key: 'amount',
      header: 'จำนวนเงิน',
      align: 'right',
      sort: (t) => t.amountFrom,
      cell: (t) => {
        const from = account(t.fromAccountId)?.currency ?? base
        const to = account(t.toAccountId)?.currency ?? base
        return (
          <div className="num">
            <div>{fmtMoney(t.amountFrom, from)}</div>
            {from !== to && <div className="text-xs text-muted">ได้รับ {fmtMoney(t.amountTo, to)}</div>}
          </div>
        )
      },
    },
    { key: 'fee', header: 'ค่าธรรมเนียม', align: 'right', cell: (t) => <span className="num">{t.fee > 0 ? fmtMoney(t.fee, account(t.fromAccountId)?.currency ?? base) : '—'}</span> },
    { key: 'note', header: 'หมายเหตุ', cell: (t) => <span className="line-clamp-2 max-w-48 text-xs text-muted">{t.note ?? '—'}</span> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (t) => (
        <div className="flex justify-end">
          <IconButton label="แก้ไข" onClick={() => setDialog({ kind: 'transfer', transfer: t })}>
            <Pencil size={15} />
          </IconButton>
          <IconButton
            label="ลบ"
            onClick={async () => {
              if (await confirm({ title: 'ลบรายการโอนนี้?', message: `โอน ${fmtMoney(t.amountFrom, account(t.fromAccountId)?.currency ?? base)} วันที่ ${fmtDate(t.date)} จะถูกลบ และยอดเงินของทั้งสองบัญชีจะถูกคำนวณใหม่`, danger: true, confirmLabel: 'ลบรายการโอน' })) {
                await removeTransfer.run({ id: t.id })
              }
            }}
          >
            <Trash2 size={15} />
          </IconButton>
        </div>
      ),
    },
  ]

  const gapTone = e.gap === null ? 'neutral' : e.gap > 0.005 ? 'warn' : 'gain'
  const cashAccounts = raw.accounts.filter((a) => a.type !== 'other_asset' && !a.isArchived)

  return (
    <div className="space-y-5">
      <section aria-label="สรุปเงินสดและเงินสำรอง" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="เงินสดรวม"
          value={fmtMoney(s.cash.totalCashBase)}
          sub={s.cash.otherAssetsBase !== 0 ? `ไม่รวมทรัพย์สินอื่น ${fmtMoney(s.cash.otherAssetsBase)}` : undefined}
          hint="ยอดคงเหลือของบัญชีเงินสด ธนาคาร และเงินสดในบัญชีโบรกเกอร์ทุกบัญชีที่ไม่ได้เก็บถาวร ไม่รวมมูลค่าหุ้นและทรัพย์สินอื่นที่ประเมินเอง"
        />
        <Stat
          label="เงินที่ใช้ได้จริง"
          value={fmtMoney(s.cash.generalCashBase)}
          sub={`พร้อมใช้หลังหักบิลและหนี้ขั้นต่ำ ${fmtMoney(s.availableThisMonth)}`}
          hint="บัญชีเงินสด/ธนาคารที่ตั้งวัตถุประสงค์เป็น 'ใช้จ่ายทั่วไป' ไม่รวมเงินสำรอง เงินออมตามเป้าหมาย และเงินในบัญชีโบรกเกอร์"
        />
        <Stat label="เงินที่กันไว้แล้ว" value={fmtMoney(s.savings)} sub={`สำรอง ${fmtMoney(s.cash.emergencyFundBase)} · เป้าหมาย ${fmtMoney(s.cash.goalReservedBase)}`} hint="เงินสำรองฉุกเฉิน + เงินออมตามเป้าหมาย (ยอดในบัญชีที่ตั้งวัตถุประสงค์ไว้)" />
        <Stat label="เงินในบัญชีโบรกเกอร์" value={fmtMoney(s.cash.brokerageCashBase)} hint="เงินสดที่ยังไม่ได้ลงทุนในบัญชีโบรกเกอร์ (ไม่รวมมูลค่าหุ้น) แยกออกจากเงินใช้จ่ายแล้ว" />
        <Stat label="เงินสำรองฉุกเฉินที่มี" value={fmtMoney(e.current)} hint="ยอดในบัญชีที่ตั้งวัตถุประสงค์เป็น 'เงินสำรองฉุกเฉิน' เงินลงทุนไม่ถูกนับ" />
        <Stat
          label="เงินสำรองที่ควรมี"
          value={e.target === null ? 'ยังคำนวณไม่ได้' : fmtMoney(e.target)}
          tone={e.target === null ? 'neutral' : undefined}
          sub={e.essentialMonthly !== null ? `${fmtMoney(e.essentialMonthly)} × ${e.targetMonths} เดือน` : 'ไม่มีข้อมูลค่าใช้จ่ายจำเป็น'}
          hint="ค่าใช้จ่ายจำเป็นต่อเดือน × จำนวนเดือนที่ตั้งไว้ใน Settings"
        />
        <Stat
          label="ขาด / เกินเป้าหมาย"
          value={e.gap === null ? '—' : e.gap > 0.005 ? `ขาด ${fmtMoney(e.gap)}` : Math.abs(e.gap) <= 0.005 ? 'ครบพอดี' : `เกิน ${fmtMoney(-e.gap)}`}
          tone={gapTone}
          hint="เงินสำรองที่ควรมี − เงินสำรองที่มี (บวก = ยังขาด)"
        />
        <Stat
          label="จำนวนเดือนที่ครอบคลุม"
          value={e.coverageMonths === null ? '—' : `${fmtNum(e.coverageMonths, 1)} เดือน`}
          tone={e.coverageMonths === null ? 'neutral' : e.coverageMonths + 1e-9 < e.targetMonths ? 'warn' : 'gain'}
          sub={`เป้าหมาย ${e.targetMonths} เดือน`}
          hint="เงินสำรองที่มี ÷ ค่าใช้จ่ายจำเป็นต่อเดือน"
        />
      </section>

      <Card title="เงินสำรองฉุกเฉิน (Emergency Fund)" subtitle={e.essentialSource === 'setting' ? 'ค่าใช้จ่ายจำเป็นต่อเดือนมาจากค่าที่ตั้งไว้ใน Settings' : e.essentialSource === 'average' ? 'ค่าใช้จ่ายจำเป็นต่อเดือน = ค่าเฉลี่ยรายจ่ายที่ติ๊ก "จำเป็น" ย้อนหลังสูงสุด 3 เดือน' : undefined}>
        {e.target === null ? (
          <Notice tone="info" title="ยังคำนวณเป้าหมายเงินสำรองไม่ได้">
            ต้องมีค่าใช้จ่ายจำเป็นต่อเดือนก่อน: บันทึกรายจ่ายและติ๊ก &quot;ค่าใช้จ่ายจำเป็น&quot; ในแท็บรายจ่าย หรือกรอกค่าใช้จ่ายจำเป็นต่อเดือนเองที่หน้า{' '}
            <Link href="/settings" className="text-accent underline">
              Settings
            </Link>{' '}
            (ตั้งจำนวนเดือนเป้าหมายได้ที่หน้าเดียวกัน ปัจจุบัน {e.targetMonths} เดือน)
          </Notice>
        ) : (
          <div>
            <div className="mb-1 flex justify-between gap-2 text-xs text-muted">
              <span>
                มี {fmtMoney(e.current)} จากเป้าหมาย {fmtMoney(e.target)}
              </span>
              <span className="num">{fmtPct(e.target > 0 ? (e.current / e.target) * 100 : null, 0)}</span>
            </div>
            <ProgressBar value={e.current} max={e.target} tone={gapTone === 'warn' ? 'warn' : 'gain'} />
          </div>
        )}
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted">
          <li>นับเฉพาะเงินสดในบัญชีที่ตั้งวัตถุประสงค์เป็น &quot;เงินสำรองฉุกเฉิน&quot; หุ้น กองทุน และเงินลงทุนอื่นไม่ถูกนับเป็นเงินสำรองฉุกเฉินเด็ดขาด เพราะมูลค่าผันผวนและอาจต้องขายขาดทุนในยามฉุกเฉิน</li>
          <li>เติมเงินสำรองด้วยการโอนเงินเข้าบัญชีเงินสำรอง (ประเภท &quot;กันเป็นเงินสำรองฉุกเฉิน&quot;) การโอนไม่ใช่รายจ่าย ยอดเงินรวมจึงไม่ลดลง</li>
        </ul>
      </Card>

      {s.cash.missingFx.length > 0 && (
        <Notice tone="warning" title={`ไม่มีอัตราแลกเปลี่ยนของ ${s.cash.missingFx.join(', ')}`}>
          ยอดในบัญชีสกุลเงินนี้ยังไม่ถูกรวมในยอดรวมเงินบาทด้านบน
        </Notice>
      )}

      <Card
        title="บัญชีเงิน (Accounts)"
        subtitle="ยอดคงเหลือ = ยอดยกมา + รายรับที่ได้รับจริง − รายจ่ายที่จ่ายจริง − ชำระหนี้ ± โอนเงิน ± ซื้อขายหุ้นที่ผูกบัญชี"
        actions={
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setDialog({ kind: 'account' })}>
            เพิ่มบัญชี
          </Button>
        }
        pad={false}
      >
        {s.accounts.length === 0 ? (
          <EmptyState
            icon={<Landmark size={28} />}
            title="ยังไม่มีบัญชี"
            description="เพิ่มบัญชีเงินสด/ธนาคารพร้อมยอดยกมา (ยอดเงิน ณ วันที่เริ่มบันทึก) แล้วรายรับ รายจ่าย และการโอนจะปรับยอดให้อัตโนมัติ"
            action={
              <Button variant="primary" onClick={() => setDialog({ kind: 'account' })}>
                เพิ่มบัญชี
              </Button>
            }
          />
        ) : (
          <DataTable
            rows={s.accounts}
            columns={accountColumns}
            rowKey={(a) => a.id}
            search={(a) => `${a.name} ${a.note ?? ''} ${goalName(a.goalId) ?? ''}`}
            filters={[
              { key: 'type', label: 'ประเภท', options: Object.entries(ACCOUNT_TYPE_LABELS).map(([value, label]) => ({ value, label })), get: (a) => a.type },
              { key: 'purpose', label: 'วัตถุประสงค์', options: Object.entries(ACCOUNT_PURPOSE_LABELS).map(([value, label]) => ({ value, label })), get: (a) => (a.type === 'other_asset' ? null : a.purpose) },
              {
                key: 'archived',
                label: 'สถานะ',
                options: [
                  { value: 'active', label: 'ใช้งาน' },
                  { value: 'archived', label: 'เก็บถาวร' },
                ],
                get: (a) => (a.isArchived ? 'archived' : 'active'),
              },
            ]}
            rowClassName={(a) => (a.isArchived ? 'opacity-60' : undefined)}
            defaultSort={{ key: 'balance', dir: 'desc' }}
          />
        )}
      </Card>

      <Card
        title="การโอนเงินระหว่างบัญชี (Transfers)"
        subtitle="การโอนไม่ใช่รายรับหรือรายจ่าย: ยอดเงินรวมไม่เปลี่ยน (ยกเว้นค่าธรรมเนียม) รวมถึงการโอนเข้าบัญชีโบรกเกอร์ จึงไม่นับซ้ำเมื่อนำไปซื้อหุ้น"
        actions={
          <Button size="sm" icon={<ArrowRightLeft size={14} />} disabled={cashAccounts.length < 2} title={cashAccounts.length < 2 ? 'ต้องมีบัญชีเงินสด/ธนาคาร/โบรกเกอร์อย่างน้อย 2 บัญชี' : undefined} onClick={() => setDialog({ kind: 'transfer' })}>
            โอนเงิน
          </Button>
        }
        pad={false}
      >
        <DataTable
          rows={raw.transfers}
          columns={transferColumns}
          rowKey={(t) => t.id}
          search={(t) => `${account(t.fromAccountId)?.name ?? ''} ${account(t.toAccountId)?.name ?? ''} ${t.note ?? ''}`}
          filters={[{ key: 'kind', label: 'ประเภท', options: TRANSFER_KINDS.map((k) => ({ value: k, label: TRANSFER_KIND_LABELS[k] })), get: (t) => t.kind }]}
          defaultSort={{ key: 'date', dir: 'desc' }}
          pageSize={15}
          empty={cashAccounts.length < 2 ? 'ยังไม่มีการโอน (ต้องมีบัญชีอย่างน้อย 2 บัญชีจึงจะโอนได้)' : 'ยังไม่มีการโอนเงินระหว่างบัญชี'}
        />
      </Card>

      <Card
        title="เป้าหมายการออม (Savings Goals)"
        subtitle="ยอดที่ออมได้ = ยอดคงเหลือของบัญชีที่ตั้งวัตถุประสงค์ 'เงินออมตามเป้าหมาย' และผูกกับเป้าหมายนั้น"
        actions={
          <Button size="sm" icon={<Plus size={14} />} onClick={() => setDialog({ kind: 'goal' })}>
            เพิ่มเป้าหมาย
          </Button>
        }
      >
        {s.goals.length === 0 ? (
          <EmptyState icon={<Target size={28} />} title="ยังไม่มีเป้าหมายการออม" description="ตั้งเป้าหมาย (เช่น ท่องเที่ยว ดาวน์บ้าน) แล้วผูกบัญชีเงินออมกับเป้าหมาย ระบบจะแสดงความคืบหน้าจากยอดในบัญชีนั้น" />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {s.goals.map((g) => (
              <GoalCard
                key={g.id}
                g={g}
                onEdit={() => setDialog({ kind: 'goal', goal: g })}
                onDelete={async () => {
                  const ok = await confirm({
                    title: `ลบเป้าหมาย "${g.name}"?`,
                    message:
                      g.accountNames.length > 0
                        ? `บัญชีที่ผูกไว้ (${g.accountNames.join(', ')}) จะกลับเป็นวัตถุประสงค์ "ใช้จ่ายทั่วไป" เงินในบัญชียังอยู่ครบ แต่จะนับเป็นเงินที่ใช้ได้จริงแทนเงินที่กันไว้`
                        : 'ลบเฉพาะเป้าหมาย ไม่มีบัญชีใดผูกอยู่ ไม่กระทบยอดเงิน',
                    danger: true,
                    confirmLabel: 'ลบเป้าหมาย',
                  })
                  if (ok) await removeGoal.run({ id: g.id })
                }}
              />
            ))}
          </ul>
        )}
      </Card>

      {dialog?.kind === 'account' && <AccountForm account={dialog.account} goals={raw.goals} base={base} today={today} onClose={close} />}
      {dialog?.kind === 'transfer' && <TransferForm transfer={dialog.transfer} accounts={s.accounts} today={today} onClose={close} />}
      {dialog?.kind === 'goal' && <GoalForm goal={dialog.goal} onClose={close} />}
    </div>
  )
}

function GoalCard({ g, onEdit, onDelete }: { g: GoalView; onEdit: () => void; onDelete: () => void }) {
  const done = g.saved + 0.005 >= g.targetAmount
  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{g.name}</div>
          <Badge tone={GOAL_STATUS[g.status].tone}>{GOAL_STATUS[g.status].label}</Badge>
        </div>
        <div className="flex shrink-0">
          <IconButton label="แก้ไขเป้าหมาย" onClick={onEdit}>
            <Pencil size={15} />
          </IconButton>
          <IconButton label="ลบเป้าหมาย" onClick={onDelete}>
            <Trash2 size={15} />
          </IconButton>
        </div>
      </div>
      <div className="mt-2 mb-1 flex justify-between gap-2 text-xs">
        <span className="num">
          {fmtMoney(g.saved)} / {fmtMoney(g.targetAmount)}
        </span>
        <span className="num text-muted">{fmtPct(g.progressPct, 0)}</span>
      </div>
      <ProgressBar value={g.saved} max={g.targetAmount} tone={done ? 'gain' : 'accent'} />
      <dl className="mt-2 space-y-0.5 text-xs">
        <div className="flex justify-between gap-2">
          <dt className="text-muted">ยังขาด</dt>
          <dd className="num">{done ? 'ครบเป้าหมายแล้ว' : fmtMoney(g.remaining)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted">วันที่ต้องการ</dt>
          <dd className="num">{fmtDate(g.targetDate)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted">ออมต่อเดือน (ตามแผน)</dt>
          <dd className="num">{g.monthlyContribution > 0 ? fmtMoney(g.monthlyContribution) : '—'}</dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-muted">
        {g.accountNames.length > 0 ? `บัญชีที่ผูก: ${g.accountNames.join(', ')}` : 'ยังไม่มีบัญชีที่ผูกกับเป้าหมายนี้: เพิ่มหรือแก้ไขบัญชีให้มีวัตถุประสงค์ "เงินออมตามเป้าหมาย" แล้วเลือกเป้าหมายนี้'}
      </p>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------
function AccountForm({ account, goals, base, today, onClose }: { account?: AccountRow; goals: GoalRow[]; base: string; today: string; onClose: () => void }) {
  const fields: FieldDef[] = [
    { name: 'name', label: 'ชื่อบัญชี', required: true, placeholder: 'เช่น ออมทรัพย์ธนาคาร, เงินสดในกระเป๋า', full: true },
    {
      name: 'type',
      label: 'ประเภทบัญชี',
      type: 'select',
      required: true,
      options: Object.entries(ACCOUNT_TYPE_LABELS).map(([value, label]) => ({ value, label })),
      full: true,
      hint: (v) =>
        v.type === 'other_asset'
          ? 'ทรัพย์สินที่ประเมินมูลค่าเอง (เช่น ทองคำ รถ ที่ดิน): นับในทรัพย์สินสุทธิ แต่ไม่นับเป็นเงินสด และใช้รับ/จ่าย/โอนเงินไม่ได้'
          : v.type === 'brokerage'
            ? 'เงินสดที่พักในบัญชีโบรกเกอร์ แยกจากเงินใช้จ่าย (มูลค่าหุ้นบันทึกที่หน้าพอร์ตหุ้น)'
            : undefined,
    },
    {
      name: 'purpose',
      label: 'วัตถุประสงค์ของเงิน',
      type: 'select',
      required: true,
      options: Object.entries(ACCOUNT_PURPOSE_LABELS).map(([value, label]) => ({ value, label })),
      showIf: (v) => v.type !== 'other_asset',
      hint: (v) => (v.purpose === 'emergency' ? 'ยอดในบัญชีนี้นับเป็นเงินสำรองฉุกเฉิน' : v.purpose === 'goal' ? 'ยอดในบัญชีนี้นับเป็นเงินออมของเป้าหมายที่เลือก' : 'นับเป็นเงินที่ใช้ได้จริง'),
    },
    {
      name: 'goalId',
      label: 'เป้าหมายการออม',
      type: 'select',
      required: true,
      options: goals.map((g) => ({ value: g.id, label: g.name })),
      showIf: (v) => v.type !== 'other_asset' && v.purpose === 'goal',
      hint: goals.length === 0 ? 'ยังไม่มีเป้าหมาย: สร้างเป้าหมายการออมก่อน (ส่วนล่างของแท็บนี้)' : 'บัญชีที่กันไว้สำหรับเป้าหมายต้องเลือกเป้าหมาย',
    },
    {
      name: 'currency',
      label: 'สกุลเงิน',
      required: true,
      placeholder: base,
      hint: `รายรับ รายจ่าย และการชำระหนี้บันทึกเป็น ${base} จึงผูกได้เฉพาะบัญชีสกุล ${base} · บัญชีที่มีรายการแล้วเปลี่ยนสกุลเงินไม่ได้`,
    },
    {
      name: 'openingBalance',
      label: 'ยอดยกมา / มูลค่า (Opening Balance)',
      type: 'number',
      hint: (v) => (v.type === 'other_asset' ? 'มูลค่าที่ประเมินเอง แก้ไขตัวเลขนี้เมื่อมูลค่าเปลี่ยน' : 'ยอดเงิน ณ วันที่เริ่มบันทึก (ก่อนรายการแรกในระบบ)'),
    },
    { name: 'openingDate', label: 'วันที่ของยอดยกมา', type: 'date', required: true, max: today },
    { name: 'note', label: 'หมายเหตุ', type: 'textarea' },
    ...(account ? [{ name: 'isArchived', label: 'เก็บถาวร (ซ่อนจากตัวเลือกและไม่นับในยอดรวม ประวัติยังอยู่ครบ)', type: 'checkbox' as const }] : []),
  ]
  const initial: FormValues = {
    name: account?.name ?? '',
    type: account?.type ?? 'bank',
    purpose: account?.purpose ?? 'general',
    goalId: account?.goalId ?? '',
    currency: account?.currency ?? base,
    openingBalance: account ? str(account.openingBalance) : '',
    openingDate: account?.openingDate ?? today,
    note: account?.note ?? '',
    isArchived: account?.isArchived ?? false,
  }
  return (
    <FormModal
      title={account ? `แก้ไขบัญชี: ${account.name}` : 'เพิ่มบัญชี'}
      intro={
        <Notice tone="info">
          ยอดยกมา (Opening Balance) คือยอดเงินก่อนเริ่มบันทึกรายการในระบบ ยอดคงเหลือปัจจุบันไม่ได้เก็บเป็นตัวเลขแยก แต่คำนวณจากยอดยกมา + ทุกรายการที่ผูกกับบัญชีนี้หลังจากนั้นเสมอ
        </Notice>
      }
      fields={fields}
      initial={initial}
      action={saveAccountAction}
      onClose={onClose}
      validate={(v) => {
        const e: Record<string, string> = {}
        if (!/^[A-Za-z]{3}$/.test(String(v.currency).trim())) e.currency = 'รหัสสกุลเงิน 3 ตัวอักษร เช่น THB, USD'
        if (v.type !== 'other_asset' && Number(v.openingBalance) < 0) e.openingBalance = 'ต้องไม่ติดลบ (หนี้ให้บันทึกในแท็บหนี้สิน)'
        return e
      }}
      toInput={(v) => {
        const purpose = v.type === 'other_asset' ? 'general' : v.purpose
        return {
          id: account?.id,
          name: v.name,
          type: v.type,
          purpose,
          goalId: purpose === 'goal' ? v.goalId : '',
          currency: String(v.currency).trim().toUpperCase(),
          openingBalance: v.openingBalance === '' ? 0 : v.openingBalance,
          openingDate: v.openingDate,
          note: v.note,
          isArchived: v.isArchived === true,
        }
      }}
      success={account ? 'บันทึกการแก้ไขบัญชีแล้ว' : 'เพิ่มบัญชีแล้ว'}
    />
  )
}

function TransferForm({ transfer, accounts, today, onClose }: { transfer?: TransferRow; accounts: AccountView[]; today: string; onClose: () => void }) {
  const usable = accounts.filter((a) => a.type !== 'other_asset' && (!a.isArchived || a.id === transfer?.fromAccountId || a.id === transfer?.toAccountId))
  const byId = (id: unknown) => accounts.find((a) => a.id === id)
  const options = usable.map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` }))
  const differ = (v: FormValues) => {
    const f = byId(v.fromAccountId)
    const t = byId(v.toAccountId)
    return !!f && !!t && f.currency !== t.currency
  }
  const fields: FieldDef[] = [
    { name: 'date', label: 'วันที่โอน', type: 'date', required: true, max: today },
    {
      name: 'kind',
      label: 'ประเภทการโอน',
      type: 'select',
      required: true,
      options: TRANSFER_KINDS.map((k) => ({ value: k, label: TRANSFER_KIND_LABELS[k] })),
      hint: 'ใช้จัดกลุ่มรายการ ส่วนการนับเป็นเงินสำรอง/เงินออม ขึ้นกับวัตถุประสงค์ของบัญชีปลายทาง',
    },
    {
      name: 'fromAccountId',
      label: 'จากบัญชี',
      type: 'select',
      required: true,
      options,
      hint: (v) => {
        const a = byId(v.fromAccountId)
        return a ? `ยอดปัจจุบัน ${fmtMoney(a.balance, a.currency)}` : undefined
      },
    },
    {
      name: 'toAccountId',
      label: 'ไปบัญชี',
      type: 'select',
      required: true,
      options,
      hint: (v) => {
        const a = byId(v.toAccountId)
        return a ? `${ACCOUNT_TYPE_LABELS[a.type]} · ${ACCOUNT_PURPOSE_LABELS[a.purpose]}` : undefined
      },
    },
    {
      name: 'amountFrom',
      label: 'จำนวนเงินที่โอนออก',
      type: 'number',
      required: true,
      min: 0,
      hint: (v) => {
        const a = byId(v.fromAccountId)
        return a ? `สกุล ${a.currency} (ตัดจากบัญชีต้นทาง)` : undefined
      },
    },
    {
      name: 'amountTo',
      label: 'จำนวนเงินที่ได้รับจริง',
      type: 'number',
      required: true,
      min: 0,
      showIf: differ,
      hint: (v) => `บัญชีต่างสกุลเงิน: กรอกยอดที่เข้าบัญชีปลายทางจริงเป็น ${byId(v.toAccountId)?.currency ?? ''}`,
    },
    {
      name: 'fee',
      label: 'ค่าธรรมเนียม',
      type: 'number',
      min: 0,
      hint: (v) => `หักเพิ่มจากบัญชีต้นทาง${byId(v.fromAccountId) ? ` (${byId(v.fromAccountId)!.currency})` : ''}`,
    },
    { name: 'note', label: 'หมายเหตุ', type: 'textarea' },
  ]
  const kindMismatch = (v: FormValues): string | null => {
    const to = byId(v.toAccountId)
    if (!to) return null
    if (v.kind === 'emergency_allocation' && to.purpose !== 'emergency') return 'บัญชีปลายทางไม่ได้ตั้งวัตถุประสงค์เป็นเงินสำรองฉุกเฉิน เงินที่โอนจะยังไม่นับเป็นเงินสำรอง'
    if (v.kind === 'goal_allocation' && to.purpose !== 'goal') return 'บัญชีปลายทางไม่ได้ผูกกับเป้าหมายการออม เงินที่โอนจะยังไม่นับเป็นเงินออมตามเป้าหมาย'
    if (v.kind === 'investment_funding' && to.type !== 'brokerage') return 'บัญชีปลายทางไม่ใช่บัญชีโบรกเกอร์'
    return null
  }
  return (
    <FormModal
      title={transfer ? 'แก้ไขรายการโอน' : 'โอนเงินระหว่างบัญชี'}
      intro={<Notice tone="info">การโอนเงินไม่ใช่รายรับหรือรายจ่าย เป็นการย้ายเงินจากบัญชีหนึ่งไปอีกบัญชีหนึ่ง ยอดเงินรวมไม่เปลี่ยน (ยกเว้นค่าธรรมเนียม) การโอนเข้าบัญชีโบรกเกอร์ก็ไม่ใช่ค่าใช้จ่าย จึงไม่นับซ้ำเมื่อซื้อหุ้น</Notice>}
      fields={fields}
      initial={{
        date: transfer?.date ?? today,
        kind: transfer?.kind ?? 'transfer',
        fromAccountId: transfer?.fromAccountId ?? '',
        toAccountId: transfer?.toAccountId ?? '',
        amountFrom: str(transfer?.amountFrom),
        amountTo: str(transfer?.amountTo),
        fee: transfer && transfer.fee > 0 ? str(transfer.fee) : '',
        note: transfer?.note ?? '',
      }}
      action={saveTransferAction}
      onClose={onClose}
      validate={(v) => {
        const e: Record<string, string> = {}
        if (v.fromAccountId && v.fromAccountId === v.toAccountId) e.toAccountId = 'บัญชีต้นทางและปลายทางต้องไม่ใช่บัญชีเดียวกัน'
        if (v.amountFrom !== '' && Number(v.amountFrom) <= 0) e.amountFrom = 'ต้องมากกว่า 0'
        if (differ(v) && v.amountTo !== '' && Number(v.amountTo) <= 0) e.amountTo = 'ต้องมากกว่า 0'
        if (String(v.date) > today) e.date = 'ต้องไม่เป็นวันในอนาคต'
        return e
      }}
      extra={(v) => {
        const warn = kindMismatch(v)
        return warn ? <Notice tone="warning">{warn}</Notice> : null
      }}
      toInput={(v) => ({
        id: transfer?.id,
        date: v.date,
        kind: v.kind,
        fromAccountId: v.fromAccountId,
        toAccountId: v.toAccountId,
        amountFrom: v.amountFrom,
        amountTo: differ(v) ? v.amountTo : '',
        fee: v.fee === '' ? 0 : v.fee,
        note: v.note,
      })}
      success={transfer ? 'บันทึกการแก้ไขรายการโอนแล้ว' : 'บันทึกการโอนแล้ว'}
    />
  )
}

function GoalForm({ goal, onClose }: { goal?: GoalRow; onClose: () => void }) {
  return (
    <FormModal
      title={goal ? `แก้ไขเป้าหมาย: ${goal.name}` : 'เพิ่มเป้าหมายการออม'}
      intro={<Notice tone="info">ยอดที่ออมได้ไม่ต้องกรอกเอง ระบบรวมจากยอดคงเหลือของบัญชีที่ตั้งวัตถุประสงค์ &quot;เงินออมตามเป้าหมาย&quot; และเลือกเป้าหมายนี้</Notice>}
      fields={[
        { name: 'name', label: 'ชื่อเป้าหมาย', required: true, placeholder: 'เช่น เที่ยวญี่ปุ่น, เงินดาวน์บ้าน', full: true },
        { name: 'targetAmount', label: 'จำนวนเงินเป้าหมาย (บาท)', type: 'number', required: true, min: 0 },
        { name: 'targetDate', label: 'วันที่ต้องการ', type: 'date' },
        { name: 'monthlyContribution', label: 'ออมต่อเดือน (บาท)', type: 'number', min: 0, hint: 'ใช้เป็นค่าอัตโนมัติของ "เงินออมตามเป้าหมาย" ในแผนแบ่งเงินรายเดือน' },
        {
          name: 'status',
          label: 'สถานะ',
          type: 'select',
          required: true,
          options: Object.entries(GOAL_STATUS).map(([value, x]) => ({ value, label: x.label })),
        },
        { name: 'note', label: 'หมายเหตุ', type: 'textarea' },
      ]}
      initial={{
        name: goal?.name ?? '',
        targetAmount: str(goal?.targetAmount),
        targetDate: goal?.targetDate ?? '',
        monthlyContribution: goal && goal.monthlyContribution > 0 ? str(goal.monthlyContribution) : '',
        status: goal?.status ?? 'active',
        note: goal?.note ?? '',
      }}
      action={saveGoalAction}
      onClose={onClose}
      validate={(v): Record<string, string> => (v.targetAmount !== '' && Number(v.targetAmount) <= 0 ? { targetAmount: 'ต้องมากกว่า 0' } : {})}
      toInput={(v) => ({ ...v, id: goal?.id, monthlyContribution: v.monthlyContribution === '' ? 0 : v.monthlyContribution })}
      success={goal ? 'บันทึกการแก้ไขเป้าหมายแล้ว' : 'เพิ่มเป้าหมายแล้ว'}
    />
  )
}
