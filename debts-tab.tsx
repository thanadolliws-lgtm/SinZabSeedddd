'use client'

import { useState } from 'react'
import { CreditCard, HandCoins, ListOrdered, Pencil, Plus, Trash2 } from 'lucide-react'
import { deleteDebtPaymentAction, deleteLiabilityAction, saveDebtPaymentAction, saveLiabilityAction } from '@/actions/app'
import { simulateStrategy, type StrategyDebt, type StrategyResult } from '@/lib/calc/debt'
import { roundCash } from '@/lib/calc/money'
import type { LiabilityView } from '@/lib/calc/snapshot'
import type { DebtEventRow, LiabilityRow } from '@/lib/calc/types'
import { LIABILITY_KINDS } from '@/lib/services/schemas'
import { LineSeriesChart } from '@/components/charts'
import { FormModal, useAction } from '@/components/forms'
import { Badge, Button, Card, DataTable, EmptyState, Field, IconButton, Input, Notice, Select, Stat, useFeedback, type Column } from '@/components/ui'
import { fmtDate, fmtMoney, fmtNum, type Tone } from '@/lib/format'
import { LIABILITY_KIND_LABELS, baseCashAccountOptions, liabilityKindLabel, parseAmount, str, type MoneyTabProps } from './shared'

type Dialog =
  | { kind: 'liability'; liability?: LiabilityRow }
  | { kind: 'payment'; liability: LiabilityView; event?: DebtEventRow; preset?: 'payment' | 'charge' }
  | null

/** 27 -> '2 ปี 3 เดือน' */
function fmtDuration(months: number): string {
  if (months < 12) return `${months} เดือน`
  const y = Math.floor(months / 12)
  const m = months % 12
  return m ? `${y} ปี ${m} เดือน` : `${y} ปี`
}

function statusOf(l: LiabilityView, dueSoonDays: number): { label: string; tone: Tone } {
  if (l.liability.status === 'closed') return { label: 'ปิดแล้ว', tone: 'neutral' }
  if (l.due.overdueAmount > 0.005) return { label: 'เกินกำหนด', tone: 'loss' }
  if (l.balance <= 0.005) return { label: 'ไม่มียอดค้าง', tone: 'gain' }
  if (l.liability.minPayment <= 0) return { label: 'ไม่มียอดขั้นต่ำ', tone: 'neutral' }
  if (l.due.remainingThisMonth > 0.005 && l.due.daysUntilDue !== null && l.due.daysUntilDue >= 0 && l.due.daysUntilDue <= dueSoonDays) return { label: `ใกล้ครบกำหนด (${l.due.daysUntilDue} วัน)`, tone: 'warn' }
  if (l.due.requiredThisMonth > 0 && l.due.remainingThisMonth <= 0.005) return { label: 'ชำระขั้นต่ำเดือนนี้แล้ว', tone: 'gain' }
  if (l.due.remainingThisMonth > 0.005) return { label: 'รอชำระ', tone: 'neutral' }
  return { label: 'ปกติ', tone: 'neutral' }
}

export function DebtsTab({ s, raw, today }: MoneyTabProps) {
  const [dialog, setDialog] = useState<Dialog>(null)
  const close = () => setDialog(null)
  const { confirm } = useFeedback()
  const base = s.baseCurrency
  const d = s.debt
  const dueSoonDays = raw.settings.dueSoonDays
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = s.liabilities.find((l) => l.liability.id === selectedId) ?? s.liabilities.find((l) => l.ledger.length > 0) ?? s.liabilities[0] ?? null
  const removeLiability = useAction(deleteLiabilityAction, { success: 'ลบหนี้สินและรายการชำระทั้งหมดของหนี้นี้แล้ว' })
  const estimatedInterest = roundCash(s.liabilities.reduce((a, l) => a + l.interestEstimatedPortion, 0))
  const issues = s.liabilities.flatMap((l) => l.issues.map((i) => `${l.liability.name}: ${i}`))
  const high = s.liabilities.filter((l) => l.highInterest)

  const columns: Column<LiabilityView>[] = [
    {
      key: 'name',
      header: 'หนี้สิน',
      sort: (l) => l.liability.name,
      cell: (l) => (
        <div className="max-w-52">
          <div className="font-medium">{l.liability.name}</div>
          <div className="text-xs text-muted">{liabilityKindLabel(l.liability.kind)}</div>
        </div>
      ),
    },
    {
      key: 'balance',
      header: 'ยอดคงเหลือ',
      align: 'right',
      sort: (l) => l.balance,
      title: 'รวมดอกเบี้ยค้างจ่ายโดยประมาณตั้งแต่รายการล่าสุดถึงวันนี้',
      cell: (l) => (
        <div className="num">
          <div className="font-medium">{fmtMoney(l.balance, base)}</div>
          {l.accruedInterest > 0.005 && <div className="text-xs text-muted">รวมดอกเบี้ยค้าง ~{fmtMoney(l.accruedInterest, base)}</div>}
        </div>
      ),
    },
    {
      key: 'rate',
      header: 'ดอกเบี้ย/ปี',
      align: 'right',
      sort: (l) => l.liability.annualRate,
      cell: (l) => (
        <div className="num">
          <div>{fmtNum(l.liability.annualRate, 2)}%</div>
          {l.highInterest && <Badge tone="warn">ดอกเบี้ยสูง</Badge>}
        </div>
      ),
    },
    {
      key: 'min',
      header: 'ขั้นต่ำ/เดือน',
      align: 'right',
      sort: (l) => l.liability.minPayment,
      cell: (l) => (
        <div className="num">
          <div>{l.liability.minPayment > 0 ? fmtMoney(l.liability.minPayment, base) : '—'}</div>
          {l.liability.targetPayment !== null && l.liability.targetPayment > 0 && <div className="text-xs text-muted">ตั้งใจจ่าย {fmtMoney(l.liability.targetPayment, base)}</div>}
        </div>
      ),
    },
    {
      key: 'due',
      header: 'ครบกำหนดเดือนนี้',
      sort: (l) => l.due.dueDate,
      cell: (l) => (
        <div className="num text-xs">
          <div>{l.due.dueDate ? fmtDate(l.due.dueDate) : '—'}</div>
          {l.liability.dueDay && <div className="text-muted">ทุกวันที่ {l.liability.dueDay}</div>}
        </div>
      ),
    },
    {
      key: 'paid',
      header: 'ชำระเดือนนี้',
      align: 'right',
      sort: (l) => l.due.paidThisMonth,
      cell: (l) => (
        <div className="num">
          <div>{fmtMoney(l.due.paidThisMonth, base)}</div>
          {l.due.remainingThisMonth > 0.005 && <div className="text-xs text-warn">ยังต้องจ่าย {fmtMoney(l.due.remainingThisMonth, base)}</div>}
          {l.due.overdueAmount > 0.005 && <div className="text-xs text-loss">เกินกำหนด {fmtMoney(l.due.overdueAmount, base)}</div>}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'สถานะ',
      sort: (l) => statusOf(l, dueSoonDays).label,
      cell: (l) => {
        const st = statusOf(l, dueSoonDays)
        return <Badge tone={st.tone}>{st.label}</Badge>
      },
    },
    {
      key: 'payoff',
      header: 'คาดว่าจะปลดหนี้',
      sort: (l) => l.payoff.months,
      title: 'คาดการณ์จากยอดที่ตั้งใจจ่าย (หรือยอดขั้นต่ำ) ต่อเดือน ดอกเบี้ยคงที่ ทบต้นรายเดือน ไม่กู้เพิ่ม',
      cell: (l) => {
        if (l.liability.status === 'closed') return <span className="text-muted">—</span>
        if (l.balance <= 0.005) return <span className="text-xs text-gain">ชำระครบแล้ว</span>
        if (l.payoff.neverPaysOff) {
          return l.payoffPayment <= 0 ? (
            <Badge tone="neutral" title="ตั้งยอดชำระขั้นต่ำหรือยอดที่ตั้งใจจ่ายเพื่อคาดการณ์">
              ยังไม่ได้ตั้งยอดชำระ
            </Badge>
          ) : (
            <div className="max-w-44">
              <Badge tone="warn">ไม่มีวันหมด</Badge>
              <div className="text-xs text-muted">จ่าย {fmtMoney(l.payoffPayment, base)}/เดือน ไม่พอดอกเบี้ย</div>
            </div>
          )
        }
        return (
          <div className="num text-xs">
            <div className="text-sm">{fmtDuration(l.payoff.months ?? 0)}</div>
            <div className="text-muted">ดอกเบี้ยรวม {fmtMoney(l.payoff.totalInterest, base)}</div>
            <div className="text-muted">ที่ {fmtMoney(l.payoffPayment, base)}/เดือน</div>
          </div>
        )
      },
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (l) => (
        <div className="flex items-center justify-end">
          {l.liability.status === 'active' && (
            <Button size="sm" variant="ghost" icon={<HandCoins size={14} />} onClick={() => setDialog({ kind: 'payment', liability: l, preset: 'payment' })}>
              ชำระ
            </Button>
          )}
          <IconButton label="ดูรายการชำระ" onClick={() => setSelectedId(l.liability.id)}>
            <ListOrdered size={15} />
          </IconButton>
          <IconButton label="แก้ไข" onClick={() => setDialog({ kind: 'liability', liability: l.liability })}>
            <Pencil size={15} />
          </IconButton>
          <IconButton
            label="ลบ"
            onClick={async () => {
              const n = l.ledger.length
              const ok = await confirm({
                title: `ลบหนี้ "${l.liability.name}"?`,
                message: (
                  <>
                    <p>
                      {n > 0 ? `รายการชำระ/ยืมเพิ่มของหนี้นี้ ${n} รายการจะถูกลบไปด้วย และเงินที่เคยตัดจ่ายจากบัญชีจะกลับเข้ายอดบัญชี (ยอดเงินถูกคำนวณใหม่)` : 'หนี้นี้ยังไม่มีรายการชำระ'} การลบถูกบันทึกใน Audit Log
                    </p>
                    {n > 0 && <p className="mt-2 text-warn">ถ้าชำระหมดแล้ว แนะนำให้แก้ไขสถานะเป็น &quot;ปิดแล้ว&quot; แทน เพื่อเก็บประวัติการชำระไว้</p>}
                  </>
                ),
                danger: true,
                confirmLabel: n > 0 ? `ลบหนี้และ ${n} รายการ` : 'ลบหนี้',
              })
              if (ok) await removeLiability.run({ id: l.liability.id })
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
      <section aria-label="สรุปหนี้สิน" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="หนี้สินคงเหลือรวม" value={fmtMoney(d.total)} sub={d.accruedInterest > 0.005 ? `รวมดอกเบี้ยค้างโดยประมาณ ${fmtMoney(d.accruedInterest)}` : undefined} hint="ยอดหนี้หลังรวมดอกเบี้ยและหักการชำระจริงของหนี้ที่ยังไม่ปิด รวมดอกเบี้ยค้างจ่ายโดยประมาณถึงวันนี้" />
        <Stat label="ต้องชำระเดือนนี้ (คงเหลือ)" value={fmtMoney(d.dueThisMonth)} tone={d.dueThisMonth > 0.005 ? 'warn' : 'neutral'} sub={`ชำระแล้วเดือนนี้ ${fmtMoney(d.paidThisMonth)}`} hint="ยอดชำระขั้นต่ำของเดือนนี้ที่ยังไม่ได้จ่าย (ถูกหักออกจากเงินที่พร้อมใช้เดือนนี้)" />
        <Stat label="เกินกำหนดชำระ" value={fmtMoney(d.overdue)} tone={d.overdue > 0.005 ? 'loss' : 'neutral'} hint="ยอดขั้นต่ำที่เลยวันครบกำหนดแล้วแต่ยังไม่ได้ชำระ (รวมยอดค้างจากเดือนก่อน)" />
        <Stat label="ดอกเบี้ยที่จ่ายไปแล้ว" value={fmtMoney(d.interestPaid)} sub={estimatedInterest > 0.005 ? `ในนี้เป็นค่าประมาณ ${fmtMoney(estimatedInterest)}` : undefined} hint="ดอกเบี้ยที่ถูกคิดในทุกรายการชำระตั้งแต่เริ่มบันทึก ถ้าไม่ได้กรอกดอกเบี้ยจริงจากใบแจ้งยอด ระบบประมาณแบบรายวัน" />
        <Stat label="ดอกเบี้ยค้างโดยประมาณ" value={fmtMoney(d.accruedInterest)} tone="neutral" className="col-span-2 md:col-span-1" hint="ดอกเบี้ยที่สะสมตั้งแต่รายการล่าสุดถึงวันนี้ซึ่งยังไม่ถูกเรียกเก็บ คำนวณแบบรายวัน: ยอดหนี้ × อัตราต่อปี ÷ 365 × จำนวนวัน" />
      </section>

      {issues.length > 0 && (
        <Notice tone="danger" title="พบข้อมูลหนี้ไม่สอดคล้องกัน">
          {issues.join(' · ')}
        </Notice>
      )}
      {high.length > 0 && (
        <Notice tone="warning" title={`มีหนี้ดอกเบี้ยสูง ${high.length} ก้อน (ตั้งแต่ ${raw.settings.highInterestRate}% ต่อปีตามค่าที่ตั้งไว้)`}>
          {high.map((l) => `${l.liability.name} ${fmtNum(l.liability.annualRate, 2)}%`).join(' · ')} — การโปะหนี้ดอกเบี้ยสูงลดดอกเบี้ยที่ต้องจ่ายได้แน่นอน ขณะที่ผลตอบแทนจากการลงทุนไม่แน่นอน
        </Notice>
      )}

      <Card
        title="หนี้สิน (Liabilities)"
        subtitle="ยอดคงเหลือ = ยอดเริ่มต้น + ดอกเบี้ย + ค่าธรรมเนียม + ยืมเพิ่ม − เงินที่ชำระจริง · ดอกเบี้ยที่ไม่ได้กรอกจากใบแจ้งยอดเป็นค่าประมาณเสมอ"
        actions={
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setDialog({ kind: 'liability' })}>
            เพิ่มหนี้สิน
          </Button>
        }
        pad={false}
      >
        {s.liabilities.length === 0 ? (
          <EmptyState
            icon={<CreditCard size={28} />}
            title="ยังไม่มีหนี้สินที่บันทึกไว้"
            description="บันทึกบัตรเครดิต สินเชื่อ หรือหนี้อื่นพร้อมยอด ณ วันที่เริ่มบันทึก อัตราดอกเบี้ย และยอดชำระขั้นต่ำ เพื่อติดตามวันครบกำหนดและวางแผนปลดหนี้"
            action={
              <Button variant="primary" onClick={() => setDialog({ kind: 'liability' })}>
                เพิ่มหนี้สิน
              </Button>
            }
          />
        ) : (
          <DataTable
            rows={s.liabilities}
            columns={columns}
            rowKey={(l) => l.liability.id}
            search={(l) => `${l.liability.name} ${l.liability.note ?? ''}`}
            filters={[
              {
                key: 'status',
                label: 'สถานะ',
                options: [
                  { value: 'active', label: 'ยังไม่ปิด' },
                  { value: 'closed', label: 'ปิดแล้ว' },
                ],
                get: (l) => l.liability.status,
              },
              { key: 'kind', label: 'ประเภท', options: LIABILITY_KINDS.map((k) => ({ value: k, label: LIABILITY_KIND_LABELS[k] })), get: (l) => l.liability.kind },
            ]}
            rowClassName={(l) => (l.liability.status === 'closed' ? 'opacity-60' : l.due.overdueAmount > 0.005 ? 'bg-loss-soft/40' : undefined)}
            defaultSort={{ key: 'balance', dir: 'desc' }}
          />
        )}
      </Card>

      {selected && <LedgerCard l={selected} all={s.liabilities} raw={raw} base={base} onSelect={setSelectedId} onAdd={(preset) => setDialog({ kind: 'payment', liability: selected, preset })} onEdit={(event) => setDialog({ kind: 'payment', liability: selected, event })} />}

      <StrategyCard liabilities={s.liabilities} base={base} />

      {dialog?.kind === 'liability' && <LiabilityForm liability={dialog.liability} today={today} onClose={close} />}
      {dialog?.kind === 'payment' && <DebtPaymentForm l={dialog.liability} event={dialog.event} preset={dialog.preset} raw={raw} base={base} today={today} onClose={close} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Payment ledger of one liability
// ---------------------------------------------------------------------------
type LedgerLine = { id: string; type: 'opening' | 'event' | 'accrued'; date: string; row?: LiabilityView['ledger'][number]; event?: DebtEventRow }

function LedgerCard({ l, all, raw, base, onSelect, onAdd, onEdit }: { l: LiabilityView; all: LiabilityView[]; raw: MoneyTabProps['raw']; base: string; onSelect: (id: string) => void; onAdd: (preset: 'payment' | 'charge') => void; onEdit: (e: DebtEventRow) => void }) {
  const { confirm } = useFeedback()
  const remove = useAction(deleteDebtPaymentAction, { success: 'ลบรายการแล้ว ยอดหนี้ถูกคำนวณใหม่' })
  const accountName = (id: string | null) => (id ? (raw.accounts.find((a) => a.id === id)?.name ?? '?') : null)
  const eventOf = (id: string) => raw.debtEvents.find((e) => e.id === id)
  const lines: LedgerLine[] = [
    { id: 'opening', type: 'opening', date: l.liability.openingDate },
    ...l.ledger.map((row) => ({ id: row.eventId, type: 'event' as const, date: row.date, row, event: eventOf(row.eventId) })),
    ...(l.accruedInterest > 0.005 ? [{ id: 'accrued', type: 'accrued' as const, date: '' }] : []),
  ]

  const columns: Column<LedgerLine>[] = [
    { key: 'date', header: 'วันที่', cell: (x) => <span className="num">{x.type === 'accrued' ? 'ถึงวันนี้' : fmtDate(x.date)}</span> },
    {
      key: 'kind',
      header: 'รายการ',
      cell: (x) =>
        x.type === 'opening' ? (
          <Badge tone="neutral">ยอดเริ่มต้น</Badge>
        ) : x.type === 'accrued' ? (
          <Badge tone="warn" title="ยังไม่ถูกเรียกเก็บ จะถูกรวมเป็นดอกเบี้ยของรายการชำระครั้งถัดไป">
            ดอกเบี้ยค้าง (ประมาณ)
          </Badge>
        ) : x.row!.kind === 'payment' ? (
          <Badge tone="accent">ชำระหนี้</Badge>
        ) : (
          <Badge tone="warn">ยืมเพิ่ม / รูดเพิ่ม</Badge>
        ),
    },
    { key: 'amount', header: 'จำนวนเงิน', align: 'right', cell: (x) => <span className="num">{x.type === 'event' ? fmtMoney(x.row!.amount, base) : '—'}</span> },
    {
      key: 'interest',
      header: 'ดอกเบี้ย',
      align: 'right',
      cell: (x) => {
        if (x.type === 'accrued') return <span className="num">{fmtMoney(l.accruedInterest, base)}</span>
        if (x.type !== 'event') return <span className="text-muted">—</span>
        const r = x.row!
        const actual = x.event?.interestAmount !== null && x.event?.interestAmount !== undefined
        if (!actual && r.interest <= 0) return <span className="text-muted">—</span>
        return (
          <div className="num">
            <div>{fmtMoney(r.interest, base)}</div>
            {r.interestEstimated ? <Badge tone="warn">ประมาณการ</Badge> : <Badge tone="neutral">ตามใบแจ้งยอด</Badge>}
          </div>
        )
      },
    },
    { key: 'fee', header: 'ค่าธรรมเนียม', align: 'right', cell: (x) => <span className="num">{x.type === 'event' && x.row!.fee > 0 ? fmtMoney(x.row!.fee, base) : '—'}</span> },
    {
      key: 'after',
      header: 'ยอดหนี้หลังรายการ',
      align: 'right',
      cell: (x) => (
        <div className="num">
          <div className="font-medium">{fmtMoney(x.type === 'opening' ? l.liability.openingBalance : x.type === 'accrued' ? l.balance : x.row!.balanceAfter, base)}</div>
          {x.type === 'event' && <div className="text-xs text-muted">{x.row!.balanceChange > 0 ? '+' : ''}{fmtMoney(x.row!.balanceChange, base)}</div>}
        </div>
      ),
    },
    { key: 'account', header: 'บัญชีที่จ่าย', cell: (x) => <span className="text-xs">{x.type === 'event' ? (accountName(x.event?.accountId ?? null) ?? <span className="text-muted">ไม่ระบุ</span>) : ''}</span> },
    { key: 'note', header: 'หมายเหตุ', cell: (x) => <span className="line-clamp-1 max-w-40 text-xs text-muted">{x.event?.note ?? ''}</span> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (x) =>
        x.type === 'event' && x.event ? (
          <div className="flex justify-end">
            <IconButton label="แก้ไขรายการ" onClick={() => onEdit(x.event!)}>
              <Pencil size={15} />
            </IconButton>
            <IconButton
              label="ลบรายการ"
              onClick={async () => {
                const e = x.event!
                const ok = await confirm({
                  title: 'ลบรายการนี้?',
                  message: `${e.kind === 'payment' ? 'ชำระหนี้' : 'ยืมเพิ่ม'} ${fmtMoney(e.amount, base)} วันที่ ${fmtDate(e.date)} จะถูกลบ ยอดหนี้และดอกเบี้ยประมาณการหลังจากนี้จะถูกคำนวณใหม่${e.kind === 'payment' && e.accountId ? ' และเงินจะกลับเข้ายอดบัญชีที่จ่าย' : ''}`,
                  danger: true,
                  confirmLabel: 'ลบรายการ',
                })
                if (ok) await remove.run({ id: e.id })
              }}
            >
              <Trash2 size={15} />
            </IconButton>
          </div>
        ) : null,
    },
  ]

  return (
    <Card
      title={`รายการชำระหนี้: ${l.liability.name}`}
      subtitle="ดอกเบี้ยที่ไม่ได้กรอกเองประมาณแบบรายวัน: ยอดหนี้ × อัตราต่อปี ÷ 365 × จำนวนวันตั้งแต่รายการก่อนหน้า"
      actions={
        <>
          {all.length > 1 && (
            <Select aria-label="เลือกหนี้สิน" value={l.liability.id} onChange={(e) => onSelect(e.target.value)} className="w-auto max-w-56">
              {all.map((x) => (
                <option key={x.liability.id} value={x.liability.id}>
                  {x.liability.name}
                </option>
              ))}
            </Select>
          )}
          <Button size="sm" icon={<HandCoins size={14} />} onClick={() => onAdd('payment')}>
            บันทึกชำระ
          </Button>
          <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => onAdd('charge')}>
            ยืมเพิ่ม
          </Button>
        </>
      }
      pad={false}
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 border-b border-line px-4 py-3 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted">ชำระไปแล้วทั้งหมด</dt>
          <dd className="num text-sm">{fmtMoney(l.totalPaid, base)}</dd>
        </div>
        <div>
          <dt className="text-muted">ดอกเบี้ยรวม</dt>
          <dd className="num text-sm">
            {fmtMoney(l.interestPaid, base)}
            {l.interestEstimatedPortion > 0.005 && <span className="block text-xs text-muted">ประมาณการ {fmtMoney(l.interestEstimatedPortion, base)}</span>}
          </dd>
        </div>
        <div>
          <dt className="text-muted">ค่าธรรมเนียมรวม</dt>
          <dd className="num text-sm">{fmtMoney(l.feesPaid, base)}</dd>
        </div>
        <div>
          <dt className="text-muted">ยอดคงเหลือ</dt>
          <dd className="num text-sm font-medium">{fmtMoney(l.balance, base)}</dd>
        </div>
      </dl>
      <DataTable rows={lines} columns={columns} rowKey={(x) => x.id} pageSize={50} />
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Avalanche vs snowball
// ---------------------------------------------------------------------------
function StrategyCard({ liabilities, base }: { liabilities: LiabilityView[]; base: string }) {
  const active = liabilities.filter((l) => l.liability.status === 'active' && l.balance > 0.005)
  const debts: StrategyDebt[] = active.map((l) => ({ id: l.liability.id, name: l.liability.name, balance: l.balance, annualRate: l.liability.annualRate, minPayment: l.liability.minPayment }))
  const defaultBudget = roundCash(active.reduce((a, l) => a + l.payoffPayment, 0))
  const minTotal = roundCash(active.reduce((a, l) => a + Math.min(l.liability.minPayment, l.balance), 0))
  const [input, setInput] = useState(defaultBudget > 0 ? String(defaultBudget) : '')
  const budget = parseAmount(input)
  const valid = budget !== null && budget > 0

  // A few debts x at most 1,200 months: cheap enough to recompute on every keystroke.
  const results = valid && debts.length > 0 ? { avalanche: simulateStrategy(debts, budget, 'avalanche'), snowball: simulateStrategy(debts, budget, 'snowball') } : null
  const chart = results
    ? Array.from({ length: Math.max(results.avalanche.timeline.length, results.snowball.timeline.length) }, (_, i) => ({
        m: String(i),
        avalanche: results.avalanche.timeline[i] ?? null,
        snowball: results.snowball.timeline[i] ?? null,
      }))
    : []

  const nameOf = (id: string) => debts.find((x) => x.id === id)?.name ?? '?'

  return (
    <Card title="เปรียบเทียบวิธีปลดหนี้ (Avalanche vs Snowball)" subtitle="จ่ายขั้นต่ำทุกก้อนก่อน เงินที่เหลือโปะก้อนเป้าหมาย เมื่อปิดก้อนหนึ่งได้ เงินผ่อนของก้อนนั้นจะไปโปะก้อนถัดไป">
      {debts.length === 0 ? (
        <EmptyState icon={<CreditCard size={28} />} title="ไม่มีหนี้ที่ยังต้องชำระ" description="เมื่อมีหนี้ที่ยังมียอดคงเหลือ จะเปรียบเทียบระยะเวลาและดอกเบี้ยรวมของทั้งสองวิธีได้ที่นี่" />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="งบชำระหนี้รวมต่อเดือน (บาท)" hint={`ขั้นต่ำรวม ${fmtMoney(minTotal, base)} · ค่าเริ่มต้น = ยอดที่ตั้งใจจ่าย (หรือขั้นต่ำ) ของทุกก้อน ${fmtMoney(defaultBudget, base)}`} error={input !== '' && !valid ? 'ต้องเป็นตัวเลขมากกว่า 0' : undefined} className="w-full sm:w-72">
              <Input type="number" inputMode="decimal" min={0} step="any" value={input} aria-invalid={input !== '' && !valid} onChange={(e) => setInput(e.target.value)} />
            </Field>
          </div>

          {results && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <StrategyResultBox title="Avalanche: ดอกเบี้ยสูงก่อน" r={results.avalanche} nameOf={nameOf} base={base} />
                <StrategyResultBox title="Snowball: ยอดน้อยก่อน" r={results.snowball} nameOf={nameOf} base={base} />
              </div>
              {results.avalanche.feasible && results.snowball.feasible && results.avalanche.totalInterest !== null && results.snowball.totalInterest !== null && (
                <p className="text-sm">
                  {Math.abs(results.snowball.totalInterest - results.avalanche.totalInterest) < 0.01 ? (
                    'ทั้งสองวิธีจ่ายดอกเบี้ยรวมเท่ากันในกรณีนี้'
                  ) : results.avalanche.totalInterest < results.snowball.totalInterest ? (
                    <>
                      Avalanche ประหยัดดอกเบี้ยกว่า <span className="num font-medium text-gain">{fmtMoney(results.snowball.totalInterest - results.avalanche.totalInterest, base)}</span> ส่วน Snowball ปิดหนี้ก้อนแรกได้เร็วกว่าซึ่งช่วยเรื่องกำลังใจ
                    </>
                  ) : (
                    <>
                      Snowball ประหยัดดอกเบี้ยกว่า <span className="num font-medium text-gain">{fmtMoney(results.avalanche.totalInterest - results.snowball.totalInterest, base)}</span> ในกรณีนี้
                    </>
                  )}
                </p>
              )}
              <LineSeriesChart
                data={chart}
                xKey="m"
                xFormat={(v) => `เดือนที่ ${v}`}
                series={[
                  { key: 'avalanche', label: 'Avalanche' },
                  { key: 'snowball', label: 'Snowball', dashed: true },
                ]}
                empty="งบไม่พอสำหรับการคาดการณ์"
              />
            </>
          )}

          <Notice tone="info" title="สมมติฐานของการคาดการณ์">
            อัตราดอกเบี้ยคงที่ตามที่บันทึก คิดดอกเบี้ยทบต้นรายเดือน (อัตราต่อปี ÷ 12) ไม่มีการกู้หรือรูดเพิ่ม และจ่ายตามงบทุกเดือน ยอดเริ่มต้นใช้ยอดหนี้ปัจจุบันรวมดอกเบี้ยค้างโดยประมาณ ผลลัพธ์เป็นการคาดการณ์ ไม่ใช่ตัวเลขจากสัญญาจริง
          </Notice>
        </div>
      )}
    </Card>
  )
}

function StrategyResultBox({ title, r, nameOf, base }: { title: string; r: StrategyResult; nameOf: (id: string) => string; base: string }) {
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="text-sm font-semibold">{title}</div>
      {!r.feasible ? (
        <Notice tone="warning" className="mt-2">
          {r.reason ?? 'คาดการณ์ไม่ได้'}
        </Notice>
      ) : (
        <>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <div>
              <dt className="text-muted">ปลดหนี้หมดใน</dt>
              <dd className="num text-base font-semibold">{r.months === null ? '—' : fmtDuration(r.months)}</dd>
            </div>
            <div>
              <dt className="text-muted">ดอกเบี้ยรวม</dt>
              <dd className="num text-base font-semibold">{fmtMoney(r.totalInterest, base)}</dd>
            </div>
          </dl>
          <div className="mt-2 text-xs text-muted">ลำดับการโปะ</div>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm">
            {r.order.map((id) => (
              <li key={id}>
                {nameOf(id)} <span className="num text-xs text-muted">· ปิดได้เดือนที่ {r.payoffMonth[id] ?? '—'}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------
function LiabilityForm({ liability, today, onClose }: { liability?: LiabilityRow; today: string; onClose: () => void }) {
  return (
    <FormModal
      title={liability ? `แก้ไขหนี้สิน: ${liability.name}` : 'เพิ่มหนี้สิน'}
      intro={liability ? <Notice tone="info">การเปลี่ยนยอดเริ่มต้น วันที่ หรืออัตราดอกเบี้ย จะคำนวณยอดหนี้และดอกเบี้ยประมาณการของทุกรายการใหม่</Notice> : undefined}
      fields={[
        { name: 'name', label: 'ชื่อหนี้', required: true, placeholder: 'เช่น บัตรเครดิต ธนาคาร A, สินเชื่อรถ', full: true },
        { name: 'kind', label: 'ประเภท', type: 'select', required: true, options: LIABILITY_KINDS.map((k) => ({ value: k, label: LIABILITY_KIND_LABELS[k] })) },
        { name: 'status', label: 'สถานะ', type: 'select', required: true, options: [{ value: 'active', label: 'ยังไม่ปิด' }, { value: 'closed', label: 'ปิดแล้ว' }], hint: (v) => (v.status === 'closed' ? 'หนี้ที่ปิดแล้วถือว่ายอดคงเหลือเป็น 0 และไม่แจ้งเตือน' : undefined) },
        { name: 'openingBalance', label: 'ยอดหนี้ ณ วันที่เริ่มบันทึก (บาท)', type: 'number', required: true, min: 0, hint: 'ยอดค้างตามใบแจ้งยอดหรือสัญญา ณ วันที่ด้านขวา' },
        { name: 'openingDate', label: 'วันที่เริ่มบันทึก', type: 'date', required: true, max: today },
        { name: 'annualRate', label: 'อัตราดอกเบี้ยต่อปี (%)', type: 'number', min: 0, max: 1000, hint: 'ใช้ประมาณดอกเบี้ยเมื่อไม่ได้กรอกจากใบแจ้งยอด และใช้คาดการณ์ระยะเวลาปลดหนี้' },
        { name: 'minPayment', label: 'ยอดชำระขั้นต่ำต่อเดือน (บาท)', type: 'number', min: 0, hint: 'ใช้คำนวณยอดที่ต้องจ่ายเดือนนี้ และแจ้งเตือนใกล้/เกินกำหนด' },
        { name: 'dueDay', label: 'วันครบกำหนดชำระ (วันที่ 1-31)', type: 'number', min: 1, max: 31, step: '1', hint: 'ถ้าเดือนนั้นมีวันน้อยกว่า ใช้วันสุดท้ายของเดือน · เว้นว่าง = ไม่มีวันครบกำหนด' },
        { name: 'targetPayment', label: 'ยอดที่ตั้งใจชำระต่อเดือน (บาท)', type: 'number', min: 0, hint: 'เว้นว่าง = ใช้ยอดขั้นต่ำในการคาดการณ์ระยะเวลาปลดหนี้' },
        { name: 'note', label: 'หมายเหตุ', type: 'textarea' },
      ]}
      initial={{
        name: liability?.name ?? '',
        kind: liability?.kind ?? 'credit_card',
        status: liability?.status ?? 'active',
        openingBalance: str(liability?.openingBalance),
        openingDate: liability?.openingDate ?? today,
        annualRate: liability ? str(liability.annualRate) : '',
        minPayment: liability && liability.minPayment > 0 ? str(liability.minPayment) : '',
        dueDay: str(liability?.dueDay),
        targetPayment: str(liability?.targetPayment),
        note: liability?.note ?? '',
      }}
      validate={(v) => {
        const e: Record<string, string> = {}
        if (v.dueDay !== '' && !Number.isInteger(Number(v.dueDay))) e.dueDay = 'ต้องเป็นจำนวนเต็ม 1-31'
        if (String(v.openingDate) > today) e.openingDate = 'ต้องไม่เป็นวันในอนาคต'
        return e
      }}
      action={saveLiabilityAction}
      toInput={(v) => ({ ...v, id: liability?.id, annualRate: v.annualRate === '' ? 0 : v.annualRate, minPayment: v.minPayment === '' ? 0 : v.minPayment })}
      onClose={onClose}
      success={liability ? 'บันทึกการแก้ไขหนี้สินแล้ว' : 'เพิ่มหนี้สินแล้ว'}
    />
  )
}

function DebtPaymentForm({ l, event, preset, raw, base, today, onClose }: { l: LiabilityView; event?: DebtEventRow; preset?: 'payment' | 'charge'; raw: MoneyTabProps['raw']; base: string; today: string; onClose: () => void }) {
  const accounts = baseCashAccountOptions(raw.accounts, base, event?.accountId)
  const opening = l.liability.openingDate
  return (
    <FormModal
      title={`${event ? 'แก้ไขรายการ' : preset === 'charge' ? 'บันทึกยืมเพิ่ม / รูดเพิ่ม' : 'บันทึกการชำระหนี้'}: ${l.liability.name}`}
      intro={
        <Notice tone="info">
          ยอดหนี้ปัจจุบัน {fmtMoney(l.balance, base)}
          {l.accruedInterest > 0.005 && ` (รวมดอกเบี้ยค้างโดยประมาณ ${fmtMoney(l.accruedInterest, base)})`}
          {l.due.remainingThisMonth > 0.005 && ` · ขั้นต่ำเดือนนี้ที่ยังต้องจ่าย ${fmtMoney(l.due.remainingThisMonth, base)}`}
        </Notice>
      }
      fields={[
        {
          name: 'kind',
          label: 'ประเภทรายการ',
          type: 'select',
          required: true,
          options: [
            { value: 'payment', label: 'ชำระหนี้ (Payment)' },
            { value: 'charge', label: 'ยืมเพิ่ม / รูดเพิ่ม (Charge)' },
          ],
          full: true,
          hint: (v) => (v.kind === 'charge' ? 'การกู้หรือใช้วงเงินเพิ่ม: ยอดหนี้เพิ่มขึ้น ไม่ผูกกับบัญชีเงิน' : 'เงินที่จ่ายจริง: ลดยอดหนี้ และหักจากบัญชีที่เลือก'),
        },
        { name: 'date', label: 'วันที่', type: 'date', required: true, max: today, hint: `ต้องไม่ก่อนวันที่เริ่มบันทึกหนี้ (${fmtDate(opening)}) และไม่เป็นวันในอนาคต` },
        { name: 'amount', label: 'จำนวนเงิน (บาท)', type: 'number', required: true, min: 0 },
        {
          name: 'interestAmount',
          label: 'ดอกเบี้ยตามใบแจ้งยอด (บาท)',
          type: 'number',
          min: 0,
          full: true,
          hint: (v) =>
            v.kind === 'charge'
              ? 'เว้นว่างได้ (รายการยืมเพิ่มจะรวมดอกเบี้ยเฉพาะเมื่อกรอก)'
              : 'เว้นว่าง = ระบบประมาณแบบรายวัน (ยอดหนี้ × อัตราต่อปี ÷ 365 × จำนวนวันตั้งแต่รายการก่อน) และแสดงป้าย "ประมาณการ" · กรอกเพื่อใช้ตัวเลขจริง',
        },
        { name: 'feeAmount', label: 'ค่าธรรมเนียม / ค่าปรับ (บาท)', type: 'number', min: 0, hint: 'เพิ่มเข้ายอดหนี้' },
        { name: 'accountId', label: 'จ่ายจากบัญชี', type: 'select', options: accounts, showIf: (v) => v.kind === 'payment', hint: `บัญชีสกุล ${base} · ไม่ระบุ = ไม่กระทบยอดเงินในบัญชี` },
        { name: 'note', label: 'หมายเหตุ', type: 'textarea' },
      ]}
      initial={{
        kind: event?.kind ?? preset ?? 'payment',
        date: event?.date ?? today,
        amount: event ? str(event.amount) : !preset || preset === 'payment' ? (l.due.remainingThisMonth > 0.005 ? String(l.due.remainingThisMonth) : '') : '',
        interestAmount: str(event?.interestAmount),
        feeAmount: event && event.feeAmount > 0 ? str(event.feeAmount) : '',
        accountId: event?.accountId ?? '',
        note: event?.note ?? '',
      }}
      validate={(v) => {
        const e: Record<string, string> = {}
        if (String(v.date) > today) e.date = 'ต้องไม่เป็นวันในอนาคต'
        else if (v.date && String(v.date) < opening) e.date = `ต้องไม่ก่อนวันที่เริ่มบันทึกหนี้ (${fmtDate(opening)})`
        if (v.amount !== '' && Number(v.amount) <= 0) e.amount = 'ต้องมากกว่า 0'
        return e
      }}
      action={saveDebtPaymentAction}
      toInput={(v) => ({ ...v, id: event?.id, liabilityId: l.liability.id, accountId: v.kind === 'charge' ? '' : v.accountId, feeAmount: v.feeAmount === '' ? 0 : v.feeAmount })}
      onClose={onClose}
      success={event ? 'บันทึกการแก้ไขแล้ว ยอดหนี้ถูกคำนวณใหม่' : 'บันทึกรายการแล้ว ยอดหนี้ถูกคำนวณใหม่'}
    />
  )
}
