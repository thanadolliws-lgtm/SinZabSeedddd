import type { z } from 'zod'
import type { Queryable } from '@/lib/db'
import { loadRaw } from '@/lib/data/load'
import { audit, type Row } from './core'
import type { settingsSchema } from './schemas'

export async function saveSettings(q: Queryable, userId: string, d: z.output<typeof settingsSchema>): Promise<void> {
  const before = (await q.query<Row>('select * from user_settings')).rows[0] ?? null
  await q.query(
    `update user_settings set theme = $1, timezone = $2, emergency_months = $3, essential_monthly_expense = $4, max_position_pct = $5,
            max_category_pct = $6, allocation_drift_pct = $7, stale_quote_hours = $8, high_interest_rate = $9, due_soon_days = $10,
            disabled_alerts = $11, updated_at = now()`,
    [d.theme, d.timezone, d.emergencyMonths, d.essentialMonthlyExpense, d.maxPositionPct, d.maxCategoryPct, d.allocationDriftPct, d.staleQuoteHours, d.highInterestRate, d.dueSoonDays, JSON.stringify(d.disabledAlerts)],
  )
  await q.query('update profiles set display_name = $1, updated_at = now()', [d.displayName])
  const after = (await q.query<Row>('select * from user_settings')).rows[0] ?? null
  await audit(q, userId, 'update', 'user_settings', userId, before, after)
}

export async function saveTheme(q: Queryable, theme: 'system' | 'light' | 'dark'): Promise<void> {
  await q.query('update user_settings set theme = $1, updated_at = now()', [theme])
}

/** Everything the user owns, as one JSON document (a portable backup). */
export async function exportAll(q: Queryable, email: string): Promise<Record<string, unknown>> {
  const raw = await loadRaw(q)
  const auditLog = (await q.query<Row>('select action, entity, entity_id, before, after, created_at from audit_log order by created_at desc limit 5000')).rows
  const profile = (await q.query<Row>('select display_name, created_at from profiles')).rows[0] ?? null
  return {
    format: 'sinsap-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    account: { email, ...profile },
    ...raw,
    auditLog,
  }
}

export async function loadAuditLog(q: Queryable, limit = 200): Promise<{ action: string; entity: string; entityId: string | null; createdAt: string; before: unknown; after: unknown }[]> {
  const r = await q.query<Row>('select action, entity, entity_id as "entityId", created_at as "createdAt", before, after from audit_log order by created_at desc limit $1', [limit])
  return r.rows as never
}
