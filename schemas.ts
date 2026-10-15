/**
 * Input validation shared by the browser (instant feedback) and the server
 * (the authority). The server never trusts that the client validated anything.
 */
import { z } from 'zod'
import { isValidDate } from '@/lib/calc/money'
import { ALLOCATION_KEYS } from '@/lib/calc/allocation'

const blankToNull = (v: unknown) => (v === '' || v === undefined ? null : v)
const blankToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v)

export const zId = z.uuid('รหัสอ้างอิงไม่ถูกต้อง')
export const zOptId = z.preprocess(blankToNull, zId.nullable())
export const zDate = z.string().refine(isValidDate, 'วันที่ไม่ถูกต้อง')
export const zOptDate = z.preprocess(blankToNull, zDate.nullable())
export const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'เดือนไม่ถูกต้อง')
const zNum = z.coerce.number('ต้องเป็นตัวเลข').refine(Number.isFinite, 'ต้องเป็นตัวเลข')
export const zAmount = zNum.refine((n) => n > 0, 'ต้องมากกว่า 0').refine((n) => n < 1e13, 'จำนวนมากเกินไป')
export const zNonNeg = zNum.refine((n) => n >= 0, 'ต้องไม่ติดลบ').refine((n) => n < 1e13, 'จำนวนมากเกินไป')
const zOptNonNeg = z.preprocess(blankToNull, zNonNeg.nullable())
const zOptAmount = z.preprocess(blankToNull, zAmount.nullable())
const zText = (max: number) => z.string().trim().max(max, `ยาวเกิน ${max} ตัวอักษร`)
const zName = zText(120).min(1, 'กรุณากรอกข้อมูล')
const zNote = z.preprocess(blankToNull, zText(1000).nullable())
const zCurrency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'รหัสสกุลเงินต้องเป็น 3 ตัวอักษร เช่น THB, USD')
export const zIdempotency = z.string().min(8).max(80)

export const idOnly = z.object({ id: zId })

// ---- accounts & transfers --------------------------------------------------
export const accountSchema = z.object({
  id: zOptId.optional(),
  name: zName,
  type: z.enum(['cash', 'bank', 'brokerage', 'other_asset']),
  purpose: z.enum(['general', 'emergency', 'goal']).default('general'),
  goalId: zOptId.default(null),
  currency: zCurrency.default('THB'),
  openingBalance: zNum.refine((n) => Math.abs(n) < 1e13, 'จำนวนมากเกินไป').default(0),
  openingDate: zDate,
  note: zNote.default(null),
  isArchived: z.boolean().default(false),
})

export const transferSchema = z
  .object({
    id: zOptId.optional(),
    fromAccountId: zId,
    toAccountId: zId,
    date: zDate,
    amountFrom: zAmount,
    /** amount received; defaults to amountFrom when both accounts share a currency */
    amountTo: zOptAmount.default(null),
    fee: zNonNeg.default(0),
    kind: z.enum(['transfer', 'emergency_allocation', 'goal_allocation', 'investment_funding']).default('transfer'),
    note: zNote.default(null),
    idempotencyKey: zIdempotency.optional(),
  })
  .refine((d) => d.fromAccountId !== d.toAccountId, { message: 'บัญชีต้นทางและปลายทางต้องไม่ใช่บัญชีเดียวกัน', path: ['toAccountId'] })

// ---- securities, watchlist --------------------------------------------------
export const securitySchema = z.object({
  id: zOptId.optional(),
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9.\-]{1,15}$/, 'Ticker ใช้ได้เฉพาะ A-Z 0-9 . -'),
  exchange: z.string().trim().toUpperCase().min(1, 'กรุณาเลือกตลาด').max(12),
  name: zName,
  assetType: z.enum(['stock', 'etf', 'fund', 'other']).default('stock'),
  category: zText(40).min(1).default('Other'),
  assetGroup: z.preprocess(blankToNull, zText(60).nullable()).default(null),
  note: zNote.default(null),
  isArchived: z.boolean().default(false),
})

export const manualPriceSchema = z.object({
  securityId: zId,
  /** null clears the manual price */
  price: zOptAmount,
  date: zOptDate.default(null),
})

export const watchSchema = z.object({
  id: zOptId.optional(),
  securityId: zId,
  targetPrice: zOptAmount.default(null),
  budget: zOptNonNeg.default(null),
  plannedQuantity: zOptNonNeg.default(null),
  reason: zNote.default(null),
  plannedDate: zOptDate.default(null),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  status: z.enum(['interested', 'waiting', 'cancelled']).default('interested'),
})

// ---- investment transactions ------------------------------------------------
export const TX_TYPES = ['buy', 'sell', 'dividend', 'fee', 'split', 'adjustment'] as const

export const transactionSchema = z.object({
  id: zOptId.optional(),
  portfolio: z.enum(['main', 'dca']),
  securityId: zId,
  accountId: zOptId.default(null),
  type: z.enum(TX_TYPES),
  tradeDate: zDate,
  quantity: z.preprocess(blankToNull, zNum.nullable()).default(null),
  price: zOptNonNeg.default(null),
  /** dividend: gross amount. fee: fee amount. adjustment: signed cost change. Ignored for buy/sell (computed). */
  amount: z.preprocess(blankToNull, zNum.nullable()).default(null),
  fee: zNonNeg.default(0),
  splitRatio: zOptAmount.default(null),
  /** base currency per 1 unit of the security's currency; ignored when the security is in the base currency */
  fxRate: zOptAmount.default(null),
  note: zNote.default(null),
  idempotencyKey: zIdempotency.optional(),
})
export type TransactionInput = z.output<typeof transactionSchema>

export const watchBoughtSchema = z.object({ watchId: zId, transaction: transactionSchema })

export const importSchema = z.object({
  csv: z.string().min(1, 'ไฟล์ว่าง').max(900_000, 'ไฟล์ใหญ่เกินไป (จำกัดประมาณ 900 KB)'),
  portfolio: z.enum(['main', 'dca']),
  accountId: zOptId.default(null),
})

// ---- DCA --------------------------------------------------------------------
export const dcaPlanSchema = z.object({
  id: zOptId.optional(),
  name: zName,
  budgetAmount: zAmount,
  budgetCurrency: zCurrency.default('THB'),
  frequency: z.enum(['monthly', 'weekly', 'daily']),
  investDay: z.preprocess(blankToNull, z.coerce.number().int().min(1).max(31).nullable()).default(null),
  daysPerMonth: z.preprocess(blankToNull, z.coerce.number().int().min(1).max(31).nullable()).default(null),
  startDate: zDate,
  durationMonths: z.preprocess(blankToNull, z.coerce.number().int().min(1).max(1200).nullable()).default(null),
  riskLevel: z.enum(['low', 'medium', 'high']).default('medium'),
  objective: z.enum(['growth', 'dividend', 'balanced']).default('balanced'),
  minInvestment: zNonNeg.default(0),
  feePct: zNonNeg.refine((n) => n <= 100, 'ต้องไม่เกิน 100').default(0),
  feeMin: zNonNeg.default(0),
  allowFractional: z.boolean().default(true),
  paused: z.boolean().default(false),
  note: zNote.default(null),
  allocations: z
    .array(z.object({ securityId: zId, targetPct: zNum.refine((n) => n >= 0 && n <= 100, 'สัดส่วนต้องอยู่ระหว่าง 0-100') }))
    .max(50)
    .refine((a) => new Set(a.map((x) => x.securityId)).size === a.length, 'มีหลักทรัพย์ซ้ำในแผน'),
  /** must be true to save a plan whose weights do not total 100% (it is then saved as a draft) */
  confirmIncomplete: z.boolean().default(false),
})

export const scheduleGenerateSchema = z.object({ planId: zId, month: zMonth, replacePlanned: z.boolean().default(false) })
export const scheduleStatusSchema = z.object({ id: zId, status: z.enum(['planned', 'skipped']), note: zNote.default(null) })
export const scheduleExecuteSchema = z.object({
  scheduleId: zId,
  tradeDate: zDate,
  quantity: zAmount,
  price: zNonNeg,
  fee: zNonNeg.default(0),
  fxRate: zOptAmount.default(null),
  accountId: zOptId.default(null),
  note: zNote.default(null),
  idempotencyKey: zIdempotency.optional(),
})

// ---- money ------------------------------------------------------------------
export const INCOME_TYPES = ['salary', 'extra', 'side_job', 'bonus', 'dividend', 'other'] as const
export const incomeSchema = z.object({
  id: zOptId.optional(),
  accountId: zOptId.default(null),
  date: zDate,
  type: z.enum(INCOME_TYPES),
  source: z.preprocess(blankToNull, zText(120).nullable()).default(null),
  amount: zAmount,
  status: z.enum(['expected', 'received']),
  note: zNote.default(null),
  idempotencyKey: zIdempotency.optional(),
})

export const EXPENSE_CATEGORIES = ['ค่าอาหาร', 'ค่าเดินทาง', 'ค่าที่พัก', 'ค่าน้ำและค่าไฟ', 'ค่าโทรศัพท์และอินเทอร์เน็ต', 'ค่าใช้จ่ายส่วนตัว', 'ค่าสมาชิก', 'ค่าใช้จ่ายครอบครัว', 'ค่าใช้จ่ายอื่น ๆ'] as const

export const expenseSchema = z
  .object({
    id: zOptId.optional(),
    accountId: zOptId.default(null),
    date: zDate,
    category: zText(60).min(1, 'กรุณาเลือกหมวดหมู่'),
    description: z.preprocess(blankToNull, zText(200).nullable()).default(null),
    amount: zAmount,
    isEssential: z.boolean().default(false),
    status: z.enum(['paid', 'unpaid']),
    paidDate: zOptDate.default(null),
    note: zNote.default(null),
    idempotencyKey: zIdempotency.optional(),
  })
  .transform((d) => ({ ...d, paidDate: d.status === 'paid' ? (d.paidDate ?? d.date) : null }))

export const expensePaidSchema = z.object({ id: zId, paid: z.boolean(), paidDate: zOptDate.default(null), accountId: zOptId.optional() })
export const incomeReceivedSchema = z.object({ id: zId, received: z.boolean(), date: zOptDate.default(null), accountId: zOptId.optional() })

export const recurringSchema = z.object({
  id: zOptId.optional(),
  accountId: zOptId.default(null),
  name: zName,
  category: zText(60).min(1, 'กรุณาเลือกหมวดหมู่'),
  amount: zAmount,
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  nextDueDate: zDate,
  endDate: zOptDate.default(null),
  isEssential: z.boolean().default(false),
  isActive: z.boolean().default(true),
})

export const LIABILITY_KINDS = ['credit_card', 'personal_loan', 'mortgage', 'auto_loan', 'student_loan', 'informal', 'other'] as const
export const liabilitySchema = z.object({
  id: zOptId.optional(),
  name: zName,
  kind: z.enum(LIABILITY_KINDS).default('other'),
  openingBalance: zNonNeg,
  openingDate: zDate,
  annualRate: zNonNeg.refine((n) => n <= 1000, 'อัตราดอกเบี้ยสูงเกินไป').default(0),
  minPayment: zNonNeg.default(0),
  dueDay: z.preprocess(blankToNull, z.coerce.number().int().min(1).max(31).nullable()).default(null),
  targetPayment: zOptNonNeg.default(null),
  status: z.enum(['active', 'closed']).default('active'),
  note: zNote.default(null),
})

export const debtPaymentSchema = z.object({
  id: zOptId.optional(),
  liabilityId: zId,
  accountId: zOptId.default(null),
  kind: z.enum(['payment', 'charge']).default('payment'),
  date: zDate,
  amount: zAmount,
  /** blank = let the system estimate from the annual rate */
  interestAmount: zOptNonNeg.default(null),
  feeAmount: zNonNeg.default(0),
  note: zNote.default(null),
  idempotencyKey: zIdempotency.optional(),
})

export const goalSchema = z.object({
  id: zOptId.optional(),
  name: zName,
  targetAmount: zAmount,
  targetDate: zOptDate.default(null),
  monthlyContribution: zNonNeg.default(0),
  status: z.enum(['active', 'achieved', 'paused']).default('active'),
  note: zNote.default(null),
})

export const budgetSchema = z.object({ month: zMonth, category: zText(60).min(1), amount: zOptNonNeg })

export const allocationPlanSchema = z.object({
  month: zMonth,
  basis: z.enum(['received', 'received_and_expected']),
  items: z.array(z.object({ key: z.enum(ALLOCATION_KEYS), mode: z.enum(['auto', 'amount', 'percent']), value: zNonNeg.default(0) })).max(ALLOCATION_KEYS.length),
  confirm: z.boolean().default(false),
})

// ---- settings ---------------------------------------------------------------
export const settingsSchema = z.object({
  displayName: zText(80).default(''),
  theme: z.enum(['system', 'light', 'dark']),
  timezone: z.string().trim().min(1).max(60).refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz })
      return true
    } catch {
      return false
    }
  }, 'เขตเวลาไม่ถูกต้อง'),
  emergencyMonths: z.coerce.number().int().min(1).max(60),
  essentialMonthlyExpense: zOptNonNeg,
  maxPositionPct: zNum.refine((n) => n >= 1 && n <= 100, 'ต้องอยู่ระหว่าง 1-100'),
  maxCategoryPct: zNum.refine((n) => n >= 1 && n <= 100, 'ต้องอยู่ระหว่าง 1-100'),
  allocationDriftPct: zNum.refine((n) => n >= 0.5 && n <= 100, 'ต้องอยู่ระหว่าง 0.5-100'),
  staleQuoteHours: z.coerce.number().int().min(1).max(720),
  highInterestRate: zNum.refine((n) => n >= 0 && n <= 100, 'ต้องอยู่ระหว่าง 0-100'),
  dueSoonDays: z.coerce.number().int().min(0).max(60),
  disabledAlerts: z.array(z.string().max(40)).max(40).default([]),
})

export const themeSchema = z.object({ theme: z.enum(['system', 'light', 'dark']) })

export function firstIssue(error: z.ZodError): { message: string; fields: Record<string, string> } {
  const fields: Record<string, string> = {}
  for (const issue of error.issues) {
    const path = issue.path.join('.')
    if (path && !fields[path]) fields[path] = issue.message
  }
  const first = error.issues[0]
  return { message: first ? (first.path.length ? `${first.path.join('.')}: ${first.message}` : first.message) : 'ข้อมูลไม่ถูกต้อง', fields }
}

export { blankToUndefined }
