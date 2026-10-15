'use client'

import Link from 'next/link'
import { Button, Notice } from '@/components/ui'

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <Notice tone="danger" title="โหลดข้อมูลไม่สำเร็จ">
        ระบบไม่สามารถอ่านข้อมูลจากฐานข้อมูลได้ในขณะนี้ ข้อมูลของคุณไม่ได้ถูกแก้ไข ลองโหลดใหม่อีกครั้ง หากยังไม่ได้ให้ตรวจสอบการเชื่อมต่อฐานข้อมูล (DATABASE_URL) ของเซิร์ฟเวอร์
        {error.digest && <span className="mt-1 block text-xs">รหัสอ้างอิงข้อผิดพลาด: {error.digest}</span>}
      </Notice>
      <div className="mt-4 flex gap-2">
        <Button variant="primary" onClick={reset}>
          ลองใหม่
        </Button>
        <Link href="/overview" className="inline-flex h-9 items-center rounded-lg border border-line px-3.5 text-sm font-medium hover:bg-surface-2">
          กลับหน้าภาพรวม
        </Link>
      </div>
    </div>
  )
}
