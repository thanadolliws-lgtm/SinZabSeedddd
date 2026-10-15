'use server'

/**
 * Server Actions for all user data. Each one goes through run():
 * authenticate -> validate -> per-user transaction (RLS) -> friendly errors -> revalidate.
 * Business rules live in src/lib/services/*.
 */
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth/session'
import { buildAppData } from '@/lib/data/app-data'
import * as dca from '@/lib/services/dca'
import * as money from '@/lib/services/money'
import * as pf from '@/lib/services/portfolio'
import * as S from '@/lib/services/schemas'
import * as settings from '@/lib/services/settings'
import { run } from './run'

type In<T extends z.ZodType> = z.input<T>

// ---- securities & watchlist -------------------------------------------------
export async function saveSecurityAction(input: In<typeof S.securitySchema>) {
  return run(S.securitySchema, input, ({ q, user, data }) => pf.saveSecurity(q, user.id, data))
}
export async function deleteSecurityAction(input: In<typeof S.idOnly>) {
  return run(S.idOnly, input, async ({ q, user, data }) => {
    await pf.deleteSecurity(q, user.id, data.id)
  })
}
export async function setManualPriceAction(input: In<typeof S.manualPriceSchema>) {
  return run(S.manualPriceSchema, input, async ({ q, user, data }) => {
    await pf.setManualPrice(q, user.id, data)
  })
}
export async function saveWatchAction(input: In<typeof S.watchSchema>) {
  return run(S.watchSchema, input, async ({ q, user, data }) => {
    await pf.saveWatch(q, user.id, data)
  })
}
export async function deleteWatchAction(input: In<typeof S.idOnly>) {
  return run(S.idOnly, input, async ({ q, user, data }) => {
    await pf.deleteWatch(q, user.id, data.id)
  })
}
export async function confirmWatchBoughtAction(input: In<typeof S.watchBoughtSchema>) {
  return run(S.watchBoughtSchema, input, ({ q, user, data }) => pf.confirmWatchBought(q, user.id, data.watchId, data.transaction))
}

// ---- investment transactions ------------------------------------------------
export async function saveTransactionAction(input: In<typeof S.transactionSchema>) {
  return run(S.transactionSchema, input, ({ q, user, data }) => pf.saveTransaction(q, user.id, data))
}
export async function deleteTransactionAction(input: In<typeof S.idOnly>) {
  return run(S.idOnly, input, async ({ q, user, data }) => {
    await pf.deleteTransaction(q, user.id, data.id)
  })
}
export async function previewImportAction(input: In<typeof S.importSchema>) {
  return run(S.importSchema, input, ({ q, data }) => pf.previewImport(q, data), { readOnly: true })
}
const commitImportSchema = S.importSchema.extend({ includeDuplicates: z.boolean().default(false) })
export async function commitImportAction(input: In<typeof commitImportSchema>) {
  return run(commitImportSchema, input, ({ q, user, data }) => pf.commitImport(q, user.id, data))
}

// ---- DCA --------------------------------------------------------------------
export async function saveDcaPlanAction(input: In<typeof S.dcaPlanSchema>) {
  return run(S.dcaPlanSchema, input, ({ q, user, data }) => dca.saveDcaPlan(q, user.id, data))
}
export async function deleteDcaPlanAction(input: In<typeof S.idOnly>) {
  return run(S.idOnly, input, async ({ q, user, data }) => {
    await dca.deleteDcaPlan(q, user.id, data.id)
  })
}
export async function generateScheduleAction(input: In<typeof S.scheduleGenerateSchema>) {
  return run(S.scheduleGenerateSchema, input, ({ q, user, data }) => dca.generateSchedule(q, user.id, data))
}
export async function setScheduleStatusAction(input: In<typeof S.scheduleStatusSchema>) {
  return run(S.scheduleStatusSchema, input, async ({ q, user, data }) => {
    await dca.setScheduleStatus(q, user.id, data)
  })
}
export async function deleteScheduleRowAction(input: In<typeof S.idOnly>) {
  return run(S.idOnly, input, async ({ q, user, data }) => {
    await dca.deleteScheduleRow(q, user.id, data.id)
  })
}
export async function executeScheduleAction(input: In<typeof S.scheduleExecuteSchema>) {
  return run(S.scheduleExecuteSchema, input, ({ q, user, data }) => dca.executeSchedule(q, user.id, data))
}

// ---- accounts & transfers ---------------------------------------------------
export async function saveAccountAction(input: In<typeof S.accountSchema>) {
  return run(S.accountSchema, input, ({ q, user, data }) => money.saveAccount(q, user.id, data))
}
export async function deleteAccountRowAction(input: In<typeof S.idOnly>) {
  return run(S.idOnly, input, async ({ q, user, data }) => {
    await money.deleteAccount(q, user.id, data.id)
  })
}
export async function saveTransferAction(input: In<typeof S.transferSchema>) {
  return run(S.transferSchema, input, ({ q, user, data }) => money.saveTransfer(q, user.id, data))
}
export async function deleteTransferAction(input: In<typeof S.idOnly>) {
  return run(S.idOnly, input, async ({ q, user, data }) => {
    await money.deleteTransfer(q, user.id, data.id)
  })
}

// ---- income & expenses ------------------------------------------------------
export async function saveIncomeAction(input: In<typeof S.incomeSchema>) {
  return run(S.incomeSchema, input, ({ q, user, data }) => money.saveIncome(q, user.id, data))
}
export async function deleteIncomeAction(input: In<typeof S.idOnly>) {
  return run(S.idOnly, input, async ({ q, user, data }) => {
    await money.deleteIncome(q, user.id, data.id)
  })
}
export async function setIncomeReceivedAction(input: In<typeof S.incomeReceivedSchema>) {
  return run(S.incomeReceivedSchema, input, async ({ q, user, data }) => {
    await money.setIncomeReceived(q, user.id, data)
  })
}
export async function saveExpenseAction(input: In<typeof S.expenseSchema>) {
  return run(S.expenseSchema, input, ({ q, user, data }) => money.saveExpense(q, user.id, data))
}
export async function deleteExpenseAction(input: In<typeof S.idOnly>) {
  return run(S.idOnly, input, async ({ q, user, data }) => {
    await money.deleteExpense(q, user.id, data.id)
  })
}
export async function setExpensePaidAction(input: In<typeof S.expensePaidSchema>) {
  return run(S.expensePaidSchema, input, async ({ q, user, data }) => {
    await money.setExpensePaid(q, user.id, data)
  })
}
export async function saveRecurringAction(input: In<typeof S.recurringSchema>) {
  return run(S.recurringSchema, input, ({ q, user, data }) => money.saveRecurring(q, user.id, data))
}
export async function deleteRecurringAction(input: In<typeof S.idOnly>) {
  return run(S.idOnly, input, async ({ q, user, data }) => {
    await money.deleteRecurring(q, user.id, data.id)
  })
}

// ---- liabilities ------------------------------------------------------------
export async function saveLiabilityAction(input: In<typeof S.liabilitySchema>) {
  return run(S.liabilitySchema, input, ({ q, user, data }) => money.saveLiability(q, user.id, data))
}
export async function deleteLiabilityAction(input: In<typeof S.idOnly>) {
  return run(S.idOnly, input, async ({ q, user, data }) => {
    await money.deleteLiability(q, user.id, data.id)
  })
}
export async function saveDebtPaymentAction(input: In<typeof S.debtPaymentSchema>) {
  return run(S.debtPaymentSchema, input, ({ q, user, data }) => money.saveDebtPayment(q, user.id, data))
}
export async function deleteDebtPaymentAction(input: In<typeof S.idOnly>) {
  return run(S.idOnly, input, async ({ q, user, data }) => {
    await money.deleteDebtPayment(q, user.id, data.id)
  })
}

// ---- goals, budgets, allocation ---------------------------------------------
export async function saveGoalAction(input: In<typeof S.goalSchema>) {
  return run(S.goalSchema, input, ({ q, user, data }) => money.saveGoal(q, user.id, data))
}
export async function deleteGoalAction(input: In<typeof S.idOnly>) {
  return run(S.idOnly, input, async ({ q, user, data }) => {
    await money.deleteGoal(q, user.id, data.id)
  })
}
export async function saveBudgetAction(input: In<typeof S.budgetSchema>) {
  return run(S.budgetSchema, input, async ({ q, user, data }) => {
    await money.saveBudget(q, user.id, data)
  })
}
export async function saveAllocationPlanAction(input: In<typeof S.allocationPlanSchema>) {
  // The plan is checked against the same snapshot the pages show, recomputed on the server.
  // Built BEFORE run(): database access must never be nested inside the per-user transaction.
  const current = await getCurrentUser()
  const snapshot = current ? (await buildAppData(current.id)).snapshot : null
  return run(S.allocationPlanSchema, input, async ({ q, user, data }) => {
    if (!snapshot) throw new Error('unreachable: run() rejects unauthenticated calls')
    const out = await money.saveAllocationPlan(q, user.id, data, snapshot)
    return { status: out.status, remaining: out.result.remaining }
  })
}

// ---- settings & export ------------------------------------------------------
export async function saveSettingsAction(input: In<typeof S.settingsSchema>) {
  return run(S.settingsSchema, input, async ({ q, user, data }) => {
    await settings.saveSettings(q, user.id, data)
  })
}
export async function saveThemeAction(input: In<typeof S.themeSchema>) {
  return run(S.themeSchema, input, async ({ q, data }) => {
    await settings.saveTheme(q, data.theme)
  })
}
export async function exportAllAction() {
  return run(z.object({}), {}, async ({ q, user }) => JSON.stringify(await settings.exportAll(q, user.email), null, 2), { readOnly: true })
}
export async function loadAuditLogAction() {
  return run(z.object({}), {}, ({ q }) => settings.loadAuditLog(q, 300), { readOnly: true })
}
