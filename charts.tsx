'use client'

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { ReactNode } from 'react'
import { fmtCompact, fmtMoney, fmtNum } from '@/lib/format'

/** Distinct in both light and dark themes; never used to mean gain/loss. */
export const PALETTE = ['#3b82f6', '#f59e0b', '#8b5cf6', '#14b8a6', '#ec4899', '#84cc16', '#f97316', '#06b6d4', '#a855f7', '#64748b']

export const SEMANTIC = { gain: 'var(--gain)', loss: 'var(--loss)', warn: 'var(--warn)', accent: 'var(--accent)', neutral: 'var(--neutral)' }

export interface Series {
  key: string
  label: string
  color?: string
  dashed?: boolean
  stack?: string
}

const axis = { stroke: 'var(--line)', tick: { fill: 'var(--muted)', fontSize: 11 }, tickLine: false as const }
const tooltipStyle = { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12, color: 'var(--text)' }

type Fmt = (n: number) => string
const money: Fmt = (n) => fmtMoney(n)

function Frame({ height, children, empty, isEmpty }: { height: number; children: ReactNode; empty?: string; isEmpty: boolean }) {
  if (isEmpty) {
    return (
      <div className="flex items-center justify-center rounded-lg bg-surface-2/50 px-4 text-center text-sm text-muted" style={{ height }}>
        {empty ?? 'ยังไม่มีข้อมูลสำหรับกราฟนี้'}
      </div>
    )
  }
  return (
    <div style={{ height }} className="w-full text-xs">
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  )
}

interface ChartProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any[]
  xKey: string
  series: Series[]
  height?: number
  format?: Fmt
  xFormat?: (v: string) => string
  empty?: string
  /** draw a horizontal reference line (e.g. a target) */
  reference?: { value: number; label: string }
}

const hasData = (data: Record<string, unknown>[], series: Series[]) => data.some((d) => series.some((s) => typeof d[s.key] === 'number'))

export function LineSeriesChart({ data, xKey, series, height = 260, format = money, xFormat, empty, reference }: ChartProps) {
  return (
    <Frame height={height} empty={empty} isEmpty={!hasData(data, series)}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey={xKey} {...axis} tickFormatter={xFormat} minTickGap={24} />
        <YAxis {...axis} axisLine={false} width={56} tickFormatter={fmtCompact} domain={['auto', 'auto']} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => (typeof v === 'number' ? format(v) : String(v))} labelFormatter={(l) => (xFormat ? xFormat(String(l)) : String(l))} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {reference && <ReferenceLine y={reference.value} stroke="var(--warn)" strokeDasharray="5 4" label={{ value: reference.label, fill: 'var(--warn)', fontSize: 11, position: 'insideTopRight' }} />}
        {series.map((s, i) => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color ?? PALETTE[i % PALETTE.length]} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} dot={data.length <= 24} connectNulls={false} isAnimationActive={false} />
        ))}
      </LineChart>
    </Frame>
  )
}

export function AreaSeriesChart({ data, xKey, series, height = 260, format = money, xFormat, empty }: ChartProps) {
  return (
    <Frame height={height} empty={empty} isEmpty={!hasData(data, series)}>
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey={xKey} {...axis} tickFormatter={xFormat} minTickGap={24} />
        <YAxis {...axis} axisLine={false} width={56} tickFormatter={fmtCompact} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => (typeof v === 'number' ? format(v) : String(v))} labelFormatter={(l) => (xFormat ? xFormat(String(l)) : String(l))} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {series.map((s, i) => {
          const c = s.color ?? PALETTE[i % PALETTE.length]
          return <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stackId={s.stack} stroke={c} fill={c} fillOpacity={0.22} strokeWidth={2} isAnimationActive={false} />
        })}
      </AreaChart>
    </Frame>
  )
}

export function BarSeriesChart({ data, xKey, series, height = 260, format = money, xFormat, empty, reference }: ChartProps) {
  return (
    <Frame height={height} empty={empty} isEmpty={!hasData(data, series)}>
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey={xKey} {...axis} tickFormatter={xFormat} minTickGap={12} />
        <YAxis {...axis} axisLine={false} width={56} tickFormatter={fmtCompact} />
        <Tooltip cursor={{ fill: 'var(--surface-2)' }} contentStyle={tooltipStyle} formatter={(v) => (typeof v === 'number' ? format(v) : String(v))} labelFormatter={(l) => (xFormat ? xFormat(String(l)) : String(l))} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {reference && <ReferenceLine y={reference.value} stroke="var(--warn)" strokeDasharray="5 4" label={{ value: reference.label, fill: 'var(--warn)', fontSize: 11, position: 'insideTopRight' }} />}
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId={s.stack} fill={s.color ?? PALETTE[i % PALETTE.length]} radius={s.stack ? 0 : [4, 4, 0, 0]} maxBarSize={38} isAnimationActive={false} />
        ))}
      </BarChart>
    </Frame>
  )
}

export function DonutChart({ data, height = 220, empty, valueFormat = money }: { data: { label: string; value: number }[]; height?: number; empty?: string; valueFormat?: Fmt }) {
  const rows = data.filter((d) => d.value > 0)
  const total = rows.reduce((s, d) => s + d.value, 0)
  if (rows.length === 0 || total <= 0) {
    return (
      <div className="flex items-center justify-center rounded-lg bg-surface-2/50 px-4 text-center text-sm text-muted" style={{ height }}>
        {empty ?? 'ยังไม่มีข้อมูลสำหรับกราฟนี้'}
      </div>
    )
  }
  return (
    <div className="grid items-center gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={rows} dataKey="value" nameKey="label" innerRadius="58%" outerRadius="88%" paddingAngle={1} stroke="var(--surface)" isAnimationActive={false}>
              {rows.map((_, i) => (
                <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => (typeof v === 'number' ? `${valueFormat(v)} (${fmtNum((v / total) * 100, 1)}%)` : String(v))} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="space-y-1.5 text-sm">
        {rows.slice(0, 10).map((d, i) => (
          <li key={d.label} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
              <span className="truncate">{d.label}</span>
            </span>
            <span className="num text-muted">{fmtNum((d.value / total) * 100, 1)}%</span>
          </li>
        ))}
        {rows.length > 10 && <li className="text-xs text-muted">และอีก {rows.length - 10} รายการ</li>}
      </ul>
    </div>
  )
}
