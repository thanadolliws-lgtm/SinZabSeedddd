'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useActionState, type ReactNode } from 'react'
import { loginAction, registerAction, requestResetAction, resetPasswordAction, type FormState } from '@/actions/auth'
import { Button, Field, Input, Notice } from '@/components/ui'

function Shell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="w-full max-w-sm">
      <div className="mb-6 flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent font-bold text-on-accent">S</span>
        <div className="leading-tight">
          <div className="font-semibold">Sinsap</div>
          <div className="text-xs text-muted">บริหารการเงินและพอร์ตลงทุน</div>
        </div>
      </div>
      <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
        <div className="mt-4">{children}</div>
      </div>
      {footer && <div className="mt-4 text-center text-sm text-muted">{footer}</div>}
    </div>
  )
}

const initial: FormState = {}

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, initial)
  const params = useSearchParams()
  return (
    <Shell title="เข้าสู่ระบบ" footer={<>ยังไม่มีบัญชี? <Link className="text-accent hover:underline" href="/register">สมัครสมาชิก</Link></>}>
      {params.get('reset') && !state.error && <Notice tone="success" className="mb-3">ตั้งรหัสผ่านใหม่แล้ว เข้าสู่ระบบด้วยรหัสผ่านใหม่ได้เลย</Notice>}
      {params.get('deleted') && <Notice tone="info" className="mb-3">ลบบัญชีและข้อมูลทั้งหมดแล้ว</Notice>}
      {state.error && <Notice tone="danger" className="mb-3">{state.error}</Notice>}
      <form action={action} className="space-y-3">
        <Field label="อีเมล" required>
          <Input name="email" type="email" autoComplete="email" required defaultValue={state.email} />
        </Field>
        <Field label="รหัสผ่าน" required>
          <Input name="password" type="password" autoComplete="current-password" required />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={pending}>
          เข้าสู่ระบบ
        </Button>
      </form>
      <div className="mt-3 text-right text-sm">
        <Link className="text-accent hover:underline" href="/forgot-password">
          ลืมรหัสผ่าน?
        </Link>
      </div>
    </Shell>
  )
}

export function RegisterForm() {
  const [state, action, pending] = useActionState(registerAction, initial)
  return (
    <Shell title="สมัครสมาชิก" subtitle="ข้อมูลของคุณเก็บในฐานข้อมูลและแยกจากผู้ใช้อื่นทั้งหมด" footer={<>มีบัญชีแล้ว? <Link className="text-accent hover:underline" href="/login">เข้าสู่ระบบ</Link></>}>
      {state.error && <Notice tone="danger" className="mb-3">{state.error}</Notice>}
      <form action={action} className="space-y-3">
        <Field label="ชื่อที่ใช้แสดง">
          <Input name="displayName" autoComplete="nickname" maxLength={80} defaultValue={state.displayName} />
        </Field>
        <Field label="อีเมล" required>
          <Input name="email" type="email" autoComplete="email" required defaultValue={state.email} />
        </Field>
        <Field label="รหัสผ่าน" required hint="อย่างน้อย 10 ตัวอักษร (ประโยคยาว ๆ จำง่ายและปลอดภัยกว่า)">
          <Input name="password" type="password" autoComplete="new-password" minLength={10} required />
        </Field>
        <Field label="ยืนยันรหัสผ่าน" required>
          <Input name="confirmPassword" type="password" autoComplete="new-password" minLength={10} required />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={pending}>
          สร้างบัญชี
        </Button>
      </form>
    </Shell>
  )
}

export function ForgotForm() {
  const [state, action, pending] = useActionState(requestResetAction, initial)
  return (
    <Shell title="ลืมรหัสผ่าน" subtitle="กรอกอีเมลของบัญชี ระบบจะสร้างลิงก์สำหรับตั้งรหัสผ่านใหม่" footer={<Link className="text-accent hover:underline" href="/login">กลับไปหน้าเข้าสู่ระบบ</Link>}>
      {state.error && <Notice tone="danger" className="mb-3">{state.error}</Notice>}
      {state.message ? (
        <Notice tone="success">{state.message}</Notice>
      ) : (
        <form action={action} className="space-y-3">
          <Field label="อีเมล" required>
            <Input name="email" type="email" autoComplete="email" required defaultValue={state.email} />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={pending}>
            ขอลิงก์ตั้งรหัสผ่านใหม่
          </Button>
        </form>
      )}
    </Shell>
  )
}

export function ResetForm() {
  const [state, action, pending] = useActionState(resetPasswordAction, initial)
  const token = useSearchParams().get('token') ?? ''
  return (
    <Shell title="ตั้งรหัสผ่านใหม่" footer={<Link className="text-accent hover:underline" href="/login">กลับไปหน้าเข้าสู่ระบบ</Link>}>
      {!token && <Notice tone="danger">ลิงก์ไม่ครบ กรุณาเปิดจากลิงก์ที่ได้รับอีกครั้ง หรือขอลิงก์ใหม่</Notice>}
      {state.error && <Notice tone="danger" className="mb-3">{state.error}</Notice>}
      {token && (
        <form action={action} className="space-y-3">
          <input type="hidden" name="token" value={token} />
          <Field label="รหัสผ่านใหม่" required hint="อย่างน้อย 10 ตัวอักษร การตั้งรหัสใหม่จะออกจากระบบในทุกอุปกรณ์">
            <Input name="password" type="password" autoComplete="new-password" minLength={10} required />
          </Field>
          <Field label="ยืนยันรหัสผ่านใหม่" required>
            <Input name="confirmPassword" type="password" autoComplete="new-password" minLength={10} required />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={pending}>
            บันทึกรหัสผ่านใหม่
          </Button>
        </form>
      )}
    </Shell>
  )
}
