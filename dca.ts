/**
 * DCA plans. A plan and its schedule are intentions only; holdings change
 * solely when executeSchedule() records a real, confirmed transaction.
 */
import type { z } from 'zod'
import type { Queryable } from '@/lib/db'
import { camelize } from '@/lib/data/load'
import { buildSchedule, checkAllocations, type DcaPlanRow } from '@/lib/calc/dca'
import { UserError, audit, insertRow, mustGet, removeRow, updateRow, type Row } from './core'
import { saveTransaction } from './portfolio'
import type { dcaPlanSchema, scheduleExecuteSchema, scheduleGenerateSchema, scheduleStatusSchema } from './schemas'

async function loadPlan(q: Queryable, id: string): Promise<{ plan: DcaPlanRow; allocations: { securityId: string; targetPct: number }[] }> {
  const plan = await mustGet<DcaPlanRow>(q, 'dca_plans', id, 'แผน DCA')
  const a = await q.query<Row>('select security_id, target_pct from dca_allocations where plan_id = $1 order by target_pct desc, security_id', [id])
  return { plan, allocations: a.rows.map((r) => camelize<{ securityId: string; targetPct: number }>(r)) }
}

export async function saveDcaPlan(q: Queryable, userId: string, d: z.output<typeof dcaPlanSchema>): Promise<{ id: string; status: string; total: number }> {
  const { id, allocations, confirmIncomplete, paused, ...fields } = d
  const check = checkAllocations(allocations)
  // A plan whose weights do not total 100% is only stored when the user explicitly confirms, and then only as a draft.
  if (!check.ok && !confirmIncomplete) {
    throw new UserError(
      allocations.length === 0 ? 'แผนยังไม่มีหลักทรัพย์ ต้องยืนยันก่อนจึงจะบันทึกเป็นแบบร่างได้' : `สัดส่วนรวม ${check.total}% ไม่เท่ากับ 100% (ต่าง ${check.diff > 0 ? '+' : ''}${check.diff}%) ต้องยืนยันก่อนจึงจะบันทึกเป็นแบบร่างได้`,
      { allocations: 'สัดส่วนรวมต้องเท่ากับ 100%' },
    )
  }
  if (fields.frequency === 'weekly' && fields.investDay !== null && fields.investDay > 5) throw new UserError('แผนรายสัปดาห์: เลือกวันจันทร์-ศุกร์ (1-5)', { investDay: 'เลือก 1-5' })
  const status = !check.ok ? 'draft' : paused ? 'paused' : 'active'
  const pf = await q.query<{ id: string }>(`select id from portfolios where kind = 'dca'`)
  if (!pf.rows[0]) throw new UserError('ไม่พบพอร์ต DCA ของบัญชีนี้')

  let planId: string
  if (id) {
    const before = await loadPlan(q, id)
    await updateRow(q, 'dca_plans', id, { ...fields, status })
    await q.query('delete from dca_allocations where plan_id = $1', [id])
    planId = id
    await audit(q, userId, 'update', 'dca_plans', id, before, { ...fields, status, allocations })
  } else {
    const row = await insertRow<{ id: string }>(q, 'dca_plans', userId, { ...fields, status, portfolioId: pf.rows[0].id })
    planId = row.id
    await audit(q, userId, 'create', 'dca_plans', planId, null, { ...fields, status, allocations })
  }
  for (const a of allocations) {
    await mustGet(q, 'securities', a.securityId, 'หลักทรัพย์')
    await insertRow(q, 'dca_allocations', userId, { planId, securityId: a.securityId, targetPct: a.targetPct })
  }
  return { id: planId, status, total: check.total }
}

export async function deleteDcaPlan(q: Queryable, userId: string, id: string): Promise<void> {
  // The schedule goes with the plan; transactions already executed stay in the portfolio untouched.
  await removeRow(q, userId, 'dca_plans', id)
}

/** Creates this month's planned rows from the plan. Existing executed/skipped rows are never overwritten. */
export async function generateSchedule(q: Queryable, userId: string, d: z.output<typeof scheduleGenerateSchema>): Promise<{ created: number; warnings: string[]; dates: number }> {
  const { plan, allocations } = await loadPlan(q, d.planId)
  if (plan.status === 'draft') throw new UserError('แผนนี้เป็นแบบร่าง (สัดส่วนรวมไม่เท่ากับ 100%) จึงสร้างตารางลงทุนไม่ได้')
  if (plan.status === 'paused') throw new UserError('แผนนี้หยุดพักอยู่ เปิดใช้งานก่อนจึงจะสร้างตารางลงทุนได้')
  const build = buildSchedule(plan, allocations, d.month)
  if (build.items.length === 0) throw new UserError(build.warnings[0] ?? 'ไม่มีรายการให้สร้าง')
  if (d.replacePlanned) {
    await q.query(`delete from dca_schedule where plan_id = $1 and status = 'planned' and to_char(planned_date, 'YYYY-MM') = $2`, [d.planId, d.month])
  }
  let created = 0
  for (const item of build.items) {
    const r = await q.query(
      `insert into dca_schedule (user_id, plan_id, security_id, planned_date, planned_amount, currency)
       values ($1, $2, $3, $4, $5, $6) on conflict (plan_id, security_id, planned_date) do nothing`,
      [userId, d.planId, item.securityId, item.date, item.amount, plan.budgetCurrency],
    )
    created += r.rowCount
  }
  await audit(q, userId, 'create', 'dca_schedule', d.planId, null, { month: d.month, created, dates: build.dates.length })
  return { created, warnings: build.warnings, dates: build.dates.length }
}

export async function setScheduleStatus(q: Queryable, userId: string, d: z.output<typeof scheduleStatusSchema>): Promise<void> {
  const before = await mustGet<{ status: string }>(q, 'dca_schedule', d.id, 'รายการในตารางลงทุน')
  if (before.status === 'executed') throw new UserError('รายการนี้ดำเนินการแล้ว หากต้องการยกเลิกให้ลบธุรกรรมที่เกี่ยวข้อง')
  const after = await updateRow(q, 'dca_schedule', d.id, { status: d.status, note: d.note })
  await audit(q, userId, 'update', 'dca_schedule', d.id, before, after)
}

export async function deleteScheduleRow(q: Queryable, userId: string, id: string): Promise<void> {
  const row = await mustGet<{ status: string }>(q, 'dca_schedule', id, 'รายการในตารางลงทุน')
  if (row.status === 'executed') throw new UserError('รายการนี้ดำเนินการแล้ว ลบไม่ได้ (ลบธุรกรรมที่เกี่ยวข้องก่อน)')
  await removeRow(q, userId, 'dca_schedule', id)
}

/** Records the real purchase for a planned slot and links the two. */
export async function executeSchedule(q: Queryable, userId: string, d: z.output<typeof scheduleExecuteSchema>): Promise<{ transactionId: string }> {
  const row = await mustGet<{ id: string; securityId: string; status: string; planId: string }>(q, 'dca_schedule', d.scheduleId, 'รายการในตารางลงทุน')
  if (row.status === 'executed') throw new UserError('รายการนี้บันทึกการลงทุนจริงไปแล้ว')
  const tx = await saveTransaction(
    q,
    userId,
    {
      portfolio: 'dca',
      securityId: row.securityId,
      accountId: d.accountId,
      type: 'buy',
      tradeDate: d.tradeDate,
      quantity: d.quantity,
      price: d.price,
      amount: null,
      fee: d.fee,
      splitRatio: null,
      fxRate: d.fxRate,
      note: d.note,
      idempotencyKey: d.idempotencyKey,
    },
    { source: 'dca' },
  )
  const after = await updateRow(q, 'dca_schedule', d.scheduleId, { status: 'executed', transactionId: tx.id })
  await audit(q, userId, 'confirm', 'dca_schedule', d.scheduleId, row, after)
  return { transactionId: tx.id }
}
