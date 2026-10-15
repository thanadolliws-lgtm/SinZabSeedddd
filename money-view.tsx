'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Badge, PageHeader, Tabs } from '@/components/ui'
import { fmtMonth } from '@/lib/format'
import { AllocationTab } from './allocation-tab'
import { CashTab } from './cash-tab'
import { DebtsTab } from './debts-tab'
import { ExpensesTab } from './expenses-tab'
import { IncomeTab } from './income-tab'
import { MONEY_TABS, type MoneyTab, type MoneyTabProps } from './shared'

const parseTab = (v: string | null): MoneyTab => ((MONEY_TABS as string[]).includes(v ?? '') ? (v as MoneyTab) : 'cash')

export function MoneyView({ s, raw, today, timezone }: MoneyTabProps) {
  const params = useSearchParams()
  const router = useRouter()
  const fromUrl = parseTab(params.get('tab'))
  // The tab follows the URL (links such as /money?tab=debts), and switches instantly on click.
  const [tab, setTab] = useState<MoneyTab>(fromUrl)
  const [seenUrl, setSeenUrl] = useState<MoneyTab>(fromUrl)
  if (fromUrl !== seenUrl) {
    setSeenUrl(fromUrl)
    setTab(fromUrl)
  }
  const change = (t: MoneyTab) => {
    setTab(t)
    router.replace(`/money?tab=${t}`, { scroll: false })
  }

  const overdueBills = raw.expenses.filter((e) => e.status === 'unpaid' && e.date < today).length
  const overdueDebts = s.liabilities.filter((l) => l.due.overdueAmount > 0.005).length
  const plan = raw.allocationPlans.find((p) => p.month === s.month)

  return (
    <div className="space-y-5">
      <PageHeader
        title="บริหารเงิน (Money Management)"
        subtitle={`เงินสด รายรับ รายจ่าย หนี้สิน และการแบ่งเงินประจำเดือน ${fmtMonth(s.month)} · ทุกตัวเลขคำนวณจากข้อมูลชุดเดียวกับทุกหน้า`}
      />

      <Tabs<MoneyTab>
        tabs={[
          { id: 'cash', label: 'เงินสด บัญชี และเงินสำรอง' },
          { id: 'income', label: 'รายรับ' },
          { id: 'expenses', label: 'รายจ่ายและงบประมาณ', badge: overdueBills > 0 ? <Badge tone="loss">{overdueBills}</Badge> : undefined },
          { id: 'debts', label: 'หนี้สิน', badge: overdueDebts > 0 ? <Badge tone="loss">{overdueDebts}</Badge> : undefined },
          { id: 'allocation', label: 'แบ่งเงินรายเดือน', badge: plan ? <Badge tone={plan.status === 'confirmed' ? 'gain' : 'warn'}>{plan.status === 'confirmed' ? 'ยืนยันแล้ว' : 'ร่าง'}</Badge> : undefined },
        ]}
        value={tab}
        onChange={change}
      />

      {tab === 'cash' && <CashTab s={s} raw={raw} today={today} timezone={timezone} />}
      {tab === 'income' && <IncomeTab s={s} raw={raw} today={today} timezone={timezone} />}
      {tab === 'expenses' && <ExpensesTab s={s} raw={raw} today={today} timezone={timezone} />}
      {tab === 'debts' && <DebtsTab s={s} raw={raw} today={today} timezone={timezone} />}
      {tab === 'allocation' && <AllocationTab s={s} raw={raw} today={today} timezone={timezone} />}
    </div>
  )
}
