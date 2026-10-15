/**
 * Accounts, transfers, income, expenses, liabilities, goals, budgets and the
 * monthly allocation plan. Income, expenses and debt are recorded in the base
 * currency, so the account they touch must be a base-currency account.
 */
import type { z } from 'zod'
import type { Queryable } from '@/lib/db'
import { allocationAuto, allocationBasis, computeAllocation } from '@/lib/calc/allocation'
import { roundCash, todayInTz } from '@/lib/calc/money'
import type { Snapshot } from '@/lib/calc/snapshot'
import { UserError, audit, mustGet, removeRow, saveRow, updateRow, type Row } from './core'
import type {
  accountSchema,
  allocationPlanSchema,
  budgetSchema,
  debtPaymentSchema,
  expensePaidSchema,
  expenseSchema,
  goalSchema,
  incomeReceivedSchema,
  incomeSchema,
  liabilitySchema,
  recurringSchema,
  transferSchema,
} from './schemas'

interface AccountDb {
  id: string
  name: string
  type: string
  currency: string
  purpose: string
}

async function ctx(q: Queryable): Promise<{ baseCurrency: string; today: string }> {
  const r = await q.query<{ base_currency: string; timezone: string }>('select base_currency, timezone from user_settings')
  const s = r.rows[0] ?? { base_currency: 'THB', timezone: 'Asia/Bangkok' }
  return { baseCurrency: s.base_currency, today: todayInTz(s.timezone) }
}

/** Income / expense / debt payments are in the base currency: the linked account must be too, and must hold cash. */
async function assertBaseCashAccount(q: Queryable, accountId: string | null, baseCurrency: string): Promise<void> {
  if (!accountId) return
  const a = await mustGet<AccountDb>(q, 'accounts', accountId, 'บัญชี')
  if (a.type === 'other_asset') throw new UserError('บัญชีประเภททรัพย์สินอื่นใช้รับ/จ่ายเงินไม่ได้', { accountId: 'เลือกบัญชีเงินสดหรือธนาคาร' })
  if (a.currency !== baseCurrency) throw new UserError(`รายการนี้บันทึกเป็น ${baseCurrency} จึงต้องใช้บัญชีสกุล ${baseCurrency} (บัญชี "${a.name}" เป็น ${a.currency})`, { accountId: 'สกุลเงินไม่ตรง' })
}

// ---- accounts ---------------------------------------------------------------
export async function saveAccount(q: Queryable, userId: string, d: z.output<typeof accountSchema>) {
  const { id, ...data } = d
  if (data.purpose === 'goal' && !data.goalId) throw new UserError('บัญชีที่กันไว้สำหรับเป้าหมายต้องเลือกเป้าหมายการออม', { goalId: 'กรุณาเลือกเป้าหมาย' })
  if (data.purpose !== 'goal') data.goalId = null
  if (data.type === 'other_asset') data.purpose = 'general'
  if (data.type !== 'other_asset' && data.openingBalance < 0) throw new UserError('ยอดยกมาของบัญชีเงินสดต้องไม่ติดลบ (หนี้ให้บันทึกในส่วนหนี้สิน)', { openingBalance: 'ต้องไม่ติดลบ' })
  if (id) {
    const before = await mustGet<AccountDb>(q, 'accounts', id, 'บัญชี')
    if (before.currency !== data.currency) {
      const used = await q.query(
        `select 1 from transfers where from_account_id = $1 or to_account_id = $1
         union all select 1 from transactions where account_id = $1
         union all select 1 from income_records where account_id = $1
         union all select 1 from expense_records where account_id = $1
         union all select 1 from debt_payments where account_id = $1 limit 1`,
        [id],
      )
      if (used.rows.length > 0) throw new UserError('บัญชีนี้มีรายการแล้ว จึงเปลี่ยนสกุลเงินไม่ได้', { currency: 'เปลี่ยนไม่ได้' })
    }
  }
  return saveRow<{ id: string }>(q, userId, 'accounts', id, data)
}

export async function deleteAccount(q: Queryable, userId: string, id: string) {
  // Foreign keys refuse the delete while any record still names the account.
  return removeRow(q, userId, 'accounts', id)
}

export async function saveTransfer(q: Queryable, userId: string, d: z.output<typeof transferSchema>) {
  const { id, date, idempotencyKey, ...rest } = d
  const { today } = await ctx(q)
  if (date > today) throw new UserError('วันที่โอนต้องไม่เป็นวันในอนาคต', { date: 'ต้องไม่เป็นวันในอนาคต' })
  const from = await mustGet<AccountDb>(q, 'accounts', d.fromAccountId, 'บัญชีต้นทาง')
  const to = await mustGet<AccountDb>(q, 'accounts', d.toAccountId, 'บัญชีปลายทาง')
  if (from.type === 'other_asset' || to.type === 'other_asset') throw new UserError('โอนเงินได้เฉพาะระหว่างบัญชีเงินสด ธนาคาร และโบรกเกอร์')
  let amountTo = rest.amountTo
  if (from.currency === to.currency) amountTo = rest.amountFrom
  else if (amountTo === null) throw new UserError(`บัญชีต่างสกุลเงิน (${from.currency} → ${to.currency}): กรุณากรอกจำนวนเงินที่ได้รับจริง`, { amountTo: 'จำเป็นต้องกรอก' })
  const data: Row = { ...rest, amountTo, transferDate: date }
  if (!id) data.idempotencyKey = idempotencyKey ?? null
  return saveRow<{ id: string }>(q, userId, 'transfers', id, data)
}

export const deleteTransfer = (q: Queryable, userId: string, id: string) => removeRow(q, userId, 'transfers', id)

// ---- income -----------------------------------------------------------------
export async function saveIncome(q: Queryable, userId: string, d: z.output<typeof incomeSchema>) {
  const { id, date, idempotencyKey, ...rest } = d
  const c = await ctx(q)
  if (rest.status === 'received' && date > c.today) throw new UserError('รายรับที่ "ได้รับจริง" ต้องไม่เป็นวันในอนาคต ให้ใช้สถานะ "คาดว่าจะได้รับ"', { date: 'ต้องไม่เป็นวันในอนาคต' })
  await assertBaseCashAccount(q, rest.accountId, c.baseCurrency)
  const data: Row = { ...rest, incomeDate: date }
  if (!id) data.idempotencyKey = idempotencyKey ?? null
  return saveRow<{ id: string }>(q, userId, 'income_records', id, data)
}

export const deleteIncome = (q: Queryable, userId: string, id: string) => removeRow(q, userId, 'income_records', id)

export async function setIncomeReceived(q: Queryable, userId: string, d: z.output<typeof incomeReceivedSchema>) {
  const before = await mustGet<Row>(q, 'income_records', d.id, 'รายรับ')
  const c = await ctx(q)
  const patch: Row = { status: d.received ? 'received' : 'expected' }
  if (d.received) {
    patch.incomeDate = d.date ?? c.today
    if ((patch.incomeDate as string) > c.today) throw new UserError('วันที่ได้รับต้องไม่เป็นวันในอนาคต')
  }
  if (d.accountId !== undefined) {
    await assertBaseCashAccount(q, d.accountId, c.baseCurrency)
    patch.accountId = d.accountId
  }
  const after = await updateRow(q, 'income_records', d.id, patch)
  await audit(q, userId, 'update', 'income_records', d.id, before, after)
}

// ---- expenses ---------------------------------------------------------------
export async function saveExpense(q: Queryable, userId: string, d: z.output<typeof expenseSchema>) {
  const { id, date, idempotencyKey, ...rest } = d
  const c = await ctx(q)
  if (rest.status === 'paid' && rest.paidDate && rest.paidDate > c.today) throw new UserError('รายจ่ายที่ "จ่ายแล้ว" ต้องไม่เป็นวันในอนาคต ให้ใช้สถานะ "ยังไม่จ่าย"', { date: 'ต้องไม่เป็นวันในอนาคต' })
  await assertBaseCashAccount(q, rest.accountId, c.baseCurrency)
  const data: Row = { ...rest, expenseDate: date }
  if (!id) data.idempotencyKey = idempotencyKey ?? null
  return saveRow<{ id: string }>(q, userId, 'expense_records', id, data)
}

export const deleteExpense = (q: Queryable, userId: string, id: string) => removeRow(q, userId, 'expense_records', id)

export async function setExpensePaid(q: Queryable, userId: string, d: z.output<typeof expensePaidSchema>) {
  const before = await mustGet<Row>(q, 'expense_records', d.id, 'รายจ่าย')
  const c = await ctx(q)
  const paidDate = d.paid ? (d.paidDate ?? c.today) : null
  if (paidDate && paidDate > c.today) throw new UserError('วันที่จ่ายต้องไม่เป็นวันในอนาคต')
  const patch: Row = { status: d.paid ? 'paid' : 'unpaid', paidDate }
  if (d.accountId !== undefined) {
    await assertBaseCashAccount(q, d.accountId, c.baseCurrency)
    patch.accountId = d.accountId
  }
  const after = await updateRow(q, 'expense_records', d.id, patch)
  await audit(q, userId, 'update', 'expense_records', d.id, before, after)
}

export async function saveRecurring(q: Queryable, userId: string, d: z.output<typeof recurringSchema>) {
  const { id, ...data } = d
  const c = await ctx(q)
  await assertBaseCashAccount(q, data.accountId, c.baseCurrency)
  if (data.endDate && data.endDate < data.nextDueDate) throw new UserError('วันสิ้นสุดต้องไม่ก่อนวันครบกำหนดถัดไป', { endDate: 'ต้องไม่ก่อนวันครบกำหนด' })
  return saveRow<{ id: string }>(q, userId, 'recurring_expenses', id, data)
}

/** Bills already generated stay as they are; only future ones stop. */
export const deleteRecurring = (q: Queryable, userId: string, id: string) => removeRow(q, userId, 'recurring_expenses', id)

// ---- liabilities ------------------------------------------------------------
export async function saveLiability(q: Queryable, userId: string, d: z.output<typeof liabilitySchema>) {
  const { id, ...data } = d
  const { today } = await ctx(q)
  if (data.openingDate > today) throw new UserError('วันที่เริ่มต้นของหนี้ต้องไม่เป็นวันในอนาคต', { openingDate: 'ต้องไม่เป็นวันในอนาคต' })
  if (id) {
    const early = await q.query('select 1 from debt_payments where liability_id = $1 and pay_date < $2 limit 1', [id, data.openingDate])
    if (early.rows.length > 0) throw new UserError('มีรายการชำระก่อนวันที่เริ่มต้นใหม่ของหนี้ ปรับวันที่หรือลบรายการนั้นก่อน', { openingDate: 'มีรายการชำระก่อนวันนี้' })
  }
  return saveRow<{ id: string }>(q, userId, 'liabilities', id, data)
}

/** Removes the liability and (by cascade) its payment records: account balances are recomputed without them. */
export const deleteLiability = (q: Queryable, userId: string, id: string) => removeRow(q, userId, 'liabilities', id)

export async function saveDebtPayment(q: Queryable, userId: string, d: z.output<typeof debtPaymentSchema>) {
  const { id, date, idempotencyKey, ...rest } = d
  const c = await ctx(q)
  if (date > c.today) throw new UserError('วันที่ชำระต้องไม่เป็นวันในอนาคต', { date: 'ต้องไม่เป็นวันในอนาคต' })
  const liability = await mustGet<{ openingDate: string; name: string }>(q, 'liabilities', d.liabilityId, 'หนี้สิน')
  if (date < liability.openingDate) throw new UserError(`วันที่ต้องไม่ก่อนวันที่เริ่มบันทึกหนี้ (${liability.openingDate})`, { date: 'ก่อนวันที่เริ่มต้นของหนี้' })
  if (rest.kind === 'charge') rest.accountId = null
  await assertBaseCashAccount(q, rest.accountId, c.baseCurrency)
  const data: Row = { ...rest, payDate: date }
  if (!id) data.idempotencyKey = idempotencyKey ?? null
  return saveRow<{ id: string }>(q, userId, 'debt_payments', id, data)
}

export const deleteDebtPayment = (q: Queryable, userId: string, id: string) => removeRow(q, userId, 'debt_payments', id)

// ---- goals & budgets --------------------------------------------------------
export async function saveGoal(q: Queryable, userId: string, d: z.output<typeof goalSchema>) {
  const { id, ...data } = d
  return saveRow<{ id: string }>(q, userId, 'savings_goals', id, data)
}

/** Linked accounts keep their money and go back to general purpose. */
export async function deleteGoal(q: Queryable, userId: string, id: string) {
  await q.query(`update accounts set purpose = 'general', goal_id = null, updated_at = now() where goal_id = $1`, [id])
  return removeRow(q, userId, 'savings_goals', id)
}

/** amount = null removes the budget for that category ('*' = whole-month budget). */
export async function saveBudget(q: Queryable, userId: string, d: z.output<typeof budgetSchema>): Promise<void> {
  const existing = await q.query<Row>('select * from monthly_budgets where month = $1 and category = $2', [d.month, d.category])
  if (d.amount === null) {
    if (existing.rows[0]) {
      await q.query('delete from monthly_budgets where id = $1', [existing.rows[0].id])
      await audit(q, userId, 'delete', 'monthly_budgets', existing.rows[0].id as string, existing.rows[0], null)
    }
    return
  }
  const r = await q.query<Row>(
    `insert into monthly_budgets (user_id, month, category, amount) values ($1, $2, $3, $4)
     on conflict (user_id, month, category) do update set amount = excluded.amount, updated_at = now() returning *`,
    [userId, d.month, d.category, d.amount],
  )
  await audit(q, userId, existing.rows[0] ? 'update' : 'create', 'monthly_budgets', r.rows[0].id as string, existing.rows[0] ?? null, r.rows[0])
}

// ---- monthly allocation -----------------------------------------------------
/**
 * Saves the month's allocation plan. Confirming is refused while allocations
 * exceed the money the plan is based on.
 */
export async function saveAllocationPlan(q: Queryable, userId: string, d: z.output<typeof allocationPlanSchema>, s: Snapshot) {
  if (d.month !== s.month) throw new UserError('บันทึกแผนแบ่งเงินได้เฉพาะเดือนปัจจุบัน')
  const basisAmount = allocationBasis(s, d.basis)
  const result = computeAllocation(basisAmount, d.items, allocationAuto(s))
  if (d.confirm) {
    if (basisAmount <= 0) throw new UserError('ยังไม่มีรายรับของเดือนนี้ จึงยืนยันแผนไม่ได้')
    if (result.overBudget) throw new UserError(`ยอดจัดสรรเกินเงินที่มี ${roundCash(-result.remaining).toLocaleString('th-TH')} บาท ปรับยอดให้ไม่เกินก่อนจึงจะยืนยันได้`)
  }
  const existing = await q.query<Row>('select * from allocation_plans where month = $1', [d.month])
  const r = await q.query<Row>(
    `insert into allocation_plans (user_id, month, basis, basis_amount, items, status, confirmed_at)
     values ($1, $2, $3, $4, $5, $6, case when $6 = 'confirmed' then now() else null end)
     on conflict (user_id, month) do update set basis = excluded.basis, basis_amount = excluded.basis_amount, items = excluded.items,
       status = excluded.status, confirmed_at = excluded.confirmed_at, updated_at = now()
     returning *`,
    [userId, d.month, d.basis, basisAmount, JSON.stringify(d.items), d.confirm ? 'confirmed' : 'draft'],
  )
  await audit(q, userId, d.confirm ? 'confirm' : existing.rows[0] ? 'update' : 'create', 'allocation_plans', r.rows[0].id as string, existing.rows[0] ?? null, r.rows[0])
  return { result, status: d.confirm ? 'confirmed' : 'draft' }
}
