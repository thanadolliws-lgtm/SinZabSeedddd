/**
 * Assembles everything a page needs for one user: database rows + cached
 * market data -> the central Snapshot. Framework-free so tests can call it.
 *
 * Rendering NEVER calls a market-data provider: it reads the cached quotes.
 * Refreshing is a separate, rate-limited step (see actions/market.ts).
 */
import { withUser } from '@/lib/db'
import { todayInTz } from '@/lib/calc/money'
import type { PriceInfo } from '@/lib/calc/portfolio'
import { buildSnapshot, type Alert, type Snapshot } from '@/lib/calc/snapshot'
import type { FxRateInfo, RawData } from '@/lib/calc/types'
import { MARKET_LABELS, marketOf, type MarketCode } from '@/lib/market/exchanges'
import { getLatestRates, monthEndRates } from '@/lib/market/fx'
import { getStoredQuotes, marketDataStatus, monthEndCloses, resolvePrice, type ProviderStatus, type StoredQuote } from '@/lib/market/service'
import { loadRaw, loadSettings, materializeRecurring } from './load'

export interface AppData {
  raw: RawData
  snapshot: Snapshot
  /** provider quote per security id (null when the provider never returned one) */
  quotes: Record<string, StoredQuote | null>
  providers: ProviderStatus[]
  fx: Record<string, FxRateInfo & { fetchedAt: string }>
  generatedAt: string
}

export async function buildAppData(userId: string, now: Date = new Date()): Promise<AppData> {
  const raw = await withUser(userId, async (q) => {
    const settings = await loadSettings(q)
    await materializeRecurring(q, userId, todayInTz(settings.timezone, now))
    return loadRaw(q)
  })
  const today = todayInTz(raw.settings.timezone, now)
  const base = raw.settings.baseCurrency

  const refs = raw.securities.map((s) => ({ symbol: s.symbol, exchange: s.exchange }))
  const stored = await getStoredQuotes(refs)
  const prices = new Map<string, PriceInfo>()
  const quotes: Record<string, StoredQuote | null> = {}
  for (const s of raw.securities) {
    const q = stored.get(`${s.exchange}:${s.symbol}`)
    quotes[s.id] = q ?? null
    const p = resolvePrice(q, { price: s.manualPrice, at: s.manualPriceAt }, raw.settings.staleQuoteHours, now)
    if (p) prices.set(s.id, p)
  }

  const currencies = [...new Set([...raw.securities.map((s) => s.currency), ...raw.accounts.map((a) => a.currency), ...raw.dcaPlans.map((p) => p.budgetCurrency)])]
  const fx = await getLatestRates(currencies, base)

  const tradedIds = new Set(raw.transactions.map((t) => t.securityId))
  const traded = raw.securities.filter((s) => tradedIds.has(s.id))
  const closes = await monthEndCloses(traded.map((s) => ({ symbol: s.symbol, exchange: s.exchange })))
  const monthEndPrices = new Map<string, Record<string, number>>()
  for (const s of traded) {
    const c = closes.get(`${s.exchange}:${s.symbol}`)
    if (c) monthEndPrices.set(s.id, c)
  }
  const monthEndFx = await monthEndRates(currencies, base)

  const snapshot = buildSnapshot(raw, { prices, fx, monthEndPrices, monthEndFx }, today)

  const providers = await marketDataStatus()
  const disabled = new Set(raw.settings.disabledAlerts)
  if (!disabled.has('market_api')) snapshot.alerts.push(...marketAlerts(raw, providers))

  return { raw, snapshot, quotes, providers, fx, generatedAt: now.toISOString() }
}

function marketAlerts(raw: RawData, providers: ProviderStatus[]): Alert[] {
  const out: Alert[] = []
  const marketsInUse = new Set<MarketCode>()
  for (const s of raw.securities) {
    const m = marketOf(s.exchange)
    if (m && !s.isArchived) marketsInUse.add(m)
  }
  for (const p of providers) {
    if (!marketsInUse.has(p.market)) continue
    if (!p.configured) {
      out.push({
        type: 'market_api',
        severity: 'info',
        title: `ยังไม่ได้ตั้งค่า Market Data API สำหรับตลาด${MARKET_LABELS[p.market]}`,
        detail: 'ระบบจะไม่ดึงราคาอัตโนมัติ: ใช้ได้เฉพาะราคาที่บันทึกเอง ดูวิธีตั้งค่าในหน้า Settings',
        href: '/settings',
      })
    } else if (p.lastError) {
      out.push({
        type: 'market_api',
        severity: 'warning',
        title: `ดึงข้อมูลตลาด${MARKET_LABELS[p.market]}ล่าสุดไม่สำเร็จ`,
        detail: `${p.lastError.message}: ราคาที่แสดงเป็นข้อมูลที่เก็บไว้ (Cached) ตามเวลาที่ระบุข้างราคา`,
        href: '/market',
      })
    }
  }
  return out
}
