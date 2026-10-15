import type { Metadata } from 'next'
import { ResetForm } from '../auth-forms'

export const metadata: Metadata = { title: 'ตั้งรหัสผ่านใหม่' }

export default function Page() {
  return <ResetForm />
}
