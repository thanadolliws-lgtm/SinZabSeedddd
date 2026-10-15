'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { emailConfigured, sendPasswordResetEmail } from '@/lib/auth/email'
import { AuthError, changePassword, createPasswordReset, deleteAccount, registerUser, resetPassword, verifyLogin } from '@/lib/auth/service'
import { clientIp, endSession, getCurrentUser, requestOrigin, sessionToken, startSession } from '@/lib/auth/session'

export interface FormState {
  error?: string
  message?: string
  /** echoed back so the form keeps what the user typed (never the password) */
  email?: string
  displayName?: string
}

const str = (fd: FormData, key: string) => {
  const v = fd.get(key)
  return typeof v === 'string' ? v : ''
}

function failure(e: unknown, extra: Partial<FormState> = {}): FormState {
  if (e instanceof AuthError) return { error: e.message, ...extra }
  console.error('[auth] unexpected error:', e)
  return { error: 'เกิดข้อผิดพลาดของระบบ กรุณาลองใหม่อีกครั้ง', ...extra }
}

export async function registerAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const email = str(fd, 'email')
  const displayName = str(fd, 'displayName')
  const password = str(fd, 'password')
  if (password !== str(fd, 'confirmPassword')) return { error: 'รหัสผ่านทั้งสองช่องไม่ตรงกัน', email, displayName }
  try {
    const user = await registerUser({ email, password, displayName, ip: await clientIp() })
    await startSession(user.id)
  } catch (e) {
    return failure(e, { email, displayName })
  }
  redirect('/overview')
}

export async function loginAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const email = str(fd, 'email')
  try {
    const user = await verifyLogin({ email, password: str(fd, 'password'), ip: await clientIp() })
    await startSession(user.id)
  } catch (e) {
    return failure(e, { email })
  }
  redirect('/overview')
}

export async function logoutAction(): Promise<void> {
  await endSession()
  revalidatePath('/', 'layout')
  redirect('/login')
}

export async function requestResetAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const email = str(fd, 'email')
  if (!email.trim()) return { error: 'กรุณากรอกอีเมล' }
  try {
    const reset = await createPasswordReset(email, await clientIp())
    if (reset) {
      const link = `${await requestOrigin()}/reset-password?token=${encodeURIComponent(reset.token)}`
      await sendPasswordResetEmail(reset.email, link)
    }
  } catch (e) {
    return failure(e, { email })
  }
  // Identical answer whether or not the address has an account.
  return {
    message: emailConfigured()
      ? 'หากอีเมลนี้มีบัญชีอยู่ ระบบได้ส่งลิงก์สำหรับตั้งรหัสผ่านใหม่ไปให้แล้ว (ลิงก์ใช้ได้ 60 นาที)'
      : 'หากอีเมลนี้มีบัญชีอยู่ ระบบได้สร้างลิงก์ตั้งรหัสผ่านใหม่แล้ว แต่ระบบนี้ยังไม่ได้ตั้งค่าการส่งอีเมล: ผู้ดูแลระบบดูลิงก์ได้จาก log ของเซิร์ฟเวอร์ (โหมดพัฒนา) หรือออกลิงก์ด้วยคำสั่ง npm run auth:reset-link',
  }
}

export async function resetPasswordAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const password = str(fd, 'password')
  if (password !== str(fd, 'confirmPassword')) return { error: 'รหัสผ่านทั้งสองช่องไม่ตรงกัน' }
  try {
    await resetPassword(str(fd, 'token'), password)
  } catch (e) {
    return failure(e)
  }
  redirect('/login?reset=1')
}

export async function changePasswordAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await getCurrentUser()
  if (!user) return { error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' }
  const next = str(fd, 'newPassword')
  if (next !== str(fd, 'confirmPassword')) return { error: 'รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน' }
  try {
    await changePassword(user.id, str(fd, 'currentPassword'), next, await sessionToken())
  } catch (e) {
    return failure(e)
  }
  return { message: 'เปลี่ยนรหัสผ่านแล้ว อุปกรณ์อื่นที่เข้าสู่ระบบไว้ถูกออกจากระบบทั้งหมด' }
}

export async function deleteAccountAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await getCurrentUser()
  if (!user) return { error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' }
  if (str(fd, 'confirm').trim() !== user.email) return { error: 'พิมพ์อีเมลของบัญชีให้ตรงเพื่อยืนยันการลบ' }
  try {
    await deleteAccount(user.id, str(fd, 'password'))
    await endSession()
  } catch (e) {
    return failure(e)
  }
  redirect('/login?deleted=1')
}
