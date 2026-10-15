'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Download, ExternalLink, FileDown, History as HistoryIcon, Pencil, RefreshCw, Search, Trash2, Upload } from 'lucide-react'
import { deleteTransactionAction, loadAuditLogAction } from '@/actions/app'
import { HISTORY_KIND_LABELS, type HistoryKind, type HistoryRow } from '@/lib/calc/history'
import type { AccountRow, LedgerTx, PortfolioRow, SecurityRow } from '@/lib/calc/types'
import { toCsv } from '@/lib/csv'
import { TONE_TEXT, fmtDate, fmtDateTime, fmtMoney, fmtNum, fmtQty, fmtSigned, toneOf, type Tone } from '@/lib/format'
import { TransactionForm } from '@/components/domain-forms'
import { useAction } from '@/components/forms'
import { ImportCsvDialog, downloadText } from '@/components/import-csv'
import { Badge, Button, Card, DataTable, EmptyState, Field, IconButton, Input, Notice, PageHeader, Select, cx, useFeedback, type Column } from '@/components/ui'

/** A history row plus every account it touches (a transfer touches two). */
export type HistoryItem = HistoryRow & { accountIds: string[] }
type EditTx = LedgerTx & { portfolio: 'main' | 'dca' }

const KIND_TONE: Record<HistoryKind, Tone> = {
  buy: 'accent',
  sell: 'warn',
  dividend: 'gain',
  fee: 'neutral',
  split: 'neutral',
  adjustment: 'neutral',
  income: 'gain',
  expense: 'loss',
  debt_payment: 'warn',
  debt_charge: 'loss',
  transfer: 'neutral',
  emergency_allocation: 'accent',
  goal_allocation: 'accent',
  investment_funding: 'accent',
}
const KIND_ORDER = Object.keys(HISTORY_KIND_LABELS) as HistoryKind[]
const PORTFOLIO_LABEL: Record<'main' | 'dca', string> = { main: 'My Portfolio', dca: 'DCA Portfolio' }
const SOURCE_LABEL: Record<string, string> = { manual: 'บันทึกเอง', dca: 'แผน DCA', import: 'นำเข้า CSV', watchlist: 'จาก Watchlist', recurring: 'รายจ่ายประจำ' }
/** recorded, but no money has moved yet */
const PENDING = new Set(['คาดว่าจะได้รับ', 'ยังไม่จ่าย'])
const TRANSFER_STATUS = 'โอนแล้ว'
const statusGroup = (r: HistoryRow) => (r.table === 'transfers' ? TRANSFER_STATUS : r.status)
const statusTone = (s: string): Tone => (PENDING.has(s) ? 'warn' : s === 'ได้รับจริง' ? 'gain' : 'neutral')

const MANAGED_AT: Record<Exclude<HistoryRow['table'], 'transactions'>, { href: string; label: string }> = {
  income_records: { href: '/money?tab=income', label: 'บริหารเงิน › รายรับ' },
  expense_records: { href: '/money?tab=expenses', label: 'บริหารเงิน › รายจ่าย' },
  debt_payments: { href: '/money?tab=debts', label: 'บริหารเงิน › หนี้สิน' },
  transfers: { href: '/money?tab=cash', label: 'บริหารเงิน › เงินสดและบัญชี' },
}

interface Filters {
  q: string
  from: string
  to: string
  kind: string
  portfolio: string
  security: string
  account: string
  currency: string
  status: string
}
const NO_FILTERS: Filters = { q: '', from: '', to: '', kind: '', portfolio: '', security: '', account: '', currency: '', status: '' }

const pad = (n: number) => String(n).padStart(2, '0')
const daysIn = (y: number, m: number) => [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]

/** Calendar ranges relative to the user's "today" (YYYY-MM-DD), computed from the string only. */
function presetRanges(today: string) {
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7))
  const py = m === 1 ? y - 1 : y
  const pm = m === 1 ? 12 : m - 1
  return [
    { id: 'month', label: 'เดือนนี้', from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(daysIn(y, m))}` },
    { id: 'prev', label: 'เดือนก่อน', from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(daysIn(py, pm))}` },
    { id: 'year', label: `ปี ${y}`, from: `${y}-01-01`, to: `${y}-12-31` },
  ]
}

const haystack = (r: HistoryRow) =>
  [HISTORY_KIND_LABELS[r.kind], r.description, r.symbol, r.account, r.status, r.note, SOURCE_LABEL[r.source] ?? r.source, r.currency, r.portfolio ? PORTFOLIO_LABEL[r.portfolio] : ''].filter(Boolean).join(' ').toLowerCase()

const CSV_HEADERS = ['date', 'kind', 'kind_label', 'description', 'symbol', 'portfolio', 'account', 'amount', 'currency', 'quantity', 'price', 'fee', 'fx_rate', 'status', 'source', 'note']
const csvRow = (r: HistoryRow): unknown[] => [r.date, r.kind, HISTORY_KIND_LABELS[r.kind], r.description, r.symbol, r.portfolio, r.account, r.amount, r.currency, r.quantity, r.price, r.fee, r.fxRate, r.status, r.source, r.note]

/** Same columns as the CSV import (plus `portfolio`, which the importer ignores) so the file can be imported again. */
const IMPORT_HEADERS = ['date', 'type', 'symbol', 'exchange', 'quantity', 'price', 'amount', 'fee', 'fx_rate', 'split_ratio', 'note', 'portfolio']

export function HistoryView({
  rows,
  securities,
  accounts,
  portfolios,
  transactions,
  baseCurrency,
  today,
  timezone,
  issues,
}: {
  rows: HistoryItem[]
  securities: SecurityRow[]
  accounts: AccountRow[]
  portfolios: PortfolioRow[]
  transactions: LedgerTx[]
  baseCurrency: string
  today: string
  timezone: string
  /** inconsistencies the calculation engine found in the recorded history */
  issues: string[]
}) {
  const [f, setF] = useState<Filters>(NO_FILTERS)
  const [editing, setEditing] = useState<EditTx | null>(null)
  const [importing, setImporting] = useState(false)
  const { confirm, toast } = useFeedback()
  const remove = useAction(deleteTransactionAction, { success: 'ลบธุรกรรมแล้ว พอร์ตถูกคำนวณใหม่' })
  const set = (k: keyof Filters, v: string) => setF((x) => ({ ...x, [k]: v }))

  const txById = useMemo(() => new Map(transactions.map((t) => [t.id, t])), [transactions])
  const secById = useMemo(() => new Map(securities.map((s) => [s.id, s])), [securities])
  const presets = useMemo(() => presetRanges(today), [today])

  const options = useMemo(() => {
    const acctName = new Map(accounts.map((a) => [a.id, a.isArchived ? `${a.name} (เก็บถาวร)` : a.name]))
    const secs = new Map<string, string>()
    const accts = new Set<string>()
    for (const r of rows) {
      if (r.securityId) secs.set(r.securityId, r.symbol ?? '?')
      for (const id of r.accountIds) accts.add(id)
    }
    const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, 'th')
    return {
      kinds: KIND_ORDER.filter((k) => rows.some((r) => r.kind === k)).map((k) => ({ value: k, label: HISTORY_KIND_LABELS[k] })),
      portfolios: (['main', 'dca'] as const).filter((p) => rows.some((r) => r.portfolio === p)).map((p) => ({ value: p, label: PORTFOLIO_LABEL[p] })),
      securities: [...secs].map(([value, label]) => ({ value, label })).sort(byLabel),
      accounts: [...accts].map((id) => ({ value: id, label: acctName.get(id) ?? 'บัญชีที่ถูกลบ' })).sort(byLabel),
      currencies: [...new Set(rows.map((r) => r.currency))].sort().map((c) => ({ value: c, label: c })),
      statuses: [...new Set(rows.map(statusGroup))].map((s) => ({ value: s, label: s })),
    }
  }, [rows, accounts])

  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase()
    return rows.filter((r) => {
      if (f.from && r.date < f.from) return false
      if (f.to && r.date > f.to) return false
      if (f.kind && r.kind !== f.kind) return false
      if (f.portfolio && r.portfolio !== f.portfolio) return false
      if (f.security && r.securityId !== f.security) return false
      if (f.account && !r.accountIds.includes(f.account)) return false
      if (f.currency && r.currency !== f.currency) return false
      if (f.status && statusGroup(r) !== f.status) return false
      if (q && !haystack(r).includes(q)) return false
      return true
    })
  }, [rows, f])

  const summary = useMemo(() => {
    const by = new Map<string, { in: number; out: number }>()
    let pending = 0
    for (const r of filtered) {
      if (PENDING.has(r.status)) {
        pending++
        continue
      }
      if (r.amount === 0) continue
      const t = by.get(r.currency) ?? { in: 0, out: 0 }
      if (r.amount > 0) t.in += r.amount
      else t.out += r.amount
      by.set(r.currency, t)
    }
    const r2 = (n: number) => Math.round(n * 100) / 100
    const totals = [...by.entries()]
      .map(([currency, t]) => ({ currency, in: r2(t.in), out: r2(t.out), net: r2(t.in + t.out) }))
      .sort((a, b) => (a.currency === baseCurrency ? -1 : b.currency === baseCurrency ? 1 : a.currency.localeCompare(b.currency)))
    return { totals, pending }
  }, [filtered, baseCurrency])

  const filtering = Object.entries(f).some(([, v]) => v.trim() !== '')
  const badRange = !!f.from && !!f.to && f.from > f.to
  const investInView = filtered.filter((r) => r.table === 'transactions').length

  const openEdit = (r: HistoryItem) => {
    const tx = txById.get(r.id)
    if (!tx) return toast('error', 'ไม่พบธุรกรรมนี้ (อาจถูกลบไปแล้ว) กรุณาโหลดหน้าใหม่')
    setEditing({ ...tx, portfolio: portfolios.find((p) => p.id === tx.portfolioId)?.kind ?? 'main' })
  }

  const askDelete = async (r: HistoryItem) => {
    const pf = r.portfolio ? PORTFOLIO_LABEL[r.portfolio] : 'พอร์ต'
    const ok = await confirm({
      title: 'ลบธุรกรรมการลงทุนนี้?',
      message: (
        <div className="space-y-2">
          <p>
            <span className="font-medium">
              {HISTORY_KIND_LABELS[r.kind]} {r.symbol}
            </span>{' '}
            วันที่ {fmtDate(r.date)}
            {r.quantity ? ` จำนวน ${fmtQty(r.quantity)} หุ้น` : ''} จะถูกลบถาวร
          </p>
          <p>
            ระบบจะคำนวณ {pf} ใหม่ทั้งหมด ทั้งจำนวนหุ้น ต้นทุนเฉลี่ย กำไร/ขาดทุน เงินปันผล และยอดเงินในบัญชีที่ผูกไว้ หากการลบทำให้ประวัติการขายเกินจำนวนหุ้นที่ถือ ระบบจะไม่ลบ
          </p>
          <p className="text-muted">ถ้ารายการนี้มาจากแผน DCA หรือ Watchlist รายการนั้นจะกลับเป็นสถานะรอซื้อ การลบถูกบันทึกใน Audit Log</p>
        </div>
      ),
      confirmLabel: 'ลบธุรกรรม',
      danger: true,
    })
    if (ok) await remove.run({ id: r.id })
  }

  const exportHistory = (list: HistoryItem[], name: string) => {
    downloadText(`sinsap-${name}-${today}.csv`, toCsv(CSV_HEADERS, list.map(csvRow)))
    toast('success', `ส่งออก ${list.length.toLocaleString('en-US')} รายการแล้ว`)
  }

  const exportImportFormat = () => {
    const txs = filtered
      .filter((r) => r.table === 'transactions')
      .map((r) => txById.get(r.id))
      .filter((t): t is LedgerTx => !!t)
      .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.createdAt.localeCompare(b.createdAt))
    const lines: unknown[][] = []
    for (const t of txs) {
      const s = secById.get(t.securityId)
      if (!s) continue
      const tradeQty = t.type === 'buy' || t.type === 'sell' || t.type === 'adjustment'
      lines.push([
        t.tradeDate,
        t.type,
        s.symbol,
        s.exchange,
        tradeQty ? t.quantity : null,
        t.type === 'buy' || t.type === 'sell' ? t.price : null,
        t.type === 'dividend' || t.type === 'fee' || t.type === 'adjustment' ? t.amount : null,
        t.fee,
        t.currency !== baseCurrency ? t.fxRate : null,
        t.type === 'split' ? t.splitRatio : null,
        t.note ?? null,
        portfolios.find((p) => p.id === t.portfolioId)?.kind ?? '',
      ])
    }
    downloadText(`sinsap-transactions-import-format-${today}.csv`, toCsv(IMPORT_HEADERS, lines))
    toast('success', `ส่งออกธุรกรรมการลงทุน ${lines.length} รายการในรูปแบบไฟล์นำเข้าแล้ว (นำเข้าทีละพอร์ต: คอลัมน์ portfolio บอกว่ามาจากพอร์ตใด)`)
  }

  const columns: Column<HistoryItem>[] = [
    { key: 'date', header: 'วันที่', sort: (r) => r.date, cell: (r) => <span className="num whitespace-nowrap">{fmtDate(r.date)}</span> },
    { key: 'kind', header: 'ประเภท', sort: (r) => HISTORY_KIND_LABELS[r.kind], cell: (r) => <Badge tone={KIND_TONE[r.kind]}>{HISTORY_KIND_LABELS[r.kind]}</Badge> },
    {
      key: 'desc',
      header: 'รายละเอียด',
      cell: (r) => (
        <span className="line-clamp-2 block min-w-32 max-w-56 text-xs" title={r.description || undefined}>
          {r.description || '—'}
        </span>
      ),
    },
    { key: 'symbol', header: 'หลักทรัพย์', sort: (r) => r.symbol, cell: (r) => (r.symbol ? <span className="font-medium">{r.symbol}</span> : <span className="text-muted">—</span>) },
    { key: 'portfolio', header: 'พอร์ต', sort: (r) => r.portfolio, cell: (r) => (r.portfolio ? <span className="whitespace-nowrap text-xs">{PORTFOLIO_LABEL[r.portfolio]}</span> : <span className="text-muted">—</span>) },
    {
      key: 'account',
      header: 'บัญชี',
      sort: (r) => r.account,
      cell: (r) => (
        <span className="block max-w-44 truncate text-xs" title={r.account ?? undefined}>
          {r.account ?? '—'}
        </span>
      ),
    },
    {
      key: 'amount',
      header: 'จำนวนเงิน (+เข้า / −ออก)',
      align: 'right',
      sort: (r) => r.amount,
      title: 'ผลต่อเงินของคุณในสกุลเงินของรายการ: สีเขียว = เงินเข้า สีแดง = เงินออก สีเทา = ไม่กระทบเงินสดหรือยังไม่เกิดขึ้นจริง',
      cell: (r) => <AmountCell r={r} />,
    },
    { key: 'qty', header: 'จำนวนหุ้น', align: 'right', sort: (r) => r.quantity, cell: (r) => <span className="num">{fmtQty(r.quantity)}</span> },
    { key: 'price', header: 'ราคา/หุ้น', align: 'right', sort: (r) => r.price, cell: (r) => <span className="num">{fmtNum(r.price, 4)}</span> },
    { key: 'fee', header: 'ค่าธรรมเนียม/ภาษี', align: 'right', sort: (r) => r.fee, cell: (r) => <span className="num">{r.fee ? fmtMoney(r.fee, r.currency) : '—'}</span> },
    {
      key: 'fx',
      header: 'อัตราแลกเปลี่ยน',
      align: 'right',
      title: `ธุรกรรมการลงทุน: ${baseCurrency} ต่อ 1 หน่วยสกุลเงินของหุ้น ณ วันทำรายการ · โอนเงินข้ามสกุล: จำนวนต้นทาง ÷ จำนวนปลายทาง`,
      cell: (r) => <span className="num text-muted">{r.fxRate !== null ? fmtNum(r.fxRate, 4) : '—'}</span>,
    },
    {
      key: 'status',
      header: 'สถานะ',
      sort: statusGroup,
      cell: (r) => (r.table === 'transfers' ? <span className="whitespace-nowrap text-xs">{r.status}</span> : <Badge tone={statusTone(r.status)}>{r.status}</Badge>),
    },
    { key: 'source', header: 'ที่มา', sort: (r) => r.source, cell: (r) => <span className="whitespace-nowrap text-xs text-muted">{SOURCE_LABEL[r.source] ?? r.source}</span> },
    {
      key: 'note',
      header: 'หมายเหตุ',
      cell: (r) =>
        r.note ? (
          <span className="line-clamp-2 block max-w-48 text-xs" title={r.note}>
            {r.note}
          </span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) =>
        r.table === 'transactions' ? (
          <div className="flex justify-end">
            <IconButton label="แก้ไขธุรกรรม" onClick={() => openEdit(r)}>
              <Pencil size={15} />
            </IconButton>
            <IconButton label="ลบธุรกรรม" disabled={remove.pending} onClick={() => void askDelete(r)}>
              <Trash2 size={15} />
            </IconButton>
          </div>
        ) : (
          <Link href={MANAGED_AT[r.table].href} title={`แก้ไขหรือลบรายการนี้ได้ที่ ${MANAGED_AT[r.table].label}`} className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-xs text-accent hover:bg-surface-2">
            จัดการ <ExternalLink size={12} />
          </Link>
        ),
    },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="ประวัติธุรกรรม (Transaction History)"
        subtitle="ทุกการเคลื่อนไหวที่บันทึกไว้ในที่เดียว: ธุรกรรมการลงทุน รายรับ รายจ่าย หนี้ และการโอนเงิน (รวมการกันเงินสำรอง เงินออมตามเป้าหมาย และการโอนเข้าบัญชีลงทุน)"
        actions={
          <>
            <Button icon={<Upload size={15} />} onClick={() => setImporting(true)}>
              นำเข้า CSV
            </Button>
            <Button icon={<Download size={15} />} disabled={rows.length === 0} onClick={() => exportHistory(rows, 'history-all')}>
              ส่งออกทั้งหมด
            </Button>
          </>
        }
      />

      {issues.length > 0 && (
        <Notice tone="danger" title={`พบข้อมูลไม่สอดคล้องกันในประวัติ ${issues.length} จุด`}>
          <ul className="list-disc space-y-0.5 pl-4">
            {issues.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <span className="mt-1 block">ตรวจสอบและแก้ไขรายการที่เกี่ยวข้องด้านล่าง ตัวเลขที่ได้รับผลกระทบอาจไม่ถูกต้องจนกว่าจะแก้ไข</span>
        </Notice>
      )}

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<HistoryIcon size={28} />}
            title="ยังไม่มีประวัติธุรกรรม"
            description="เมื่อบันทึกการซื้อขายหุ้น รายรับ รายจ่าย การชำระหนี้ หรือการโอนเงิน รายการทั้งหมดจะแสดงที่นี่ หรือนำเข้าธุรกรรมการลงทุนจากไฟล์ CSV ของโบรกเกอร์"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link href="/portfolio" className="inline-flex h-9 items-center rounded-lg border border-line px-3.5 text-sm font-medium hover:bg-surface-2">
                  ไปที่พอร์ตหุ้น
                </Link>
                <Link href="/money" className="inline-flex h-9 items-center rounded-lg border border-line px-3.5 text-sm font-medium hover:bg-surface-2">
                  ไปที่บริหารเงิน
                </Link>
                <Button variant="primary" icon={<Upload size={15} />} onClick={() => setImporting(true)}>
                  นำเข้า CSV
                </Button>
              </div>
            }
          />
        </Card>
      ) : (
        <Card
          title="รายการทั้งหมด"
          subtitle="แก้ไข/ลบธุรกรรมการลงทุนได้ที่นี่ (ระบบคำนวณพอร์ตใหม่ทันที) รายการประเภทอื่นกด “จัดการ” เพื่อไปยังหน้าที่บันทึกรายการนั้น"
          pad={false}
          actions={
            <>
              <Button size="sm" variant="primary" icon={<FileDown size={14} />} disabled={filtered.length === 0} onClick={() => exportHistory(filtered, 'history')}>
                ส่งออก CSV ตามตัวกรอง ({filtered.length.toLocaleString('en-US')})
              </Button>
              <Button
                size="sm"
                icon={<FileDown size={14} />}
                disabled={investInView === 0}
                title="ส่งออกเฉพาะธุรกรรมการลงทุนที่แสดงอยู่ ในรูปแบบเดียวกับไฟล์นำเข้า ใช้สำรองหรือย้ายข้อมูลแล้วนำเข้าใหม่ได้"
                onClick={exportImportFormat}
              >
                รูปแบบไฟล์นำเข้า ({investInView})
              </Button>
            </>
          }
        >
          <div className="space-y-2.5 border-b border-line p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <Field label="ค้นหา" className="col-span-2">
                <span className="relative block">
                  <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-muted" />
                  <Input value={f.q} placeholder="รายละเอียด หุ้น บัญชี หมายเหตุ..." className="pl-8" onChange={(e) => set('q', e.target.value)} />
                </span>
              </Field>
              <Field label="ตั้งแต่วันที่">
                <Input type="date" value={f.from} aria-invalid={badRange} onChange={(e) => set('from', e.target.value)} />
              </Field>
              <Field label="ถึงวันที่">
                <Input type="date" value={f.to} aria-invalid={badRange} onChange={(e) => set('to', e.target.value)} />
              </Field>
              <FilterSelect label="ประเภท" value={f.kind} options={options.kinds} onChange={(v) => set('kind', v)} />
              <FilterSelect label="พอร์ต" value={f.portfolio} options={options.portfolios} onChange={(v) => set('portfolio', v)} />
              <FilterSelect label="หลักทรัพย์" value={f.security} options={options.securities} onChange={(v) => set('security', v)} />
              <FilterSelect label="บัญชี" value={f.account} options={options.accounts} onChange={(v) => set('account', v)} />
              <FilterSelect label="สกุลเงิน" value={f.currency} options={options.currencies} onChange={(v) => set('currency', v)} />
              <FilterSelect label="สถานะ" value={f.status} options={options.statuses} onChange={(v) => set('status', v)} />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted">ช่วงเวลา:</span>
              {presets.map((p) => {
                const active = f.from === p.from && f.to === p.to
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setF((x) => ({ ...x, from: p.from, to: p.to }))}
                    className={cx('rounded-full border px-2.5 py-1 text-xs transition', active ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:bg-surface-2 hover:text-text')}
                  >
                    {p.label}
                  </button>
                )
              })}
              <button
                type="button"
                aria-pressed={!f.from && !f.to}
                onClick={() => setF((x) => ({ ...x, from: '', to: '' }))}
                className={cx('rounded-full border px-2.5 py-1 text-xs transition', !f.from && !f.to ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:bg-surface-2 hover:text-text')}
              >
                ทุกช่วงเวลา
              </button>
              {filtering && (
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setF(NO_FILTERS)}>
                  ล้างตัวกรองทั้งหมด
                </Button>
              )}
            </div>
            {badRange && <Notice tone="warning">วันที่เริ่มต้นอยู่หลังวันที่สิ้นสุด จึงไม่มีรายการที่ตรงเงื่อนไข</Notice>}
          </div>

          <div className="space-y-1.5 border-b border-line bg-surface-2/40 px-3 py-2.5 text-sm">
            <div>
              แสดง <span className="num font-semibold">{filtered.length.toLocaleString('en-US')}</span> จาก <span className="num">{rows.length.toLocaleString('en-US')}</span> รายการ
              {filtering && <span className="text-muted"> (ตามตัวกรอง)</span>}
            </div>
            {summary.totals.length > 0 ? (
              <ul className="grid gap-1 sm:flex sm:flex-wrap sm:gap-x-6">
                {summary.totals.map((t) => (
                  <li key={t.currency} className="num flex flex-wrap items-baseline gap-x-3 text-[13px]">
                    <span className="font-semibold">{t.currency}</span>
                    <span>
                      <span className="text-muted">เข้า </span>
                      <span className="text-gain">{fmtSigned(t.in, t.currency)}</span>
                    </span>
                    <span>
                      <span className="text-muted">ออก </span>
                      <span className="text-loss">{fmtMoney(t.out, t.currency)}</span>
                    </span>
                    <span>
                      <span className="text-muted">สุทธิ </span>
                      <span className={TONE_TEXT[toneOf(t.net)]}>{fmtSigned(t.net, t.currency)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              filtered.length > 0 && <div className="text-xs text-muted">รายการที่แสดงไม่มีเงินเข้าหรือออก</div>
            )}
            <p className="text-xs leading-relaxed text-muted">
              ยอดรวมแยกตามสกุลเงิน ไม่แปลงค่าเงิน: ซื้อหุ้นและค่าธรรมเนียม = เงินออก, ขายหุ้นและเงินปันผลสุทธิ = เงินเข้า, การโอนระหว่างบัญชีของคุณเองนับเฉพาะค่าธรรมเนียมการโอน
              {summary.pending > 0 && ` · ไม่รวม ${summary.pending} รายการที่ยังไม่เกิดขึ้นจริง (คาดว่าจะได้รับ / ยังไม่จ่าย)`}
            </p>
          </div>

          <DataTable rows={filtered} columns={columns} rowKey={(r) => r.key} defaultSort={{ key: 'date', dir: 'desc' }} pageSize={30} empty="ไม่พบรายการที่ตรงกับตัวกรอง" />
        </Card>
      )}

      <AuditLog timezone={timezone} />

      {editing && <TransactionForm securities={securities} accounts={accounts} baseCurrency={baseCurrency} today={today} tx={editing} onClose={() => setEditing(null)} />}
      {importing && <ImportCsvDialog accounts={accounts} onClose={() => setImporting(false)} />}
    </div>
  )
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <Select value={value} disabled={options.length === 0} onChange={(e) => onChange(e.target.value)}>
        <option value="">ทั้งหมด</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  )
}

function AmountCell({ r }: { r: HistoryRow }) {
  const pending = PENDING.has(r.status)
  const nonCash = r.amount === 0
  const note = pending ? 'ยังไม่เกิดขึ้น' : nonCash ? 'ไม่กระทบเงินสด' : null
  const title = pending
    ? 'ยังไม่เกิดขึ้นจริง จึงยังไม่กระทบยอดเงิน'
    : nonCash
      ? 'รายการนี้ไม่ทำให้เงินของคุณเพิ่มหรือลด (เช่น แตกหุ้น ก่อหนี้เพิ่ม หรือโอนระหว่างบัญชีของตัวเองโดยไม่มีค่าธรรมเนียม)'
      : r.table === 'transfers'
        ? 'โอนระหว่างบัญชีของคุณเอง: นับเป็นเงินออกเฉพาะค่าธรรมเนียมการโอน'
        : undefined
  return (
    <span className="num inline-flex flex-col items-end leading-tight" title={title}>
      <span className={cx('whitespace-nowrap', pending ? 'text-muted' : TONE_TEXT[toneOf(r.amount)])}>{fmtSigned(r.amount, r.currency)}</span>
      <span className="whitespace-nowrap text-[10.5px] text-muted">
        {r.currency}
        {note && ` · ${note}`}
      </span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Audit Log (append-only, loaded on demand)
// ---------------------------------------------------------------------------
interface AuditEntry {
  action: string
  entity: string
  entityId: string | null
  createdAt: string
  before: unknown
  after: unknown
}

const ACTION_META: Record<string, { label: string; tone: Tone }> = {
  create: { label: 'เพิ่ม', tone: 'gain' },
  update: { label: 'แก้ไข', tone: 'accent' },
  delete: { label: 'ลบ', tone: 'loss' },
  import: { label: 'นำเข้า', tone: 'accent' },
  confirm: { label: 'ยืนยัน', tone: 'gain' },
}
const ENTITY_LABEL: Record<string, string> = {
  transactions: 'ธุรกรรมการลงทุน',
  securities: 'หลักทรัพย์',
  'securities.manual_price': 'ราคาที่บันทึกเอง',
  watchlists: 'หุ้นที่สนใจ (Watchlist)',
  dca_plans: 'แผน DCA',
  dca_schedule: 'ตารางลงทุน DCA',
  accounts: 'บัญชีเงิน',
  transfers: 'โอนเงิน',
  income_records: 'รายรับ',
  expense_records: 'รายจ่าย',
  recurring_expenses: 'รายจ่ายประจำ',
  liabilities: 'หนี้สิน',
  debt_payments: 'ชำระหนี้ / ก่อหนี้',
  savings_goals: 'เป้าหมายการออม',
  monthly_budgets: 'งบประมาณรายเดือน',
  allocation_plans: 'แผนจัดสรรเงิน',
  user_settings: 'การตั้งค่า',
}
const IGNORED_KEYS = new Set(['updatedAt', 'updated_at'])
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function changedKeys(before: unknown, after: unknown): string[] {
  if (!isObj(before) || !isObj(after)) return []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((k) => !IGNORED_KEYS.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]))
}

const PAGE = 50

function AuditLog({ timezone }: { timezone: string }) {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [entity, setEntity] = useState('')
  const [shown, setShown] = useState(PAGE)
  const loader = useAction(loadAuditLogAction)

  const load = async () => {
    const res = await loader.run(undefined)
    if (res.ok) {
      setEntries(res.data)
      setShown(PAGE)
    }
  }
  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && entries === null && !loader.pending) void load()
  }

  const entities = useMemo(() => [...new Set((entries ?? []).map((e) => e.entity))].sort(), [entries])
  const list = (entries ?? []).filter((e) => !entity || e.entity === entity)

  return (
    <Card
      title="Audit Log (บันทึกการเปลี่ยนแปลง)"
      subtitle="บันทึกแบบเพิ่มได้อย่างเดียว (append-only): ทุกการเพิ่ม แก้ไข ลบ นำเข้า และยืนยันรายการถูกบันทึกพร้อมข้อมูลก่อน/หลัง ฐานข้อมูลอนุญาตให้แอปเพิ่มและอ่านบันทึกเท่านั้น แก้ไขหรือลบไม่ได้ (ยกเว้นเมื่อลบบัญชีผู้ใช้ทั้งบัญชี)"
      pad={false}
      actions={
        <>
          {open && entries && (
            <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} loading={loader.pending} onClick={() => void load()}>
              โหลดใหม่
            </Button>
          )}
          <Button size="sm" aria-expanded={open} aria-controls="audit-log-body" icon={open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} onClick={toggle}>
            {open ? 'ซ่อน' : 'แสดง Audit Log'}
          </Button>
        </>
      }
    >
      <div id="audit-log-body">
        {!open ? (
          <p className="px-4 py-3 text-xs text-muted">ซ่อนไว้ตามค่าเริ่มต้น กด “แสดง Audit Log” เพื่อโหลด 300 รายการล่าสุด</p>
        ) : entries === null ? (
          <div className="px-4 py-6 text-center text-sm text-muted">{loader.pending ? 'กำลังโหลด Audit Log...' : 'โหลดไม่สำเร็จ กด “โหลดใหม่” หรือซ่อนแล้วเปิดอีกครั้ง'}</div>
        ) : entries.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted">ยังไม่มีบันทึกการเปลี่ยนแปลง</div>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-2 border-b border-line px-4 py-2.5">
              <Field label="ประเภทข้อมูล" className="w-full sm:w-64">
                <Select
                  value={entity}
                  onChange={(e) => {
                    setEntity(e.target.value)
                    setShown(PAGE)
                  }}
                >
                  <option value="">ทั้งหมด</option>
                  {entities.map((x) => (
                    <option key={x} value={x}>
                      {ENTITY_LABEL[x] ?? x}
                    </option>
                  ))}
                </Select>
              </Field>
              <span className="pb-2 text-xs text-muted">
                {list.length.toLocaleString('en-US')} รายการ (ล่าสุดก่อน, โหลดสูงสุด 300 รายการ)
              </span>
            </div>
            <ul className="divide-y divide-line">
              {list.slice(0, shown).map((e, i) => {
                const meta = ACTION_META[e.action] ?? { label: e.action, tone: 'neutral' as Tone }
                const changed = e.action === 'update' ? changedKeys(e.before, e.after) : []
                const hasData = (e.before !== null && e.before !== undefined) || (e.after !== null && e.after !== undefined)
                return (
                  <li key={`${e.createdAt}-${e.entity}-${e.entityId ?? ''}-${i}`} className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      <span className="font-medium">{ENTITY_LABEL[e.entity] ?? e.entity}</span>
                      {e.entityId && (
                        <span className="num text-[11px] text-muted" title={e.entityId}>
                          #{e.entityId.slice(0, 8)}
                        </span>
                      )}
                      <span className="num ml-auto text-xs text-muted">{fmtDateTime(e.createdAt, timezone)}</span>
                    </div>
                    {changed.length > 0 && <p className="mt-1 break-words text-xs text-muted">ช่องที่เปลี่ยน: {changed.join(', ')}</p>}
                    {hasData && (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-xs text-accent hover:underline">ดูข้อมูลก่อน/หลัง (JSON)</summary>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <JsonBlock label="ก่อน (before)" value={e.before} />
                          <JsonBlock label="หลัง (after)" value={e.after} />
                        </div>
                      </details>
                    )}
                  </li>
                )
              })}
            </ul>
            {list.length > shown && (
              <div className="border-t border-line px-4 py-2.5 text-center">
                <Button size="sm" variant="ghost" onClick={() => setShown((n) => n + PAGE)}>
                  แสดงเพิ่ม ({(list.length - shown).toLocaleString('en-US')} รายการที่เหลือ)
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  )
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-medium text-muted">{label}</div>
      {value === null || value === undefined ? (
        <div className="rounded-lg bg-surface-2 p-2 text-xs text-muted">ไม่มี</div>
      ) : (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 p-2 text-[11px] leading-snug">{JSON.stringify(value, null, 2)}</pre>
      )}
    </div>
  )
}
