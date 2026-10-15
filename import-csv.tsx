'use client'

/**
 * CSV import of investment transactions in two steps:
 *   1. preview (server re-parses, validates every row, flags duplicates; nothing is written)
 *   2. confirm (server re-runs the same checks, then imports all-or-nothing)
 */
import { useState } from 'react'
import { Download, Upload } from 'lucide-react'
import { commitImportAction, previewImportAction } from '@/actions/app'
import type { ImportPreview } from '@/lib/services/portfolio'
import type { AccountRow } from '@/lib/calc/types'
import { fmtNum, fmtQty } from '@/lib/format'
import { useAction } from './forms'
import { Badge, Button, Checkbox, Field, Modal, Notice, Select } from './ui'

const TEMPLATE =
  'date,type,symbol,exchange,quantity,price,amount,fee,fx_rate,split_ratio,note\r\n' +
  '2026-01-05,buy,MSFT,NASDAQ,1.5,420.10,,0.99,34.85,,ตัวอย่าง: ซื้อ\r\n' +
  '2026-03-12,dividend,MSFT,NASDAQ,,,1.25,0.19,35.10,,ตัวอย่าง: ปันผล (fee = ภาษีหัก ณ ที่จ่าย)\r\n' +
  '2026-04-01,buy,PTT,SET,100,34.25,,15,,,หุ้นไทยไม่ต้องใส่ fx_rate\r\n'

export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ImportCsvDialog({ accounts, defaultPortfolio = 'main', onClose }: { accounts: AccountRow[]; defaultPortfolio?: 'main' | 'dca'; onClose: () => void }) {
  const [csv, setCsv] = useState('')
  const [fileName, setFileName] = useState('')
  const [portfolio, setPortfolio] = useState<'main' | 'dca'>(defaultPortfolio)
  const [accountId, setAccountId] = useState('')
  const [includeDuplicates, setIncludeDuplicates] = useState(false)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const previewer = useAction(previewImportAction)
  const committer = useAction(commitImportAction, {
    success: (d) => `นำเข้า ${d.imported} รายการ${d.skippedDuplicates ? ` ข้ามรายการซ้ำ ${d.skippedDuplicates}` : ''}${d.createdSecurities.length ? ` เพิ่มหลักทรัพย์ใหม่: ${d.createdSecurities.join(', ')}` : ''}`,
    onSuccess: onClose,
  })

  const readFile = async (f: File | undefined) => {
    if (!f) return
    if (f.size > 900_000) return setPreview(null), setCsv(''), setFileName(`${f.name}: ไฟล์ใหญ่เกิน 900 KB`)
    setFileName(f.name)
    setCsv(await f.text())
    setPreview(null)
  }
  const runPreview = async () => {
    const res = await previewer.run({ csv, portfolio, accountId: accountId || null })
    if (res.ok) setPreview(res.data)
  }
  const accountOpts = accounts.filter((a) => !a.isArchived && a.type !== 'other_asset')

  return (
    <Modal
      open
      wide
      onClose={committer.pending ? () => {} : onClose}
      title="นำเข้าธุรกรรมจากไฟล์ CSV"
      footer={
        <>
          <Button onClick={onClose} disabled={committer.pending}>
            ยกเลิก
          </Button>
          {!preview ? (
            <Button variant="primary" loading={previewer.pending} disabled={!csv} onClick={() => void runPreview()}>
              ตรวจสอบก่อนนำเข้า
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={committer.pending}
              disabled={preview.counts.error > 0 || preview.missingColumns.length > 0 || preview.counts.new + (includeDuplicates ? preview.counts.duplicate : 0) === 0}
              onClick={() => void committer.run({ csv, portfolio, accountId: accountId || null, includeDuplicates })}
            >
              ยืนยันนำเข้า {preview.counts.new + (includeDuplicates ? preview.counts.duplicate : 0)} รายการ
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <Notice tone="info">
          ระบบนี้ไม่ได้เชื่อมต่อบัญชีโบรกเกอร์โดยตรง ให้ส่งออกรายการจากโบรกเกอร์แล้วจัดรูปแบบตามแม่แบบ คอลัมน์: date (YYYY-MM-DD), type (buy/sell/dividend/fee/split/adjustment), symbol, exchange (NASDAQ/NYSE/NYSEARCA/AMEX/BATS/SET), quantity, price, amount, fee, fx_rate (บาทต่อ 1 หน่วยสกุลเงินของหุ้น), split_ratio, note
        </Notice>
        <Button size="sm" icon={<Download size={14} />} onClick={() => downloadText('sinsap-import-template.csv', '﻿' + TEMPLATE)}>
          ดาวน์โหลดแม่แบบ CSV
        </Button>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="ไฟล์ CSV" required hint={fileName || 'UTF-8 พร้อมแถวหัวตาราง'}>
            <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line px-3 text-sm text-muted hover:bg-surface-2">
              <Upload size={15} /> เลือกไฟล์
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void readFile(e.target.files?.[0])} />
            </label>
          </Field>
          <Field label="นำเข้าไปยังพอร์ต" required>
            <Select
              value={portfolio}
              onChange={(e) => {
                setPortfolio(e.target.value as 'main' | 'dca')
                setPreview(null)
              }}
            >
              <option value="main">My Portfolio</option>
              <option value="dca">DCA Portfolio</option>
            </Select>
          </Field>
          <Field label="ผูกกับบัญชีเงินสด (ไม่บังคับ)" hint="ถ้าเลือก ยอดเงินในบัญชีจะถูกตัด/เพิ่มตามธุรกรรม" className="sm:col-span-2">
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">ไม่ผูกบัญชี</option>
              {accountOpts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency})
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {preview && (
          <div className="space-y-2">
            {preview.missingColumns.length > 0 && <Notice tone="danger">ไฟล์ขาดคอลัมน์ที่จำเป็น: {preview.missingColumns.join(', ')}</Notice>}
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge tone="gain">ใหม่ {preview.counts.new}</Badge>
              <Badge tone="warn">ซ้ำ {preview.counts.duplicate}</Badge>
              <Badge tone="loss">ผิดพลาด {preview.counts.error}</Badge>
            </div>
            {preview.counts.error > 0 && <Notice tone="danger">แก้ไขบรรทัดที่ผิดพลาดในไฟล์ก่อน ระบบจะไม่นำเข้าบางส่วน (all-or-nothing)</Notice>}
            {preview.counts.duplicate > 0 && <Checkbox label="นำเข้ารายการที่ระบบพบว่าซ้ำด้วย (ใช้เมื่อมีธุรกรรมเหมือนกันจริง ๆ หลายรายการในวันเดียวกัน)" checked={includeDuplicates} onChange={setIncludeDuplicates} />}
            <div className="max-h-72 overflow-auto rounded-lg border border-line">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface-2 text-muted">
                  <tr>
                    {['บรรทัด', 'สถานะ', 'วันที่', 'ประเภท', 'หุ้น', 'จำนวน', 'ราคา/จำนวนเงิน', 'หมายเหตุ'].map((h) => (
                      <th key={h} className="px-2 py-1.5 text-left font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.line} className="border-t border-line">
                      <td className="px-2 py-1">{r.line}</td>
                      <td className="px-2 py-1">
                        <Badge tone={r.status === 'new' ? 'gain' : r.status === 'duplicate' ? 'warn' : 'loss'}>{r.status === 'new' ? 'ใหม่' : r.status === 'duplicate' ? 'ซ้ำ' : 'ผิดพลาด'}</Badge>
                      </td>
                      <td className="num px-2 py-1">{r.date}</td>
                      <td className="px-2 py-1">{r.type}</td>
                      <td className="px-2 py-1">
                        {r.symbol} <span className="text-muted">{r.exchange}</span>
                      </td>
                      <td className="num px-2 py-1">{fmtQty(r.quantity)}</td>
                      <td className="num px-2 py-1">{r.price !== null ? fmtNum(r.price, 4) : fmtNum(r.amount, 2)}</td>
                      <td className="px-2 py-1 text-muted">{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
