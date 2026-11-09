import ExcelJS from 'exceljs'
import { currencyNumberFormat, fitColumnWidth } from './report'
import { DATE_FORMAT, styleHeaderCell } from './sheet-style'
import type { ReconComputation } from '@/lib/recon/monthly/compute'
import { LINE_KIND_LABEL } from '@/lib/recon/monthly/labels'
import { monthLabel, neg, add, STATUS_LABEL, type ReconStatus } from '@/lib/recon/monthly/period'

/**
 * ONE MONTH'S RECONCILIATION REPORT (spec 2026-11-09 §8). SUMMARY holds the
 * twelve figures and both calculations as the page shows them; then one sheet
 * per list behind them, and the approval history. The file is the page: an
 * approved month is written from its frozen snapshot. Amounts are Excel
 * numbers in the cells (the one sanctioned JS number for money); every sum was
 * done in centavos in `compute.ts`.
 */
export type PeriodReportMeta = {
  accountCode: string
  bankCode: string
  month: string
  currency: string
  status: ReconStatus
  frozen: boolean
  generatedAt: Date
  generatedBy: string
  approvedBy: string | null
  history: { at: Date; action: string; by: string; remarks: string | null }[]
}

const num = (s: string | null) => (s === null ? null : Number(s))
const day = (s: string | null) => (s ? new Date(`${s}T00:00:00Z`) : null)

function table(ws: ExcelJS.Worksheet, headers: string[], rows: (string | number | Date | null)[][], moneyCols: number[], dateCols: number[], currency: string) {
  const head = ws.addRow(headers)
  headers.forEach((h, i) => styleHeaderCell(head.getCell(i + 1), h, moneyCols.includes(i) ? 'right' : 'left'))
  for (const r of rows) ws.addRow(r)
  headers.forEach((h, i) => {
    const col = ws.getColumn(i + 1)
    if (moneyCols.includes(i)) col.numFmt = currencyNumberFormat(currency)
    if (dateCols.includes(i)) col.numFmt = DATE_FORMAT
    col.width = fitColumnWidth(h, rows.map((r) => (r[i] instanceof Date ? '01 Sep 2026' : String(r[i] ?? ''))))
  })
  ws.views = [{ state: 'frozen', ySplit: 1 }]
}

export async function buildPeriodWorkbook(c: ReconComputation, meta: PeriodReportMeta): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Check Release Monitoring'
  wb.created = meta.generatedAt
  const f = c.figures
  const fmt = currencyNumberFormat(meta.currency)

  const ws = wb.addWorksheet('SUMMARY')
  ws.getCell('A1').value = `BANK RECONCILIATION — ${meta.accountCode} (${meta.bankCode}) — ${monthLabel(meta.month)}`
  ws.getCell('A1').font = { bold: true, size: 16 }
  ws.getCell('A2').value = `${STATUS_LABEL[meta.status]}${meta.frozen ? ` · figures as approved${meta.approvedBy ? ` by ${meta.approvedBy}` : ''}` : ' · live figures, not yet approved'} · ${meta.currency}`
  ws.getCell('A3').value = `Generated ${meta.generatedAt.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' })} by ${meta.generatedBy}`
  ws.getCell('A3').font = { size: 10, color: { argb: 'FF475569' } }
  const put = (label: string, value: string | null, bold = false) => {
    const row = ws.addRow([label, num(value)])
    row.getCell(2).numFmt = fmt
    if (bold) row.font = { bold: true }
  }
  ws.addRow([])
  for (const [l, v] of [
    ['Beginning bank balance', f.beginningBank], ['Beginning book balance', f.beginningBook],
    ['Total bank credits', f.totalBankCredits], ['Total bank debits', f.totalBankDebits],
    ['Total book deposits', f.totalBookDeposits], [`Total checks released (${c.counts.checksReleased})`, f.totalChecksReleased],
    [`Cleared checks (${c.counts.clearedChecks})`, f.totalClearedChecks], [`Outstanding checks (${c.counts.outstandingChecks})`, f.totalOutstandingChecks],
    ['Bank charges and unrecorded debits', add(f.bankCharges, f.unidentifiedDebits)], ['Other adjustments (net)', add(f.bankAdjustments, f.bookAdjustments)],
    ['Ending bank balance', f.endingBank], ['Ending book balance', f.endingBook],
  ] as const) put(l, v)
  ws.addRow([])
  ws.addRow(['BANK BALANCE RECONCILIATION']).font = { bold: true }
  put('Bank statement ending balance', f.endingBank)
  put('Add: deposits in transit', f.depositsInTransit)
  put('Less: outstanding checks', neg(f.totalOutstandingChecks))
  put('Less: outstanding non-check disbursements', neg(f.outstandingDisbursements))
  put('Add / less: other bank adjustments', f.bankAdjustments)
  put('ADJUSTED BANK BALANCE', f.adjustedBank, true)
  ws.addRow([])
  ws.addRow(['BOOK BALANCE RECONCILIATION']).font = { bold: true }
  put('Book ending balance (before adjustments)', f.bookBalanceBeforeAdjustments)
  put('Add: bank credits not yet recorded', add(f.bankCreditsUnrecorded, f.unidentifiedCredits))
  put('Less: bank charges and other unrecorded debits', neg(add(f.bankCharges, f.unidentifiedDebits)))
  put('Add / less: other book adjustments', f.bookAdjustments)
  put('ADJUSTED BOOK BALANCE', f.adjustedBook, true)
  ws.addRow([])
  put('DIFFERENCE (ADJUSTED BANK − ADJUSTED BOOK)', f.difference, true)
  for (const v of c.variance) ws.addRow([v.message])
  ws.getColumn(1).width = 60
  ws.getColumn(2).width = 22

  const checks = (name: string, items: ReconComputation['outstanding']) => table(
    wb.addWorksheet(name), ['CHECK NUMBER', 'PAYEE', 'RELEASED / DATED', 'BASIS', 'CLEARED', 'DAYS OUT', 'BEFORE BEGINNING', 'AMOUNT'],
    items.map((x) => [x.checkNumber, x.payee, day(x.issuedDay), x.basis, day(x.clearedDay), x.daysOutstanding, x.beforeOpening ? 'YES' : '', num(x.amount)]),
    [7], [2, 4], meta.currency,
  )
  checks('OUTSTANDING CHECKS', c.outstanding)
  checks('CLEARED CHECKS', c.cleared)
  checks('CHECKS RELEASED', c.released)
  table(wb.addWorksheet('BANK STATEMENT'), ['DATE', 'DESCRIPTION', 'REFERENCE', 'CHECK NO.', 'DEBIT', 'CREDIT', 'AS', 'METHOD', 'REMARKS'],
    c.lines.map((l) => [day(l.lineDay), l.description, l.reference, l.checkNumber, num(l.debit), num(l.credit), LINE_KIND_LABEL[l.kind], l.matchMethod, l.remarks]),
    [4, 5], [0], meta.currency)
  table(wb.addWorksheet('BOOK ENTRIES'), ['DATE', 'KIND', 'REFERENCE', 'DESCRIPTION', 'AMOUNT', 'BANK LINE DATE', 'IN TRANSIT AT MONTH END'],
    c.bookEntries.map((e) => [day(e.entryDay), e.kind, e.reference, e.description, num(e.amount), day(e.matchedLineDay), c.depositsInTransit.some((d) => d.id === e.id) || c.outstandingDisbursements.some((d) => d.id === e.id) ? 'YES' : '']),
    [4], [0, 5], meta.currency)
  table(wb.addWorksheet('DEPOSITS IN TRANSIT'), ['DATE', 'REFERENCE', 'DESCRIPTION', 'RECORDED IN', 'AMOUNT'],
    c.depositsInTransit.map((e) => [day(e.entryDay), e.reference, e.description, monthLabel(e.month), num(e.amount)]), [4], [0], meta.currency)
  table(wb.addWorksheet('ADJUSTMENTS'), ['SIDE', 'ADD / LESS', 'DESCRIPTION', 'REFERENCE', 'RECORDED IN', 'AMOUNT'],
    [...c.bankAdjustments, ...c.bookAdjustments].map((a) => [a.side, a.direction, a.description, a.reference, monthLabel(a.month), num(a.amount)])
      .concat(c.carriedBankErrors.map((l) => ['BANK', 'BANK ERROR', l.description, l.reference, monthLabel(l.month), num(l.debit ?? l.credit)])),
    [5], [], meta.currency)
  table(wb.addWorksheet('APPROVAL HISTORY'), ['WHEN', 'WHAT', 'BY', 'REMARKS'],
    meta.history.map((h) => [h.at.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' }), h.action, h.by, h.remarks]), [], [], meta.currency)

  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>
}
