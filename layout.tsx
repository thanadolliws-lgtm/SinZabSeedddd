import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/session'

/** Signed-in visitors are sent straight to their overview. */
async function RedirectIfSignedIn() {
  if (await getCurrentUser()) redirect('/overview')
  return null
}

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <Suspense fallback={null}>
        <RedirectIfSignedIn />
      </Suspense>
      <Suspense fallback={<div className="skeleton h-96 w-full max-w-sm" />}>{children}</Suspense>
    </main>
  )
}
