/**
 * Securities, watchlist and the investment ledger.
 *
 * Invariant enforced on every create / edit / delete / import: after the
 * change, replaying the affected security's ledger must never sell more shares
 * than were held at that moment. If it would, the whole change is rolled back.
 */
import { createHash } from 'node:crypto'
import type { Queryable } from '@/lib/db'
import { camelize } from '@/lib/data/load'
import { isValidDate, round, todayInTz } from '@/lib/calc/money'
import { validateLedger, type LedgerTx, type TxType } from '@/lib/calc/portfolio'
import { parseCsvObjects } from '@/lib/csv'
import { EXCHANGES } from '@/lib/market/exchanges'
import { UserError, audit, deleteRow, getRow, insertRow, mustGet, removeRow, saveRow, updateRow, type Row } from './core'
import { TX_TYPES, type TransactionInput } from './schemas'
import type { z } from 'zod'
import type { manualPriceSchema, securitySchema, watchSchema } from './schemas'

interface SecurityDb {
  id: string
  symbol: string
  exchange: string
  name: string
  currency: string
}
interface AccountDb {
  id: string
  name: string
  type: string
  currency: string
  isArchived: boolean
}

async function userContext(q: Queryable): Promise<{ baseCurrency: string; today: string }> {
  const r = await q.query<{ base_currency: string; timezone: string }>('select base_currency, timezone from user_settings')
  const s = r.rows[0] ?? { base_currency: 'THB', timezone: 'Asia/Bangkok' }
  return { baseCurrency: s.base_currency, today: todayInTz(s.timezone) }
}

async function portfolioId(q: Queryable, kind: 'main' | 'dca'): Promise<string> {
  const r = await q.query<{ id: string }>('select id from portfolios where kind = $1', [kind])
  if (!r.rows[0]) throw new UserError('ไม่พบพอร์ตของบัญชีนี้')
  return r.rows[0].id
}

// ---------------------------------------------------------------------------
// Securities
// ---------------------------------------------------------------------------
export async function saveSecurity(q: Queryable, userId: string, d: z.output<typeof securitySchema>) {
  const ex = EXCHANGES[d.exchange]
  if (!ex) throw new UserError(`ระบบยังไม่รองรับตลาด "${d.exchange}"`, { exchange: 'ตลาดไม่รองรับ' })
  const { id, ...data } = d
  if (id) {
    const before = await mustGet<SecurityDb>(q, 'securities', id, 'หลักทรัพย์')
    if (before.symbol !== data.symbol || before.exchange !== data.exchange) {
      const used = await q.query('select 1 from transactions where security_id = $1 limit 1', [id])
      if (used.rows.length > 0) throw new UserError('หลักทรัพย์นี้มีธุรกรรมแล้ว จึงแก้ Ticker หรือตลาดไม่ได้ (ธุรกรรมเดิมจะอ้างถึงหุ้นผิดตัว)')
    }
  }
  return saveRow<SecurityDb>(q, userId, 'securities', id, { ...data, currency: ex.currency })
}

export async function deleteSecurity(q: Queryable, userId: string, id: string) {
  const used = await q.query('select 1 from transactions where security_id = $1 limit 1', [id])
  if (used.rows.length > 0) throw new UserError('หลักทรัพย์นี้มีธุรกรรมอยู่ จึงลบไม่ได้ ใช้ "เก็บถาวร" แทน หรือลบธุรกรรมที่เกี่ยวข้องก่อน')
  const plan = await q.query('select 1 from dca_allocations where security_id = $1 limit 1', [id])
  if (plan.rows.length > 0) throw new UserError('หลักทรัพย์นี้อยู่ในแผน DCA นำออกจากแผนก่อนจึงจะลบได้')
  return removeRow(q, userId, 'securities', id)
}

export async function setManualPrice(q: Queryable, userId: string, d: z.output<typeof manualPriceSchema>) {
  const before = await mustGet<Row>(q, 'securities', d.securityId, 'หลักทรัพย์')
  const { today } = await userContext(q)
  if (d.date && d.date > today) throw new UserError('วันที่ของราคาต้องไม่เป็นวันในอนาคต')
  // A manual price is stamped with when the user says it was observed; never presented as live data.
  const at = d.price === null ? null : d.date && d.date < today ? `${d.date}T12:00:00.000Z` : new Date().toISOString()
  const after = await updateRow(q, 'securities', d.securityId, { manualPrice: d.price, manualPriceAt: at })
  await audit(q, userId, 'update', 'securities.manual_price', d.securityId, { manualPrice: before.manualPrice, manualPriceAt: before.manualPriceAt }, { manualPrice: d.price, manualPriceAt: at })
  return after
}

// ---------------------------------------------------------------------------
// Watchlist / planned investments (never touches holdings)
// ---------------------------------------------------------------------------
export async function saveWatch(q: Queryable, userId: string, d: z.output<typeof watchSchema>) {
  const { id, ...data } = d
  await mustGet(q, 'securities', d.securityId, 'หลักทรัพย์')
  if (id) {
    const before = await mustGet<{ status: string }>(q, 'watchlists', id, 'รายการ')
    if (before.status === 'bought') throw new UserError('รายการนี้ยืนยันซื้อแล้ว แก้ไขได้ที่ธุรกรรมในพอร์ต')
  }
  return saveRow(q, userId, 'watchlists', id, data)
}

export async function deleteWatch(q: Queryable, userId: string, id: string) {
  return removeRow(q, userId, 'watchlists', id)
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------
function toLedger(row: Row): LedgerTx {
  return row as unknown as LedgerTx
}

async function ledgerFor(q: Queryable, portfolio: string, security: string): Promise<LedgerTx[]> {
  const r = await q.query<Row>(
    `select id, portfolio_id, security_id, account_id, type, trade_date, created_at, quantity, price, amount, fee, split_ratio, currency, fx_rate, source
       from transactions where portfolio_id = $1 and security_id = $2`,
    [portfolio, security],
  )
  return r.rows.map((x) => toLedger(camelize<Row>(x)))
}

async function assertLedgerValid(q: Queryable, portfolio: string, security: string): Promise<void> {
  const problem = validateLedger(await ledgerFor(q, portfolio, security))
  if (problem) throw new UserError(`บันทึกไม่ได้: ${problem}`)
}

interface PreparedTx {
  portfolioId: string
  securityId: string
  accountId: string | null
  type: TxType
  tradeDate: string
  quantity: number | null
  price: number | null
  amount: number
  fee: number
  splitRatio: number | null
  currency: string
  fxRate: number
  note: string | null
}

/** Normalises and cross-checks a transaction against the security, the account and the calendar. */
async function prepareTx(q: Queryable, d: TransactionInput, ctx: { baseCurrency: string; today: string }): Promise<PreparedTx> {
  const security = await mustGet<SecurityDb>(q, 'securities', d.securityId, 'หลักทรัพย์')
  if (d.tradeDate > ctx.today) throw new UserError('วันที่ทำรายการต้องไม่เป็นวันในอนาคต', { tradeDate: 'ต้องไม่เป็นวันในอนาคต' })

  let fxRate = 1
  if (security.currency !== ctx.baseCurrency) {
    if (!d.fxRate) throw new UserError(`กรุณากรอกอัตราแลกเปลี่ยน ${security.currency}/${ctx.baseCurrency} ณ วันที่ทำรายการ`, { fxRate: 'จำเป็นต้องกรอก' })
    fxRate = d.fxRate
  }

  if (d.accountId) {
    const account = await mustGet<AccountDb>(q, 'accounts', d.accountId, 'บัญชี')
    if (account.type === 'other_asset') throw new UserError('บัญชีประเภททรัพย์สินอื่นใช้ชำระค่าหุ้นไม่ได้', { accountId: 'เลือกบัญชีเงินสด ธนาคาร หรือโบรกเกอร์' })
    if (account.currency !== security.currency && account.currency !== ctx.baseCurrency) {
      throw new UserError(`บัญชี "${account.name}" เป็นสกุล ${account.currency}: ต้องใช้บัญชีสกุล ${security.currency} หรือ ${ctx.baseCurrency}`, { accountId: 'สกุลเงินไม่ตรง' })
    }
  }

  const out: PreparedTx = {
    portfolioId: await portfolioId(q, d.portfolio),
    securityId: d.securityId,
    accountId: d.accountId,
    type: d.type,
    tradeDate: d.tradeDate,
    quantity: null,
    price: null,
    amount: 0,
    fee: d.fee,
    splitRatio: null,
    currency: security.currency,
    fxRate,
    note: d.note,
  }
  switch (d.type) {
    case 'buy':
    case 'sell':
      if (d.quantity === null || d.quantity <= 0) throw new UserError('จำนวนหุ้นต้องมากกว่า 0', { quantity: 'ต้องมากกว่า 0' })
      if (d.price === null) throw new UserError('กรุณากรอกราคาต่อหุ้น', { price: 'จำเป็นต้องกรอก' })
      out.quantity = round(d.quantity, 8)
      out.price = round(d.price, 6)
      out.amount = round(out.quantity * out.price, 4)
      if (d.type === 'sell' && out.fee > out.amount) throw new UserError('ค่าธรรมเนียมขายมากกว่ามูลค่าที่ขาย', { fee: 'สูงเกินมูลค่าขาย' })
      break
    case 'dividend':
      if (d.amount === null || d.amount <= 0) throw new UserError('กรุณากรอกจำนวนเงินปันผล (ก่อนหักภาษี)', { amount: 'ต้องมากกว่า 0' })
      if (d.fee > d.amount) throw new UserError('ภาษี/ค่าธรรมเนียมมากกว่าเงินปันผล', { fee: 'สูงเกินเงินปันผล' })
      out.amount = round(d.amount, 4)
      break
    case 'fee':
      if (d.amount === null || d.amount <= 0) throw new UserError('กรุณากรอกจำนวนค่าธรรมเนียม', { amount: 'ต้องมากกว่า 0' })
      out.amount = round(d.amount, 4)
      out.fee = 0
      break
    case 'split':
      if (d.splitRatio === null || d.splitRatio <= 0) throw new UserError('กรุณากรอกอัตราแตกหุ้น เช่น 4 สำหรับ 4:1 หรือ 0.1 สำหรับรวมหุ้น 10:1', { splitRatio: 'ต้องมากกว่า 0' })
      out.splitRatio = d.splitRatio
      out.fee = 0
      out.accountId = null
      break
    case 'adjustment':
      if ((d.quantity ?? 0) === 0 && (d.amount ?? 0) === 0) throw new UserError('รายการปรับปรุงต้องเปลี่ยนจำนวนหุ้นหรือต้นทุนอย่างน้อยหนึ่งอย่าง', { quantity: 'กรอกจำนวนหุ้นหรือต้นทุนที่เปลี่ยน' })
      out.quantity = round(d.quantity ?? 0, 8)
      out.amount = round(d.amount ?? 0, 4)
      out.fee = 0
      out.accountId = null
      break
  }
  return out
}

export async function saveTransaction(
  q: Queryable,
  userId: string,
  d: TransactionInput,
  extra: { source?: 'manual' | 'dca' | 'import' | 'watchlist'; importHash?: string } = {},
): Promise<{ id: string }> {
  const ctx = await userContext(q)
  const tx = await prepareTx(q, d, ctx)
  if (d.id) {
    const before = await mustGet<{ id: string; portfolioId: string; securityId: string }>(q, 'transactions', d.id, 'ธุรกรรม')
    const after = await updateRow<{ id: string }>(q, 'transactions', d.id, { ...tx })
    await assertLedgerValid(q, tx.portfolioId, tx.securityId)
    if (before.portfolioId !== tx.portfolioId || before.securityId !== tx.securityId) await assertLedgerValid(q, before.portfolioId, before.securityId)
    await audit(q, userId, 'update', 'transactions', d.id, before, after)
    return { id: d.id }
  }
  const row = await insertRow<{ id: string }>(q, 'transactions', userId, { ...tx, source: extra.source ?? 'manual', idempotencyKey: d.idempotencyKey ?? null, importHash: extra.importHash ?? null })
  await assertLedgerValid(q, tx.portfolioId, tx.securityId)
  await audit(q, userId, 'create', 'transactions', row.id, null, row)
  return { id: row.id }
}

export async function deleteTransaction(q: Queryable, userId: string, id: string): Promise<void> {
  // A linked DCA slot or watchlist entry goes back to "not done yet".
  await q.query(`update dca_schedule set status = 'planned', transaction_id = null, updated_at = now() where transaction_id = $1`, [id])
  await q.query(`update watchlists set status = 'waiting', transaction_id = null, updated_at = now() where transaction_id = $1`, [id])
  const before = await deleteRow<{ id: string; portfolioId: string; securityId: string }>(q, 'transactions', id)
  await assertLedgerValid(q, before.portfolioId, before.securityId)
  await audit(q, userId, 'delete', 'transactions', id, before, null)
}

/** Watchlist -> real holding, only through an explicit, confirmed transaction. */
export async function confirmWatchBought(q: Queryable, userId: string, watchId: string, d: TransactionInput): Promise<{ id: string }> {
  const watch = await mustGet<{ id: string; securityId: string; status: string }>(q, 'watchlists', watchId, 'รายการที่วางแผนซื้อ')
  if (watch.status === 'bought') throw new UserError('รายการนี้ยืนยันซื้อไปแล้ว')
  if (watch.securityId !== d.securityId) throw new UserError('หลักทรัพย์ของธุรกรรมไม่ตรงกับรายการที่วางแผนไว้')
  if (d.type !== 'buy') throw new UserError('การยืนยันซื้อต้องเป็นธุรกรรมประเภทซื้อ')
  const tx = await saveTransaction(q, userId, { ...d, id: undefined }, { source: 'watchlist' })
  const after = await updateRow(q, 'watchlists', watchId, { status: 'bought', transactionId: tx.id })
  await audit(q, userId, 'confirm', 'watchlists', watchId, watch, after)
  return tx
}

// ---------------------------------------------------------------------------
// CSV import with duplicate detection
// ---------------------------------------------------------------------------
export const IMPORT_COLUMNS = ['date', 'type', 'symbol', 'exchange', 'quantity', 'price', 'amount', 'fee', 'fx_rate', 'split_ratio', 'note'] as const

export const IMPORT_TEMPLATE =
  'date,type,symbol,exchange,quantity,price,amount,fee,fx_rate,split_ratio,note\r\n' +
  '2026-01-05,buy,MSFT,NASDAQ,1.5,420.10,,0.99,34.85,,ตัวอย่าง: ซื้อ\r\n' +
  '2026-03-12,dividend,MSFT,NASDAQ,,,1.25,0.19,35.10,,ตัวอย่าง: ปันผล (fee = ภาษีหัก ณ ที่จ่าย)\r\n'

export interface ImportRow {
  line: number
  status: 'new' | 'duplicate' | 'error'
  message: string
  date: string
  type: string
  symbol: string
  exchange: string
  quantity: number | null
  price: number | null
  amount: number | null
  fee: number
  fxRate: number | null
  splitRatio: number | null
  note: string | null
  createsSecurity: boolean
  hash: string
}

export interface ImportPreview {
  rows: ImportRow[]
  counts: { new: number; duplicate: number; error: number }
  missingColumns: string[]
}

const n4 = (v: number | null) => (v === null ? '' : round(v, 6).toString())

/** Identity of a ledger line: the same trade typed twice (or imported twice) hashes the same. */
export function importHash(p: { portfolio: string; date: string; type: string; symbol: string; exchange: string; quantity: number | null; price: number | null; amount: number | null; fee: number; splitRatio: number | null }): string {
  const key = [p.portfolio, p.date, p.type, p.symbol, p.exchange, n4(p.quantity), n4(p.price), p.type === 'buy' || p.type === 'sell' ? '' : n4(p.amount), n4(p.fee), n4(p.splitRatio)].join('|')
  return createHash('sha256').update(key).digest('hex').slice(0, 40)
}

function parseNum(s: string | undefined): number | null | 'bad' {
  if (s === undefined || s.trim() === '') return null
  const n = Number(s.replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : 'bad'
}

export async function previewImport(q: Queryable, d: { csv: string; portfolio: 'main' | 'dca' }): Promise<ImportPreview> {
  const { headers, rows } = parseCsvObjects(d.csv)
  const required = ['date', 'type', 'symbol', 'exchange']
  const missingColumns = required.filter((c) => !headers.includes(c))
  if (missingColumns.length > 0 || rows.length === 0) return { rows: [], counts: { new: 0, duplicate: 0, error: 0 }, missingColumns }
  if (rows.length > 2000) throw new UserError('นำเข้าได้ครั้งละไม่เกิน 2,000 รายการ')

  const ctx = await userContext(q)
  const pid = await portfolioId(q, d.portfolio)
  const secs = (await q.query<Row>('select id, symbol, exchange, currency from securities')).rows.map((r) => camelize<SecurityDb>(r))
  const secByKey = new Map(secs.map((s) => [`${s.symbol}|${s.exchange}`, s]))
  const secById = new Map(secs.map((s) => [s.id, s]))

  const existing = new Set<string>()
  const existingRows = (await q.query<Row>('select security_id, type, trade_date, quantity, price, amount, fee, split_ratio from transactions where portfolio_id = $1', [pid])).rows
  for (const r of existingRows) {
    const t = camelize<{ securityId: string; type: string; tradeDate: string; quantity: number | null; price: number | null; amount: number; fee: number; splitRatio: number | null }>(r)
    const s = secById.get(t.securityId)
    if (s) existing.add(importHash({ portfolio: d.portfolio, date: t.tradeDate, type: t.type, symbol: s.symbol, exchange: s.exchange, quantity: t.quantity, price: t.price, amount: t.amount, fee: t.fee, splitRatio: t.splitRatio }))
  }

  const seen = new Set<string>()
  const out: ImportRow[] = rows.map((r, i) => {
    const line = i + 2
    const type = (r.type ?? '').toLowerCase()
    const symbol = (r.symbol ?? '').toUpperCase()
    const exchange = (r.exchange ?? '').toUpperCase()
    const quantity = parseNum(r.quantity)
    const price = parseNum(r.price)
    const amount = parseNum(r.amount)
    const fee = parseNum(r.fee)
    const fxRate = parseNum(r.fx_rate)
    const splitRatio = parseNum(r.split_ratio)
    const base: ImportRow = {
      line,
      status: 'new',
      message: '',
      date: r.date ?? '',
      type,
      symbol,
      exchange,
      quantity: quantity === 'bad' ? null : quantity,
      price: price === 'bad' ? null : price,
      amount: amount === 'bad' ? null : amount,
      fee: fee === 'bad' || fee === null ? 0 : fee,
      fxRate: fxRate === 'bad' ? null : fxRate,
      splitRatio: splitRatio === 'bad' ? null : splitRatio,
      note: r.note ? r.note.slice(0, 1000) : null,
      createsSecurity: false,
      hash: '',
    }
    const fail = (message: string): ImportRow => ({ ...base, status: 'error', message })

    if ([quantity, price, amount, fee, fxRate, splitRatio].includes('bad')) return fail('มีช่องตัวเลขที่ไม่ใช่ตัวเลข')
    if (!isValidDate(base.date)) return fail('วันที่ต้องเป็นรูปแบบ YYYY-MM-DD')
    if (base.date > ctx.today) return fail('วันที่เป็นวันในอนาคต')
    if (!(TX_TYPES as readonly string[]).includes(type)) return fail(`ประเภทต้องเป็นหนึ่งใน ${TX_TYPES.join(', ')}`)
    if (!/^[A-Z0-9.\-]{1,15}$/.test(symbol)) return fail('Ticker ไม่ถูกต้อง')
    const ex = EXCHANGES[exchange]
    if (!ex) return fail(`ไม่รู้จักตลาด "${exchange}" (รองรับ: ${Object.keys(EXCHANGES).join(', ')})`)
    if (base.fee < 0) return fail('ค่าธรรมเนียมติดลบ')
    if ((type === 'buy' || type === 'sell') && (!(base.quantity! > 0) || base.price === null || base.price < 0)) return fail('ซื้อ/ขาย ต้องมี quantity > 0 และ price')
    if ((type === 'dividend' || type === 'fee') && !(base.amount! > 0)) return fail('ปันผล/ค่าธรรมเนียม ต้องมี amount > 0')
    if (type === 'split' && !(base.splitRatio! > 0)) return fail('แตกหุ้น ต้องมี split_ratio > 0')
    if (type === 'adjustment' && (base.quantity ?? 0) === 0 && (base.amount ?? 0) === 0) return fail('รายการปรับปรุง ต้องมี quantity หรือ amount')
    if (ex.currency !== ctx.baseCurrency && !(base.fxRate! > 0)) return fail(`หลักทรัพย์สกุล ${ex.currency} ต้องมี fx_rate (${ctx.baseCurrency} ต่อ 1 ${ex.currency})`)

    base.createsSecurity = !secByKey.has(`${symbol}|${exchange}`)
    base.hash = importHash({ portfolio: d.portfolio, date: base.date, type, symbol, exchange, quantity: base.quantity, price: base.price, amount: base.amount, fee: base.fee, splitRatio: base.splitRatio })
    if (existing.has(base.hash)) return { ...base, status: 'duplicate', message: 'มีรายการเดียวกันนี้ในพอร์ตอยู่แล้ว' }
    if (seen.has(base.hash)) return { ...base, status: 'duplicate', message: 'ซ้ำกับบรรทัดก่อนหน้าในไฟล์เดียวกัน' }
    seen.add(base.hash)
    if (base.createsSecurity) base.message = 'จะเพิ่มหลักทรัพย์ใหม่ในรายการของคุณ'
    return base
  })

  const counts = { new: 0, duplicate: 0, error: 0 }
  for (const r of out) counts[r.status]++
  return { rows: out, counts, missingColumns }
}

/**
 * Imports the rows that the (re-computed, server-side) preview marks as new.
 * Duplicates are skipped unless `includeDuplicates`. Any invalid row or any
 * resulting impossible ledger aborts the whole import.
 */
export async function commitImport(
  q: Queryable,
  userId: string,
  d: { csv: string; portfolio: 'main' | 'dca'; accountId: string | null; includeDuplicates?: boolean },
): Promise<{ imported: number; skippedDuplicates: number; createdSecurities: string[] }> {
  const preview = await previewImport(q, d)
  if (preview.missingColumns.length > 0) throw new UserError(`ไฟล์ขาดคอลัมน์: ${preview.missingColumns.join(', ')}`)
  if (preview.counts.error > 0) throw new UserError(`มี ${preview.counts.error} บรรทัดที่ผิดพลาด แก้ไขไฟล์ก่อนนำเข้า (บรรทัดแรกที่ผิด: ${preview.rows.find((r) => r.status === 'error')!.line})`)
  const todo = preview.rows.filter((r) => r.status === 'new' || (d.includeDuplicates && r.status === 'duplicate'))
  if (todo.length === 0) throw new UserError('ไม่มีรายการใหม่ให้นำเข้า (ทุกรายการซ้ำกับที่มีอยู่)')

  const created: string[] = []
  const secIds = new Map<string, string>()
  for (const s of (await q.query<Row>('select id, symbol, exchange from securities')).rows) secIds.set(`${s.symbol}|${s.exchange}`, s.id as string)
  // Chronological order so the ledger check sees buys before the sells that depend on them.
  const ordered = [...todo].sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line)
  for (const r of ordered) {
    const k = `${r.symbol}|${r.exchange}`
    let securityId = secIds.get(k)
    if (!securityId) {
      const ex = EXCHANGES[r.exchange]
      const sec = await insertRow<{ id: string }>(q, 'securities', userId, { symbol: r.symbol, exchange: r.exchange, name: r.symbol, currency: ex.currency, category: 'Other', assetType: 'stock' })
      securityId = sec.id
      secIds.set(k, securityId)
      created.push(r.symbol)
    }
    try {
      await saveTransaction(
        q,
        userId,
        {
          portfolio: d.portfolio,
          securityId,
          accountId: r.type === 'split' || r.type === 'adjustment' ? null : d.accountId,
          type: r.type as TxType,
          tradeDate: r.date,
          quantity: r.quantity,
          price: r.price,
          amount: r.amount,
          fee: r.fee,
          splitRatio: r.splitRatio,
          fxRate: r.fxRate,
          note: r.note,
        },
        { source: 'import', importHash: r.hash },
      )
    } catch (e) {
      if (e instanceof UserError) throw new UserError(`บรรทัด ${r.line} (${r.symbol} ${r.date}): ${e.message}`)
      throw e
    }
  }
  await audit(q, userId, 'import', 'transactions', null, null, { portfolio: d.portfolio, imported: todo.length, skippedDuplicates: d.includeDuplicates ? 0 : preview.counts.duplicate, createdSecurities: created })
  return { imported: todo.length, skippedDuplicates: d.includeDuplicates ? 0 : preview.counts.duplicate, createdSecurities: created }
}

export { getRow }
