'use client'

import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsUpDown, CircleAlert, CircleCheck, Info, LoaderCircle, Search, TriangleAlert, X } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { TONE_BADGE, TONE_TEXT, fmtMoney, fmtPct, fmtSigned, toneOf, type Tone } from '@/lib/format'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Card({ title, subtitle, actions, children, className, pad = true }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    // min-w-0: inside CSS grids a card must be allowed to shrink below its content (tables/tabs scroll inside)
    <section className={cx('min-w-0 rounded-xl border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  )
}

/** A headline figure with its definition available on hover / tap. */
export function Stat({ label, value, sub, tone, hint, className }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; hint?: string; className?: string }) {
  return (
    <div className={cx('min-w-0 rounded-xl border border-line bg-surface p-4', className)}>
      <div className="flex items-center gap-1 text-xs text-muted">
        <span>{label}</span>
        {hint && <Hint text={hint} />}
      </div>
      <div className={cx('num mt-1 text-lg font-semibold', tone && TONE_TEXT[tone])}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  )
}

export function Hint({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative inline-flex">
      <button type="button" aria-label={`คำอธิบาย: ${text}`} title={text} onClick={() => setOpen((o) => !o)} onBlur={() => setOpen(false)} className="text-muted hover:text-text">
        <Info size={13} />
      </button>
      {open && (
        <span role="tooltip" className="absolute left-0 top-5 z-30 w-60 rounded-lg border border-line bg-surface p-2 text-xs font-normal leading-relaxed text-text shadow-lg">
          {text}
        </span>
      )}
    </span>
  )
}

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium', TONE_BADGE[tone])}>
      {children}
    </span>
  )
}

const NOTICE: Record<'info' | 'warning' | 'danger' | 'success', { box: string; icon: ReactNode }> = {
  info: { box: 'border-line bg-accent-soft text-text', icon: <Info size={16} className="text-accent" /> },
  warning: { box: 'border-transparent bg-warn-soft text-text', icon: <TriangleAlert size={16} className="text-warn" /> },
  danger: { box: 'border-transparent bg-loss-soft text-text', icon: <CircleAlert size={16} className="text-loss" /> },
  success: { box: 'border-transparent bg-gain-soft text-text', icon: <CircleCheck size={16} className="text-gain" /> },
}

export function Notice({ tone = 'info', title, children, className }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('flex gap-2 rounded-lg border px-3 py-2 text-sm', NOTICE[tone].box, className)}>
      <span className="mt-0.5 shrink-0">{NOTICE[tone].icon}</span>
      <div className="min-w-0">
        {title && <div className="font-medium">{title}</div>}
        {children && <div className={cx('text-[13px] leading-relaxed', !!title && 'text-muted')}>{children}</div>}
      </div>
    </div>
  )
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-4 py-10 text-center">
      {icon && <div className="mb-3 text-muted">{icon}</div>}
      <div className="font-medium">{title}</div>
      {description && <p className="mt-1 max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/** Coloured profit / loss figure: green up, red down, grey flat or unknown. */
export function PnL({ value, currency = 'THB', pct, className }: { value: number | null | undefined; currency?: string; pct?: number | null; className?: string }) {
  return (
    <span className={cx('num', TONE_TEXT[toneOf(value)], className)}>
      {fmtSigned(value, currency)}
      {pct !== undefined && <span className="ml-1 text-xs">({fmtPct(pct, 2, true)})</span>}
    </span>
  )
}

export function Money({ value, currency = 'THB', className }: { value: number | null | undefined; currency?: string; className?: string }) {
  return <span className={cx('num', className)}>{fmtMoney(value, currency)}</span>
}

export function ProgressBar({ value, max, tone = 'accent' }: { value: number; max: number; tone?: Tone }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  const bar: Record<Tone, string> = { accent: 'bg-accent', gain: 'bg-gain', loss: 'bg-loss', warn: 'bg-warn', neutral: 'bg-neutral' }
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full rounded-full', bar[tone])} style={{ width: `${pct}%` }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Buttons & form controls
// ---------------------------------------------------------------------------
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
const BTN: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:opacity-90',
  secondary: 'border border-line bg-surface text-text hover:bg-surface-2',
  ghost: 'text-muted hover:bg-surface-2 hover:text-text',
  danger: 'bg-loss text-white hover:opacity-90 dark:text-[#2a0707]',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        BTN[variant],
        className,
      )}
    >
      {loading ? <LoaderCircle size={15} className="animate-spin" /> : icon}
      {children}
    </button>
  )
}

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} {...rest} className={cx('inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-text disabled:opacity-40', className)}>
      {children}
    </button>
  )
}

const CONTROL = 'h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-text placeholder:text-muted/70 disabled:bg-surface-2 disabled:text-muted aria-[invalid=true]:border-loss'

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(CONTROL, rest.type === 'number' && 'num', className)} />
}
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(CONTROL, 'pr-7', className)}>
      {children}
    </select>
  )
}
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={2} {...rest} className={cx(CONTROL, 'h-auto py-2', className)} />
}

export function Field({ label, error, hint, required, children, className }: { label: string; error?: string; hint?: ReactNode; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-xs font-medium text-muted">
        {label}
        {required && <span className="text-loss"> *</span>}
      </span>
      {children}
      {error ? <span className="mt-1 block text-xs text-loss">{error}</span> : hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  )
}

export function Checkbox({ label, checked, onChange, hint, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: string; disabled?: boolean }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-line accent-[var(--accent)]" />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; badge?: ReactNode }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx('-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition', value === t.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text')}
        >
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  if (!open) return null
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose()
      }}
      className={cx('m-auto w-[calc(100vw-1.5rem)] rounded-2xl border border-line bg-surface p-0 text-text shadow-2xl', wide ? 'max-w-3xl' : 'max-w-lg')}
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <IconButton label="ปิด" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="overflow-y-auto p-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer>}
      </div>
    </dialog>
  )
}

// ---------------------------------------------------------------------------
// Toasts + confirmation (provided once in the app shell)
// ---------------------------------------------------------------------------
type ToastTone = 'success' | 'error' | 'info'
interface Toast {
  id: number
  tone: ToastTone
  text: string
}
interface ConfirmOptions {
  title: string
  message: ReactNode
  confirmLabel?: string
  danger?: boolean
}
interface Feedback {
  toast: (tone: ToastTone, text: string) => void
  confirm: (o: ConfirmOptions) => Promise<boolean>
}
const FeedbackContext = createContext<Feedback | null>(null)

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [ask, setAsk] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)
  const seq = useRef(0)

  const toast = useCallback((tone: ToastTone, text: string) => {
    const id = ++seq.current
    setToasts((t) => [...t.slice(-3), { id, tone, text }])
    // errors stay longer: they usually need to be read
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 9000 : 4000)
  }, [])
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setAsk({ ...o, resolve })), [])
  const value = useMemo(() => ({ toast, confirm }), [toast, confirm])
  const answer = (v: boolean) => {
    ask?.resolve(v)
    setAsk(null)
  }

  return (
    <FeedbackContext value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex flex-col items-center gap-2 px-3" data-no-print>
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={cx(
              'pointer-events-auto flex max-w-xl items-start gap-2 rounded-xl border px-3.5 py-2.5 text-sm shadow-lg',
              t.tone === 'error' ? 'border-loss bg-loss-soft' : t.tone === 'success' ? 'border-gain bg-gain-soft' : 'border-line bg-surface',
            )}
          >
            <span className="mt-0.5 shrink-0">{t.tone === 'error' ? <CircleAlert size={16} className="text-loss" /> : t.tone === 'success' ? <CircleCheck size={16} className="text-gain" /> : <Info size={16} className="text-accent" />}</span>
            <span className="whitespace-pre-line">{t.text}</span>
            <button type="button" aria-label="ปิดข้อความ" className="ml-1 text-muted hover:text-text" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      <Modal
        open={!!ask}
        onClose={() => answer(false)}
        title={ask?.title ?? ''}
        footer={
          <>
            <Button onClick={() => answer(false)}>ยกเลิก</Button>
            <Button variant={ask?.danger ? 'danger' : 'primary'} onClick={() => answer(true)} autoFocus>
              {ask?.confirmLabel ?? 'ยืนยัน'}
            </Button>
          </>
        }
      >
        <div className="text-sm leading-relaxed">{ask?.message}</div>
      </Modal>
    </FeedbackContext>
  )
}

export function useFeedback(): Feedback {
  const ctx = useContext(FeedbackContext)
  if (!ctx) throw new Error('useFeedback must be used inside <FeedbackProvider>')
  return ctx
}

// ---------------------------------------------------------------------------
// DataTable: search, sort, filter, paginate
// ---------------------------------------------------------------------------
export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  /** value used for sorting; omit to make the column unsortable */
  sort?: (row: T) => number | string | null | undefined
  align?: 'left' | 'right' | 'center'
  className?: string
  title?: string
}

export interface FilterDef<T> {
  key: string
  label: string
  options: { value: string; label: string }[]
  get: (row: T) => string | string[] | null | undefined
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  search,
  searchPlaceholder = 'ค้นหา...',
  filters = [],
  defaultSort,
  pageSize = 25,
  empty,
  toolbar,
  footer,
  rowClassName,
}: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  search?: (row: T) => string
  searchPlaceholder?: string
  filters?: FilterDef<T>[]
  defaultSort?: { key: string; dir: 'asc' | 'desc' }
  pageSize?: number
  empty?: ReactNode
  toolbar?: ReactNode
  footer?: ReactNode
  rowClassName?: (row: T) => string | undefined
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<Record<string, string>>({})
  const [sort, setSort] = useState(defaultSort ?? null)
  const [page, setPage] = useState(0)
  const searchId = useId()

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let out = rows.filter((r) => {
      if (q && search && !search(r).toLowerCase().includes(q)) return false
      for (const f of filters) {
        const want = active[f.key]
        if (!want) continue
        const got = f.get(r)
        if (Array.isArray(got) ? !got.includes(want) : got !== want) return false
      }
      return true
    })
    const col = sort && columns.find((c) => c.key === sort.key)
    if (sort && col?.sort) {
      const get = col.sort
      const dir = sort.dir === 'asc' ? 1 : -1
      out = [...out].sort((a, b) => {
        const x = get(a)
        const y = get(b)
        // rows without a value always sink to the bottom, whichever direction
        if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1
        if (y === null || y === undefined) return -1
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'th')) * dir
      })
    }
    return out
  }, [rows, query, search, filters, active, sort, columns])

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const current = Math.min(page, pages - 1)
  const visible = filtered.slice(current * pageSize, current * pageSize + pageSize)
  const filtering = query.trim() !== '' || Object.values(active).some(Boolean)

  return (
    <div>
      {(search || filters.length > 0 || toolbar) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
          {search && (
            <div className="relative w-full sm:w-56">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-muted" />
              <label htmlFor={searchId} className="sr-only">
                ค้นหา
              </label>
              <Input
                id={searchId}
                value={query}
                placeholder={searchPlaceholder}
                className="pl-8"
                onChange={(e) => {
                  setQuery(e.target.value)
                  setPage(0)
                }}
              />
            </div>
          )}
          {filters.map((f) => (
            <Select
              key={f.key}
              aria-label={f.label}
              value={active[f.key] ?? ''}
              className="w-auto min-w-28"
              onChange={(e) => {
                setActive((a) => ({ ...a, [f.key]: e.target.value }))
                setPage(0)
              }}
            >
              <option value="">{f.label}: ทั้งหมด</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ))}
          {filtering && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setQuery('')
                setActive({})
                setPage(0)
              }}
            >
              ล้างตัวกรอง
            </Button>
          )}
          {toolbar && <div className="ml-auto flex flex-wrap items-center gap-2">{toolbar}</div>}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-2/60 text-xs text-muted">
              {columns.map((c) => {
                const isSorted = sort?.key === c.key
                return (
                  <th key={c.key} scope="col" title={c.title} aria-sort={isSorted ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined} className={cx('px-3 py-2 font-medium', c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left', c.className)}>
                    {c.sort ? (
                      <button
                        type="button"
                        className={cx('inline-flex items-center gap-1 hover:text-text', c.align === 'right' && 'flex-row-reverse')}
                        onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: 'desc' }))}
                      >
                        {c.header}
                        {isSorted ? sort!.dir === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} /> : <ChevronsUpDown size={12} className="opacity-50" />}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={rowKey(r)} className={cx('border-b border-line/70 last:border-0 hover:bg-surface-2/50', rowClassName?.(r))}>
                {columns.map((c) => (
                  <td key={c.key} className={cx('px-3 py-2 align-middle', c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left', c.className)}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {footer && visible.length > 0 && <tfoot className="border-t border-line bg-surface-2/40 text-sm font-medium">{footer}</tfoot>}
        </table>
      </div>
      {filtered.length === 0 && <div className="px-4 py-8 text-center text-sm text-muted">{rows.length === 0 ? (empty ?? 'ยังไม่มีข้อมูล') : 'ไม่พบรายการที่ตรงกับการค้นหาหรือตัวกรอง'}</div>}
      {filtered.length > pageSize && (
        <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs text-muted">
          <span>
            {current * pageSize + 1}-{Math.min(filtered.length, (current + 1) * pageSize)} จาก {filtered.length} รายการ
          </span>
          <span className="flex items-center gap-1">
            <IconButton label="หน้าก่อน" disabled={current === 0} onClick={() => setPage(current - 1)}>
              <ChevronLeft size={16} />
            </IconButton>
            <span>
              หน้า {current + 1}/{pages}
            </span>
            <IconButton label="หน้าถัดไป" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
              <ChevronRight size={16} />
            </IconButton>
          </span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Skeletons (Suspense fallbacks)
// ---------------------------------------------------------------------------
export function PageSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <div aria-busy="true" aria-label="กำลังโหลดข้อมูล">
      <div className="skeleton mb-5 h-7 w-56" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="skeleton h-20" />
        ))}
      </div>
      <div className="skeleton mt-4 h-72" />
      <div className="skeleton mt-4 h-48" />
    </div>
  )
}
