'use client'

/** Holdings table and transaction list, shared by My Portfolio and DCA Portfolio. */
import { Pencil, Plus, Tag, Trash2 } from 'lucide-react'
import { deleteTransactionAction } from '@/actions/app'
import type { LedgerTx, PortfolioSummary, ValuedPosition } from '@/lib/calc/portfolio'
import type { SecurityView } from '@/lib/calc/snapshot'
import type { AccountRow } from '@/lib/calc/types'
import { HISTORY_KIND_LABELS } from '@/lib/calc/history'
import { fmtDate, fmtMoney, fmtNum, fmtPct, fmtQty } from '@/lib/format'
import { PriceSource } from './common'
import { useAction } from './forms'
import { Badge, DataTable, IconButton, PnL, useFeedback, type Column } from './ui'

const STATUS: Record<ValuedPosition['status'], { label: string; tone: 'gain' | 'loss' | 'neutral' | 'warn' }> = {
  profit: { label: 'กำไร', tone: 'gain' },
  loss: { label: 'ขาดทุน', tone: 'loss' },
  flat: { label: 'เท่าทุน', tone: 'neutral' },
  no_price: { label: 'ไม่มีข้อมูลราคาปัจจุบัน', tone: 'neutral' },
  no_fx: { label: 'ไม่มีอัตราแลกเปลี่ยน', tone: 'warn' },
}

export function HoldingsTable({
  summary,
  securities,
  baseCurrency,
  timezone,
  onAddTx,
  onPrice,
}: {
  summary: PortfolioSummary
  securities: SecurityView[]
  baseCurrency: string
  timezone: string
  onAddTx?: (securityId: string) => void
  onPrice?: (securityId: string) => void
}) {
  const sec = (id: string) => securities.find((s) => s.id === id)
  const columns: Column<ValuedPosition>[] = [
    {
      key: 'symbol',
      header: 'หุ้น',
      sort: (p) => sec(p.securityId)?.symbol ?? '',
      cell: (p) => (
        <div className="min-w-36">
          <div className="font-medium">{sec(p.securityId)?.symbol}</div>
          <div className="max-w-48 truncate text-xs text-muted">{sec(p.securityId)?.name}</div>
        </div>
      ),
    },
    { key: 'qty', header: 'จำนวนคงเหลือ', align: 'right', sort: (p) => p.quantity, cell: (p) => <span className="num">{fmtQty(p.quantity)}</span> },
    { key: 'avg', header: 'ต้นทุนเฉลี่ย/หุ้น', align: 'right', sort: (p) => p.avgCost, cell: (p) => <span className="num">{fmtNum(p.avgCost, 4)}</span>, title: 'Weighted Average Cost รวมค่าธรรมเนียมซื้อ (สกุลเงินต้นทาง)' },
    {
      key: 'cost',
      header: 'ต้นทุนรวม',
      align: 'right',
      sort: (p) => p.costBasisBase,
      cell: (p) => (
        <div className="num">
          <div>{fmtMoney(p.costBasisBase, baseCurrency)}</div>
          {p.currency !== baseCurrency && <div className="text-xs text-muted">{fmtMoney(p.costBasis, p.currency)}</div>}
        </div>
      ),
    },
    {
      key: 'price',
      header: 'ราคาตลาดล่าสุด',
      align: 'right',
      sort: (p) => p.price?.price ?? null,
      cell: (p) => (
        <div className="num">
          <div>{p.price ? fmtNum(p.price.price, 2) : '—'}</div>
          <PriceSource price={p.price} timeZone={timezone} compact />
        </div>
      ),
    },
    {
      key: 'mv',
      header: 'มูลค่าตลาด',
      align: 'right',
      sort: (p) => p.marketValueBase,
      cell: (p) => (
        <div className="num">
          <div>{fmtMoney(p.marketValueBase, baseCurrency)}</div>
          {p.currency !== baseCurrency && <div className="text-xs text-muted">{fmtMoney(p.marketValue, p.currency)}</div>}
        </div>
      ),
    },
    {
      key: 'pnl',
      header: 'กำไร/ขาดทุน',
      align: 'right',
      sort: (p) => p.unrealizedPnlBase,
      title: 'เป็นบาทรวมผลอัตราแลกเปลี่ยน · บรรทัดล่างเป็นสกุลเงินต้นทาง (ผลจากราคาอย่างเดียว)',
      cell: (p) => (
        <div>
          <PnL value={p.unrealizedPnlBase} currency={baseCurrency} />
          {p.currency !== baseCurrency && (
            <div className="text-xs">
              <PnL value={p.unrealizedPnl} currency={p.currency} />
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'pct',
      header: 'กำไร/ขาดทุน (%)',
      align: 'right',
      sort: (p) => p.unrealizedPctBase,
      cell: (p) => <span className={`num ${p.unrealizedPctBase === null ? 'text-neutral' : p.unrealizedPctBase > 0 ? 'text-gain' : p.unrealizedPctBase < 0 ? 'text-loss' : 'text-neutral'}`}>{fmtPct(p.unrealizedPctBase, 2, true)}</span>,
    },
    { key: 'weight', header: 'สัดส่วน', align: 'right', sort: (p) => p.weight, cell: (p) => <span className="num">{fmtPct(p.weight, 1)}</span> },
    { key: 'status', header: 'สถานะ', sort: (p) => p.status, cell: (p) => <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (p) => (
        <div className="flex justify-end">
          {onPrice && (
            <IconButton label="บันทึกราคาเอง" onClick={() => onPrice(p.securityId)}>
              <Tag size={15} />
            </IconButton>
          )}
          {onAddTx && (
            <IconButton label="เพิ่มรายการของหุ้นนี้" onClick={() => onAddTx(p.securityId)}>
              <Plus size={16} />
            </IconButton>
          )}
        </div>
      ),
    },
  ]
  const cats = [...new Set(summary.positions.map((p) => sec(p.securityId)?.category ?? 'Other'))]
  return (
    <DataTable
      rows={summary.positions}
      columns={columns}
      rowKey={(p) => p.securityId}
      search={(p) => `${sec(p.securityId)?.symbol} ${sec(p.securityId)?.name}`}
      searchPlaceholder="ค้นหาชื่อหรือ Ticker"
      filters={[
        { key: 'cat', label: 'หมวด', options: cats.map((c) => ({ value: c, label: c })), get: (p) => sec(p.securityId)?.category ?? 'Other' },
        { key: 'ccy', label: 'สกุลเงิน', options: [...new Set(summary.positions.map((p) => p.currency))].map((c) => ({ value: c, label: c })), get: (p) => p.currency },
        { key: 'status', label: 'สถานะ', options: Object.entries(STATUS).map(([value, v]) => ({ value, label: v.label })), get: (p) => p.status },
      ]}
      defaultSort={{ key: 'mv', dir: 'desc' }}
      empty="ยังไม่มีหุ้นที่ถืออยู่ในพอร์ตนี้"
      footer={
        <tr>
          <td className="px-3 py-2" colSpan={3}>
            รวม {summary.positions.length} หลักทรัพย์{!summary.complete && <span className="ml-1 text-xs text-warn">(มูลค่าไม่รวมรายการที่ไม่มีราคา)</span>}
          </td>
          <td className="num px-3 py-2 text-right">{fmtMoney(summary.costBasisBase, baseCurrency)}</td>
          <td />
          <td className="num px-3 py-2 text-right">{fmtMoney(summary.marketValueBase, baseCurrency)}</td>
          <td className="px-3 py-2 text-right">
            <PnL value={summary.unrealizedPnlBase} currency={baseCurrency} />
          </td>
          <td className="num px-3 py-2 text-right">{fmtPct(summary.unrealizedPct, 2, true)}</td>
          <td colSpan={3} />
        </tr>
      }
    />
  )
}

export function TransactionsTable({
  txs,
  securities,
  accounts,
  portfolioKind,
  baseCurrency,
  onEdit,
}: {
  txs: LedgerTx[]
  securities: SecurityView[]
  accounts: AccountRow[]
  portfolioKind: (portfolioId: string) => 'main' | 'dca'
  baseCurrency: string
  onEdit: (tx: LedgerTx & { portfolio: 'main' | 'dca' }) => void
}) {
  const { confirm } = useFeedback()
  const { run } = useAction(deleteTransactionAction, { success: 'ลบธุรกรรมแล้ว พอร์ตถูกคำนวณใหม่' })
  const sec = (id: string) => securities.find((s) => s.id === id)
  const acct = (id: string | null) => (id ? accounts.find((a) => a.id === id)?.name : null)
  const SOURCE: Record<string, string> = { manual: 'บันทึกเอง', dca: 'DCA', import: 'นำเข้า CSV', watchlist: 'จาก Watchlist' }
  const columns: Column<LedgerTx>[] = [
    { key: 'date', header: 'วันที่', sort: (t) => `${t.tradeDate}${t.createdAt}`, cell: (t) => <span className="num">{fmtDate(t.tradeDate)}</span> },
    { key: 'type', header: 'ประเภท', sort: (t) => t.type, cell: (t) => <Badge tone={t.type === 'buy' ? 'accent' : t.type === 'sell' ? 'warn' : t.type === 'dividend' ? 'gain' : 'neutral'}>{HISTORY_KIND_LABELS[t.type]}</Badge> },
    { key: 'symbol', header: 'หุ้น', sort: (t) => sec(t.securityId)?.symbol ?? '', cell: (t) => <span className="font-medium">{sec(t.securityId)?.symbol}</span> },
    { key: 'qty', header: 'จำนวน', align: 'right', cell: (t) => <span className="num">{t.type === 'split' ? `×${fmtQty(t.splitRatio)}` : fmtQty(t.quantity)}</span> },
    { key: 'price', header: 'ราคา', align: 'right', cell: (t) => <span className="num">{fmtNum(t.price, 4)}</span> },
    { key: 'amount', header: 'จำนวนเงิน', align: 'right', sort: (t) => t.amount * t.fxRate, cell: (t) => <span className="num">{t.type === 'split' ? '—' : fmtMoney(t.amount, t.currency)}</span> },
    { key: 'fee', header: 'ค่าธรรมเนียม/ภาษี', align: 'right', cell: (t) => <span className="num">{t.fee ? fmtMoney(t.fee, t.currency) : '—'}</span> },
    { key: 'fx', header: `อัตรา ${baseCurrency}`, align: 'right', cell: (t) => <span className="num text-muted">{t.currency === baseCurrency ? '—' : fmtNum(t.fxRate, 4)}</span> },
    { key: 'account', header: 'บัญชี', cell: (t) => <span className="text-xs">{acct(t.accountId) ?? '—'}</span> },
    { key: 'source', header: 'ที่มา', cell: (t) => <span className="text-xs text-muted">{SOURCE[t.source] ?? t.source}</span> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (t) => (
        <div className="flex justify-end">
          <IconButton label="แก้ไข" onClick={() => onEdit({ ...t, portfolio: portfolioKind(t.portfolioId) })}>
            <Pencil size={15} />
          </IconButton>
          <IconButton
            label="ลบ"
            onClick={async () => {
              const ok = await confirm({
                title: 'ลบธุรกรรมนี้?',
                message: `${HISTORY_KIND_LABELS[t.type]} ${sec(t.securityId)?.symbol} วันที่ ${fmtDate(t.tradeDate)} จะถูกลบ และต้นทุน จำนวนหุ้น กำไร/ขาดทุน รวมถึงยอดเงินในบัญชีที่ผูกไว้จะถูกคำนวณใหม่ การลบถูกบันทึกใน Audit Log`,
                confirmLabel: 'ลบธุรกรรม',
                danger: true,
              })
              if (ok) await run({ id: t.id })
            }}
          >
            <Trash2 size={15} />
          </IconButton>
        </div>
      ),
    },
  ]
  return (
    <DataTable
      rows={txs}
      columns={columns}
      rowKey={(t) => t.id}
      search={(t) => `${sec(t.securityId)?.symbol} ${sec(t.securityId)?.name} ${t.note ?? ''}`}
      filters={[
        { key: 'type', label: 'ประเภท', options: ['buy', 'sell', 'dividend', 'fee', 'split', 'adjustment'].map((v) => ({ value: v, label: HISTORY_KIND_LABELS[v as 'buy'] })), get: (t) => t.type },
        { key: 'sec', label: 'หุ้น', options: [...new Set(txs.map((t) => t.securityId))].map((id) => ({ value: id, label: sec(id)?.symbol ?? '?' })), get: (t) => t.securityId },
      ]}
      defaultSort={{ key: 'date', dir: 'desc' }}
      pageSize={20}
      empty="ยังไม่มีธุรกรรม"
    />
  )
}
