import 'server-only'

export type MailResult = 'sent' | 'logged' | 'not_configured' | 'failed'

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM
}

/**
 * Sends the password-reset link.
 *  - RESEND_API_KEY + EMAIL_FROM set : e-mail through Resend's HTTP API.
 *  - not set, outside production     : the link is printed to the SERVER console only (never to the browser).
 *  - not set, in production          : nothing is sent; an operator can issue a link with `npm run auth:reset-link`.
 */
export async function sendPasswordResetEmail(to: string, link: string): Promise<MailResult> {
  if (!emailConfigured()) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`\n[auth] Password reset link for ${to} (e-mail is not configured, development only):\n${link}\n`)
      return 'logged'
    }
    console.warn('[auth] Password reset requested but RESEND_API_KEY / EMAIL_FROM are not configured.')
    return 'not_configured'
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [to],
        subject: 'รีเซ็ตรหัสผ่าน Sinsap',
        text: `มีการขอรีเซ็ตรหัสผ่านสำหรับบัญชีนี้\n\nเปิดลิงก์นี้ภายใน 60 นาทีเพื่อตั้งรหัสผ่านใหม่:\n${link}\n\nหากคุณไม่ได้เป็นผู้ขอ ไม่ต้องดำเนินการใด ๆ รหัสผ่านเดิมยังใช้ได้ตามปกติ`,
      }),
      cache: 'no-store',
    })
    if (!res.ok) {
      console.error(`[auth] Resend responded ${res.status}`)
      return 'failed'
    }
    return 'sent'
  } catch (e) {
    console.error('[auth] Sending reset e-mail failed:', (e as Error).message)
    return 'failed'
  }
}
