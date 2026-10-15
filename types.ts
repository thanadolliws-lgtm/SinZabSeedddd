export type ActionResult<T = unknown> =
  | { ok: true; data: T; message?: string; duplicate?: boolean }
  | { ok: false; error: string; fields?: Record<string, string>; code?: 'unauthenticated' }
