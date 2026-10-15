'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ActionResult } from '@/actions/types'
import { Button, Checkbox, Field, Input, Modal, Select, Textarea, cx, useFeedback } from './ui'

/**
 * Runs a Server Action with the feedback every mutation needs:
 *  - `pending` to disable the button (no double submit from the UI)
 *  - a toast when it worked and, importantly, when it did NOT
 *  - redirect to /login when the session has expired
 */
export function useAction<I, T>(action: (input: I) => Promise<ActionResult<T>>, opts: { success?: string | ((data: T) => string); onSuccess?: (data: T) => void } = {}) {
  const { toast } = useFeedback()
  const router = useRouter()
  const [pending, setPending] = useState(false)
  // Latest options without re-creating run(): callbacks passed inline always see current props/state.
  const optsRef = useRef(opts)
  useEffect(() => {
    optsRef.current = opts
  })
  const run = useCallback(
    async (input: I): Promise<ActionResult<T>> => {
      setPending(true)
      try {
        const res = await action(input)
        if (res.ok) {
          const o = optsRef.current
          const msg = res.message ?? (typeof o.success === 'function' ? o.success(res.data) : o.success)
          if (msg) toast(res.duplicate ? 'info' : 'success', msg)
          o.onSuccess?.(res.data)
        } else {
          toast('error', res.error)
          if (res.code === 'unauthenticated') router.push('/login')
        }
        return res
      } catch {
        // network failure, server restart, or an outdated tab after a deploy
        const error = 'บันทึกไม่สำเร็จ: ติดต่อเซิร์ฟเวอร์ไม่ได้ ข้อมูลยังไม่ถูกบันทึก กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่'
        toast('error', error)
        return { ok: false, error }
      } finally {
        setPending(false)
      }
    },
    [action, toast, router],
  )
  return { run, pending }
}

/** A key that identifies one logical submission; the server refuses to save the same key twice. */
export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

// ---------------------------------------------------------------------------
// Declarative form in a modal
// ---------------------------------------------------------------------------
export type FormValues = Record<string, string | boolean>

export interface FieldDef {
  name: string
  label: string
  type?: 'text' | 'number' | 'date' | 'month' | 'select' | 'checkbox' | 'textarea'
  options?: { value: string; label: string }[]
  required?: boolean
  hint?: ReactNode | ((v: FormValues) => ReactNode)
  placeholder?: string
  step?: string
  min?: number
  max?: number | string
  /** span the full width of the 2-column grid */
  full?: boolean
  showIf?: (v: FormValues) => boolean
  disabled?: boolean | ((v: FormValues) => boolean)
}

function validateClient(fields: FieldDef[], v: FormValues): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const f of fields) {
    if (f.showIf && !f.showIf(v)) continue
    const raw = v[f.name]
    if (f.type === 'checkbox') continue
    const s = typeof raw === 'string' ? raw.trim() : ''
    if (f.required && s === '') {
      errors[f.name] = 'จำเป็นต้องกรอก'
      continue
    }
    if (s === '') continue
    if (f.type === 'number') {
      const n = Number(s)
      if (!Number.isFinite(n)) errors[f.name] = 'ต้องเป็นตัวเลข'
      else if (f.min !== undefined && n < f.min) errors[f.name] = `ต้องไม่น้อยกว่า ${f.min}`
      else if (typeof f.max === 'number' && n > f.max) errors[f.name] = `ต้องไม่เกิน ${f.max}`
    }
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) errors[f.name] = 'วันที่ไม่ถูกต้อง'
  }
  return errors
}

export function FormFields({ fields, values, errors, onChange }: { fields: FieldDef[]; values: FormValues; errors: Record<string, string>; onChange: (name: string, value: string | boolean) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {fields.map((f) => {
        if (f.showIf && !f.showIf(values)) return null
        const disabled = typeof f.disabled === 'function' ? f.disabled(values) : f.disabled
        const hint = typeof f.hint === 'function' ? f.hint(values) : f.hint
        const span = f.full || f.type === 'textarea' || f.type === 'checkbox' ? 'sm:col-span-2' : ''
        if (f.type === 'checkbox') {
          return (
            <div key={f.name} className={span}>
              <Checkbox label={f.label} checked={values[f.name] === true} disabled={disabled} onChange={(c) => onChange(f.name, c)} hint={typeof hint === 'string' ? hint : undefined} />
            </div>
          )
        }
        const common = { 'aria-invalid': !!errors[f.name], disabled, value: String(values[f.name] ?? ''), required: f.required }
        return (
          <Field key={f.name} label={f.label} required={f.required} error={errors[f.name]} hint={hint} className={span}>
            {f.type === 'select' ? (
              <Select {...common} onChange={(e) => onChange(f.name, e.target.value)}>
                {!f.required && <option value="">ไม่ระบุ</option>}
                {f.required && common.value === '' && <option value="">เลือก...</option>}
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : f.type === 'textarea' ? (
              <Textarea {...common} placeholder={f.placeholder} onChange={(e) => onChange(f.name, e.target.value)} />
            ) : (
              <Input
                {...common}
                type={f.type ?? 'text'}
                inputMode={f.type === 'number' ? 'decimal' : undefined}
                step={f.type === 'number' ? (f.step ?? 'any') : undefined}
                min={f.min}
                max={f.max}
                placeholder={f.placeholder}
                onChange={(e) => onChange(f.name, e.target.value)}
              />
            )}
          </Field>
        )
      })}
    </div>
  )
}

/**
 * Modal form driven by a field list. Validates in the browser for instant
 * feedback; the server validates again and its field errors are shown in place.
 * Mount it only while open (`{open && <FormModal ... />}`) so each opening
 * starts clean with a fresh idempotency key.
 */
export function FormModal<T = unknown>({
  title,
  fields,
  initial,
  action,
  onClose,
  success = 'บันทึกแล้ว',
  submitLabel = 'บันทึก',
  extra,
  validate,
  toInput,
  confirmBefore,
  wide,
  intro,
}: {
  title: string
  fields: FieldDef[]
  initial: FormValues
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  action: (input: any) => Promise<ActionResult<T>>
  onClose: () => void
  success?: string | ((data: T) => string)
  submitLabel?: string
  /** live content computed from the current values (totals, previews, warnings) */
  extra?: (v: FormValues) => ReactNode
  validate?: (v: FormValues) => Record<string, string>
  /** map form values to the action input; default sends the values as they are */
  toInput?: (v: FormValues) => Record<string, unknown>
  /** ask before submitting (edits of important records) */
  confirmBefore?: (v: FormValues) => { title: string; message: ReactNode; danger?: boolean } | null
  wide?: boolean
  intro?: ReactNode
}) {
  const [values, setValues] = useState<FormValues>(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [key] = useState(newIdempotencyKey)
  const { confirm } = useFeedback()
  const { run, pending } = useAction(action, { success, onSuccess: onClose })

  const onChange = (name: string, value: string | boolean) => {
    setValues((v) => ({ ...v, [name]: value }))
    setErrors((e) => (e[name] ? { ...e, [name]: '' } : e))
  }

  const submit = async () => {
    const found = { ...validateClient(fields, values), ...(validate?.(values) ?? {}) }
    if (Object.values(found).some(Boolean)) {
      setErrors(found)
      return
    }
    const ask = confirmBefore?.(values)
    if (ask && !(await confirm(ask))) return
    const res = await run({ ...(toInput ? toInput(values) : values), idempotencyKey: key })
    if (!res.ok && res.fields) setErrors(res.fields)
  }

  return (
    <Modal
      open
      onClose={pending ? () => {} : onClose}
      title={title}
      wide={wide}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            ยกเลิก
          </Button>
          <Button variant="primary" loading={pending} onClick={submit}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="space-y-3"
      >
        {intro}
        <FormFields fields={fields} values={values} errors={errors} onChange={onChange} />
        {extra?.(values)}
        {/* lets Enter submit the form */}
        <button type="submit" className="hidden" tabIndex={-1} aria-hidden="true" />
      </form>
    </Modal>
  )
}

/** Row action buttons used in tables. */
export function RowActions({ children }: { children: ReactNode }) {
  return <div className={cx('flex items-center justify-end gap-0.5')}>{children}</div>
}
