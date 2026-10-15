'use client'

/** Forms shared by several pages: securities, prices, watchlist and investment transactions. */
import { useState } from 'react'
import { Search } from 'lucide-react'
import { confirmWatchBoughtAction, saveSecurityAction, saveTransactionAction, saveWatchAction, setManualPriceAction } from '@/actions/app'
import { lookupFxRateAction, searchSymbolsAction } from '@/actions/market'
import type { AccountRow, SecurityRow, WatchRow } from '@/lib/calc/types'
import type { LedgerTx } from '@/lib/calc/portfolio'
import { CATEGORIES, EXCHANGES } from '@/lib/market/exchanges'
import { fmtMoney, fmtNum, fmtQty } from '@/lib/format'
import { FormFields, FormModal, newIdempotencyKey, useAction, type FieldDef, type FormValues } from './forms'
import { Button, Input, Modal, Notice, cx } from './ui'

const EXCHANGE_OPTIONS = Object.values(EXCHANGES).map((e) => ({ value: e.code, label: `${e.code} · ${e.currency}` }))
const CATEGORY_OPTIONS = CATEGORIES.map((c) => ({ value: c, label: c }))
const ASSET_TYPES = [
  { value: 'stock', label: 'หุ้น (Stock)' },
  { value: 'etf', label: 'ETF' },
  { value: 'fund', label: 'กองทุน (Fund)' },
  { value: 'other', label: 'อื่น ๆ' },
]
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))

// ---------------------------------------------------------------------------
// Security (add / edit), with optional provider search
// ---------------------------------------------------------------------------
export function SecurityForm({ security, onClose, onSaved }: { security?: SecurityRow; onClose: () => void; onSaved?: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ symbol: string; exchange: string; name: string; currency: string | null; country: string | null }[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [seed, setSeed] = useState<FormValues | null>(null)
  const initial: FormValues = seed ?? {
    symbol: security?.symbol ?? '',
    exchange: security?.exchange ?? 'NASDAQ',
    name: security?.name ?? '',
    assetType: security?.assetType ?? 'stock',
    category: security?.category ?? 'Other',
    assetGroup: security?.assetGroup ?? '',
    note: security?.note ?? '',
    isArchived: security?.isArchived ?? false,
  }
  const search = async () => {
    if (!query.trim()) return
    setSearching(true)
    setSearchError(null)
    const res = await searchSymbolsAction({ query })
    setSearching(false)
    if (res.ok) setResults(res.data.results)
    else {
      setResults(null)
      setSearchError(res.error)
    }
  }
  const fields: FieldDef[] = [
    { name: 'symbol', label: 'Ticker Symbol', required: true, placeholder: 'เช่น MSFT, PTT', disabled: !!security },
    { name: 'exchange', label: 'ตลาดหลักทรัพย์', type: 'select', required: true, options: EXCHANGE_OPTIONS, disabled: !!security, hint: (v) => `สกุลเงิน: ${EXCHANGES[String(v.exchange)]?.currency ?? '-'}` },
    { name: 'name', label: 'ชื่อบริษัท / กองทุน', required: true, full: true },
    { name: 'assetType', label: 'ประเภท', type: 'select', required: true, options: ASSET_TYPES },
    { name: 'category', label: 'หมวดธุรกิจ', type: 'select', required: true, options: CATEGORY_OPTIONS },
    { name: 'assetGroup', label: 'กลุ่มสินทรัพย์ (ใช้ตรวจการถือซ้ำซ้อน)', placeholder: 'เช่น US Large-Cap Growth', full: true, hint: 'หลักทรัพย์ที่ใส่กลุ่มเดียวกันจะถูกตรวจว่าอาจถือสินทรัพย์ซ้ำกัน' },
    { name: 'note', label: 'หมายเหตุ', type: 'textarea' },
    ...(security ? [{ name: 'isArchived', label: 'เก็บถาวร (ซ่อนจากรายการหลัก ข้อมูลเดิมยังอยู่)', type: 'checkbox' as const }] : []),
  ]
  return (
    <FormModal
      key={seed ? JSON.stringify(seed) : 'blank'}
      title={security ? `แก้ไข ${security.symbol}` : 'เพิ่มหลักทรัพย์'}
      fields={fields}
      initial={initial}
      action={saveSecurityAction}
      onClose={onClose}
      toInput={(v) => ({ ...v, id: security?.id })}
      success={(d) => {
        const id = (d as { id?: string })?.id
        if (id) onSaved?.(id)
        return security ? 'บันทึกการแก้ไขแล้ว' : 'เพิ่มหลักทรัพย์แล้ว'
      }}
      intro={
        !security && (
          <div className="rounded-lg border border-line p-3">
            <div className="mb-2 text-xs font-medium text-muted">ค้นหาจากผู้ให้บริการข้อมูลตลาด (ถ้าตั้งค่า API ไว้) หรือกรอกเองด้านล่าง</div>
            <div className="flex gap-2">
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ชื่อบริษัทหรือ Ticker" onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void search())} />
              <Button icon={<Search size={14} />} loading={searching} onClick={() => void search()}>
                ค้นหา
              </Button>
            </div>
            {searchError && <p className="mt-2 text-xs text-warn">{searchError}</p>}
            {results && (
              <ul className="mt-2 max-h-48 overflow-y-auto text-sm">
                {results.length === 0 && <li className="text-xs text-muted">ไม่พบผลลัพธ์</li>}
                {results.map((r) => (
                  <li key={`${r.symbol}-${r.exchange}-${r.name}`}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left hover:bg-surface-2"
                      onClick={() => {
                        setSeed({ ...initial, symbol: r.symbol.replace(/\.(BK|US)$/i, ''), exchange: r.exchange || (r.country === 'Thailand' ? 'SET' : 'NASDAQ'), name: r.name })
                        setResults(null)
                      }}
                    >
                      <span>
                        <span className="font-medium">{r.symbol}</span> <span className="text-muted">{r.name}</span>
                      </span>
                      <span className="text-xs text-muted">{r.exchange || 'เลือกตลาดเอง'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Manual price (clearly labelled as user-entered, never as market data)
// ---------------------------------------------------------------------------
export function ManualPriceForm({ security, today, onClose }: { security: SecurityRow; today: string; onClose: () => void }) {
  return (
    <FormModal
      title={`บันทึกราคาเอง: ${security.symbol}`}
      intro={<Notice tone="info">ใช้เมื่อยังไม่มี Market Data API หรือ API ไม่มีข้อมูลหลักทรัพย์นี้ ราคานี้จะแสดงป้าย &quot;บันทึกเอง&quot; พร้อมวันที่เสมอ และระบบจะใช้ราคาที่ใหม่กว่าระหว่างราคานี้กับราคาจาก API</Notice>}
      fields={[
        { name: 'price', label: `ราคาต่อหน่วย (${security.currency})`, type: 'number', min: 0, hint: 'เว้นว่างแล้วบันทึกเพื่อลบราคาที่บันทึกเอง' },
        { name: 'date', label: 'วันที่ของราคา', type: 'date', max: today },
      ]}
      initial={{ price: str(security.manualPrice), date: security.manualPriceAt?.slice(0, 10) ?? today }}
      action={setManualPriceAction}
      onClose={onClose}
      toInput={(v) => ({ securityId: security.id, price: v.price, date: v.date })}
      success="บันทึกราคาแล้ว"
    />
  )
}

// ---------------------------------------------------------------------------
// Watchlist / planned investment
// ---------------------------------------------------------------------------
export function WatchForm({ securities, watch, securityId, onClose }: { securities: SecurityRow[]; watch?: WatchRow; securityId?: string; onClose: () => void }) {
  const opts = securities.filter((s) => !s.isArchived || s.id === watch?.securityId).map((s) => ({ value: s.id, label: `${s.symbol} · ${s.name}` }))
  return (
    <FormModal
      title={watch ? 'แก้ไขหุ้นที่วางแผนจะซื้อ' : 'เพิ่มหุ้นที่สนใจ / วางแผนจะซื้อ'}
      intro={<Notice tone="info">รายการนี้เป็นแผนเท่านั้น จะไม่เปลี่ยนพอร์ตที่ถือจริงจนกว่าจะกด &quot;ยืนยันซื้อแล้ว&quot; และบันทึกธุรกรรมจริง</Notice>}
      fields={[
        { name: 'securityId', label: 'หลักทรัพย์', type: 'select', required: true, options: opts, full: true, disabled: !!watch },
        { name: 'targetPrice', label: 'ราคาที่สนใจซื้อ (ต่อหุ้น)', type: 'number', min: 0 },
        { name: 'budget', label: 'งบประมาณที่ต้องการลงทุน', type: 'number', min: 0, hint: 'ในสกุลเงินของหลักทรัพย์' },
        { name: 'plannedQuantity', label: 'จำนวนหุ้นที่คาดว่าจะซื้อ', type: 'number', min: 0, hint: (v) => (Number(v.budget) > 0 && Number(v.targetPrice) > 0 ? `งบ ÷ ราคาที่สนใจ ≈ ${fmtQty(Number(v.budget) / Number(v.targetPrice))} หุ้น` : undefined) },
        { name: 'plannedDate', label: 'วันที่วางแผนซื้อ', type: 'date' },
        {
          name: 'priority',
          label: 'ระดับความสำคัญ',
          type: 'select',
          required: true,
          options: [
            { value: 'high', label: 'สูง' },
            { value: 'medium', label: 'กลาง' },
            { value: 'low', label: 'ต่ำ' },
          ],
        },
        {
          name: 'status',
          label: 'สถานะ',
          type: 'select',
          required: true,
          options: [
            { value: 'interested', label: 'สนใจ' },
            { value: 'waiting', label: 'รอซื้อ' },
            { value: 'cancelled', label: 'ยกเลิก' },
          ],
        },
        { name: 'reason', label: 'เหตุผลที่สนใจ', type: 'textarea' },
      ]}
      initial={{
        securityId: watch?.securityId ?? securityId ?? '',
        targetPrice: str(watch?.targetPrice),
        budget: str(watch?.budget),
        plannedQuantity: str(watch?.plannedQuantity),
        plannedDate: watch?.plannedDate ?? '',
        priority: watch?.priority ?? 'medium',
        status: watch?.status === 'bought' ? 'waiting' : (watch?.status ?? 'interested'),
        reason: watch?.reason ?? '',
      }}
      action={saveWatchAction}
      onClose={onClose}
      toInput={(v) => ({ ...v, id: watch?.id })}
      success="บันทึกรายการที่สนใจแล้ว"
    />
  )
}

// ---------------------------------------------------------------------------
// Investment transaction
// ---------------------------------------------------------------------------
const TX_TYPE_OPTIONS = [
  { value: 'buy', label: 'ซื้อ' },
  { value: 'sell', label: 'ขาย' },
  { value: 'dividend', label: 'เงินปันผล' },
  { value: 'fee', label: 'ค่าธรรมเนียม' },
  { value: 'split', label: 'แตกหุ้น / รวมหุ้น (Stock Split)' },
  { value: 'adjustment', label: 'รายการปรับปรุง' },
]

export interface TxFormProps {
  securities: SecurityRow[]
  accounts: AccountRow[]
  baseCurrency: string
  today: string
  onClose: () => void
  /** editing an existing transaction */
  tx?: LedgerTx & { portfolio: 'main' | 'dca' }
  /** pre-filled values for a new transaction */
  preset?: Partial<Record<string, string>>
  /** confirming a planned purchase from the watchlist */
  watchId?: string
  title?: string
}

export function TransactionForm({ securities, accounts, baseCurrency, today, onClose, tx, preset, watchId, title }: TxFormProps) {
  const [values, setValues] = useState<FormValues>(() => ({
    portfolio: tx?.portfolio ?? preset?.portfolio ?? 'main',
    securityId: tx?.securityId ?? preset?.securityId ?? '',
    type: tx?.type ?? preset?.type ?? 'buy',
    tradeDate: tx?.tradeDate ?? preset?.tradeDate ?? today,
    quantity: str(tx?.quantity ?? preset?.quantity),
    price: str(tx?.price ?? preset?.price),
    amount: tx && (tx.type === 'dividend' || tx.type === 'fee' || tx.type === 'adjustment') ? str(tx.amount) : str(preset?.amount),
    fee: str(tx?.fee ?? preset?.fee ?? ''),
    splitRatio: str(tx?.splitRatio),
    fxRate: tx && tx.currency !== baseCurrency ? str(tx.fxRate) : str(preset?.fxRate),
    accountId: tx?.accountId ?? preset?.accountId ?? '',
    note: tx?.note ?? '',
  }))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [key] = useState(newIdempotencyKey)
  const [fxNote, setFxNote] = useState<string | null>(null)
  const [fxLoading, setFxLoading] = useState(false)

  const sec = securities.find((s) => s.id === values.securityId)
  const currency = sec?.currency ?? baseCurrency
  const foreign = currency !== baseCurrency
  const type = String(values.type)
  const n = (k: string) => (values[k] === '' ? null : Number(values[k]))
  const qty = n('quantity')
  const price = n('price')
  const fee = n('fee') ?? 0
  const fx = foreign ? n('fxRate') : 1
  const gross = qty !== null && price !== null ? qty * price : null
  const total = type === 'buy' ? (gross ?? 0) + fee : type === 'sell' ? (gross ?? 0) - fee : type === 'dividend' ? (n('amount') ?? 0) - fee : type === 'fee' ? (n('amount') ?? 0) : null

  const accountOpts = accounts.filter((a) => !a.isArchived && a.type !== 'other_asset' && (a.currency === currency || a.currency === baseCurrency)).map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` }))

  const set = (k: string, v: string | boolean) => {
    setValues((s) => ({ ...s, [k]: v }))
    setErrors((e) => ({ ...e, [k]: '' }))
  }

  const lookupFx = async () => {
    if (!sec) return
    setFxLoading(true)
    const res = await lookupFxRateAction({ currency: sec.currency, date: String(values.tradeDate) })
    setFxLoading(false)
    if (res.ok && res.data) {
      set('fxRate', String(res.data.rate))
      setFxNote(`อัตราอ้างอิง ${res.data.date} จาก ${res.data.source} (อัตรากลาง ไม่ใช่อัตราที่ธนาคาร/โบรกเกอร์ให้จริง แก้ไขให้ตรงกับใบยืนยันได้)`)
    } else setFxNote('ไม่พบอัตราอ้างอิงสำหรับวันที่นี้ กรุณากรอกอัตราที่ได้รับจริง')
  }

  const fields: FieldDef[] = [
    {
      name: 'portfolio',
      label: 'พอร์ต',
      type: 'select',
      required: true,
      options: [
        { value: 'main', label: 'My Portfolio (หุ้นที่ถือจริง)' },
        { value: 'dca', label: 'DCA Portfolio' },
      ],
      disabled: !!watchId,
    },
    { name: 'securityId', label: 'หลักทรัพย์', type: 'select', required: true, options: securities.filter((s) => !s.isArchived || s.id === tx?.securityId).map((s) => ({ value: s.id, label: `${s.symbol} · ${s.name} (${s.currency})` })), disabled: !!watchId },
    { name: 'type', label: 'ประเภทธุรกรรม', type: 'select', required: true, options: TX_TYPE_OPTIONS, disabled: !!watchId },
    { name: 'tradeDate', label: 'วันที่ทำรายการ', type: 'date', required: true, max: today },
    { name: 'quantity', label: type === 'adjustment' ? 'จำนวนหุ้นที่เปลี่ยน (+/−)' : 'จำนวนหุ้น', type: 'number', required: type === 'buy' || type === 'sell', min: type === 'adjustment' ? undefined : 0, showIf: () => ['buy', 'sell', 'adjustment'].includes(type), hint: 'รองรับหุ้นเศษส่วน (สูงสุด 8 ตำแหน่ง)' },
    { name: 'price', label: `ราคาต่อหุ้น (${currency})`, type: 'number', required: true, min: 0, showIf: () => type === 'buy' || type === 'sell' },
    {
      name: 'amount',
      label: type === 'dividend' ? `เงินปันผลก่อนหักภาษี (${currency})` : type === 'fee' ? `จำนวนค่าธรรมเนียม (${currency})` : `ต้นทุนที่เปลี่ยน (+/−, ${currency})`,
      type: 'number',
      required: type === 'dividend' || type === 'fee',
      showIf: () => ['dividend', 'fee', 'adjustment'].includes(type),
    },
    { name: 'fee', label: type === 'dividend' ? `ภาษีหัก ณ ที่จ่าย / ค่าธรรมเนียม (${currency})` : `ค่าธรรมเนียม (${currency})`, type: 'number', min: 0, showIf: () => ['buy', 'sell', 'dividend'].includes(type) },
    { name: 'splitRatio', label: 'อัตราส่วน (หุ้นใหม่ต่อหุ้นเดิม)', type: 'number', required: true, min: 0, showIf: () => type === 'split', hint: 'แตกหุ้น 4:1 ใส่ 4 · รวมหุ้น 1:10 ใส่ 0.1 ต้นทุนรวมไม่เปลี่ยน' },
    {
      name: 'fxRate',
      label: `อัตราแลกเปลี่ยน ${baseCurrency} ต่อ 1 ${currency} ณ วันที่ทำรายการ`,
      type: 'number',
      required: true,
      min: 0,
      showIf: () => foreign && type !== 'split',
      hint: fxNote ?? 'ใช้อัตราที่ได้รับจริงจากธนาคาร/โบรกเกอร์ เพื่อให้ต้นทุนเป็นบาทถูกต้อง',
    },
    { name: 'accountId', label: 'ตัดเงิน/รับเงินจากบัญชี', type: 'select', options: accountOpts, showIf: () => !['split', 'adjustment'].includes(type), hint: 'ไม่ระบุ = ไม่กระทบยอดเงินสดในระบบ (เช่น เงินอยู่ในโบรกเกอร์ที่ไม่ได้บันทึก)' },
    { name: 'note', label: 'หมายเหตุ', type: 'textarea' },
  ]

  const { run, pending } = useAction<Record<string, unknown>, unknown>(watchId ? (confirmWatchBoughtAction as never) : (saveTransactionAction as never), {
    success: tx ? 'แก้ไขธุรกรรมแล้ว พอร์ตถูกคำนวณใหม่' : watchId ? 'บันทึกการซื้อจริงแล้ว รายการถูกเพิ่มเข้าพอร์ต' : 'บันทึกธุรกรรมแล้ว',
    onSuccess: onClose,
  })

  const submit = async () => {
    const e: Record<string, string> = {}
    for (const f of fields) {
      if (f.showIf && !f.showIf(values)) continue
      const v = String(values[f.name] ?? '').trim()
      if (f.required && !v) e[f.name] = 'จำเป็นต้องกรอก'
      else if (v && f.type === 'number' && !Number.isFinite(Number(v))) e[f.name] = 'ต้องเป็นตัวเลข'
    }
    if ((type === 'buy' || type === 'sell') && qty !== null && qty <= 0) e.quantity = 'ต้องมากกว่า 0'
    if (String(values.tradeDate) > today) e.tradeDate = 'ต้องไม่เป็นวันในอนาคต'
    if (Object.values(e).some(Boolean)) return setErrors(e)
    const payload = { ...values, id: tx?.id, idempotencyKey: key }
    const res = await run(watchId ? { watchId, transaction: payload } : payload)
    if (!res.ok && 'fields' in res && res.fields) setErrors(Object.fromEntries(Object.entries(res.fields).map(([k, v]) => [k.replace(/^transaction\./, ''), v])))
  }

  return (
    <Modal
      open
      wide
      onClose={pending ? () => {} : onClose}
      title={title ?? (tx ? 'แก้ไขธุรกรรม' : watchId ? 'ยืนยันการซื้อจริง' : 'เพิ่มรายการลงทุน')}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            ยกเลิก
          </Button>
          <Button variant="primary" loading={pending} onClick={() => void submit()}>
            {watchId ? 'ยืนยันและบันทึกธุรกรรม' : 'บันทึก'}
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
        className="space-y-3"
      >
        {tx && <Notice tone="warning">การแก้ไขจะคำนวณต้นทุน จำนวนหุ้น และกำไร/ขาดทุนของหลักทรัพย์นี้ใหม่ทั้งหมด หากทำให้ประวัติขายเกินจำนวนที่ถือ ระบบจะไม่บันทึก</Notice>}
        <FormFields fields={fields} values={values} errors={errors} onChange={set} />
        {foreign && type !== 'split' && (
          <Button size="sm" onClick={() => void lookupFx()} loading={fxLoading} disabled={!values.tradeDate}>
            ดึงอัตราอ้างอิง {currency}/{baseCurrency} ของวันที่นี้
          </Button>
        )}
        {(type === 'buy' || type === 'sell' || type === 'dividend' || type === 'fee') && total !== null && (
          <div className="rounded-lg bg-surface-2 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">{type === 'buy' ? 'ยอดซื้อ (จำนวน × ราคา)' : type === 'sell' ? 'ยอดขาย (จำนวน × ราคา)' : 'ยอดก่อนหัก'}</span>
              <span className="num">{fmtMoney(type === 'buy' || type === 'sell' ? gross : n('amount'), currency)}</span>
            </div>
            <div className={cx('flex justify-between font-medium')}>
              <span>{type === 'buy' ? 'ต้นทุนรวมค่าธรรมเนียม' : type === 'sell' ? 'เงินที่ได้รับหลังหักค่าธรรมเนียม' : type === 'dividend' ? 'เงินปันผลสุทธิ' : 'ค่าธรรมเนียม'}</span>
              <span className="num">
                {fmtMoney(total, currency)}
                {foreign && fx ? <span className="ml-2 text-muted">≈ {fmtMoney(total * fx, baseCurrency)}</span> : null}
              </span>
            </div>
            {type === 'buy' && qty ? <div className="mt-1 text-xs text-muted">ต้นทุนต่อหุ้นรวมค่าธรรมเนียม {fmtNum(total / qty, 4)} {currency}</div> : null}
          </div>
        )}
        <button type="submit" className="hidden" tabIndex={-1} aria-hidden="true" />
      </form>
    </Modal>
  )
}
