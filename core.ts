/**
 * Shared plumbing for the mutation services.
 *
 * Every service function takes a Queryable that is ALREADY inside
 * withUser(userId): RLS guarantees the statements can only touch that user's
 * rows, and the whole service call is one transaction (all-or-nothing).
 */
import type { Queryable } from '@/lib/db'
import { camelize } from '@/lib/data/load'

/** An error whose message is safe and useful to show to the user. Throwing it rolls the transaction back. */
export class UserError extends Error {
  constructor(
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message)
  }
}

export type Row = Record<string, unknown>

const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

// Table and column names below come from code (validated schema keys), never from request data.
function cols(data: Row): { names: string[]; values: unknown[] } {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined)
  return { names: entries.map(([k]) => toSnake(k)), values: entries.map(([, v]) => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v)) }
}

export async function insertRow<T = Row>(q: Queryable, table: string, userId: string, data: Row): Promise<T> {
  const { names, values } = cols({ userId, ...data })
  const r = await q.query<Row>(`insert into ${table} (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')}) returning *`, values)
  return camelize<T>(r.rows[0])
}

export async function updateRow<T = Row>(q: Queryable, table: string, id: string, data: Row, opts: { touch?: boolean } = {}): Promise<T> {
  const { names, values } = cols(data)
  const sets = names.map((n, i) => `${n} = $${i + 1}`)
  if (opts.touch !== false) sets.push('updated_at = now()')
  const r = await q.query<Row>(`update ${table} set ${sets.join(', ')} where id = $${names.length + 1} returning *`, [...values, id])
  if (!r.rows[0]) throw new UserError('ไม่พบรายการที่ต้องการแก้ไข (อาจถูกลบไปแล้ว)')
  return camelize<T>(r.rows[0])
}

export async function getRow<T = Row>(q: Queryable, table: string, id: string): Promise<T | null> {
  const r = await q.query<Row>(`select * from ${table} where id = $1`, [id])
  return r.rows[0] ? camelize<T>(r.rows[0]) : null
}

export async function mustGet<T = Row>(q: Queryable, table: string, id: string, what: string): Promise<T> {
  const row = await getRow<T>(q, table, id)
  if (!row) throw new UserError(`ไม่พบ${what} (อาจถูกลบไปแล้ว)`)
  return row
}

export async function deleteRow<T = Row>(q: Queryable, table: string, id: string): Promise<T> {
  const r = await q.query<Row>(`delete from ${table} where id = $1 returning *`, [id])
  if (!r.rows[0]) throw new UserError('ไม่พบรายการที่ต้องการลบ (อาจถูกลบไปแล้ว)')
  return camelize<T>(r.rows[0])
}

export type AuditAction = 'create' | 'update' | 'delete' | 'import' | 'confirm'

export async function audit(q: Queryable, userId: string, action: AuditAction, entity: string, entityId: string | null, before: unknown, after: unknown): Promise<void> {
  await q.query('insert into audit_log (user_id, action, entity, entity_id, before, after) values ($1, $2, $3, $4, $5, $6)', [
    userId,
    action,
    entity,
    entityId,
    before === null || before === undefined ? null : JSON.stringify(before),
    after === null || after === undefined ? null : JSON.stringify(after),
  ])
}

/** Create-or-update with an audit entry. Returns the saved row. */
export async function saveRow<T extends { id: string }>(q: Queryable, userId: string, table: string, id: string | null | undefined, data: Row): Promise<T> {
  if (id) {
    const before = await mustGet<T>(q, table, id, 'รายการ')
    const after = await updateRow<T>(q, table, id, data)
    await audit(q, userId, 'update', table, id, before, after)
    return after
  }
  const row = await insertRow<T>(q, table, userId, data)
  await audit(q, userId, 'create', table, row.id, null, row)
  return row
}

export async function removeRow<T extends { id: string }>(q: Queryable, userId: string, table: string, id: string): Promise<T> {
  const before = await deleteRow<T>(q, table, id)
  await audit(q, userId, 'delete', table, id, before, null)
  return before
}

interface PgError {
  code?: string
  constraint?: string
  message?: string
  detail?: string
}

/**
 * Was this insert rejected because the same idempotency key was already saved?
 * That means the user's click was processed twice: the first one won, so the
 * second is reported as "already saved" rather than as an error.
 */
export function isDuplicateSubmit(e: unknown): boolean {
  const err = e as PgError
  return err?.code === '23505' && /idempotency_key/.test(`${err.constraint ?? ''} ${err.message ?? ''} ${err.detail ?? ''}`)
}

/** Maps database errors to a message a person can act on. Unknown errors are not leaked. */
export function friendlyDbError(e: unknown): string | null {
  const err = e as PgError
  const text = `${err?.constraint ?? ''} ${err?.message ?? ''}`
  switch (err?.code) {
    case '23505':
      if (/securities/.test(text)) return 'มีหลักทรัพย์นี้ (Ticker + ตลาด) อยู่ในรายการแล้ว'
      if (/monthly_budgets/.test(text)) return 'มีงบของหมวดนี้ในเดือนนี้อยู่แล้ว'
      if (/dca_allocations/.test(text)) return 'มีหลักทรัพย์ซ้ำในแผน DCA'
      if (/dca_schedule/.test(text)) return 'มีรายการในตารางลงทุนของวันนั้นอยู่แล้ว'
      return 'มีข้อมูลนี้อยู่แล้ว ไม่สามารถบันทึกซ้ำได้'
    case '23503':
      return 'ไม่สามารถดำเนินการได้เพราะมีรายการอื่นอ้างอิงข้อมูลนี้อยู่ (ลบหรือย้ายรายการที่เกี่ยวข้องก่อน หรือใช้การเก็บถาวรแทน)'
    case '23514':
      return 'ข้อมูลไม่ผ่านเงื่อนไขความถูกต้องของฐานข้อมูล กรุณาตรวจสอบตัวเลขที่กรอก'
    case '23502':
      return 'กรอกข้อมูลที่จำเป็นไม่ครบ'
    case '42501':
      return 'ไม่มีสิทธิ์เข้าถึงข้อมูลนี้'
    case '22003':
      return 'ตัวเลขมีค่ามากเกินกว่าที่ระบบรองรับ'
    default:
      return null
  }
}
