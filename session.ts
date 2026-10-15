import 'server-only'
import { cache } from 'react'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { connection } from 'next/server'
import { SESSION_DAYS, createSession, deleteSession, getSessionUser, type AuthUser } from './service'

export const SESSION_COOKIE = 'sinsap_session'

/** The signed-in user for this request, or null. Deduplicated per request. */
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
  // Everything that depends on the user is request-time only: never part of a prerendered shell.
  await connection()
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  return getSessionUser(token)
})

/** For pages: redirects to /login when there is no valid session. */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  return user
}

export async function sessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null
}

export async function startSession(userId: string): Promise<void> {
  const h = await headers()
  const { token } = await createSession(userId, h.get('user-agent'))
  ;(await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== 'true',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  })
}

export async function endSession(): Promise<void> {
  const store = await cookies()
  await deleteSession(store.get(SESSION_COOKIE)?.value)
  store.delete(SESSION_COOKIE)
}

export async function clientIp(): Promise<string> {
  const h = await headers()
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || 'local'
}

export async function requestOrigin(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '')
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https')
  return `${proto}://${host}`
}
