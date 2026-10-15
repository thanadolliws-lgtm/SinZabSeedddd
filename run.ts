import 'server-only'
import { revalidatePath } from 'next/cache'
import type { z } from 'zod'
import { getCurrentUser } from '@/lib/auth/session'
import type { AuthUser } from '@/lib/auth/service'
import { withUser, type Queryable } from '@/lib/db'
import { UserError, friendlyDbError, isDuplicateSubmit } from '@/lib/services/core'
import { firstIssue } from '@/lib/services/schemas'
import type { ActionResult } from './types'

interface Ctx<D> {
  user: AuthUser
  q: Queryable
  data: D
}

/**
 * The one path every mutation takes:
 *   1. authenticate (never trust that the page was rendered for a signed-in user)
 *   2. validate the input on the server
 *   3. run inside a per-user transaction (RLS + all-or-nothing)
 *   4. translate failures into messages a person can act on
 *   5. invalidate every cached page so all screens re-read the same numbers
 */
export async function run<S extends z.ZodType, T>(schema: S, input: unknown, fn: (ctx: Ctx<z.output<S>>) => Promise<T>, opts: { readOnly?: boolean } = {}): Promise<ActionResult<T>> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', code: 'unauthenticated' }
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const { message, fields } = firstIssue(parsed.error)
    return { ok: false, error: `ข้อมูลไม่ถูกต้อง: ${message}`, fields }
  }
  try {
    const data = await withUser(user.id, (q) => fn({ user, q, data: parsed.data }))
    if (!opts.readOnly) revalidatePath('/', 'layout')
    return { ok: true, data }
  } catch (e) {
    if (e instanceof UserError) return { ok: false, error: e.message, fields: e.fields }
    if (isDuplicateSubmit(e)) {
      revalidatePath('/', 'layout')
      return { ok: true, data: undefined as T, duplicate: true, message: 'รายการนี้ถูกบันทึกไปแล้ว (ระบบป้องกันการบันทึกซ้ำ)' }
    }
    const friendly = friendlyDbError(e)
    if (friendly) return { ok: false, error: friendly }
    console.error('[action] unexpected error:', e)
    return { ok: false, error: 'บันทึกไม่สำเร็จเนื่องจากข้อผิดพลาดของระบบ ข้อมูลยังไม่ถูกเปลี่ยนแปลง กรุณาลองใหม่' }
  }
}
