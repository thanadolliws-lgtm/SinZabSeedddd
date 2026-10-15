/**
 * Authentication core (no framework imports, so it is directly testable).
 *
 *  - Passwords: scrypt (N=2^15, r=8, p=3: an OWASP-recommended parameter set), random 16-byte salt.
 *  - Sessions: 32 random bytes handed to the browser in an HttpOnly cookie;
 *    only the SHA-256 of the token is stored, so a database leak cannot be replayed.
 *  - Reset tokens: same scheme, single use, 60-minute lifetime; using one signs
 *    the user out everywhere.
 *  - Sliding-window rate limits on login, registration and reset requests.
 *  - Login and reset answers never reveal whether an e-mail address is registered.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { sys, sysTx, withUser } from '@/lib/db'

const SCRYPT = { N: 2 ** 15, r: 8, p: 3, keylen: 64, maxmem: 128 * 2 ** 15 * 8 * 2 }
export const SESSION_DAYS = 30
const RESET_MINUTES = 60

export interface AuthUser {
  id: string
  email: string
  displayName: string
}

export class AuthError extends Error {
  constructor(
    message: string,
    public code: 'invalid' | 'rate_limited' | 'exists' | 'weak_password' | 'expired' = 'invalid',
  ) {
    super(message)
  }
}

function scryptAsync(password: string, salt: Buffer, o = SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: o.maxmem }, (err, key) => (err ? reject(err) : resolve(key))),
  )
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt)
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, keyB64] = stored.split('$')
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false
  const expected = Buffer.from(keyB64, 'base64')
  const N = Number(n)
  const rr = Number(r)
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), { N, r: rr, p: Number(p), keylen: expected.length, maxmem: 128 * N * rr * 2 })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// Compared against when the e-mail is unknown, so both paths cost the same time.
let dummyHash: Promise<string> | null = null
const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(18).toString('base64')))

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const newToken = () => randomBytes(32).toString('base64url')

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร'
  if (password.length > 200) return 'รหัสผ่านยาวเกินไป'
  if (/^(.)\1+$/.test(password)) return 'รหัสผ่านต้องไม่ใช่ตัวอักษรเดียวกันซ้ำทั้งหมด'
  return null
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
async function attempts(kind: string, key: string, minutes: number): Promise<number> {
  const r = await sys.query<{ n: number }>(`select count(*)::int as n from auth_attempts where kind = $1 and key = $2 and created_at > now() - make_interval(mins => $3)`, [kind, key, minutes])
  return r.rows[0]?.n ?? 0
}

async function record(kind: string, key: string): Promise<void> {
  await sys.query('insert into auth_attempts (kind, key) values ($1, $2)', [kind, key])
  // opportunistic cleanup
  if (Math.random() < 0.02) await sys.query(`delete from auth_attempts where created_at < now() - interval '2 days'`)
}

async function limit(kind: string, key: string, max: number, minutes: number): Promise<void> {
  if ((await attempts(kind, key, minutes)) >= max) {
    throw new AuthError(`พยายามหลายครั้งเกินไป กรุณารออีกสักครู่แล้วลองใหม่ (ภายใน ${minutes} นาที)`, 'rate_limited')
  }
}

// ---------------------------------------------------------------------------
// Register / login / sessions
// ---------------------------------------------------------------------------
export async function registerUser(input: { email: string; password: string; displayName: string; ip?: string }): Promise<AuthUser> {
  const email = normalizeEmail(input.email)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new AuthError('รูปแบบอีเมลไม่ถูกต้อง')
  const problem = passwordProblem(input.password)
  if (problem) throw new AuthError(problem, 'weak_password')
  const displayName = input.displayName.trim().slice(0, 80)
  const ipKey = input.ip ?? 'unknown'
  await limit('register', ipKey, 10, 60)
  await record('register', ipKey)

  const passwordHash = await hashPassword(input.password)
  let id: string
  try {
    const r = await sys.query<{ id: string }>('insert into users (email, password_hash) values ($1, $2) returning id', [email, passwordHash])
    id = r.rows[0].id
  } catch (e) {
    if (isUniqueViolation(e)) throw new AuthError('อีเมลนี้มีบัญชีอยู่แล้ว กรุณาเข้าสู่ระบบหรือรีเซ็ตรหัสผ่าน', 'exists')
    throw e
  }
  // Per-user defaults are created AS the user, so RLS is exercised from the first write.
  try {
    await withUser(id, async (q) => {
      await q.query('insert into profiles (user_id, display_name) values ($1, $2)', [id, displayName])
      await q.query('insert into user_settings (user_id) values ($1)', [id])
      await q.query(`insert into portfolios (user_id, name, kind) values ($1, 'พอร์ตหุ้นที่ถือจริง', 'main'), ($1, 'พอร์ต DCA', 'dca')`, [id])
    })
  } catch (e) {
    // Never leave a half-created account behind.
    await sys.query('delete from users where id = $1', [id]).catch(() => {})
    throw e
  }
  return { id, email, displayName }
}

export async function verifyLogin(input: { email: string; password: string; ip?: string }): Promise<AuthUser> {
  const email = normalizeEmail(input.email)
  const ipKey = input.ip ?? 'unknown'
  await limit('login_fail_email', email, 8, 15)
  await limit('login_fail_ip', ipKey, 40, 15)
  const r = await sys.query<{ id: string; email: string; password_hash: string; display_name: string | null }>(
    `select u.id, u.email, u.password_hash, p.display_name from users u left join profiles p on p.user_id = u.id where lower(u.email) = $1`,
    [email],
  )
  const row = r.rows[0]
  const ok = await verifyPassword(input.password, row?.password_hash ?? (await getDummyHash()))
  if (!row || !ok) {
    await record('login_fail_email', email)
    await record('login_fail_ip', ipKey)
    throw new AuthError('อีเมลหรือรหัสผ่านไม่ถูกต้อง')
  }
  return { id: row.id, email: row.email, displayName: row.display_name ?? '' }
}

export async function createSession(userId: string, userAgent?: string | null): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken()
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000)
  await sys.query('insert into sessions (user_id, token_hash, expires_at, user_agent) values ($1, $2, $3, $4)', [userId, sha256(token), expiresAt.toISOString(), userAgent?.slice(0, 300) ?? null])
  return { token, expiresAt }
}

export async function getSessionUser(token: string | undefined | null): Promise<AuthUser | null> {
  if (!token || token.length > 200) return null
  const r = await sys.query<{ id: string; email: string; display_name: string | null; session_id: string; stale: boolean }>(
    `select u.id, u.email, p.display_name, s.id as session_id, (s.last_seen_at < now() - interval '1 hour') as stale
       from sessions s join users u on u.id = s.user_id left join profiles p on p.user_id = u.id
      where s.token_hash = $1 and s.expires_at > now()`,
    [sha256(token)],
  )
  const row = r.rows[0]
  if (!row) return null
  if (row.stale) await sys.query('update sessions set last_seen_at = now() where id = $1', [row.session_id]).catch(() => {})
  return { id: row.id, email: row.email, displayName: row.display_name ?? '' }
}

export async function deleteSession(token: string | undefined | null): Promise<void> {
  if (token) await sys.query('delete from sessions where token_hash = $1', [sha256(token)])
}

export async function deleteExpiredSessions(): Promise<void> {
  await sys.query('delete from sessions where expires_at < now()')
}

// ---------------------------------------------------------------------------
// Password reset / change
// ---------------------------------------------------------------------------
/** Returns a reset token when the e-mail belongs to an account, otherwise null. Callers must answer identically in both cases. */
export async function createPasswordReset(emailInput: string, ip?: string): Promise<{ token: string; email: string } | null> {
  const email = normalizeEmail(emailInput)
  await limit('reset_email', email, 3, 60)
  await limit('reset_ip', ip ?? 'unknown', 10, 60)
  await record('reset_email', email)
  await record('reset_ip', ip ?? 'unknown')
  const r = await sys.query<{ id: string; email: string }>('select id, email from users where lower(email) = $1', [email])
  const user = r.rows[0]
  if (!user) return null
  const token = newToken()
  await sys.query(`insert into password_reset_tokens (user_id, token_hash, expires_at) values ($1, $2, now() + make_interval(mins => $3))`, [user.id, sha256(token), RESET_MINUTES])
  return { token, email: user.email }
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const problem = passwordProblem(newPassword)
  if (problem) throw new AuthError(problem, 'weak_password')
  const hash = await hashPassword(newPassword)
  await sysTx(async (q) => {
    const r = await q.query<{ id: string; user_id: string }>(
      `update password_reset_tokens set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning id, user_id`,
      [sha256(token)],
    )
    const row = r.rows[0]
    if (!row) throw new AuthError('ลิงก์รีเซ็ตรหัสผ่านไม่ถูกต้องหรือหมดอายุแล้ว กรุณาขอลิงก์ใหม่', 'expired')
    await q.query('update users set password_hash = $1, password_changed_at = now() where id = $2', [hash, row.user_id])
    await q.query('delete from sessions where user_id = $1', [row.user_id])
    await q.query('update password_reset_tokens set used_at = now() where user_id = $1 and used_at is null', [row.user_id])
  })
}

/** Changes the password and signs out every other session; `keepToken` stays valid. */
export async function changePassword(userId: string, currentPassword: string, newPassword: string, keepToken?: string | null): Promise<void> {
  const problem = passwordProblem(newPassword)
  if (problem) throw new AuthError(problem, 'weak_password')
  await limit('change_password', userId, 8, 15)
  const r = await sys.query<{ password_hash: string }>('select password_hash from users where id = $1', [userId])
  if (!r.rows[0] || !(await verifyPassword(currentPassword, r.rows[0].password_hash))) {
    await record('change_password', userId)
    throw new AuthError('รหัสผ่านปัจจุบันไม่ถูกต้อง')
  }
  const hash = await hashPassword(newPassword)
  await sysTx(async (q) => {
    await q.query('update users set password_hash = $1, password_changed_at = now() where id = $2', [hash, userId])
    await q.query('delete from sessions where user_id = $1 and token_hash <> $2', [userId, keepToken ? sha256(keepToken) : ''])
  })
}

/** Permanently deletes the account and, through ON DELETE CASCADE, every row the user owns. */
export async function deleteAccount(userId: string, password: string): Promise<void> {
  const r = await sys.query<{ password_hash: string }>('select password_hash from users where id = $1', [userId])
  if (!r.rows[0] || !(await verifyPassword(password, r.rows[0].password_hash))) throw new AuthError('รหัสผ่านไม่ถูกต้อง')
  await sys.query('delete from users where id = $1', [userId])
}

export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string }
  return err?.code === '23505' || /duplicate key value|unique constraint/i.test(err?.message ?? '')
}
