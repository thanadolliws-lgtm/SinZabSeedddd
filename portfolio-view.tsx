'use client'

import { useState } from 'react'
import { BriefcaseBusiness, CircleCheck, Pencil, Plus, Trash2 } from 'lucide-react'
import { deleteWatchAction } from '@/actions/app'
import type { Snapshot, SecurityView } from '@/lib/calc/snapshot'
import type { LedgerTx } from '@/lib/calc/portfolio'
import type { RawData, WatchRow } from '@/lib/calc/types'
import { HoldingsTable, TransactionsTable } from '@/components/holdings'
import { ManualPriceForm, SecurityForm, TransactionForm, WatchForm } from '@/components/domain-forms'
import { PriceSource } from '@/components/common'
import { useAction } from '@/components/forms'
import { Badge, Button, Card, DataTable, EmptyState, IconButton, Notice, PageHeader, PnL, Stat, Tabs, useFeedback, type Column } from '@/components/ui'
import { fmtDate, fmtMoney, fmtNum, fmtPct, fmtQty, toneOf } from '@/lib/format'

type View = 'main' | 'dca' | 'combined'
const WATCH_STATUS: Record<WatchRow['status'], { label: string; tone: 'accent' | 'warn' | 'gain' | 'neutral' }> = {
  interested: { label: 'สนใจ', tone: 'accent' },
  waiting: { label: 'รอซื้อ', tone: 'warn' },
  bought: { label: 'ซื้อแล้ว', tone: 'gain' },
  cancelled: { label: 'ยกเลิก', tone: 'neutral' },
}
const PRIORITY: Record<WatchRow['priority'], string> = { high: 'สูง', medium: 'กลาง', low: 'ต่ำ' }

type Dialog =
  | { kind: 'tx'; tx?: LedgerTx & { portfolio: 'main' | 'dca' }; preset?: Record<string, string> }
  | { kind: 'buyWatch'; watch: WatchRow }
  | { kind: 'security' }
  | { kind: 'price'; securityId: string }
  | { kind: 'watch'; watch?: WatchRow }
  | null

export function PortfolioView({ s, raw, today, timezone }: { s: Snapshot; raw: RawData; today: string; timezone: string }) {
  const [view, setView] = useState<View>('main')
  const [dialog, setDialog] = useState<Dialog>(null)
  const { confirm } = useFeedback()
  const removeWatch = useAction(deleteWatchAction, { success: 'ลบรายการแล้ว' })
  const base = s.baseCurrency
  const p = s.portfolios[view]
  const kindOf = (pid: string) => (raw.portfolios.find((x) => x.id === pid)?.kind ?? 'main') as 'main' | 'dca'
  const txs = raw.transactions.filter((t) => view === 'combined' || kindOf(t.portfolioId) === view)
  const sec = (id: string) => s.securities.find((x) => x.id === id) as SecurityView | undefined
  const close = () => setDialog(null)

  const watchRows = raw.watchlist
  const watchColumns: Column<WatchRow>[] = [
    { key: 'sym', header: 'หุ้น', sort: (w) => sec(w.securityId)?.symbol ?? '', cell: (w) => <span className="font-medium">{sec(w.securityId)?.symbol}</span> },
    {
      key: 'price',
      header: 'ราคาปัจจุบัน',
      align: 'right',
      cell: (w) => {
        const pr = sec(w.securityId)?.price ?? null
        return (
          <div className="num">
            <div>{pr ? fmtNum(pr.price, 2) : '—'}</div>
            <PriceSource price={pr} timeZone={timezone} compact />
          </div>
        )
      },
    },
    { key: 'target', header: 'ราคาที่สนใจ', align: 'right', sort: (w) => w.targetPrice, cell: (w) => <span className="num">{fmtNum(w.targetPrice, 2)}</span> },
    {
      key: 'gap',
      header: 'ห่างจากราคาที่สนใจ',
      align: 'right',
      sort: (w) => {
        const pr = sec(w.securityId)?.price?.price
        return pr && w.targetPrice ? (pr / w.targetPrice - 1) * 100 : null
      },
      cell: (w) => {
        const pr = sec(w.securityId)?.price?.price
        if (!pr || !w.targetPrice) return <span className="text-muted">—</span>
        const gap = (pr / w.targetPrice - 1) * 100
        return <span className={`num ${gap <= 0 ? 'text-gain' : 'text-muted'}`}>{gap <= 0 ? 'ถึงราคาแล้ว ' : ''}{fmtPct(gap, 1, true)}</span>
      },
    },
    { key: 'budget', header: 'งบประมาณ', align: 'right', cell: (w) => <span className="num">{w.budget !== null ? fmtMoney(w.budget, sec(w.securityId)?.currency) : '—'}</span> },
    { key: 'qty', header: 'จำนวนที่คาดว่าจะซื้อ', align: 'right', cell: (w) => <span className="num">{fmtQty(w.plannedQuantity)}</span> },
    { key: 'reason', header: 'เหตุผล', cell: (w) => <span className="line-clamp-2 max-w-56 text-xs">{w.reason ?? '—'}</span> },
    { key: 'date', header: 'วันที่วางแผน', sort: (w) => w.plannedDate, cell: (w) => <span className="num text-xs">{fmtDate(w.plannedDate)}</span> },
    { key: 'priority', header: 'ความสำคัญ', sort: (w) => ({ high: 0, medium: 1, low: 2 })[w.priority], cell: (w) => PRIORITY[w.priority] },
    { key: 'status', header: 'สถานะ', sort: (w) => w.status, cell: (w) => <Badge tone={WATCH_STATUS[w.status].tone}>{WATCH_STATUS[w.status].label}</Badge> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (w) => (
        <div className="flex justify-end">
          {(w.status === 'interested' || w.status === 'waiting') && (
            <Button size="sm" variant="ghost" icon={<CircleCheck size={14} />} onClick={() => setDialog({ kind: 'buyWatch', watch: w })}>
              ยืนยันซื้อแล้ว
            </Button>
          )}
          {w.status !== 'bought' && (
            <IconButton label="แก้ไข" onClick={() => setDialog({ kind: 'watch', watch: w })}>
              <Pencil size={15} />
            </IconButton>
          )}
          <IconButton
            label="ลบ"
            onClick={async () => {
              if (await confirm({ title: 'ลบรายการที่วางแผนไว้?', message: w.status === 'bought' ? 'ธุรกรรมที่ซื้อไปแล้วยังอยู่ในพอร์ต ลบเฉพาะบันทึกแผนนี้' : 'ลบเฉพาะแผน ไม่กระทบพอร์ตที่ถือจริง', danger: true, confirmLabel: 'ลบ' })) await removeWatch.run({ id: w.id })
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
      <PageHeader
        title="พอร์ตหุ้นที่ถือจริง (My Portfolio)"
        subtitle="บันทึกเฉพาะหุ้นที่ซื้อจริงแล้ว ต้นทุนคำนวณแบบ Weighted Average Cost จากธุรกรรมทั้งหมด"
        actions={
          <>
            <Button icon={<Plus size={15} />} onClick={() => setDialog({ kind: 'security' })}>
              เพิ่มหลักทรัพย์
            </Button>
            <Button variant="primary" icon={<Plus size={15} />} disabled={raw.securities.length === 0} title={raw.securities.length === 0 ? 'เพิ่มหลักทรัพย์ก่อน' : undefined} onClick={() => setDialog({ kind: 'tx', preset: { portfolio: view === 'dca' ? 'dca' : 'main' } })}>
              เพิ่มรายการลงทุน
            </Button>
          </>
        }
      />

      <Tabs<View>
        tabs={[
          { id: 'main', label: 'My Portfolio' },
          { id: 'dca', label: 'DCA Portfolio' },
          { id: 'combined', label: 'รวมทุกพอร์ต' },
        ]}
        value={view}
        onChange={setView}
      />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="ต้นทุนของหุ้นที่ยังถืออยู่" value={fmtMoney(p.costBasisBase)} />
        <Stat label="มูลค่าตลาด" value={fmtMoney(p.marketValueBase)} tone={p.complete ? undefined : 'warn'} sub={p.complete ? undefined : 'ไม่รวมรายการที่ไม่มีราคา'} />
        <Stat label="กำไร/ขาดทุนที่ยังไม่รับรู้" value={<PnL value={p.unrealizedPnlBase} />} sub={fmtPct(p.unrealizedPct, 2, true)} tone={toneOf(p.unrealizedPnlBase)} hint="มูลค่าตลาด − ต้นทุนของหุ้นที่ยังถืออยู่ (เป็นบาท รวมผลอัตราแลกเปลี่ยน)" />
        <Stat label="กำไร/ขาดทุนที่รับรู้แล้ว" value={<PnL value={p.realizedPnlBase} />} hint="จากการขาย: ยอดขายหลังหักค่าธรรมเนียม − ต้นทุนเฉลี่ยของหุ้นที่ขาย" />
        <Stat label="เงินปันผลสุทธิ" value={fmtMoney(p.dividendsNetBase)} hint="แสดงแยกจากกำไร/ขาดทุนของราคาหุ้น หลังหักภาษี ณ ที่จ่าย" />
        <Stat label="ผลตอบแทนรวม" value={<PnL value={p.totalReturnBase} />} hint="ยังไม่รับรู้ + รับรู้แล้ว + ปันผลสุทธิ − ค่าธรรมเนียมอื่น" />
      </section>

      {p.issues.length > 0 && <Notice tone="danger" title="พบข้อมูลไม่สอดคล้องในประวัติธุรกรรม">{p.issues.join(' · ')}</Notice>}

      <Card title="หุ้นที่ถืออยู่" subtitle="ราคาและอัตราแลกเปลี่ยนแสดงประเภทข้อมูลและเวลาเสมอ" pad={false}>
        {p.positions.length === 0 && raw.securities.length === 0 ? (
          <EmptyState icon={<BriefcaseBusiness size={28} />} title="ยังไม่มีหลักทรัพย์" description="เพิ่มหลักทรัพย์ (Ticker และตลาด) แล้วบันทึกรายการซื้อที่เกิดขึ้นจริง" action={<Button variant="primary" onClick={() => setDialog({ kind: 'security' })}>เพิ่มหลักทรัพย์</Button>} />
        ) : (
          <HoldingsTable summary={p} securities={s.securities} baseCurrency={base} timezone={timezone} onAddTx={(id) => setDialog({ kind: 'tx', preset: { securityId: id, portfolio: view === 'dca' ? 'dca' : 'main' } })} onPrice={(id) => setDialog({ kind: 'price', securityId: id })} />
        )}
      </Card>

      {p.closedPositions.length > 0 && (
        <Card title="หุ้นที่ขายหมดแล้ว" subtitle="กำไร/ขาดทุนที่รับรู้แล้วและเงินปันผลที่เคยได้รับ">
          <ul className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {p.closedPositions.map((c) => (
              <li key={c.securityId} className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
                <span className="font-medium">{sec(c.securityId)?.symbol}</span>
                <span className="text-right text-xs">
                  <PnL value={c.realizedPnlBase} />
                  {c.dividendsNetBase > 0 && <span className="block text-muted">ปันผล {fmtMoney(c.dividendsNetBase)}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="หุ้นที่สนใจ / วางแผนจะซื้อ (Watchlist)" subtitle="ไม่ถูกนับในพอร์ตจนกว่าจะยืนยันการซื้อและบันทึกธุรกรรมจริง" actions={<Button size="sm" icon={<Plus size={14} />} disabled={raw.securities.length === 0} onClick={() => setDialog({ kind: 'watch' })}>เพิ่มรายการที่สนใจ</Button>} pad={false}>
        <DataTable rows={watchRows} columns={watchColumns} rowKey={(w) => w.id} search={(w) => `${sec(w.securityId)?.symbol} ${w.reason ?? ''}`} filters={[{ key: 'status', label: 'สถานะ', options: Object.entries(WATCH_STATUS).map(([value, v]) => ({ value, label: v.label })), get: (w) => w.status }]} defaultSort={{ key: 'priority', dir: 'asc' }} empty="ยังไม่มีหุ้นที่วางแผนจะซื้อ" />
      </Card>

      <Card title="ธุรกรรม" subtitle="แก้ไขหรือลบแล้วระบบคำนวณพอร์ตใหม่ทันที ทุกการเปลี่ยนแปลงถูกบันทึกใน Audit Log" pad={false}>
        <TransactionsTable txs={txs} securities={s.securities} accounts={raw.accounts} portfolioKind={kindOf} baseCurrency={base} onEdit={(tx) => setDialog({ kind: 'tx', tx })} />
      </Card>

      {dialog?.kind === 'tx' && <TransactionForm securities={raw.securities} accounts={raw.accounts} baseCurrency={base} today={today} onClose={close} tx={dialog.tx} preset={dialog.preset} />}
      {dialog?.kind === 'buyWatch' && (
        <TransactionForm
          securities={raw.securities}
          accounts={raw.accounts}
          baseCurrency={base}
          today={today}
          onClose={close}
          watchId={dialog.watch.id}
          title={`ยืนยันการซื้อจริง: ${sec(dialog.watch.securityId)?.symbol}`}
          preset={{
            portfolio: 'main',
            type: 'buy',
            securityId: dialog.watch.securityId,
            quantity: dialog.watch.plannedQuantity !== null ? String(dialog.watch.plannedQuantity) : '',
            price: String(dialog.watch.targetPrice ?? sec(dialog.watch.securityId)?.price?.price ?? ''),
          }}
        />
      )}
      {dialog?.kind === 'security' && <SecurityForm onClose={close} />}
      {dialog?.kind === 'price' && sec(dialog.securityId) && <ManualPriceForm security={sec(dialog.securityId)!} today={today} onClose={close} />}
      {dialog?.kind === 'watch' && <WatchForm securities={raw.securities} watch={dialog.watch} onClose={close} />}
    </div>
  )
}
