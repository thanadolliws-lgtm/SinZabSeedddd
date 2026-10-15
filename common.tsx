'use client'

/** Small building blocks shared by several pages. */
import Link from 'next/link'
import { CircleAlert, Info, TriangleAlert } from 'lucide-react'
import type { Alert } from '@/lib/calc/snapshot'
import type { PriceInfo } from '@/lib/calc/portfolio'
import { DATA_TYPE_LABELS, fmtDateTime } from '@/lib/format'
import { Badge, cx } from './ui'

export function AlertList({ alerts, limit }: { alerts: Alert[]; limit?: number }) {
  const shown = limit ? alerts.slice(0, limit) : alerts
  if (alerts.length === 0) return null
  return (
    <ul className="divide-y divide-line">
      {shown.map((a, i) => (
        <li key={`${a.type}-${i}`}>
          <Link href={a.href} className="flex gap-2.5 px-4 py-2.5 hover:bg-surface-2/60">
            <span className="mt-0.5 shrink-0">
              {a.severity === 'danger' ? <CircleAlert size={16} className="text-loss" /> : a.severity === 'warning' ? <TriangleAlert size={16} className="text-warn" /> : <Info size={16} className="text-accent" />}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{a.title}</span>
              <span className="block text-xs text-muted">{a.detail}</span>
            </span>
          </Link>
        </li>
      ))}
      {limit && alerts.length > limit && <li className="px-4 py-2 text-xs text-muted">และอีก {alerts.length - limit} รายการ</li>}
    </ul>
  )
}

/**
 * Shows where a price came from and how old it is. A price that is stale is
 * labelled "Cached" so an old figure is never presented as current.
 */
export function PriceSource({ price, timeZone, compact }: { price: PriceInfo | null; timeZone: string; compact?: boolean }) {
  if (!price) return <Badge tone="neutral">ไม่มีข้อมูลราคา</Badge>
  const meta = price.stale ? DATA_TYPE_LABELS.cached : (DATA_TYPE_LABELS[price.dataType] ?? DATA_TYPE_LABELS.eod)
  const title = `${meta.hint}\nราคา ณ: ${fmtDateTime(price.asOf, timeZone)}\nดึงข้อมูลเมื่อ: ${fmtDateTime(price.fetchedAt, timeZone)}\nแหล่งข้อมูล: ${price.source}`
  return (
    <span className={cx('inline-flex flex-wrap items-center gap-1', compact ? '' : 'text-xs text-muted')} title={title}>
      <Badge tone={meta.tone}>{price.stale ? `${DATA_TYPE_LABELS[price.dataType]?.label ?? price.dataType} · เก่า` : meta.label}</Badge>
      {!compact && <span className="num">{fmtDateTime(price.asOf, timeZone)}</span>}
    </span>
  )
}

export function DefinitionList({ items }: { items: { term: string; detail: string }[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {items.map((i) => (
        <div key={i.term}>
          <dt className="font-medium">{i.term}</dt>
          <dd className="text-xs leading-relaxed text-muted">{i.detail}</dd>
        </div>
      ))}
    </dl>
  )
}
