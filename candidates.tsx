'use client'

/**
 * Candidates for DCA (6.3): securities in active plans and on the watchlist, with the
 * data points the app actually has. Every "reason" below is derived from those data
 * points only; nothing here predicts prices or recommends a purchase.
 */
import { useState } from 'react'
import { Database, Lightbulb } from 'lucide-react'
import { loadFundamentalsAction } from '@/actions/market'
import type { DcaPlanView, SecurityView, Snapshot } from '@/lib/calc/snapshot'
import type { RawData, WatchRow } from '@/lib/calc/types'
import { PriceSource } from '@/components/common'
import { Badge, Button, Card, EmptyState, Notice } from '@/components/ui'
import { fmtCompact, fmtDate, fmtDateTime, fmtMoney, fmtNum, fmtPct } from '@/lib/format'
import { ASSET_TYPE, RISK, convert, orderSplit, rateOf, referenceMonth } from './shared'

type FundResult = Extract<Awaited<ReturnType<typeof loadFundamentalsAction>>, { ok: true }>['data']
type FundState = { status: 'loading' } | { status: 'done'; result: FundResult } | { status: 'error'; error: string }

const WATCH_LABEL: Record<WatchRow['status'], string> = { interested: 'สนใจ', waiting: 'รอซื้อ', bought: 'ซื้อแล้ว', cancelled: 'ยกเลิก' }

interface PlanFee {
  pv: DcaPlanView
  amount: number
  estFee: number
  feeDragPct: number | null
  belowMinimum: boolean
  daily: boolean
}

export function CandidatesSection({ s, raw, timezone }: { s: Snapshot; raw: RawData; timezone: string }) {
  const [funds, setFunds] = useState<Record<string, FundState>>({})
  const base = s.baseCurrency
  const set = raw.settings
  const activePlans = s.dcaPlans.filter((p) => p.plan.status === 'active')
  const watch = raw.watchlist.filter((w) => w.status === 'interested' || w.status === 'waiting')
  const ids = [...new Set([...activePlans.flatMap((p) => p.allocations.map((a) => a.securityId)), ...watch.map((w) => w.securityId)])]
  const secById = new Map(s.securities.map((x) => [x.id, x]))
  const candidates = ids.map((id) => secById.get(id)).filter((x): x is SecurityView => !!x)
  const combined = s.portfolios.combined
  const weightWhere = (pred: (x: SecurityView) => boolean) =>
    combined.positions.reduce((a, p) => {
      const x = secById.get(p.securityId)
      return x && p.weight !== null && pred(x) ? a + p.weight : a
    }, 0)

  const loadFund = async (id: string) => {
    setFunds((f) => ({ ...f, [id]: { status: 'loading' } }))
    try {
      const res = await loadFundamentalsAction({ securityId: id })
      setFunds((f) => ({ ...f, [id]: res.ok ? { status: 'done', result: res.data } : { status: 'error', error: res.error } }))
    } catch {
      setFunds((f) => ({ ...f, [id]: { status: 'error', error: 'ติดต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่' } }))
    }
  }

  return (
    <div className="space-y-4">
      <Notice tone="warning" title="ไม่ใช่คำแนะนำการลงทุน">
        ข้อมูลในส่วนนี้สรุปจากข้อมูลที่มีในระบบเท่านั้น (ราคา หมวด ประเภทสินทรัพย์ สัดส่วนในพอร์ต ค่าธรรมเนียมในแผน และข้อมูลพื้นฐานจากผู้ให้บริการถ้ามี) ไม่ใช่การคาดการณ์ราคา ไม่รับประกันผลตอบแทน และไม่ใช่คำแนะนำให้ซื้อหรือขาย ผู้ใช้เป็นผู้ตัดสินใจเองทั้งหมด
      </Notice>
      {candidates.length === 0 ? (
        <Card>
          <EmptyState icon={<Lightbulb size={28} />} title="ยังไม่มีหลักทรัพย์ให้ศึกษา" description="หลักทรัพย์ในแผน DCA ที่ใช้งาน และรายการที่สนใจ/รอซื้อใน Watchlist (หน้าพอร์ตหุ้นที่ถือจริง) จะแสดงที่นี่" />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {candidates.map((c) => {
            const plans = activePlans.filter((pv) => pv.allocations.some((a) => a.securityId === c.id))
            const w = watch.find((x) => x.securityId === c.id)
            const ownPos = combined.positions.find((p) => p.securityId === c.id)
            const ownWeight = ownPos ? ownPos.weight : 0
            const catWeight = weightWhere((x) => x.category === c.category)
            // held at all (priced or not): an unpriced holding still counts as "already held"
            const catHeld = combined.positions.some((p) => secById.get(p.securityId)?.category === c.category)
            const peers = c.assetGroup ? combined.positions.filter((p) => p.securityId !== c.id && secById.get(p.securityId)?.assetGroup === c.assetGroup) : []
            const peerWeight = peers.reduce((a, p) => a + (p.weight ?? 0), 0)
            const peersUnpriced = peers.some((p) => p.weight === null)
            const rate = rateOf(s, c.currency)
            const fx = c.currency !== base ? s.fx[c.currency] : undefined
            const price = c.price
            const fees: PlanFee[] = plans.flatMap((pv) => {
              const a = orderSplit(pv.plan, pv.allocations, referenceMonth(pv.plan, s.month)).amounts.find((x) => x.securityId === c.id)
              return a ? [{ pv, amount: a.amount, estFee: a.estFee, feeDragPct: a.feeDragPct, belowMinimum: a.belowMinimum, daily: pv.plan.frequency === 'daily' }] : []
            })
            const fund = funds[c.id]
            const fd = fund?.status === 'done' ? fund.result.data : undefined

            // ---- reasons, from the data points above only ------------------------
            const study: string[] = []
            const caution: string[] = []
            if (c.assetType === 'etf' || c.assetType === 'fund') study.push(`เป็น${c.assetType === 'etf' ? ' ETF' : 'กองทุน'}: ถือหลักทรัพย์หลายตัวในตัวเอง กระจายความเสี่ยงมากกว่าหุ้นรายตัว`)
            if (c.assetType === 'stock') caution.push('เป็นหุ้นรายตัว: ความเสี่ยงกระจุกอยู่ที่บริษัทเดียว')
            if (combined.positions.length > 0 && !catHeld) study.push(`ยังไม่มีหลักทรัพย์หมวด ${c.category} ในพอร์ตรวม: อาจช่วยกระจายหมวดธุรกิจ`)
            if (catWeight > set.maxCategoryPct) caution.push(`หมวด ${c.category} มีสัดส่วน ${fmtPct(catWeight, 1)} ของพอร์ตรวมแล้ว เกินเกณฑ์ ${fmtNum(set.maxCategoryPct, 0)}% ที่ตั้งไว้`)
            if (c.assetGroup && combined.positions.length > 0 && peers.length === 0 && !ownPos) study.push(`ยังไม่มีสินทรัพย์ในกลุ่ม "${c.assetGroup}" ในพอร์ต: ไม่ซ้ำกับที่ถืออยู่`)
            if (peers.length > 0) {
              const share = peersUnpriced ? (peerWeight > 0 ? `รวมอย่างน้อย ${fmtPct(peerWeight, 1)} (บางตัวไม่มีราคา)` : 'ยังคำนวณสัดส่วนไม่ได้เพราะไม่มีราคา') : `รวม ${fmtPct(peerWeight, 1)}`
              caution.push(`มีหลักทรัพย์อื่นในกลุ่ม "${c.assetGroup}" อยู่แล้ว (${peers.map((p) => secById.get(p.securityId)?.symbol).join(', ')}) ${share}: อาจถือสินทรัพย์ซ้ำซ้อน`)
            }
            if (ownWeight !== null && ownWeight > set.maxPositionPct) caution.push(`ถืออยู่แล้ว ${fmtPct(ownWeight, 1)} ของพอร์ตรวม เกินเกณฑ์ต่อหลักทรัพย์ ${fmtNum(set.maxPositionPct, 0)}%`)
            if (c.currency === base) study.push(`ซื้อขายเป็น ${base}: ไม่มีความเสี่ยงอัตราแลกเปลี่ยนโดยตรง`)
            else caution.push(`ซื้อขายเป็น ${c.currency}: ผลตอบแทนเมื่อคิดเป็น ${base} ขึ้นกับอัตราแลกเปลี่ยนด้วย${rate === null ? ' (ยังไม่มีอัตราแลกเปลี่ยนในระบบ)' : ''}`)
            for (const f of fees) {
              const ccy = f.pv.plan.budgetCurrency
              const name = f.pv.plan.name
              if (f.pv.plan.feePct === 0 && f.pv.plan.feeMin === 0) caution.push(`แผน "${name}" ยังไม่ได้กรอกค่าธรรมเนียม ต้นทุนที่ประมาณไว้จึงอาจต่ำกว่าจริง`)
              else if (f.feeDragPct !== null && f.feeDragPct > 1) caution.push(`ค่าธรรมเนียมโดยประมาณ ${fmtPct(f.feeDragPct, 2)} ของยอดซื้อ${f.daily ? 'ต่อวัน' : 'ต่อรอบ'} ${fmtMoney(f.amount, ccy)} ในแผน "${name}"`)
              else if (f.feeDragPct !== null && f.feeDragPct <= 0.5) study.push(`ค่าธรรมเนียมโดยประมาณต่อรอบในแผน "${name}" ${fmtPct(f.feeDragPct, 2)} ของยอดซื้อ`)
              if (f.belowMinimum) caution.push(`ยอดต่อรอบ ${fmtMoney(f.amount, ccy)} ต่ำกว่าเงินลงทุนขั้นต่ำ ${fmtMoney(f.pv.plan.minInvestment, ccy)} ของแผน "${name}"`)
              const inSec = convert(s, f.amount, ccy, c.currency)
              if (!f.pv.plan.allowFractional && price && inSec !== null && inSec < price.price) caution.push(`ยอดต่อรอบในแผน "${name}" ไม่พอซื้อ 1 หุ้นที่ราคาล่าสุด (แผนตั้งว่าไม่รองรับเศษหุ้น)`)
              if (f.pv.plan.riskLevel === 'low' && c.assetType === 'stock') caution.push(`แผน "${name}" ตั้งความเสี่ยงที่รับได้ไว้ "${RISK.low}" แต่หลักทรัพย์นี้เป็นหุ้นรายตัว`)
            }
            if (!price) caution.push('ไม่มีข้อมูลราคาปัจจุบันในระบบ')
            else if (price.stale) caution.push('ราคาที่มีเป็นข้อมูลเก่า (Cached) ตรวจสอบราคาล่าสุดก่อนตัดสินใจ')
            if (fund?.status === 'done' && !fd) caution.push('ไม่มีข้อมูลพื้นฐานจากผู้ให้บริการ ต้องศึกษาข้อมูลจากแหล่งอื่นเพิ่มเติม')
            if (fd?.eps !== null && fd?.eps !== undefined) {
              if (fd.eps < 0) caution.push(`EPS ติดลบ (${fmtNum(fd.eps, 2)}) ตามข้อมูลผู้ให้บริการ: บริษัทขาดทุนในงวดล่าสุดที่มีข้อมูล`)
              else if (fd.eps > 0) study.push(`EPS เป็นบวก (${fmtNum(fd.eps, 2)}) ตามข้อมูลผู้ให้บริการ`)
            }
            if (fd?.dividendYieldPct) {
              const forDividend = plans.some((pv) => pv.plan.objective === 'dividend')
              study.push(`อัตราเงินปันผล ${fmtPct(fd.dividendYieldPct, 2)} ตามข้อมูลผู้ให้บริการ${forDividend ? ' (มีแผนที่ตั้งเป้าหมายเน้นเงินปันผล)' : ''}`)
            }

            return (
              <Card
                key={c.id}
                title={
                  <span>
                    {c.symbol} <span className="font-normal text-muted">· {c.exchange}</span>
                  </span>
                }
                subtitle={c.name}
                actions={
                  <div className="flex flex-wrap gap-1">
                    {plans.map((pv) => (
                      <Badge key={pv.plan.id} tone="accent">
                        แผน: {pv.plan.name}
                      </Badge>
                    ))}
                    {w && <Badge tone="warn">Watchlist: {WATCH_LABEL[w.status]}</Badge>}
                  </div>
                }
              >
                <div className="space-y-3 text-sm">
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-muted">ราคาปัจจุบัน</dt>
                      <dd>
                        <span className="num font-medium">{price ? `${fmtNum(price.price, 2)} ${c.currency}` : 'ไม่มีข้อมูล'}</span>
                        <div>
                          <PriceSource price={price} timeZone={timezone} />
                        </div>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">หมวด / ประเภท</dt>
                      <dd>
                        {c.category} · {ASSET_TYPE[c.assetType] ?? c.assetType}
                        {c.assetGroup && <div className="text-xs text-muted">กลุ่มสินทรัพย์: {c.assetGroup}</div>}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">การถือซ้ำในพอร์ตรวม (Overlap)</dt>
                      <dd className="text-xs leading-relaxed">
                        หลักทรัพย์นี้ <span className="num">{ownPos ? (ownWeight === null ? 'ถืออยู่ (ไม่มีราคา)' : fmtPct(ownWeight, 1)) : '0%'}</span> · หมวด {c.category} <span className="num">{fmtPct(catWeight, 1)}</span>
                        {c.assetGroup && (
                          <>
                            {' '}
                            · กลุ่มเดียวกัน (ตัวอื่น) <span className="num">{fmtPct(peerWeight, 1)}</span>
                            {peersUnpriced && ' + ตัวที่ไม่มีราคา'}
                          </>
                        )}
                        {!combined.complete && <div className="text-warn">สัดส่วนคิดเฉพาะหลักทรัพย์ที่มีราคา</div>}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">อัตราแลกเปลี่ยน / ค่าธรรมเนียม</dt>
                      <dd className="space-y-0.5 text-xs leading-relaxed">
                        {c.currency === base ? (
                          <div>สกุลเงิน {base}: ไม่มีความเสี่ยงอัตราแลกเปลี่ยนโดยตรง</div>
                        ) : fx ? (
                          <div>
                            1 {c.currency} = <span className="num">{fmtNum(fx.rate, 4)}</span> {base} (ณ {fmtDate(fx.date)}, {fx.source}) · ราคาและผลตอบแทนเป็นบาทขึ้นกับอัตรานี้
                          </div>
                        ) : (
                          <div className="text-warn">ไม่มีอัตราแลกเปลี่ยน {c.currency}/{base}</div>
                        )}
                        {fees.length === 0 ? (
                          <div className="text-muted">ยังไม่อยู่ในแผน DCA ที่ใช้งาน: ค่าธรรมเนียมขึ้นกับแผนที่จะใส่</div>
                        ) : (
                          fees.map((f) => (
                            <div key={f.pv.plan.id}>
                              แผน &quot;{f.pv.plan.name}&quot;: {f.daily ? 'เฉลี่ยวันละ' : 'รอบละ'} <span className="num">{fmtMoney(f.amount, f.pv.plan.budgetCurrency)}</span> ค่าธรรมเนียมประมาณ <span className="num">{fmtMoney(f.estFee, f.pv.plan.budgetCurrency)}</span>
                              {f.feeDragPct !== null && <span className="num"> ({fmtPct(f.feeDragPct, 2)})</span>}
                              <span className="text-muted">
                                {' '}
                                · ตั้งไว้ {fmtNum(f.pv.plan.feePct, 2)}% ขั้นต่ำ {fmtMoney(f.pv.plan.feeMin, f.pv.plan.budgetCurrency)}
                              </span>
                            </div>
                          ))
                        )}
                      </dd>
                    </div>
                  </dl>

                  <div className="rounded-lg border border-line p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-medium text-muted">ข้อมูลพื้นฐาน (Fundamentals)</span>
                      <Button size="sm" icon={<Database size={14} />} loading={fund?.status === 'loading'} onClick={() => void loadFund(c.id)}>
                        {fund?.status === 'done' ? 'โหลดใหม่' : 'โหลดข้อมูลพื้นฐาน'}
                      </Button>
                    </div>
                    {fund?.status === 'error' && <p className="mt-2 text-xs text-loss">{fund.error}</p>}
                    {fund?.status === 'done' &&
                      (fd ? (
                        <div className="mt-2 text-xs">
                          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                            <Fact label="Sector" value={fd.sector ?? 'ไม่มีข้อมูล'} />
                            <Fact label="Industry" value={fd.industry ?? 'ไม่มีข้อมูล'} />
                            <Fact label="P/E" value={fd.peRatio !== null ? fmtNum(fd.peRatio, 2) : 'ไม่มีข้อมูล'} />
                            <Fact label="EPS" value={fd.eps !== null ? fmtNum(fd.eps, 2) : 'ไม่มีข้อมูล'} />
                            <Fact label="อัตราเงินปันผล" value={fd.dividendYieldPct !== null ? fmtPct(fd.dividendYieldPct, 2) : 'ไม่มีข้อมูล'} />
                            <Fact label="มูลค่าตลาด" value={fd.marketCap !== null ? fmtCompact(fd.marketCap) : 'ไม่มีข้อมูล'} />
                          </dl>
                          {fd.description && <p className="mt-2 line-clamp-3 text-muted">{fd.description}</p>}
                          <p className="mt-1 text-muted">
                            ข้อมูล ณ {fmtDateTime(fund.result.fetchedAt, timezone)} · แหล่งข้อมูล {fund.result.source ?? '—'}
                            {fund.result.notice && <span className="text-warn"> · {fund.result.notice}</span>}
                          </p>
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-muted">
                          ไม่มีข้อมูล{fund.result.notice ? `: ${fund.result.notice}` : ''}
                        </p>
                      ))}
                    {!fund && <p className="mt-1 text-xs text-muted">โหลดเมื่อต้องการเท่านั้น (ใช้โควตาของผู้ให้บริการข้อมูล)</p>}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <ReasonList title="เหตุผลที่ควรศึกษาต่อ" tone="accent" items={study} empty="ไม่มีจุดเด่นที่ระบุได้จากข้อมูลในระบบ" />
                    <ReasonList title="เหตุผลที่ควรระมัดระวัง" tone="warn" items={caution} empty="ไม่พบข้อควรระวังจากข้อมูลในระบบ (ไม่ได้แปลว่าไม่มีความเสี่ยง)" />
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="break-words font-medium">{value}</dd>
    </div>
  )
}

function ReasonList({ title, tone, items, empty }: { title: string; tone: 'accent' | 'warn'; items: string[]; empty: string }) {
  return (
    <div className={tone === 'accent' ? 'rounded-lg bg-accent-soft/60 p-3' : 'rounded-lg bg-warn-soft/60 p-3'}>
      <div className={tone === 'accent' ? 'text-xs font-semibold text-accent' : 'text-xs font-semibold text-warn'}>{title}</div>
      {items.length === 0 ? (
        <p className="mt-1 text-xs text-muted">{empty}</p>
      ) : (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-relaxed">
          {items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
