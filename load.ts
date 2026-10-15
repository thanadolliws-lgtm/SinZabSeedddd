/**
 * Loads every row the calculation engine needs for one user.
 * Must be called inside withUser(): RLS, not a WHERE clause, scopes the rows.
 * (No framework imports: usable from tests and scripts.)
 */
import type { Queryable } from '@/lib/db'
import { addDays, addMonths, daysInMonth, monthEnd, monthOf } from '@/lib/calc/money'
import { DEFAULT_SETTINGS, type RawData, type RecurringRow, type SettingsRow } from '@/lib/calc/types'

const snakeToCamel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())

export function camelize<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[snakeToCamel(k)] = v
  return out as T
}

async function rows<T>(q: Queryable, sql: string, params?: unknown[]): Promise<T[]> {
  return (await q.query<Record<string, unknown>>(sql, params)).rows.map((r) => camelize<T>(r))
}

export async function loadSettings(q: Queryable): Promise<SettingsRow> {
  const r = await rows<SettingsRow>(
    q,
    `select base_currency, timezone, theme, emergency_months, essential_monthly_expense, max_position_pct, max_category_pct,
            allocation_drift_pct, stale_quote_hours, high_interest_rate, due_soon_days, disabled_alerts from user_settings`,
  )
  return r[0] ? { ...DEFAULT_SETTINGS, ...r[0], disabledAlerts: Array.isArray(r[0].disabledAlerts) ? r[0].disabledAlerts : [] } : DEFAULT_SETTINGS
}

export async function loadRaw(q: Queryable): Promise<RawData> {
  const settings = await loadSettings(q)
  return {
    settings,
    accounts: await rows(q, `select id, name, type, purpose, goal_id, currency, opening_balance, opening_date, is_archived, note from accounts order by is_archived, created_at`),
    securities: await rows(q, `select id, symbol, exchange, name, asset_type, category, asset_group, currency, manual_price, manual_price_at, note, is_archived from securities order by symbol`),
    portfolios: await rows(q, `select id, name, kind from portfolios order by kind desc`),
    transactions: await rows(
      q,
      `select id, portfolio_id, security_id, account_id, type, trade_date, created_at, quantity, price, amount, fee, split_ratio, currency, fx_rate, source, note
         from transactions order by trade_date, created_at, id`,
    ),
    watchlist: await rows(q, `select id, security_id, target_price, budget, planned_quantity, reason, planned_date, priority, status, transaction_id, created_at from watchlists order by created_at desc`),
    dcaPlans: await rows(
      q,
      `select id, name, portfolio_id, budget_amount, budget_currency, frequency, invest_day, days_per_month, start_date, duration_months,
              risk_level, objective, min_investment, fee_pct, fee_min, allow_fractional, status, note from dca_plans order by created_at`,
    ),
    dcaAllocations: await rows(q, `select id, plan_id, security_id, target_pct from dca_allocations order by target_pct desc`),
    dcaSchedule: await rows(q, `select id, plan_id, security_id, planned_date, planned_amount, currency, status, transaction_id, note from dca_schedule order by planned_date, security_id`),
    incomes: await rows(q, `select id, account_id, income_date as date, type, source, amount, status, note from income_records order by income_date desc, created_at desc`),
    expenses: await rows(
      q,
      `select id, account_id, recurring_id, expense_date as date, paid_date, category, description, amount, frequency, is_essential, status, note
         from expense_records order by expense_date desc, created_at desc`,
    ),
    recurring: await rows(q, `select id, account_id, name, category, amount, frequency, next_due_date, end_date, is_essential, is_active from recurring_expenses order by created_at`),
    liabilities: await rows(q, `select id, name, kind, opening_balance, opening_date, annual_rate, min_payment, due_day, target_payment, status, note from liabilities order by status, created_at`),
    debtEvents: await rows(q, `select id, liability_id, account_id, kind, pay_date as date, amount, interest_amount, fee_amount, note from debt_payments order by pay_date, created_at`),
    transfers: await rows(q, `select id, from_account_id, to_account_id, transfer_date as date, amount_from, amount_to, fee, kind, note from transfers order by transfer_date desc, created_at desc`),
    goals: await rows(q, `select id, name, target_amount, target_date, monthly_contribution, status, note from savings_goals order by created_at`),
    budgets: await rows(q, `select id, month, category, amount from monthly_budgets order by month desc, category`),
    allocationPlans: await rows(q, `select id, month, basis, basis_amount, items, status, confirmed_at from allocation_plans order by month desc`),
  }
}

// ---------------------------------------------------------------------------
// Recurring expenses -> concrete unpaid bills
// ---------------------------------------------------------------------------
export function nextOccurrence(date: string, frequency: RecurringRow['frequency']): string {
  switch (frequency) {
    case 'daily':
      return addDays(date, 1)
    case 'weekly':
      return addDays(date, 7)
    case 'monthly': {
      const m = addMonths(monthOf(date), 1)
      const day = Math.min(Number(date.slice(8, 10)), daysInMonth(m))
      return `${m}-${String(day).padStart(2, '0')}`
    }
    case 'yearly': {
      const y = Number(date.slice(0, 4)) + 1
      const m = `${y}-${date.slice(5, 7)}`
      const day = Math.min(Number(date.slice(8, 10)), daysInMonth(m))
      return `${m}-${String(day).padStart(2, '0')}`
    }
  }
}

/**
 * Turns active recurring expenses into unpaid expense rows up to the end of the
 * current month (daily items: up to today). Idempotent: (recurring_id, expense_date) is unique, so running it
 * twice never duplicates a bill. Returns how many bills were created.
 */
export async function materializeRecurring(q: Queryable, userId: string, today: string): Promise<number> {
  const monthHorizon = monthEnd(monthOf(today))
  const due = await rows<RecurringRow>(
    q,
    `select id, account_id, name, category, amount, frequency, next_due_date, end_date, is_essential, is_active
       from recurring_expenses where is_active and next_due_date <= $1`,
    [monthHorizon],
  )
  let created = 0
  for (const r of due) {
    const horizon = r.frequency === 'daily' ? today : monthHorizon
    let date = r.nextDueDate
    // a "monthly on the 31st" series keeps aiming at the 31st after a short month
    const anchorDay = Number(r.nextDueDate.slice(8, 10))
    let guard = 0
    while (date <= horizon && (!r.endDate || date <= r.endDate) && guard++ < 800) {
      const ins = await q.query(
        `insert into expense_records (user_id, account_id, recurring_id, expense_date, category, description, amount, frequency, is_essential, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'unpaid') on conflict (recurring_id, expense_date) do nothing`,
        [userId, r.accountId, r.id, date, r.category, r.name, r.amount, r.frequency, r.isEssential],
      )
      created += ins.rowCount
      date = nextOccurrence(date, r.frequency)
      if (r.frequency === 'monthly' || r.frequency === 'yearly') {
        const m = monthOf(date)
        date = `${m}-${String(Math.min(anchorDay, daysInMonth(m))).padStart(2, '0')}`
      }
    }
    const ended = !!r.endDate && date > r.endDate
    await q.query('update recurring_expenses set next_due_date = $1, is_active = $2, updated_at = now() where id = $3', [date, !ended, r.id])
  }
  return created
}
