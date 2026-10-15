'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from 'react'
import { BriefcaseBusiness, CalendarClock, ChartCandlestick, History, LayoutDashboard, Lightbulb, Menu, Monitor, Moon, RefreshCw, Settings, Sun, TrendingUp, Wallet, X } from 'lucide-react'
import { refreshMarketAction, type MarketRefreshResult } from '@/actions/market'
import { saveThemeAction } from '@/actions/app'
import { fmtAgo } from '@/lib/format'
import { IconButton, cx, useFeedback } from './ui'

export const NAV = [
  { href: '/overview', label: 'ภาพรวม', en: 'Overview', icon: LayoutDashboard },
  { href: '/market', label: 'ตลาดหุ้น', en: 'Market', icon: ChartCandlestick },
  { href: '/portfolio', label: 'พอร์ตหุ้นที่ถือจริง', en: 'My Portfolio', icon: BriefcaseBusiness },
  { href: '/dca', label: 'พอร์ต DCA', en: 'DCA Portfolio', icon: CalendarClock },
  { href: '/money', label: 'บริหารเงิน', en: 'Money Management', icon: Wallet },
  { href: '/simulator', label: 'จำลองการเติบโต', en: 'Growth Simulator', icon: TrendingUp },
  { href: '/analysis', label: 'วิเคราะห์และแนะนำ', en: 'Analysis', icon: Lightbulb },
  { href: '/history', label: 'ประวัติธุรกรรม', en: 'Transaction History', icon: History },
  { href: '/settings', label: 'ตั้งค่า', en: 'Settings', icon: Settings },
] as const

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname()
  return (
    <nav aria-label="เมนูหลัก" className="space-y-0.5">
      {NAV.map(({ href, label, en, icon: Icon }) => {
        const active = path === href || path.startsWith(`${href}/`)
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cx('flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition', active ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-surface-2 hover:text-text')}
          >
            <Icon size={17} className="shrink-0" />
            <span className="min-w-0">
              <span className="block truncate">{label}</span>
              <span className="block truncate text-[10.5px] opacity-70">{en}</span>
            </span>
          </Link>
        )
      })}
    </nav>
  )
}

function Brand() {
  return (
    <Link href="/overview" className="flex items-center gap-2 px-3 py-1">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-sm font-bold text-on-accent">S</span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold">Sinsap</span>
        <span className="block text-[11px] text-muted">การเงินและการลงทุน</span>
      </span>
    </Link>
  )
}

export function Sidebar() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-surface p-3 lg:flex">
        <Brand />
        <NavLinks />
      </aside>
      <div className="lg:hidden">
        <IconButton label="เปิดเมนู" onClick={() => setOpen(true)} className="fixed left-2 top-2 z-40 h-10 w-10 border border-line bg-surface">
          <Menu size={20} />
        </IconButton>
        {open && (
          <div className="fixed inset-0 z-50 flex">
            <button type="button" aria-label="ปิดเมนู" className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
            <aside className="relative flex h-full w-72 max-w-[85vw] flex-col gap-4 overflow-y-auto bg-surface p-3 shadow-xl">
              <div className="flex items-center justify-between">
                <Brand />
                <IconButton label="ปิดเมนู" onClick={() => setOpen(false)}>
                  <X size={18} />
                </IconButton>
              </div>
              <NavLinks onNavigate={() => setOpen(false)} />
            </aside>
          </div>
        )}
      </div>
    </>
  )
}

type Theme = 'system' | 'light' | 'dark'

function applyTheme(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

function readTheme(): Theme {
  try {
    return (localStorage.getItem('theme') as Theme) || 'system'
  } catch {
    return 'system'
  }
}

function subscribeTheme(onChange: () => void) {
  window.addEventListener('storage', onChange)
  window.addEventListener('themechange', onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener('themechange', onChange)
  }
}

export function ThemeToggle() {
  // localStorage is the source; the server always renders 'system' to avoid a hydration mismatch
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => 'system' as Theme)
  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' }
  const label: Record<Theme, string> = { system: 'ธีม: ตามระบบ', light: 'ธีม: สว่าง', dark: 'ธีม: มืด' }
  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor
  return (
    <IconButton
      label={`${label[theme]} (คลิกเพื่อเปลี่ยน)`}
      onClick={() => {
        const t = next[theme]
        try {
          localStorage.setItem('theme', t)
        } catch {}
        applyTheme(t)
        window.dispatchEvent(new Event('themechange'))
        void saveThemeAction({ theme: t })
      }}
    >
      <Icon size={17} />
    </IconButton>
  )
}

/** Applies the theme saved in the user's settings on a device that has no local choice yet. */
export function ThemeSync({ theme }: { theme: Theme }) {
  useEffect(() => {
    try {
      if (!localStorage.getItem('theme')) {
        localStorage.setItem('theme', theme)
        applyTheme(theme)
      }
    } catch {}
  }, [theme])
  return null
}

const AUTO_REFRESH_MS = 10 * 60_000

/**
 * Keeps market data current without blocking pages: pages render from the
 * cache immediately; this asks the server to refresh what is due, then
 * re-renders if anything changed. The server decides what is actually due.
 */
export function MarketRefresher() {
  const router = useRouter()
  const { toast } = useFeedback()
  const [last, setLast] = useState<MarketRefreshResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [, startTransition] = useTransition()
  const started = useRef(false)

  const refresh = async (manual: boolean) => {
    setBusy(true)
    try {
      const res = await refreshMarketAction({ force: false })
      if (!res.ok) {
        if (manual) toast('error', res.error)
        return
      }
      setLast(res.data)
      try {
        sessionStorage.setItem('marketRefreshAt', String(Date.now()))
      } catch {}
      const d = res.data
      if (d.refreshed.length > 0 || d.fxRefreshed.length > 0 || d.historyUpdated > 0) startTransition(() => router.refresh())
      if (manual) {
        const parts = [
          d.refreshed.length > 0 ? `อัปเดตราคา ${d.refreshed.length} รายการ` : d.alreadyFresh > 0 ? 'ราคาเป็นข้อมูลล่าสุดแล้ว' : null,
          d.skippedQuota.length > 0 ? `ข้ามเพราะโควตา API: ${d.skippedQuota.join(', ')}` : null,
          d.noProvider.length > 0 ? `ยังไม่ได้ตั้งค่า API ตลาด${d.noProvider.join(', ')}` : null,
          ...d.errors.slice(0, 3).map((e) => `${e.symbol}: ${e.message}`),
          ...d.fxErrors.slice(0, 2),
        ].filter(Boolean)
        toast(d.errors.length > 0 || d.fxErrors.length > 0 ? 'error' : 'info', parts.join('\n') || 'ไม่มีรายการที่ต้องอัปเดต')
      }
    } catch {
      if (manual) toast('error', 'ติดต่อเซิร์ฟเวอร์ไม่ได้ ราคายังเป็นข้อมูลล่าสุดที่เก็บไว้')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    let lastAt = 0
    try {
      lastAt = Number(sessionStorage.getItem('marketRefreshAt') ?? 0)
    } catch {}
    if (Date.now() - lastAt > AUTO_REFRESH_MS) void refresh(false)
    const timer = setInterval(() => void refresh(false), AUTO_REFRESH_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <button
      type="button"
      onClick={() => void refresh(true)}
      disabled={busy}
      title="อัปเดตราคาและอัตราแลกเปลี่ยน (เฉพาะรายการที่ถึงเวลาอัปเดต ตามโควตา API)"
      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-text disabled:opacity-60"
    >
      <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
      <span className="hidden sm:inline">{busy ? 'กำลังอัปเดตราคา...' : last ? `อัปเดตราคา ${fmtAgo(last.at)}` : 'อัปเดตราคา'}</span>
    </button>
  )
}
