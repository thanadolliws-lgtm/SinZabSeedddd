'use server'

/**
 * Market-data actions. Provider calls happen only here, on the server, behind
 * the cache and the rate limiter. They report what really happened (refreshed,
 * skipped for quota, failed) so the UI never implies data is fresher than it is.
 */
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth/session'
import { buildPositions } from '@/lib/calc/portfolio'
import { loadRaw } from '@/lib/data/load'
import { withUser } from '@/lib/db'
import { marketOf, MARKET_LABELS, type MarketCode } from '@/lib/market/exchanges'
import { ensureFxHistory, getRateOn, refreshFx } from '@/lib/market/fx'
import { providerFor, type ProviderBar, type ProviderFundamentals, type ProviderSearchResult } from '@/lib/market/providers'
import { ensureHistory, getFundamentals, getHistory, historyMeta, refreshQuotes, searchSymbols } from '@/lib/market/service'
import { zDate, zId } from '@/lib/services/schemas'
import type { ActionResult } from './types'

const unauth = { ok: false as const, error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', code: 'unauthenticated' as const }

export interface MarketRefreshResult {
  refreshed: string[]
  alreadyFresh: number
  skippedQuota: string[]
  errors: { symbol: string; message: string }[]
  noProvider: string[]
  fxRefreshed: string[]
  fxErrors: string[]
  historyUpdated: number
  at: string
}

/**
 * Refresh quotes (held securities first), FX rates and, budget permitting,
 * daily history for held securities. Safe to call often: anything still fresh
 * costs no API call.
 */
export async function refreshMarketAction(input: { force?: boolean } = {}): Promise<ActionResult<MarketRefreshResult>> {
  const user = await getCurrentUser()
  if (!user) return unauth
  const force = input?.force === true
  try {
    const raw = await withUser(user.id, loadRaw)
    const base = raw.settings.baseCurrency
    const held = new Set([...buildPositions(raw.transactions).values()].filter((p) => p.quantity > 0).map((p) => p.securityId))
    const planned = new Set([...raw.dcaAllocations.map((a) => a.securityId), ...raw.watchlist.filter((w) => w.status !== 'cancelled').map((w) => w.securityId)])
    const rank = (id: string) => (held.has(id) ? 0 : planned.has(id) ? 1 : 2)
    const secs = raw.securities.filter((s) => !s.isArchived).sort((a, b) => rank(a.id) - rank(b.id) || a.symbol.localeCompare(b.symbol))

    const report = await refreshQuotes(secs.map((s) => ({ symbol: s.symbol, exchange: s.exchange })), { force })

    const currencies = [...new Set([...raw.securities.map((s) => s.currency), ...raw.accounts.map((a) => a.currency), ...raw.dcaPlans.map((p) => p.budgetCurrency)])]
    const fx = await refreshFx(currencies, base, { force })
    const firstTrade = raw.transactions.map((t) => t.tradeDate).sort()[0]
    if (firstTrade) for (const c of currencies) await ensureFxHistory(c, base, firstTrade)

    // History feeds the value-over-time chart; spend at most a few calls per refresh on it.
    let historyUpdated = 0
    let attempts = 0
    for (const s of secs.filter((x) => held.has(x.id))) {
      if (attempts >= 3) break
      const m = marketOf(s.exchange)
      if (!m || !providerFor(m)) continue
      const meta = await historyMeta({ symbol: s.symbol, exchange: s.exchange })
      if (meta && Date.now() - Date.parse(meta.fetchedAt) < 20 * 3_600_000) continue
      attempts++
      const r = await ensureHistory({ symbol: s.symbol, exchange: s.exchange })
      if (r.updated) historyUpdated++
    }

    revalidatePath('/', 'layout')
    return {
      ok: true,
      data: {
        refreshed: report.refreshed,
        alreadyFresh: report.alreadyFresh,
        skippedQuota: report.skippedQuota,
        errors: report.errors.map((e) => ({ symbol: e.symbol, message: e.message })),
        noProvider: report.noProvider.map((m: MarketCode) => MARKET_LABELS[m]),
        fxRefreshed: fx.refreshed,
        fxErrors: fx.errors.map((e) => e.message),
        historyUpdated,
        at: new Date().toISOString(),
      },
    }
  } catch (e) {
    console.error('[market] refresh failed:', e)
    return { ok: false, error: 'อัปเดตข้อมูลตลาดไม่สำเร็จ ระบบยังแสดงข้อมูลล่าสุดที่เก็บไว้' }
  }
}

export interface HistoryResult {
  bars: ProviderBar[]
  fetchedAt: string | null
  source: string | null
  /** why fresh data could not be fetched, if it could not */
  notice: string | null
}

const historySchema = z.object({ securityId: zId })

export async function loadHistoryAction(input: z.input<typeof historySchema>): Promise<ActionResult<HistoryResult>> {
  const user = await getCurrentUser()
  if (!user) return unauth
  const parsed = historySchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'คำขอไม่ถูกต้อง' }
  const sec = await withUser(user.id, async (q) => (await q.query<{ symbol: string; exchange: string }>('select symbol, exchange from securities where id = $1', [parsed.data.securityId])).rows[0])
  if (!sec) return { ok: false, error: 'ไม่พบหลักทรัพย์' }
  const ensured = await ensureHistory(sec)
  const bars = await getHistory(sec)
  const meta = await historyMeta(sec)
  return { ok: true, data: { bars, fetchedAt: meta?.fetchedAt ?? null, source: meta?.source ?? null, notice: ensured.error ?? null } }
}

const searchSchema = z.object({ query: z.string().trim().min(1).max(40) })

export async function searchSymbolsAction(input: z.input<typeof searchSchema>): Promise<ActionResult<{ results: ProviderSearchResult[]; provider: string | null }>> {
  const user = await getCurrentUser()
  if (!user) return unauth
  const parsed = searchSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'กรอกคำค้นหา 1-40 ตัวอักษร' }
  try {
    return { ok: true, data: await searchSymbols(parsed.data.query) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

const fxSchema = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), date: zDate })

/** Reference rate for pre-filling a form. The user can (and should) overwrite it with the rate they actually got. */
export async function lookupFxRateAction(input: z.input<typeof fxSchema>): Promise<ActionResult<{ rate: number; date: string; source: string } | null>> {
  const user = await getCurrentUser()
  if (!user) return unauth
  const parsed = fxSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'คำขอไม่ถูกต้อง' }
  const base = await withUser(user.id, async (q) => (await q.query<{ base_currency: string }>('select base_currency from user_settings')).rows[0]?.base_currency ?? 'THB')
  try {
    return { ok: true, data: await getRateOn(parsed.data.currency, base, parsed.data.date) }
  } catch {
    return { ok: true, data: null }
  }
}

export async function loadFundamentalsAction(input: z.input<typeof historySchema>): Promise<ActionResult<{ data: ProviderFundamentals | null; fetchedAt: string | null; source: string | null; notice: string | null }>> {
  const user = await getCurrentUser()
  if (!user) return unauth
  const parsed = historySchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'คำขอไม่ถูกต้อง' }
  const sec = await withUser(user.id, async (q) => (await q.query<{ symbol: string; exchange: string }>('select symbol, exchange from securities where id = $1', [parsed.data.securityId])).rows[0])
  if (!sec) return { ok: false, error: 'ไม่พบหลักทรัพย์' }
  return { ok: true, data: await getFundamentals(sec) }
}
