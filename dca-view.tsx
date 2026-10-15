'use client'

/**
 * DCA Portfolio page. "Plan" (plans, schedules, previews) and "actual execution"
 * (transactions recorded in the DCA portfolio) are kept visibly separate:
 * planned money is never shown as invested.
 */
import Link from 'next/link'
import { useState } from 'react'
import { BriefcaseBusiness, Plus, Upload } from 'lucide-react'
import type { DcaPlanView, Snapshot } from '@/lib/calc/snapshot'
import type { LedgerTx } from '@/lib/calc/portfolio'
import type { DcaScheduleRow, RawData } from '@/lib/calc/types'
import { HoldingsTable, TransactionsTable } from '@/components/holdings'
import { ManualPriceForm, SecurityForm, TransactionForm } from '@/components/domain-forms'
import { ImportCsvDialog } from '@/components/import-csv'
import { Badge, Button, Card, EmptyState, Notice, PageHeader, PnL, Stat, Tabs } from '@/components/ui'
import { fmtMoney, fmtMonth, fmtNum, fmtPct, toneOf } from '@/lib/format'
import { DcaCalendar } from './calendar'
import { CandidatesSection } from './candidates'
import { DriftSection } from './drift'
import { ExecuteForm } from './execute-form'
import { PlanForm } from './plan-form'
import { PlansSection } from './plans'
import { rateOf } from './shared'

type View = 'plans' | 'calendar' | 'holdings' | 'drift' | 'candidates'

type Dialog =
  | { kind: 'plan'; plan?: DcaPlanView }
  | { kind: 'execute'; row: DcaScheduleRow }
  | { kind: 'tx'; tx?: LedgerTx & { portfolio: 'main' | 'dca' }; preset?: Record<string, string> }
  | { kind: 'import' }
  | { kind: 'security' }
  | { kind: 'price'; securityId: string }
  | null

export function DcaView({ s, raw, today, timezone }: { s: Snapshot; raw: RawData; today: string; timezone: string }) {
  const [view, setView] = useState<View>('plans')
  const [dialog, setDialog] = useState<Dialog>(null)
  const close = () => setDialog(null)
  const base = s.baseCurrency
  const p = s.portfolios.dca
  const kindOf = (pid: string) => (raw.portfolios.find((x) => x.id === pid)?.kind ?? 'main') as 'main' | 'dca'
  const txs = raw.transactions.filter((t) => s.portfolioIds.dca !== null && t.portfolioId === s.portfolioIds.dca)
  const sec = (id: string) => s.securities.find((x) => x.id === id)

  // ---- this month, from active plans (same definition as the dca_over_cash alert) ----
  const active = s.dcaPlans.filter((x) => x.plan.status === 'active' && x.check.ok)
  let plannedBase = 0
  let pendingBase = 0
  const noRate: string[] = []
  for (const x of active) {
    const r = rateOf(s, x.plan.budgetCurrency)
    if (r === null) {
      noRate.push(x.plan.budgetCurrency)
      continue
    }
    // with a generated schedule: what is still planned; without one: what is left of the monthly budget
    plannedBase += (x.monthPlanned > 0 ? x.monthPlanned : x.monthlyEquivalent) * r
    pendingBase += (x.monthPlanned > 0 ? x.monthPending : Math.max(0, x.monthlyEquivalent - x.monthExecuted)) * r
  }
  const investable = s.availableThisMonth + s.cash.brokerageCashBase
  const overBudget = noRate.length === 0 && pendingBase > 0.005 && pendingBase > investable + 0.005
  const debtOverdue = s.debt.overdue > 0.005
  const emergencyGap = s.emergency.gap !== null && s.emergency.gap > 0.005 ? s.emergency.gap : null

  return (
    <div className="space-y-5">
      <PageHeader
        title="พอร์ต DCA (DCA Portfolio)"
        subtitle="วางแผนลงทุนแบบถัวเฉลี่ย (Dollar-Cost Averaging) แยกจากการซื้อจริง: แผนและตารางลงทุนไม่ถูกนับเป็นเงินลงทุนจนกว่าจะบันทึกการซื้อจริง"
        actions={
          <>
            <Button icon={<Plus size={15} />} onClick={() => setDialog({ kind: 'security' })}>
              เพิ่มหลักทรัพย์
            </Button>
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setDialog({ kind: 'plan' })}>
              สร้างแผน DCA
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <Badge tone="neutral">แผน (Plan)</Badge> กรอบเส้นประ = ตัวเลขตามแผน ยังไม่ใช่เงินที่ลงทุนจริง
        </span>
        <span className="flex items-center gap-1.5">
          <Badge tone="accent">ซื้อจริง (Actual)</Badge> กรอบเส้นทึบ = คำนวณจากธุรกรรมที่บันทึกจริงในพอร์ต DCA
        </span>
      </div>

      <section aria-label="สรุปพอร์ต DCA" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="ต้นทุน DCA ที่ยังถืออยู่" value={fmtMoney(p.costBasisBase)} sub="ซื้อจริง · Weighted Average Cost" hint="ต้นทุนเฉลี่ยถ่วงน้ำหนักของหุ้นในพอร์ต DCA ที่ยังถืออยู่ รวมค่าธรรมเนียมซื้อ คิดเป็นบาทตามอัตราแลกเปลี่ยน ณ วันที่ซื้อ" />
        <Stat
          label="มูลค่าตลาด"
          value={
            <span className="flex flex-wrap items-center gap-1.5">
              {fmtMoney(p.marketValueBase)}
              {!p.complete && <Badge tone="warn">ไม่ครบ</Badge>}
            </span>
          }
          tone={p.complete ? undefined : 'warn'}
          sub={p.complete ? `${p.positions.length} หลักทรัพย์` : `ไม่รวม ${p.missingPrice.length + p.missingFx.length} รายการที่ไม่มีราคา/อัตราแลกเปลี่ยน`}
          hint="จำนวนหุ้นที่ถืออยู่จริง × ราคาล่าสุด × อัตราแลกเปลี่ยนล่าสุด ไม่รวมแผนที่ยังไม่ได้ซื้อ"
        />
        <Stat label="กำไร/ขาดทุนที่ยังไม่รับรู้" value={<PnL value={p.unrealizedPnlBase} />} sub={fmtPct(p.unrealizedPct, 2, true)} tone={toneOf(p.unrealizedPnlBase)} hint="มูลค่าตลาด − ต้นทุนของหุ้นที่ยังถืออยู่ (เป็นบาท รวมผลอัตราแลกเปลี่ยน) คิดเฉพาะหลักทรัพย์ที่มีราคา" />
        <Stat label={`ลงทุนจริงเดือน ${fmtMonth(s.month)}`} value={fmtMoney(s.investedThisMonth.dca)} sub="ซื้อจริงในพอร์ต DCA รวมค่าธรรมเนียม" hint="ผลรวมธุรกรรมซื้อ (ยอดซื้อ + ค่าธรรมเนียม) × อัตราแลกเปลี่ยน ณ วันที่ซื้อ ของเดือนนี้ ไม่รวมรายการที่ยังเป็นแผน" />
        <Stat
          label="แผนเดือนนี้ที่ยังไม่ได้ซื้อ"
          className="border-dashed"
          value={active.length === 0 ? '—' : noRate.length > 0 ? 'ไม่ครบ' : fmtMoney(pendingBase)}
          tone={noRate.length > 0 ? 'warn' : undefined}
          sub={active.length === 0 ? 'ไม่มีแผนที่ใช้งาน' : noRate.length > 0 ? `ไม่มีอัตราแลกเปลี่ยน ${[...new Set(noRate)].join(', ')}` : `งบตามแผนทั้งเดือน ${fmtMoney(plannedBase)}`}
          hint="เป็นแผน ไม่ใช่เงินที่ลงทุนแล้ว: แผนที่สร้างตารางเดือนนี้แล้วใช้ยอดที่ยังรอซื้อ แผนที่ยังไม่สร้างตารางใช้งบรายเดือน (รายสัปดาห์เทียบเป็นรายเดือน × 52 ÷ 12) ลบยอดที่ซื้อตามแผนแล้ว"
        />
        <Stat
          label="เงินที่ลงทุนได้"
          value={fmtMoney(investable)}
          tone={investable < 0 ? 'loss' : undefined}
          sub={`พร้อมใช้ ${fmtMoney(s.availableThisMonth)} · โบรกเกอร์ ${fmtMoney(s.cash.brokerageCashBase)}`}
          hint="เงินที่พร้อมใช้เดือนนี้ (เงินสด/ธนาคารที่ไม่ได้กันไว้ − รายจ่ายค้างที่ครบกำหนดภายในสิ้นเดือน − ยอดชำระหนี้ขั้นต่ำที่ยังค้าง) + เงินสดในบัญชีโบรกเกอร์ ไม่รวมเงินสำรองฉุกเฉินและเงินออมตามเป้าหมาย"
        />
      </section>

      {(overBudget || debtOverdue || emergencyGap !== null || p.issues.length > 0) && (
        <div className="space-y-2">
          {debtOverdue && (
            <Notice tone="danger" title={`มีหนี้เกินกำหนดชำระ ${fmtMoney(s.debt.overdue)}`}>
              แนะนำให้จัดการหนี้ที่เกินกำหนดก่อนเพิ่มเงินลงทุน เพราะดอกเบี้ยและค่าปรับเป็นต้นทุนที่เกิดขึ้นแน่นอน ระบบไม่ได้ห้ามการลงทุน เป็นเพียงข้อเตือน ·{' '}
              <Link href="/money?tab=debts" className="text-accent underline">
                ไปที่หนี้สิน
              </Link>
            </Notice>
          )}
          {emergencyGap !== null && (
            <Notice tone="warning" title={`เงินสำรองฉุกเฉินยังขาดอีก ${fmtMoney(emergencyGap)}`}>
              มี {fmtMoney(s.emergency.current)} จากเป้าหมาย {fmtMoney(s.emergency.target)}
              {s.emergency.coverageMonths !== null && ` (ครอบคลุม ${fmtNum(s.emergency.coverageMonths, 1)} จาก ${s.emergency.targetMonths} เดือน)`} พิจารณาเติมเงินสำรองก่อนหรือควบคู่กับการลงทุน ระบบไม่ได้ห้ามการลงทุน ·{' '}
              <Link href="/money?tab=cash" className="text-accent underline">
                ไปที่เงินสด
              </Link>
            </Notice>
          )}
          {overBudget && (
            <Notice tone="warning" title="แผน DCA ที่ยังไม่ได้ซื้อเดือนนี้มากกว่าเงินที่ลงทุนได้">
              แผนยังต้องใช้ {fmtMoney(pendingBase)} แต่เงินที่ลงทุนได้ (เงินพร้อมใช้ + เงินสดในบัญชีโบรกเกอร์) มี {fmtMoney(investable)} พิจารณาลดงบ ข้ามบางรายการในปฏิทิน หรือหยุดพักแผนชั่วคราว
            </Notice>
          )}
          {p.issues.length > 0 && <Notice tone="danger" title="พบข้อมูลไม่สอดคล้องในประวัติธุรกรรม DCA">{p.issues.join(' · ')}</Notice>}
        </div>
      )}

      <Tabs<View>
        tabs={[
          { id: 'plans', label: 'แผน DCA', badge: <Badge tone="neutral">{s.dcaPlans.length}</Badge> },
          { id: 'calendar', label: 'ปฏิทิน DCA' },
          { id: 'holdings', label: 'พอร์ต DCA (ซื้อจริง)' },
          { id: 'drift', label: 'สัดส่วนเทียบเป้าหมาย' },
          { id: 'candidates', label: 'หุ้นที่น่าศึกษา' },
        ]}
        value={view}
        onChange={setView}
      />

      {view === 'plans' && <PlansSection s={s} raw={raw} onNew={() => setDialog({ kind: 'plan' })} onEdit={(pv) => setDialog({ kind: 'plan', plan: pv })} />}

      {view === 'calendar' && <DcaCalendar s={s} raw={raw} today={today} onExecute={(row) => setDialog({ kind: 'execute', row })} />}

      {view === 'holdings' && (
        <div className="space-y-4">
          <Notice tone="info" title="แอปนี้ไม่ได้เชื่อมต่อกับโบรกเกอร์">
            ข้อมูลการซื้อจริงมาจากการบันทึกเอง (ปุ่มด้านล่างหรือ &quot;บันทึกการซื้อจริง&quot; ในปฏิทิน DCA) หรือการนำเข้าไฟล์ CSV เท่านั้น ระบบไม่ได้ส่งคำสั่งซื้อขายและไม่ได้ดึงรายการจากบัญชีโบรกเกอร์
          </Notice>
          <Card
            title="หุ้นที่ถืออยู่ในพอร์ต DCA"
            subtitle="จากธุรกรรมที่บันทึกจริง · ราคาและอัตราแลกเปลี่ยนแสดงประเภทข้อมูลและเวลาเสมอ"
            pad={false}
            actions={
              <>
                <Button size="sm" icon={<Upload size={14} />} onClick={() => setDialog({ kind: 'import' })}>
                  นำเข้า CSV
                </Button>
                <Button size="sm" variant="primary" icon={<Plus size={14} />} disabled={raw.securities.length === 0} title={raw.securities.length === 0 ? 'เพิ่มหลักทรัพย์ก่อน' : undefined} onClick={() => setDialog({ kind: 'tx', preset: { portfolio: 'dca', type: 'buy' } })}>
                  บันทึกการซื้อ DCA เอง
                </Button>
              </>
            }
          >
            {p.positions.length === 0 && p.closedPositions.length === 0 ? (
              <EmptyState icon={<BriefcaseBusiness size={28} />} title="ยังไม่มีหุ้นในพอร์ต DCA" description="บันทึกการซื้อจริงจากปฏิทิน DCA บันทึกเอง หรือนำเข้า CSV แล้วต้นทุนและกำไร/ขาดทุนจะคำนวณให้อัตโนมัติ" />
            ) : (
              <HoldingsTable summary={p} securities={s.securities} baseCurrency={base} timezone={timezone} onAddTx={(id) => setDialog({ kind: 'tx', preset: { securityId: id, portfolio: 'dca' } })} onPrice={(id) => setDialog({ kind: 'price', securityId: id })} />
            )}
          </Card>
          {p.closedPositions.length > 0 && (
            <Card title="หุ้นที่ขายหมดแล้วในพอร์ต DCA" subtitle="กำไร/ขาดทุนที่รับรู้แล้วและเงินปันผลที่เคยได้รับ">
              <ul className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {p.closedPositions.map((c) => (
                  <li key={c.securityId} className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
                    <span className="font-medium">{sec(c.securityId)?.symbol}</span>
                    <span className="text-right text-xs">
                      <PnL value={c.realizedPnlBase} />
                      {c.dividendsNetBase > 0 && <span className="block text-muted">ปันผล {fmtMoney(c.dividendsNetBase)}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="ธุรกรรมในพอร์ต DCA" subtitle="รวมรายการจากตาราง DCA (ที่มา: DCA) บันทึกเอง และนำเข้า CSV · แก้ไขหรือลบแล้วระบบคำนวณใหม่ทันที" pad={false}>
            <TransactionsTable txs={txs} securities={s.securities} accounts={raw.accounts} portfolioKind={kindOf} baseCurrency={base} onEdit={(tx) => setDialog({ kind: 'tx', tx })} />
          </Card>
        </div>
      )}

      {view === 'drift' && <DriftSection s={s} threshold={raw.settings.allocationDriftPct} />}

      {view === 'candidates' && <CandidatesSection s={s} raw={raw} timezone={timezone} />}

      {dialog?.kind === 'plan' && <PlanForm plan={dialog.plan} securities={raw.securities} s={s} today={today} onClose={close} />}
      {dialog?.kind === 'execute' && <ExecuteForm row={dialog.row} plan={s.dcaPlans.find((x) => x.plan.id === dialog.row.planId)?.plan} s={s} accounts={raw.accounts} today={today} timezone={timezone} onClose={close} />}
      {dialog?.kind === 'tx' && <TransactionForm securities={raw.securities} accounts={raw.accounts} baseCurrency={base} today={today} onClose={close} tx={dialog.tx} preset={dialog.preset} />}
      {dialog?.kind === 'import' && <ImportCsvDialog accounts={raw.accounts} defaultPortfolio="dca" onClose={close} />}
      {dialog?.kind === 'security' && <SecurityForm onClose={close} />}
      {dialog?.kind === 'price' && sec(dialog.securityId) && <ManualPriceForm security={sec(dialog.securityId)!} today={today} onClose={close} />}
    </div>
  )
}
