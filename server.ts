import 'server-only'
import { cache } from 'react'
import { requireUser } from '@/lib/auth/session'
import { buildAppData, type AppData } from './app-data'
import type { AuthUser } from '@/lib/auth/service'

export type PageData = AppData & { user: AuthUser }

/**
 * The data for the current request: one load, shared by every component that
 * asks for it during the same render. Redirects to /login when signed out.
 */
export const getPageData = cache(async (): Promise<PageData> => {
  const user = await requireUser()
  return { user, ...(await buildAppData(user.id)) }
})
