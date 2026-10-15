'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChartLine, Pencil, Plus, Star, Tag, Trash2 } from 'lucide-react'
import { deleteSecurityAction } from '@/actions/app'
import { loadHistoryAction, type HistoryResult } from '@/actions/market'
import type { Snapshot, SecurityView } from '@/lib/calc/snapshot'
import type { RawData } from '@/lib/calc/types'
import { EXCHANGES, MARKET_LABELS, marketOf, marketStatus, type MarketCode, type MarketStatus } from '@/lib/market/exchanges'
import type { ProviderStatus, StoredQuote } from '@/lib/market/service'
import { PriceSource } from '@/components/common'
import { LineSeriesChart, PALETTE } from '@/components/charts'
import { ManualPriceForm, SecurityForm, WatchForm } from '@/components/domain-forms'
import { useAction } from '@/components/forms'
import { Badge, Button, Card, DataTable, EmptyState, IconButton, Notice, PageHeader, cx, useFeedback, type Column } from '@/components/ui'
import { DATA_TYPE_LABELS, fmtAgo, fmtCompact, fmtDate, fmtDateTime, fmtNum, fmtPct, toneOf, TONE_TEXT } from '@/lib/format'

type Range = '1D' | '1W' | '1M' | '3M' | '1Y' | 'MAX'
const RANGE_DAYS: Record<Range, number | null> = { '1D': 1, '1W': 7, '1M': 31, '3M': 92, '1Y': 366, MAX: null }

interface Row {
  s: SecurityView
  q: StoredQuote | null
  market: MarketCode | null
  change: number | null
  changePct: number | null
  holding: 'held' | 'watch' | 'dca' | 'none'
}

type Dialog = { kind: 'security'; security?: SecurityView } | { kind: 'price'; security: SecurityView } | { kind: 'watch'; securityId: string } | null

const STATE_TONE: Record<MarketStatus['state'], 'gain' | 'warn' | 'neutral'> = { open: 'gain', break: 'warn', off_hours: 'neutral', closed: 'neutral' }

export function MarketView({ s, raw, quotes, providers, today, timezone }: { s: Snapshot; raw: RawData; quotes: Record<string, StoredQuote | null>; providers: ProviderStatus[]; today: string; timezone: string }) {
  const [dialog, setDialog] = useState<Dialog>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [compare, setCompare] = useState<string[]>([])
  const [range, setRange] = useState<Range>('3M')
  const [histories, setHistories] = useState<Record<string, HistoryResult | { error: string }>>({})
  const [loading, setLoading] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<string, MarketStatus | null>>({})
  const { confirm } = useFeedback()
  const remove = useAction(deleteSecurityAction, { success: 'ลบหลักทรัพย์แล้ว' })

  // market clocks are computed in the browser so they tick and never mismatch the server render
  useEffect(() => {
    const tick = () => setStatuses({ US: marketStatus('NYSE'), TH: marketStatus('SET') })
    tick()
    const t = setInterval(tick, 30_000)
    return () => clearInterval(t)
  }, [])

  const rows: Row[] = useMemo(
    () =>
      s.securities
        .filter((x) => showArchived || !x.isArchived)
        .map((x) => {
          const q = quotes[x.id] ?? null
          const fromProvider = x.price && x.price.dataType !== 'manual'
          const prev = fromProvider ? (q?.prevClose ?? null) : null
          const price = x.price?.price ?? null
          const change = price !== null && prev ? price - prev : null
          const active = x.watch && (x.watch.status === 'interested' || x.watch.status === 'waiting')
          return {
            s: x,
            q,
            market: marketOf(x.exchange),
            change,
            changePct: change !== null && prev ? (change / prev) * 100 : null,
            holding: x.heldMain > 0 || x.heldDca > 0 ? 'held' : active ? 'watch' : x.inDcaPlan ? 'dca' : 'none',
          }
        }),
    [s.securities, quotes, showArchived],
  )

  const load = async (id: string) => {
    if (histories[id] && !('error' in histories[id])) return
    setLoading(id)
    const res = await loadHistoryAction({ securityId: id })
    setLoading(null)
    setHistories((h) => ({ ...h, [id]: res.ok ? res.data : { error: res.error } }))
  }
  const select = (id: string) => {
    setSelected(id)
    void load(id)
  }
  const toggleCompare = (id: string) => {
    setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= 5 ? c : [...c, id]))
    void load(id)
  }

  const cutoff = (r: Range) => {
    const days = RANGE_DAYS[r]
    if (days === null) return '0000-00-00'
    const d = new Date(`${today}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - days)
    return d.toISOString().slice(0, 10)
  }
  const sel = selected ? s.securities.find((x) => x.id === selected) : null
  const selHist = selected ? histories[selected] : undefined
  const selBars = selHist && !('error' in selHist) ? selHist.bars.filter((b) => b.date >= cutoff(range)) : []

  const compareData = useMemo(() => {
    const from = cutoff(range)
    const series = compare.map((id) => {
      const h = histories[id]
      const bars = h && !('error' in h) ? h.bars.filter((b) => b.date >= from) : []
      return { id, bars, base: bars[0]?.close ?? null }
    })
    const dates = [...new Set(series.flatMap((x) => x.bars.map((b) => b.date)))].sort()
    return dates.map((date) => {
      const row: Record<string, string | number> = { date }
      for (const x of series) {
        const bar = x.bars.find((b) => b.date === date)
        if (bar && x.base) row[x.id] = (bar.close / x.base - 1) * 100
      }
      return row
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compare, histories, range, today])

  const marketsInUse = new Set(rows.map((r) => r.market).filter(Boolean) as MarketCode[])
  const missing = providers.filter((p) => !p.configured && marketsInUse.has(p.market))
  const failing = providers.filter((p) => p.configured && p.lastError)

  const columns: Column<Row>[] = [
    {
      key: 'sym',
      header: 'หลักทรัพย์',
      sort: (r) => r.s.symbol,
      cell: (r) => (
        <button type="button" onClick={() => select(r.s.id)} className="min-w-40 text-left">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-accent hover:underline">{r.s.symbol}</span>
            <span className="text-[11px] text-muted">{r.s.exchange}</span>
            {r.s.isArchived && <Badge>เก็บถาวร</Badge>}
          </div>
          <div className="max-w-52 truncate text-xs text-muted">{r.s.name}</div>
        </button>
      ),
    },
    {
      key: 'price',
      header: 'ราคาล่าสุด',
      align: 'right',
      sort: (r) => r.s.price?.price ?? null,
      cell: (r) => (
        <div className="num">
          <div className="font-medium">{r.s.price ? fmtNum(r.s.price.price, 2) : '—'}</div>
          <div className="text-[11px] text-muted">{r.s.currency}</div>
        </div>
      ),
    },
    { key: 'prev', header: 'ปิดครั้งก่อน', align: 'right', cell: (r) => <span className="num">{fmtNum(r.q?.prevClose, 2)}</span> },
    {
      key: 'chg',
      header: 'เปลี่ยนแปลง',
      align: 'right',
      sort: (r) => r.changePct,
      cell: (r) => (
        <div className={cx('num', TONE_TEXT[toneOf(r.change)])}>
          <div>{r.change === null ? '—' : `${r.change > 0 ? '+' : ''}${fmtNum(r.change, 2)}`}</div>
          <div className="text-xs">{fmtPct(r.changePct, 2, true)}</div>
        </div>
      ),
    },
    { key: 'open', header: 'เปิด', align: 'right', cell: (r) => <span className="num">{fmtNum(r.q?.open, 2)}</span> },
    {
      key: 'hl',
      header: 'สูง / ต่ำ',
      align: 'right',
      cell: (r) => (
        <span className="num text-xs">
          {fmtNum(r.q?.high, 2)} / {fmtNum(r.q?.low, 2)}
        </span>
      ),
    },
    { key: 'vol', header: 'ปริมาณ', align: 'right', sort: (r) => r.q?.volume ?? null, cell: (r) => <span className="num">{r.q?.volume ? fmtCompact(r.q.volume) : '—'}</span> },
    {
      key: 'asof',
      header: 'ข้อมูล ณ / ประเภท',
      sort: (r) => r.s.price?.asOf ?? null,
      cell: (r) => (
        <div className="min-w-36">
          <PriceSource price={r.s.price} timeZone={timezone} />
          {r.q && <div className="text-[11px] text-muted">ดึงข้อมูล {fmtAgo(r.q.fetchedAt)}</div>}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'สถานะในพอร์ต',
      sort: (r) => r.holding,
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.s.heldMain > 0 && <Badge tone="accent">ถืออยู่</Badge>}
          {r.s.heldDca > 0 && <Badge tone="accent">DCA</Badge>}
          {r.s.watch && (r.s.watch.status === 'interested' || r.s.watch.status === 'waiting') && <Badge tone="warn">สนใจซื้อ</Badge>}
          {r.s.inDcaPlan && r.s.heldDca === 0 && <Badge>ในแผน DCA</Badge>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <div className="flex justify-end">
          <IconButton label="ดูกราฟ" onClick={() => select(r.s.id)}>
            <ChartLine size={15} />
          </IconButton>
          <IconButton label={compare.includes(r.s.id) ? 'เอาออกจากการเปรียบเทียบ' : 'เพิ่มในการเปรียบเทียบ (สูงสุด 5)'} onClick={() => toggleCompare(r.s.id)} className={compare.includes(r.s.id) ? 'text-accent' : ''}>
            <span className="text-xs font-semibold">⇄</span>
          </IconButton>
          <IconButton label="เพิ่มใน Watchlist" onClick={() => setDialog({ kind: 'watch', securityId: r.s.id })}>
            <Star size={15} />
          </IconButton>
          <IconButton label="บันทึกราคาเอง" onClick={() => setDialog({ kind: 'price', security: r.s })}>
            <Tag size={15} />
          </IconButton>
          <IconButton label="แก้ไข" onClick={() => setDialog({ kind: 'security', security: r.s })}>
            <Pencil size={15} />
          </IconButton>
          <IconButton
            label="ลบ"
            onClick={async () => {
              if (await confirm({ title: `ลบ ${r.s.symbol}?`, message: 'ลบได้เฉพาะหลักทรัพย์ที่ไม่มีธุรกรรมและไม่อยู่ในแผน DCA (ถ้ามีให้ใช้ "เก็บถาวร" ในหน้าแก้ไขแทน)', danger: true, confirmLabel: 'ลบ' })) await remove.run({ id: r.s.id })
            }}
          >
            <Trash2 size={15} />
          </IconButton>
        </div>
      ),
    },
  ]

  const categories = [...new Set(rows.map((r) => r.s.category))]

  return (
    <div className="space-y-5">
      <PageHeader
        title="ตลาดหุ้น (Market)"
        subtitle="ราคาแสดงพร้อมประเภทข้อมูล (Real-time / Delayed / End-of-day / Cached / บันทึกเอง) และเวลาที่ได้รับจริงเสมอ"
        actions={
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setDialog({ kind: 'security' })}>
            เพิ่มหลักทรัพย์
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {(['US', 'TH'] as MarketCode[]).map((m) => {
          const st = statuses[m]
          const p = providers.find((x) => x.market === m)
          return (
            <div key={m} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-4 py-3">
              <div>
                <div className="text-sm font-medium">ตลาด{MARKET_LABELS[m]}</div>
                <div className="text-xs text-muted">{st ? `เวลาท้องถิ่น ${st.localTime} (${st.timezone})` : '—'}</div>
                <div className="text-[11px] text-muted">ตามเวลาทำการปกติ ไม่รวมวันหยุดตลาด</div>
              </div>
              <div className="text-right">
                {st && <Badge tone={STATE_TONE[st.state]}>{st.label}</Badge>}
                <div className="mt-1 text-[11px] text-muted">{p?.configured ? `ข้อมูลจาก ${p.label}` : 'ยังไม่ได้ตั้งค่า API'}</div>
              </div>
            </div>
          )
        })}
      </div>

      {missing.length > 0 && (
        <Notice tone="warning" title={`ยังไม่ได้ตั้งค่า Market Data API สำหรับตลาด${missing.map((p) => MARKET_LABELS[p.market]).join(' และ ')}`}>
          ระบบจะไม่สร้างราคาจำลอง: หลักทรัพย์ในตลาดนี้จะแสดง &quot;ไม่มีข้อมูลราคา&quot; หรือราคาล่าสุดที่เคยเก็บไว้พร้อมวันที่ หรือราคาที่คุณบันทึกเอง ผู้ดูแลระบบตั้งค่า API Key ได้ใน Environment Variables ฝั่งเซิร์ฟเวอร์ (ดูหน้า Settings และ README)
        </Notice>
      )}
      {failing.map((p) => (
        <Notice key={p.market} tone="danger" title={`ดึงข้อมูลตลาด${MARKET_LABELS[p.market]}ครั้งล่าสุดไม่สำเร็จ (${fmtDateTime(p.lastError!.at, timezone)})`}>
          {p.lastError!.message} · ราคาที่แสดงเป็นข้อมูลที่เก็บไว้ตามเวลาที่ระบุในแต่ละแถว ไม่ใช่ราคาปัจจุบัน
        </Notice>
      ))}

      <Card title="กระดานหุ้น" subtitle={`${rows.length} หลักทรัพย์ · คลิกชื่อเพื่อดูกราฟ · ⇄ เพื่อเปรียบเทียบ`} pad={false}>
        {rows.length === 0 ? (
          <EmptyState icon={<ChartLine size={28} />} title="ยังไม่มีหลักทรัพย์ในรายการ" description="เพิ่มหุ้นหรือ ETF ที่ถืออยู่หรือที่สนใจ ระบบรองรับตลาดสหรัฐฯ และตลาดหลักทรัพย์แห่งประเทศไทย" action={<Button variant="primary" onClick={() => setDialog({ kind: 'security' })}>เพิ่มหลักทรัพย์</Button>} />
        ) : (
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.s.id}
            search={(r) => `${r.s.symbol} ${r.s.name}`}
            searchPlaceholder="ค้นหาชื่อบริษัทหรือ Ticker"
            filters={[
              { key: 'market', label: 'ตลาด', options: (['US', 'TH'] as MarketCode[]).map((m) => ({ value: m, label: MARKET_LABELS[m] })), get: (r) => r.market },
              { key: 'cat', label: 'หมวด', options: categories.map((c) => ({ value: c, label: c })), get: (r) => r.s.category },
              {
                key: 'hold',
                label: 'สถานะในพอร์ต',
                options: [
                  { value: 'held', label: 'ถืออยู่' },
                  { value: 'watch', label: 'สนใจซื้อ' },
                  { value: 'dca', label: 'ในแผน DCA' },
                  { value: 'none', label: 'ติดตามอย่างเดียว' },
                ],
                get: (r) => r.holding,
              },
            ]}
            toolbar={
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> แสดงรายการที่เก็บถาวร
              </label>
            }
            defaultSort={{ key: 'sym', dir: 'asc' }}
            rowClassName={(r) => (r.s.id === selected ? 'bg-accent-soft/40' : undefined)}
          />
        )}
      </Card>

      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="ช่วงเวลาของกราฟ">
        <span className="mr-1 text-xs text-muted">ช่วงกราฟ:</span>
        {(Object.keys(RANGE_DAYS) as Range[]).map((r) => (
          <Button key={r} size="sm" variant={range === r ? 'primary' : 'secondary'} disabled={r === '1D'} title={r === '1D' ? 'ระบบเก็บเฉพาะราคารายวัน ยังไม่มีข้อมูลระหว่างวัน (Intraday)' : undefined} onClick={() => setRange(r)}>
            {r}
          </Button>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title={sel ? `กราฟราคา ${sel.symbol} (${sel.currency})` : 'กราฟราคา'} subtitle={selHist && !('error' in selHist) ? `ราคาปิดรายวัน ${selHist.source ? `จาก ${selHist.source}` : ''}${selHist.fetchedAt ? ` · อัปเดต ${fmtDateTime(selHist.fetchedAt, timezone)}` : ''}` : 'เลือกหลักทรัพย์จากกระดาน'}>
          {!sel ? (
            <EmptyState title="ยังไม่ได้เลือกหลักทรัพย์" description="คลิกชื่อหลักทรัพย์ในกระดานเพื่อดูกราฟ" />
          ) : loading === sel.id ? (
            <div className="skeleton h-64" />
          ) : selHist && 'error' in selHist ? (
            <Notice tone="danger">{selHist.error}</Notice>
          ) : (
            <>
              {selHist?.notice && <Notice tone="warning" className="mb-3">{`ยังอัปเดตข้อมูลย้อนหลังไม่ได้: ${selHist.notice}${selHist.bars.length ? ' (แสดงข้อมูลที่เก็บไว้)' : ''}`}</Notice>}
              <LineSeriesChart data={selBars} xKey="date" xFormat={(d) => fmtDate(d)} series={[{ key: 'close', label: 'ราคาปิด', color: PALETTE[0] }]} format={(n) => fmtNum(n, 2)} empty="ไม่มีข้อมูลราคาย้อนหลังในช่วงนี้" />
              {selBars.length > 1 && (
                <p className="mt-2 text-xs text-muted">
                  {fmtDate(selBars[0].date)} → {fmtDate(selBars[selBars.length - 1].date)}: <span className={TONE_TEXT[toneOf(selBars[selBars.length - 1].close - selBars[0].close)]}>{fmtPct((selBars[selBars.length - 1].close / selBars[0].close - 1) * 100, 2, true)}</span>
                </p>
              )}
            </>
          )}
        </Card>
        <Card title="เปรียบเทียบการเปลี่ยนแปลง (%)" subtitle="ปรับฐานเป็น 0% ที่วันแรกของช่วง · เลือกได้สูงสุด 5 ตัวด้วยปุ่ม ⇄">
          {compare.length === 0 ? (
            <EmptyState title="ยังไม่ได้เลือกหลักทรัพย์ที่จะเปรียบเทียบ" />
          ) : (
            <>
              <LineSeriesChart data={compareData} xKey="date" xFormat={(d) => fmtDate(d)} series={compare.map((id, i) => ({ key: id, label: s.securities.find((x) => x.id === id)?.symbol ?? id, color: PALETTE[i] }))} format={(n) => fmtPct(n, 2, true)} empty="ยังไม่มีข้อมูลราคาย้อนหลัง" />
              <div className="mt-2 flex flex-wrap gap-1">
                {compare.map((id) => {
                  const h = histories[id]
                  return (
                    <Badge key={id} tone={h && 'error' in h ? 'loss' : 'neutral'} title={h && 'error' in h ? h.error : h && !('error' in h) && h.notice ? h.notice : undefined}>
                      {s.securities.find((x) => x.id === id)?.symbol}
                      {loading === id ? ' …' : h && 'error' in h ? ' (โหลดไม่ได้)' : h && !('error' in h) && h.bars.length === 0 ? ' (ไม่มีข้อมูล)' : ''}
                    </Badge>
                  )
                })}
              </div>
            </>
          )}
        </Card>
      </div>

      <Card title="ประเภทของข้อมูลราคา">
        <ul className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(DATA_TYPE_LABELS).map(([k, v]) => (
            <li key={k} className="flex items-start gap-2">
              <Badge tone={v.tone}>{v.label}</Badge>
              <span className="text-xs text-muted">{v.hint}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">
          ระบบดึงราคาเฉพาะเมื่อข้อมูลเดิมถึงเวลาอัปเดต (ตลาดเปิด: ทุก ~15 นาที, ตลาดปิด: หลังราคาปิด) และหยุดเมื่อใช้ครบโควตาที่ตั้งไว้ของผู้ให้บริการ ราคาที่เก่ากว่าเกณฑ์ในหน้า Settings จะถูกติดป้ายว่าเก่า ตลาดที่รองรับ: {Object.values(EXCHANGES).map((e) => e.code).join(', ')}
        </p>
      </Card>

      {dialog?.kind === 'security' && <SecurityForm security={dialog.security} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'price' && <ManualPriceForm security={dialog.security} today={today} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'watch' && <WatchForm securities={raw.securities} securityId={dialog.securityId} onClose={() => setDialog(null)} />}
    </div>
  )
}
