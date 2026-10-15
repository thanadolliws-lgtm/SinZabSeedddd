'use client'

import Link from 'next/link'
import { startTransition, useActionState, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Bell, Database, Download, Info, KeyRound, LogOut, RefreshCw, ShieldAlert, UserRound } from 'lucide-react'
import { exportAllAction, saveSettingsAction } from '@/actions/app'
import { changePasswordAction, deleteAccountAction, logoutAction, type FormState } from '@/actions/auth'
import { refreshMarketAction, type MarketRefreshResult } from '@/actions/market'
import type { EmergencyStatus } from '@/lib/calc/cash'
import type { FxRateInfo, SettingsRow } from '@/lib/calc/types'
import { MARKET_LABELS, type MarketCode } from '@/lib/market/exchanges'
import type { ProviderStatus } from '@/lib/market/service'
import { fmtDateTime, fmtMoney, fmtNum } from '@/lib/format'
import { useAction } from '@/components/forms'
import { downloadText } from '@/components/import-csv'
import { Badge, Button, Card, Checkbox, Field, Input, Notice, PageHeader, ProgressBar, Select, cx, useFeedback } from '@/components/ui'

const APP_VERSION = '0.1.0'

type Theme = 'system' | 'light' | 'dark'

/** Same behaviour as the header theme toggle: remember on this device and switch now. */
function applyThemeLocally(t: Theme) {
  try {
    localStorage.setItem('theme', t)
  } catch {}
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  // lets the header toggle (ThemeToggle) pick up the new value without a reload
  window.dispatchEvent(new Event('themechange'))
}

const SECTIONS = [
  { id: 'profile', label: 'โปรไฟล์และเกณฑ์' },
  { id: 'alerts', label: 'การแจ้งเตือน' },
  { id: 'market', label: 'ข้อมูลตลาดและ FX' },
  { id: 'security', label: 'ความปลอดภัย' },
  { id: 'data', label: 'ส่งออกและสำรองข้อมูล' },
  { id: 'danger', label: 'ลบบัญชี' },
  { id: 'about', label: 'เกี่ยวกับ' },
]

const TIMEZONES = [
  'Asia/Bangkok',
  'Asia/Ho_Chi_Minh',
  'Asia/Jakarta',
  'Asia/Kuala_Lumpur',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Shanghai',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
]

// ---------------------------------------------------------------------------
// Preferences form state (strings while editing; the server validates again)
// ---------------------------------------------------------------------------
const NUM_KEYS = ['emergencyMonths', 'essentialMonthlyExpense', 'maxPositionPct', 'maxCategoryPct', 'allocationDriftPct', 'staleQuoteHours', 'highInterestRate', 'dueSoonDays'] as const
type NumKey = (typeof NUM_KEYS)[number]

type Prefs = { displayName: string; theme: Theme; timezone: string; disabledAlerts: string[] } & Record<NumKey, string>

const RULES: Record<NumKey, { min: number; max: number; int?: boolean; optional?: boolean }> = {
  emergencyMonths: { min: 1, max: 60, int: true },
  essentialMonthlyExpense: { min: 0, max: 1e13, optional: true },
  maxPositionPct: { min: 1, max: 100 },
  maxCategoryPct: { min: 1, max: 100 },
  allocationDriftPct: { min: 0.5, max: 100 },
  staleQuoteHours: { min: 1, max: 720, int: true },
  highInterestRate: { min: 0, max: 100 },
  dueSoonDays: { min: 0, max: 60, int: true },
}

const s = (n: number | null) => (n === null ? '' : String(n))

function toPrefs(st: SettingsRow, displayName: string): Prefs {
  return {
    displayName,
    theme: st.theme,
    timezone: st.timezone,
    disabledAlerts: [...st.disabledAlerts],
    emergencyMonths: s(st.emergencyMonths),
    essentialMonthlyExpense: s(st.essentialMonthlyExpense),
    maxPositionPct: s(st.maxPositionPct),
    maxCategoryPct: s(st.maxCategoryPct),
    allocationDriftPct: s(st.allocationDriftPct),
    staleQuoteHours: s(st.staleQuoteHours),
    highInterestRate: s(st.highInterestRate),
    dueSoonDays: s(st.dueSoonDays),
  }
}

function normalize(p: Prefs): Prefs {
  const out: Prefs = { ...p, displayName: p.displayName.trim(), timezone: p.timezone.trim(), disabledAlerts: [...p.disabledAlerts].sort() }
  for (const k of NUM_KEYS) {
    const v = p[k].trim()
    const n = Number(v)
    out[k] = v === '' ? '' : Number.isFinite(n) ? String(n) : v
  }
  return out
}
const keyOf = (p: Prefs) => JSON.stringify(normalize(p))

function validate(p: Prefs): Record<string, string> {
  const e: Record<string, string> = {}
  if (p.displayName.trim().length > 80) e.displayName = 'ยาวเกิน 80 ตัวอักษร'
  if (!p.timezone.trim()) e.timezone = 'กรุณาเลือกเขตเวลา'
  for (const k of NUM_KEYS) {
    const r = RULES[k]
    const v = p[k].trim()
    if (v === '') {
      if (!r.optional) e[k] = 'จำเป็นต้องกรอก'
      continue
    }
    const n = Number(v)
    if (!Number.isFinite(n)) e[k] = 'ต้องเป็นตัวเลข'
    else if (r.int && !Number.isInteger(n)) e[k] = 'ต้องเป็นจำนวนเต็ม'
    else if (n < r.min || n > r.max) e[k] = r.optional ? (n < r.min ? 'ต้องไม่ติดลบ' : 'จำนวนมากเกินไป') : `ต้องอยู่ระหว่าง ${r.min}-${r.max}`
  }
  return e
}

function alertHint(type: string, p: Prefs): string | undefined {
  const v = (x: string) => x.trim() || '?'
  switch (type) {
    case 'emergency_low':
      return `เงินในบัญชีเงินสำรองต่ำกว่า ค่าใช้จ่ายจำเป็นต่อเดือน × ${v(p.emergencyMonths)} เดือน`
    case 'debt_due_soon':
      return `ยอดขั้นต่ำที่ยังค้างและครบกำหนดภายใน ${v(p.dueSoonDays)} วัน`
    case 'debt_overdue':
      return 'ยอดชำระขั้นต่ำที่เลยวันครบกำหนดแล้วยังไม่ได้ชำระ'
    case 'bill_due':
      return `รายจ่ายที่ยังไม่จ่ายซึ่งครบกำหนดภายใน ${v(p.dueSoonDays)} วัน หรือเลยกำหนดแล้ว`
    case 'over_budget':
      return 'ใช้จ่ายเกินงบรายเดือนที่ตั้งไว้ในหน้าบริหารเงิน'
    case 'dca_over_cash':
      return 'งบ DCA ที่เหลือของเดือนมากกว่าเงินพร้อมใช้ + เงินสดในบัญชีโบรกเกอร์'
    case 'allocation_drift':
      return `สัดส่วนจริงต่างจากเป้าหมายในแผน DCA เกิน ${v(p.allocationDriftPct)}%`
    case 'position_concentration':
      return `หุ้นรายตัวมีสัดส่วนเกิน ${v(p.maxPositionPct)}% ของพอร์ตรวม`
    case 'category_concentration':
      return `หมวดธุรกิจมีสัดส่วนเกิน ${v(p.maxCategoryPct)}% ของพอร์ตรวม`
    case 'stale_price':
      return `หุ้นที่ถืออยู่ไม่มีราคา หรือราคาเก่ากว่า ${v(p.staleQuoteHours)} ชั่วโมง`
    case 'missing_fx':
      return 'ไม่มีอัตราแลกเปลี่ยนของสกุลเงินที่ใช้ จึงรวมเป็นเงินบาทไม่ได้'
    case 'data_issue':
      return 'ประวัติธุรกรรมขัดแย้งกัน เช่น ขายเกินจำนวนที่ถือ (แสดงในหน้าประวัติธุรกรรม)'
    case 'market_api':
      return 'ยังไม่ได้ตั้งค่า Market Data API ของตลาดที่มีหลักทรัพย์ หรือดึงข้อมูลล่าสุดไม่สำเร็จ'
    default:
      return undefined
  }
}

const SOURCE_TEXT: Record<EmergencyStatus['essentialSource'], string> = {
  setting: 'จากค่าที่ตั้งไว้ในช่องนี้',
  average: 'เฉลี่ยจากรายจ่ายที่ระบุว่า “จำเป็น” ใน 3 เดือนล่าสุดที่มีข้อมูล (หรือเดือนนี้ ถ้ายังไม่มีเดือนก่อนหน้า)',
  none: 'ยังคำนวณไม่ได้: ยังไม่มีรายจ่ายที่ระบุว่าจำเป็น',
}

const EMPTY_FORM: FormState = {}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function SettingsView({
  email,
  displayName,
  settings,
  emergency,
  alertTypes,
  providers,
  fx,
  missingFx,
  marketsInUse,
  baseCurrency,
  today,
  generatedAt,
}: {
  email: string
  displayName: string
  settings: SettingsRow
  emergency: EmergencyStatus
  alertTypes: Record<string, string>
  providers: ProviderStatus[]
  fx: Record<string, FxRateInfo & { fetchedAt: string }>
  missingFx: string[]
  marketsInUse: MarketCode[]
  baseCurrency: string
  today: string
  generatedAt: string
}) {
  const { toast } = useFeedback()
  const timezone = settings.timezone
  const initial = useMemo(() => toPrefs(settings, displayName), [settings, displayName])
  const [prefs, setPrefs] = useState<Prefs>(initial)
  const [prevInitial, setPrevInitial] = useState<Prefs>(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Saved settings changed underneath us (e.g. the theme toggle in the header):
  // follow them, unless the user has unsaved edits here.
  if (keyOf(prevInitial) !== keyOf(initial)) {
    if (keyOf(prefs) === keyOf(prevInitial)) setPrefs(initial)
    setPrevInitial(initial)
  }
  const dirty = keyOf(prefs) !== keyOf(initial)

  const saver = useAction(saveSettingsAction, { success: 'บันทึกการตั้งค่าแล้ว' })
  const setField = <K extends keyof Prefs>(k: K, v: Prefs[K]) => {
    setPrefs((p) => ({ ...p, [k]: v }))
    setErrors((e) => (e[k] ? { ...e, [k]: '' } : e))
  }

  const save = async () => {
    const found = validate(prefs)
    setErrors(found)
    if (Object.keys(found).length > 0) {
      toast('error', 'ยังบันทึกไม่ได้: กรุณาแก้ไขช่องที่มีข้อความสีแดง')
      return
    }
    const sent = normalize(prefs)
    const res = await saver.run({ ...sent })
    if (res.ok) {
      applyThemeLocally(sent.theme)
      setPrefs(sent)
    } else if (res.fields) setErrors(res.fields)
  }

  const saveBar = (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
      {dirty && <span className="mr-auto text-xs text-warn">มีการเปลี่ยนแปลงที่ยังไม่บันทึก</span>}
      <Button
        disabled={!dirty || saver.pending}
        onClick={() => {
          setPrefs(initial)
          setErrors({})
        }}
      >
        ยกเลิกการเปลี่ยนแปลง
      </Button>
      <Button variant="primary" loading={saver.pending} disabled={!dirty} onClick={() => void save()}>
        บันทึกการตั้งค่า
      </Button>
    </div>
  )

  return (
    <div className="space-y-5">
      <PageHeader title="ตั้งค่า (Settings)" subtitle="โปรไฟล์ เกณฑ์การเตือน ข้อมูลตลาด ความปลอดภัย และการสำรองข้อมูล" />

      <nav aria-label="หัวข้อในหน้าตั้งค่า" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {SECTIONS.map((x) => (
          <a key={x.id} href={`#${x.id}`} className="whitespace-nowrap rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text">
            {x.label}
          </a>
        ))}
      </nav>

      <Section id="profile">
        <Card title={<Title icon={<UserRound size={15} />}>โปรไฟล์ การแสดงผล และเกณฑ์การคำนวณ</Title>} subtitle="ค่าที่นี่ใช้กับทุกหน้า: เงินสำรองฉุกเฉิน การแจ้งเตือน และการวิเคราะห์">
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              if (dirty) void save()
            }}
            className="space-y-5"
          >
            <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">โปรไฟล์และการแสดงผล</legend>
              <Field label="อีเมลบัญชี" hint="ใช้เข้าสู่ระบบ เปลี่ยนจากหน้านี้ไม่ได้">
                <Input value={email} readOnly disabled />
              </Field>
              <Field label="ชื่อที่ใช้แสดง (Display name)" error={errors.displayName} hint="ไม่บังคับ แสดงที่มุมขวาบน">
                <Input value={prefs.displayName} maxLength={80} autoComplete="nickname" aria-invalid={!!errors.displayName} onChange={(e) => setField('displayName', e.target.value)} />
              </Field>
              <Field label="ธีม (Theme)" hint="เมื่อบันทึก จะเปลี่ยนธีมของอุปกรณ์นี้ทันที">
                <Select value={prefs.theme} onChange={(e) => setField('theme', e.target.value as Theme)}>
                  <option value="system">ตามระบบ (System)</option>
                  <option value="light">สว่าง (Light)</option>
                  <option value="dark">มืด (Dark)</option>
                </Select>
              </Field>
              <Field label="เขตเวลา (Timezone)" error={errors.timezone} hint="กำหนด “วันนี้” ที่ใช้คำนวณยอดรายเดือน วันครบกำหนด และเวลาที่แสดง" className="sm:col-span-2 lg:col-span-1">
                <Select value={prefs.timezone} aria-invalid={!!errors.timezone} onChange={(e) => setField('timezone', e.target.value)}>
                  {[...new Set([prefs.timezone, ...TIMEZONES])].filter(Boolean).map((tz) => (
                    <option key={tz} value={tz}>
                      {tz === 'Asia/Bangkok' ? 'Asia/Bangkok (เวลาประเทศไทย)' : tz}
                    </option>
                  ))}
                </Select>
              </Field>
            </fieldset>

            <fieldset className="grid gap-3 sm:grid-cols-2">
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">เงินสำรองฉุกเฉิน (Emergency Fund)</legend>
              <div>
                <Field label="จำนวนเดือนที่ต้องการสำรอง" required error={errors.emergencyMonths} hint="ทั่วไป: รายได้ประจำ 3-6 เดือน · อาชีพอิสระหรือรายได้ไม่แน่นอน 6-12 เดือน">
                  <Input type="number" inputMode="numeric" min={1} max={60} step={1} value={prefs.emergencyMonths} aria-invalid={!!errors.emergencyMonths} onChange={(e) => setField('emergencyMonths', e.target.value)} />
                </Field>
                <div className="mt-1.5 flex gap-1.5" role="group" aria-label="จำนวนเดือนที่แนะนำ">
                  {[3, 6, 12].map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={prefs.emergencyMonths.trim() === String(m)}
                      onClick={() => setField('emergencyMonths', String(m))}
                      className={cx('rounded-full border px-2.5 py-0.5 text-xs transition', prefs.emergencyMonths.trim() === String(m) ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:bg-surface-2 hover:text-text')}
                    >
                      {m} เดือน
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Field
                  label={`ค่าใช้จ่ายจำเป็นต่อเดือน (${baseCurrency})`}
                  error={errors.essentialMonthlyExpense}
                  hint="เว้นว่าง (หรือ 0) = ให้ระบบคำนวณจากรายจ่ายที่ระบุว่าจำเป็นซึ่งบันทึกไว้"
                >
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    value={prefs.essentialMonthlyExpense}
                    placeholder={emergency.essentialSource === 'average' && emergency.essentialMonthly !== null ? `คำนวณได้ ${fmtNum(emergency.essentialMonthly, 2)}` : 'เว้นว่างเพื่อคำนวณอัตโนมัติ'}
                    aria-invalid={!!errors.essentialMonthlyExpense}
                    onChange={(e) => setField('essentialMonthlyExpense', e.target.value)}
                  />
                </Field>
                <EssentialInfo emergency={emergency} baseCurrency={baseCurrency} prefs={prefs} onUse={(v) => setField('essentialMonthlyExpense', v)} />
              </div>
            </fieldset>

            <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">เกณฑ์การเตือนและการวิเคราะห์ (Thresholds)</legend>
              <p className="text-xs text-muted sm:col-span-2 lg:col-span-3">ค่าเหล่านี้กำหนดว่าการแจ้งเตือนในส่วนถัดไปจะเกิดขึ้นเมื่อใด</p>
              <NumField k="maxPositionPct" label="สัดส่วนสูงสุดของหุ้นรายตัว (%)" hint="เตือนเมื่อหุ้นตัวใดมีสัดส่วนเกินค่านี้ของพอร์ตรวม (1-100)" prefs={prefs} errors={errors} onChange={setField} />
              <NumField k="maxCategoryPct" label="สัดส่วนสูงสุดต่อหมวดธุรกิจ (%)" hint="เตือนเมื่อหมวดธุรกิจใดมีสัดส่วนเกินค่านี้ของพอร์ตรวม (1-100)" prefs={prefs} errors={errors} onChange={setField} />
              <NumField k="allocationDriftPct" label="ยอมให้สัดส่วนแผน DCA คลาดเคลื่อน (%)" hint="เตือนเมื่อสัดส่วนจริงต่างจากเป้าหมายในแผน DCA เกินค่านี้ (0.5-100)" prefs={prefs} errors={errors} onChange={setField} />
              <NumField k="staleQuoteHours" label="ราคาถือว่าเก่าเมื่อเกิน (ชั่วโมง)" hint="ราคาที่เก่ากว่านี้แสดงป้าย “เก่า” และแจ้งเตือน (1-720)" prefs={prefs} errors={errors} onChange={setField} integer />
              <NumField k="highInterestRate" label="ดอกเบี้ยที่ถือว่าสูง (% ต่อปี)" hint="หนี้ที่ดอกเบี้ยตั้งแต่ค่านี้ถูกจัดเป็นหนี้ดอกเบี้ยสูง และระบบแนะนำให้ชำระก่อนลงทุนเพิ่ม (0-100)" prefs={prefs} errors={errors} onChange={setField} />
              <NumField k="dueSoonDays" label="เตือนก่อนครบกำหนด (วัน)" hint="เตือนหนี้และรายจ่ายที่ครบกำหนดภายในจำนวนวันนี้ (0-60)" prefs={prefs} errors={errors} onChange={setField} integer />
            </fieldset>

            {saveBar}
            <button type="submit" className="hidden" tabIndex={-1} aria-hidden="true" />
          </form>
        </Card>
      </Section>

      <Section id="alerts">
        <AlertsCard alertTypes={alertTypes} prefs={prefs} onToggle={(type, on) => setField('disabledAlerts', on ? prefs.disabledAlerts.filter((x) => x !== type) : [...prefs.disabledAlerts, type])} footer={saveBar} />
      </Section>

      <Section id="market">
        <MarketCard providers={providers} fx={fx} missingFx={missingFx} marketsInUse={marketsInUse} baseCurrency={baseCurrency} timezone={timezone} />
      </Section>

      <Section id="security">
        <SecurityCard email={email} />
      </Section>

      <Section id="data">
        <DataCard today={today} />
      </Section>

      <Section id="danger">
        <DangerCard email={email} />
      </Section>

      <Section id="about">
        <Card title={<Title icon={<Info size={15} />}>เกี่ยวกับ (About)</Title>}>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted">เวอร์ชัน</dt>
            <dd className="num">Sinsap {APP_VERSION}</dd>
            <dt className="text-muted">การจัดเก็บข้อมูล</dt>
            <dd>ข้อมูลทั้งหมดเก็บในฐานข้อมูลบนเซิร์ฟเวอร์และแยกตามผู้ใช้ด้วย Row Level Security</dd>
            <dt className="text-muted">บัญชีที่เข้าสู่ระบบ</dt>
            <dd className="break-all">{email}</dd>
            <dt className="text-muted">ข้อมูลในหน้านี้ ณ</dt>
            <dd className="num">{fmtDateTime(generatedAt, timezone)}</dd>
          </dl>
        </Card>
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------
function Section({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div id={id} className="scroll-mt-16">
      {children}
    </div>
  )
}

function Title({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-muted">{icon}</span>
      {children}
    </span>
  )
}

function Code({ children }: { children: ReactNode }) {
  return <code className="break-all rounded bg-surface-2 px-1 py-0.5 font-mono text-[12px]">{children}</code>
}

function NumField({
  k,
  label,
  hint,
  prefs,
  errors,
  onChange,
  integer,
}: {
  k: NumKey
  label: string
  hint: string
  prefs: Prefs
  errors: Record<string, string>
  onChange: (k: NumKey, v: string) => void
  integer?: boolean
}) {
  const r = RULES[k]
  return (
    <Field label={label} required error={errors[k]} hint={hint}>
      <Input type="number" inputMode={integer ? 'numeric' : 'decimal'} min={r.min} max={r.max} step={integer ? 1 : 'any'} value={prefs[k]} aria-invalid={!!errors[k]} onChange={(e) => onChange(k, e.target.value)} />
    </Field>
  )
}

function EssentialInfo({ emergency, baseCurrency, prefs, onUse }: { emergency: EmergencyStatus; baseCurrency: string; prefs: Prefs; onUse: (v: string) => void }) {
  const typed = prefs.essentialMonthlyExpense.trim() === '' ? null : Number(prefs.essentialMonthlyExpense)
  const months = Number(prefs.emergencyMonths)
  // Preview only from numbers we actually have: what the user typed, or the value the system computed.
  const monthly = typed !== null && Number.isFinite(typed) && typed > 0 ? typed : emergency.essentialSource === 'average' ? emergency.essentialMonthly : null
  const target = monthly !== null && Number.isInteger(months) && months > 0 ? monthly * months : null
  return (
    <div className="mt-2 space-y-1 rounded-lg bg-surface-2 p-2.5 text-xs">
      <div>
        <span className="text-muted">ค่าที่ระบบใช้อยู่ตอนนี้: </span>
        <span className="num font-medium">{emergency.essentialMonthly !== null ? `${fmtMoney(emergency.essentialMonthly, baseCurrency)} / เดือน` : '—'}</span>
      </div>
      <div className="text-muted">ที่มา: {SOURCE_TEXT[emergency.essentialSource]}</div>
      {emergency.essentialSource === 'setting' && <div className="text-muted">ถ้าล้างช่องนี้แล้วบันทึก ระบบจะเปลี่ยนไปคำนวณจากรายจ่ายจำเป็นที่บันทึกไว้แทน (ถ้ามี)</div>}
      {emergency.essentialSource === 'average' && emergency.essentialMonthly !== null && prefs.essentialMonthlyExpense.trim() === '' && (
        <button type="button" className="text-accent hover:underline" onClick={() => onUse(String(emergency.essentialMonthly))}>
          ตรึงค่านี้ไว้เป็นค่าที่ตั้งเอง
        </button>
      )}
      <div className="border-t border-line pt-1">
        <span className="text-muted">เป้าหมายเงินสำรองตามค่าในฟอร์ม: </span>
        {target !== null ? (
          <span className="num font-medium">
            {fmtMoney(target, baseCurrency)} <span className="font-normal text-muted">({fmtMoney(monthly, baseCurrency)} × {months} เดือน)</span>
          </span>
        ) : (
          <span className="text-muted">ยังคำนวณไม่ได้ (ต้องมีค่าใช้จ่ายจำเป็นต่อเดือน)</span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
function AlertsCard({ alertTypes, prefs, onToggle, footer }: { alertTypes: Record<string, string>; prefs: Prefs; onToggle: (type: string, on: boolean) => void; footer: ReactNode }) {
  const types = Object.keys(alertTypes)
  const off = new Set(prefs.disabledAlerts)
  const onCount = types.filter((t) => !off.has(t)).length
  return (
    <Card
      title={<Title icon={<Bell size={15} />}>การแจ้งเตือน (Alerts)</Title>}
      subtitle={`เปิดอยู่ ${onCount} จาก ${types.length} ประเภท · แสดงในหน้าภาพรวมและคำนวณใหม่จากข้อมูลที่บันทึกทุกครั้งที่เปิดหน้า`}
    >
      <div className="space-y-3">
        <p className="text-xs text-muted">ติ๊กออกเพื่อซ่อนการแจ้งเตือนประเภทนั้น เกณฑ์ตัวเลข (เช่น สัดส่วนสูงสุด จำนวนวันก่อนครบกำหนด) ตั้งได้ในส่วน “เกณฑ์การเตือนและการวิเคราะห์” ด้านบน</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {types.map((t) => (
            <Checkbox key={t} label={alertTypes[t]} hint={alertHint(t, prefs)} checked={!off.has(t)} onChange={(on) => onToggle(t, on)} />
          ))}
        </div>
        {footer}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Market data & FX
// ---------------------------------------------------------------------------
const PROVIDER_ENVS: Record<MarketCode, string[]> = {
  US: ['TWELVEDATA_API_KEY', 'EODHD_API_KEY', 'ALPHAVANTAGE_API_KEY'],
  TH: ['EODHD_API_KEY', 'TWELVEDATA_API_KEY'],
}

const ENV_VARS: { name: string; detail: string }[] = [
  { name: 'TWELVEDATA_API_KEY', detail: 'Twelve Data: ตลาดสหรัฐฯ (ลำดับแรก) และตลาดไทย (ลำดับสอง ต้องเป็นแพ็กเกจที่รองรับ SET)' },
  { name: 'EODHD_API_KEY', detail: 'EODHD: ตลาดไทย (ลำดับแรก) และตลาดสหรัฐฯ (ลำดับสอง)' },
  { name: 'ALPHAVANTAGE_API_KEY', detail: 'Alpha Vantage: ตลาดสหรัฐฯ (ลำดับสาม คีย์ฟรีเป็นราคาปิดสิ้นวัน)' },
  { name: 'MARKET_PROVIDER_US, MARKET_PROVIDER_TH', detail: 'ไม่บังคับ: บังคับใช้ผู้ให้บริการรายเดียวของตลาดนั้น ค่า twelvedata, eodhd หรือ alphavantage' },
  { name: 'TWELVEDATA_PER_DAY, EODHD_PER_MINUTE, ...', detail: 'ไม่บังคับ: ปรับโควตาต่อนาที/ต่อวันให้ตรงกับแพ็กเกจที่สมัคร (รูปแบบ <ผู้ให้บริการ>_PER_MINUTE และ _PER_DAY)' },
]

function MarketCard({
  providers,
  fx,
  missingFx,
  marketsInUse,
  baseCurrency,
  timezone,
}: {
  providers: ProviderStatus[]
  fx: Record<string, FxRateInfo & { fetchedAt: string }>
  missingFx: string[]
  marketsInUse: MarketCode[]
  baseCurrency: string
  timezone: string
}) {
  const [report, setReport] = useState<MarketRefreshResult | null>(null)
  const refresher = useAction(refreshMarketAction, { onSuccess: (d) => setReport(d) })
  const fxRows = Object.entries(fx)
    .filter(([c]) => c !== baseCurrency)
    .sort(([a], [b]) => a.localeCompare(b))

  return (
    <Card
      title={<Title icon={<Database size={15} />}>ข้อมูลตลาดและอัตราแลกเปลี่ยน (Market Data & FX)</Title>}
      subtitle="สถานะผู้ให้บริการ โควตาที่ใช้ไป และอัตราแลกเปลี่ยนที่ระบบใช้คำนวณมูลค่าเป็นเงินบาท"
      actions={
        <Button size="sm" icon={<RefreshCw size={14} />} loading={refresher.pending} title="บังคับดึงราคาและอัตราแลกเปลี่ยนใหม่ทุกรายการตอนนี้ (ใช้โควตา API ตามจำนวนหลักทรัพย์)" onClick={() => void refresher.run({ force: true })}>
          ดึงข้อมูลใหม่ทั้งหมดตอนนี้
        </Button>
      }
    >
      <div className="space-y-4">
        <Notice tone="info" title="API Key อยู่ใน Environment Variables ของเซิร์ฟเวอร์เท่านั้น">
          <p>
            ระบบอ่านคีย์จากตัวแปรสภาพแวดล้อมของเซิร์ฟเวอร์ (เช่น ไฟล์ .env.local หรือหน้าตั้งค่าของผู้ให้บริการโฮสติ้ง) ไม่ส่งคีย์ไปยังเบราว์เซอร์และไม่เก็บคีย์ในฐานข้อมูล จึงตั้งค่าคีย์จากหน้านี้ไม่ได้ หลังแก้ค่าให้รีสตาร์ตเซิร์ฟเวอร์หรือ deploy ใหม่
          </p>
          <p className="mt-1">
            ก่อนใช้งาน โปรดตรวจสอบเงื่อนไขการใช้งาน สัญญาอนุญาต (Licence) และเงื่อนไขการแสดงผลข้อมูล (Display terms) ของผู้ให้บริการแต่ละราย เช่น การจำกัดให้ใช้ส่วนตัว การห้ามเผยแพร่ต่อ หรือการต้องระบุแหล่งที่มา
          </p>
        </Notice>

        {report && <RefreshReport report={report} timezone={timezone} onClose={() => setReport(null)} />}

        <div className="grid gap-3 md:grid-cols-2">
          {providers.map((p) => (
            <ProviderBox key={p.market} p={p} inUse={marketsInUse.includes(p.market)} timezone={timezone} />
          ))}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold">ตัวแปรที่ใช้เปิดผู้ให้บริการ (Environment Variables)</h3>
          <dl className="divide-y divide-line rounded-lg border border-line text-[13px]">
            {ENV_VARS.map((v) => (
              <div key={v.name} className="grid gap-1 px-3 py-2 sm:grid-cols-[minmax(0,18rem)_1fr] sm:gap-3">
                <dt>
                  <Code>{v.name}</Code>
                </dt>
                <dd className="text-muted">{v.detail}</dd>
              </div>
            ))}
            <div className="grid gap-1 px-3 py-2 sm:grid-cols-[minmax(0,18rem)_1fr] sm:gap-3">
              <dt className="font-medium">อัตราแลกเปลี่ยน (FX)</dt>
              <dd className="text-muted">ใช้ Frankfurter (อัตราอ้างอิงที่ธนาคารกลางเผยแพร่) ไม่ต้องใช้ API Key หากเรียกไม่สำเร็จจะใช้ open.er-api.com เป็นแหล่งสำรองสำหรับอัตราล่าสุด</dd>
            </div>
          </dl>
        </div>

        <div>
          <h3 className="mb-1 text-sm font-semibold">อัตราแลกเปลี่ยนที่ใช้อยู่</h3>
          <p className="mb-2 text-xs text-muted">อัตรากลางอ้างอิง ไม่ใช่อัตราที่ธนาคารหรือโบรกเกอร์ให้จริง ใช้ประเมินมูลค่าวันนี้เท่านั้น ส่วนต้นทุนของแต่ละธุรกรรมใช้อัตราที่คุณบันทึกไว้ในธุรกรรมนั้น</p>
          {missingFx.length > 0 && (
            <Notice tone="warning" className="mb-2" title={`ไม่มีอัตราแลกเปลี่ยนของ ${missingFx.join(', ')}`}>
              ยอดในสกุลเงินนี้ยังไม่ถูกรวมในยอดรวมเงินบาท ลองกด “ดึงข้อมูลใหม่ทั้งหมดตอนนี้” หรือรอการอัปเดตอัตโนมัติ
            </Notice>
          )}
          {fxRows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-sm text-muted">ยังไม่มีอัตราแลกเปลี่ยนที่เก็บไว้ (ยังไม่มีหลักทรัพย์หรือบัญชีในสกุลเงินต่างประเทศ หรือยังดึงข้อมูลไม่สำเร็จ)</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full min-w-max text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2/60 text-xs text-muted">
                    <th className="px-3 py-2 text-left font-medium">สกุลเงิน</th>
                    <th className="px-3 py-2 text-right font-medium">
                      {baseCurrency} ต่อ 1 หน่วย
                    </th>
                    <th className="px-3 py-2 text-left font-medium">วันที่ของอัตรา</th>
                    <th className="px-3 py-2 text-left font-medium">แหล่งข้อมูล</th>
                    <th className="px-3 py-2 text-left font-medium">ดึงข้อมูลเมื่อ</th>
                  </tr>
                </thead>
                <tbody>
                  {fxRows.map(([ccy, r]) => (
                    <tr key={ccy} className="border-b border-line/70 last:border-0">
                      <td className="px-3 py-2 font-medium">{ccy}</td>
                      <td className="num px-3 py-2 text-right">{fmtNum(r.rate, 4)}</td>
                      <td className="num px-3 py-2">{r.date}</td>
                      <td className="px-3 py-2 text-xs">{r.source}</td>
                      <td className="num px-3 py-2 text-xs text-muted">{fmtDateTime(r.fetchedAt, timezone)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

function ProviderBox({ p, inUse, timezone }: { p: ProviderStatus; inUse: boolean; timezone: string }) {
  const dayPct = p.limits && p.usage && p.limits.perDay > 0 ? (p.usage.lastDay / p.limits.perDay) * 100 : 0
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium">
          ตลาด{MARKET_LABELS[p.market]} ({p.market})
        </div>
        <Badge tone={!p.configured ? 'neutral' : p.lastError ? 'warn' : 'gain'}>{!p.configured ? 'ยังไม่ได้ตั้งค่า' : p.lastError ? 'ตั้งค่าแล้ว · ครั้งล่าสุดผิดพลาด' : 'ตั้งค่าแล้ว'}</Badge>
      </div>
      <p className="mt-0.5 text-xs text-muted">{inUse ? 'มีหลักทรัพย์ในตลาดนี้' : 'ยังไม่มีหลักทรัพย์ในตลาดนี้'}</p>
      {p.configured ? (
        <>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
            <dt className="text-muted">ผู้ให้บริการ</dt>
            <dd className="font-medium">{p.label}</dd>
            <dt className="text-muted">ความสดของข้อมูล</dt>
            <dd>{p.freshnessNote}</dd>
            {p.limits && (
              <>
                <dt className="text-muted">โควตาที่ตั้งไว้</dt>
                <dd className="num">
                  {p.limits.perMinute} ครั้ง/นาที · {p.limits.perDay} ครั้ง/24 ชม.
                </dd>
              </>
            )}
            {p.usage && p.limits && (
              <>
                <dt className="text-muted">ใช้ไปแล้ว</dt>
                <dd className="num">
                  {p.usage.lastMinute}/{p.limits.perMinute} ใน 1 นาที · {p.usage.lastDay}/{p.limits.perDay} ใน 24 ชม.
                  <div className="mt-1">
                    <ProgressBar value={p.usage.lastDay} max={p.limits.perDay} tone={dayPct >= 90 ? 'loss' : dayPct >= 70 ? 'warn' : 'accent'} />
                  </div>
                </dd>
              </>
            )}
            <dt className="text-muted">ดึงสำเร็จล่าสุด</dt>
            <dd className="num">{p.lastSuccessAt ? fmtDateTime(p.lastSuccessAt, timezone) : 'ยังไม่เคย'}</dd>
          </dl>
          {p.lastError && (
            <Notice tone="warning" className="mt-2" title={`ผิดพลาดล่าสุด ${fmtDateTime(p.lastError.at, timezone)}`}>
              <span className="break-words">{p.lastError.message}</span>
            </Notice>
          )}
        </>
      ) : (
        <p className="mt-2 text-[13px] leading-relaxed">
          ระบบจะไม่ดึงราคาอัตโนมัติสำหรับตลาดนี้ ยังบันทึกราคาเองได้ในหน้าตลาดหุ้นหรือพอร์ต เปิดใช้โดยตั้งค่าอย่างน้อยหนึ่งตัวแปร:{' '}
          {PROVIDER_ENVS[p.market].map((e, i) => (
            <span key={e}>
              {i > 0 && ' หรือ '}
              <Code>{e}</Code>
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

function Line({ tone, label, items }: { tone?: string; label: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <li>
      <span className={cx('font-medium', tone)}>
        {label} ({items.length}):
      </span>{' '}
      <span className="break-words">{items.join(', ')}</span>
    </li>
  )
}

function RefreshReport({ report, timezone, onClose }: { report: MarketRefreshResult; timezone: string; onClose: () => void }) {
  const failed = report.errors.length > 0 || report.fxErrors.length > 0
  const nothing = report.refreshed.length === 0 && report.alreadyFresh === 0 && report.skippedQuota.length === 0 && report.errors.length === 0 && report.noProvider.length === 0 && report.fxRefreshed.length === 0 && report.fxErrors.length === 0 && report.historyUpdated === 0
  return (
    <div role="status" className={cx('rounded-lg border p-3 text-sm', failed ? 'border-warn bg-warn-soft' : 'border-line bg-surface-2/50')}>
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="font-medium">ผลการดึงข้อมูล ณ {fmtDateTime(report.at, timezone)}</div>
        <button type="button" className="text-xs text-muted hover:text-text" onClick={onClose}>
          ปิด
        </button>
      </div>
      {nothing ? (
        <p className="text-[13px] text-muted">ไม่มีรายการที่ต้องอัปเดต (ยังไม่มีหลักทรัพย์ที่ใช้งานอยู่ หรือสกุลเงินต่างประเทศ)</p>
      ) : (
        <ul className="space-y-1 text-[13px]">
          <Line tone="text-gain" label="อัปเดตราคาแล้ว" items={report.refreshed} />
          {report.alreadyFresh > 0 && <li>ราคาเป็นข้อมูลล่าสุดอยู่แล้ว {report.alreadyFresh} รายการ</li>}
          <Line tone="text-warn" label="ข้ามเพราะครบโควตา API" items={report.skippedQuota} />
          <Line label="ไม่มีผู้ให้บริการสำหรับตลาด" items={report.noProvider} />
          {report.errors.length > 0 && (
            <li>
              <span className="font-medium text-loss">ดึงราคาไม่สำเร็จ ({report.errors.length}):</span>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                {report.errors.map((e, i) => (
                  <li key={`${e.symbol}-${i}`} className="break-words">
                    {e.symbol}: {e.message}
                  </li>
                ))}
              </ul>
            </li>
          )}
          <Line tone="text-gain" label="อัปเดตอัตราแลกเปลี่ยนแล้ว" items={report.fxRefreshed} />
          <Line tone="text-loss" label="อัตราแลกเปลี่ยนผิดพลาด" items={report.fxErrors} />
          {report.historyUpdated > 0 && <li>อัปเดตราคาย้อนหลังรายวัน {report.historyUpdated} หลักทรัพย์</li>}
        </ul>
      )}
      <p className="mt-1.5 text-xs text-muted">ราคาที่ดึงไม่สำเร็จยังแสดงเป็นข้อมูลที่เก็บไว้ (Cached) พร้อมเวลาจริงของราคา</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------
function SecurityCard({ email }: { email: string }) {
  const [state, action, pending] = useActionState(changePasswordAction, EMPTY_FORM)
  return (
    <Card title={<Title icon={<KeyRound size={15} />}>ความปลอดภัย (Security)</Title>} subtitle="เปลี่ยนรหัสผ่านจะออกจากระบบในอุปกรณ์อื่นทั้งหมด อุปกรณ์นี้ยังเข้าสู่ระบบอยู่">
      <div className="space-y-4">
        <form action={action} className="grid gap-3 sm:grid-cols-2">
          {/* lets password managers attach the new password to the right account */}
          <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
          {state.error && (
            <Notice tone="danger" className="sm:col-span-2">
              {state.error}
            </Notice>
          )}
          {state.message && (
            <Notice tone="success" className="sm:col-span-2">
              {state.message}
            </Notice>
          )}
          <Field label="รหัสผ่านปัจจุบัน" required className="sm:col-span-2">
            <Input name="currentPassword" type="password" autoComplete="current-password" required />
          </Field>
          <Field label="รหัสผ่านใหม่" required hint="อย่างน้อย 10 ตัวอักษร ประโยคยาว ๆ จำง่ายและปลอดภัยกว่า">
            <Input name="newPassword" type="password" autoComplete="new-password" minLength={10} required />
          </Field>
          <Field label="ยืนยันรหัสผ่านใหม่" required>
            <Input name="confirmPassword" type="password" autoComplete="new-password" minLength={10} required />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" variant="primary" loading={pending}>
              เปลี่ยนรหัสผ่าน
            </Button>
          </div>
        </form>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <p className="text-sm text-muted">ออกจากระบบในอุปกรณ์นี้</p>
          <form action={logoutAction}>
            <Button type="submit" icon={<LogOut size={15} />}>
              ออกจากระบบ
            </Button>
          </form>
        </div>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Export & backup
// ---------------------------------------------------------------------------
function DataCard({ today }: { today: string }) {
  const { toast } = useFeedback()
  const exporter = useAction(exportAllAction)
  const exportJson = async () => {
    const res = await exporter.run(undefined)
    if (res.ok) {
      downloadText(`sinsap-export-${today}.json`, res.data, 'application/json')
      toast('success', 'ดาวน์โหลดข้อมูลทั้งหมดแล้ว ไฟล์นี้มีข้อมูลการเงินส่วนตัว เก็บไว้ในที่ปลอดภัย')
    }
  }
  return (
    <Card title={<Title icon={<Download size={15} />}>ส่งออกและสำรองข้อมูล (Export & Backup)</Title>}>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" icon={<Download size={15} />} loading={exporter.pending} onClick={() => void exportJson()}>
            ดาวน์โหลดข้อมูลทั้งหมด (JSON)
          </Button>
          <Link href="/history" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 text-sm font-medium hover:bg-surface-2">
            ส่งออก CSV ที่หน้าประวัติธุรกรรม
          </Link>
        </div>
        <ul className="list-disc space-y-1 pl-5 text-[13px] leading-relaxed">
          <li>ไฟล์ JSON มีข้อมูลทั้งหมดของบัญชีนี้: บัญชีเงิน หลักทรัพย์ ธุรกรรม รายรับ-รายจ่าย หนี้ แผน DCA เป้าหมาย งบประมาณ การตั้งค่า และ Audit Log ล่าสุด (สูงสุด 5,000 รายการ)</li>
          <li>หน้าประวัติธุรกรรมส่งออก CSV ได้ทั้งแบบตามตัวกรอง ทั้งหมด และแบบ “รูปแบบไฟล์นำเข้า” สำหรับธุรกรรมการลงทุน</li>
        </ul>
        <Notice tone="warning" title="การกู้คืนจากไฟล์ JSON ยังไม่เป็นอัตโนมัติ">
          ระบบยังไม่มีปุ่มนำเข้าไฟล์ JSON กลับ ไฟล์นี้จึงเป็นสำเนาสำหรับเก็บไว้อ้างอิงหรือย้ายข้อมูลด้วยตนเอง ธุรกรรมการลงทุนนำเข้าใหม่ได้ด้วยไฟล์ CSV (ส่งออกแบบ “รูปแบบไฟล์นำเข้า” แล้วกด “นำเข้า CSV” ในหน้าประวัติธุรกรรม ทีละพอร์ต) ส่วนข้อมูลอื่นต้องบันทึกใหม่
        </Notice>
        <div>
          <h3 className="mb-1.5 text-sm font-semibold">สำรองทั้งฐานข้อมูล (สำหรับผู้ดูแลระบบ)</h3>
          <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed">
            <li>
              <span className="font-medium">PostgreSQL ที่ผู้ให้บริการดูแล (เช่น Supabase):</span> เปิดใช้ Daily Backups หรือ Point-in-Time Recovery (PITR) ตามแพ็กเกจ หรือสำรองเองด้วย <Code>pg_dump -Fc -f backup.dump &quot;$DATABASE_URL&quot;</Code> และกู้คืนด้วย <Code>pg_restore --clean --no-owner -d &quot;$DATABASE_URL&quot; backup.dump</Code> (ใช้สิทธิ์เจ้าของฐานข้อมูล)
            </li>
            <li>
              <span className="font-medium">ฐานข้อมูลในเครื่อง (embedded เมื่อไม่ได้ตั้ง DATABASE_URL):</span> หยุดเซิร์ฟเวอร์ แล้วคัดลอกโฟลเดอร์ <Code>.data/pglite</Code> (หรือโฟลเดอร์ที่ตั้งใน <Code>PGLITE_DATA_DIR</Code>) ไปเก็บ กู้คืนโดยหยุดเซิร์ฟเวอร์แล้วคัดลอกกลับที่เดิม
            </li>
            <li>ทดสอบการกู้คืนเป็นระยะ และเก็บสำเนาไว้นอกเครื่องเซิร์ฟเวอร์</li>
          </ul>
        </div>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Danger zone
// ---------------------------------------------------------------------------
function DangerCard({ email }: { email: string }) {
  const [state, action, pending] = useActionState(deleteAccountAction, EMPTY_FORM)
  const [typed, setTyped] = useState('')
  const { confirm } = useFeedback()
  const matches = typed.trim() === email

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    if (!matches) return
    const ok = await confirm({
      title: 'ลบบัญชีและข้อมูลทั้งหมดถาวร?',
      message: (
        <div className="space-y-2">
          <p>
            บัญชี <span className="font-medium">{email}</span> และข้อมูลทั้งหมด (ธุรกรรม พอร์ต รายรับ-รายจ่าย หนี้ แผน DCA การตั้งค่า และ Audit Log) จะถูกลบจากฐานข้อมูลทันทีและกู้คืนไม่ได้
          </p>
          <p className="text-muted">ถ้ายังไม่ได้ดาวน์โหลดข้อมูล (JSON) ให้กดยกเลิกแล้วดาวน์โหลดก่อน</p>
        </div>
      ),
      confirmLabel: 'ลบบัญชีถาวร',
      danger: true,
    })
    if (!ok) return
    const fd = new FormData(form)
    startTransition(() => action(fd))
  }

  return (
    <section className="rounded-xl border border-loss/60 bg-surface">
      <header className="border-b border-loss/40 px-4 py-3">
        <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-loss">
          <ShieldAlert size={15} /> ลบบัญชี (Danger Zone)
        </h2>
        <p className="mt-0.5 text-xs text-muted">ลบบัญชีและข้อมูลการเงินทั้งหมดของคุณอย่างถาวร</p>
      </header>
      <div className="space-y-3 p-4">
        <Notice tone="danger" title="การลบบัญชีย้อนกลับไม่ได้">
          ข้อมูลทั้งหมดของบัญชีนี้จะถูกลบถาวรทันที รวมถึง Audit Log ระบบไม่มีถังขยะหรือช่วงเวลาให้กู้คืน แนะนำให้ดาวน์โหลดข้อมูลทั้งหมด (JSON) ก่อน
        </Notice>
        {state.error && <Notice tone="danger">{state.error}</Notice>}
        <form onSubmit={(e) => void onSubmit(e)} className="grid gap-3 sm:grid-cols-2">
          <Field label="พิมพ์อีเมลของบัญชีเพื่อยืนยัน" required hint={<span className="break-all">ต้องตรงกับ {email}</span>}>
            <Input name="confirm" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} value={typed} aria-invalid={typed.trim() !== '' && !matches} onChange={(e) => setTyped(e.target.value)} />
          </Field>
          <Field label="รหัสผ่านปัจจุบัน" required>
            <Input name="password" type="password" autoComplete="current-password" required />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" variant="danger" loading={pending} disabled={!matches}>
              ลบบัญชีและข้อมูลทั้งหมดถาวร
            </Button>
          </div>
        </form>
      </div>
    </section>
  )
}
