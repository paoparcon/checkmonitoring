import ExcelJS from 'exceljs'
import { OTHER_PAYMENT_METHODS, methodLabel } from '@/lib/integrations/acumatica/other-payments'
import { formatManila } from '@/lib/manila-format'
import { manilaToday } from '@/lib/manila-day'
import { DISPLAY_MARKINGS } from '@/lib/payments/marking'
import type { PaymentRow } from '@/lib/payments/query'
import { amountToCentavos } from '@/lib/transmittal'
import { currencyNumberFormat, fitColumnWidth } from './report'
import { BAND_FILL, COUNT_FORMAT, DATE_FORMAT, DATE_WIDTH_SAMPLE, GRID, styleHeaderCell } from './sheet-style'

/**
 * OTHER PAYMENTS as a workbook (user, 2026-11-20: "just a presentable excel
 * extraction"). SUMMARY - by marking, by method, by month - then ALL PAYMENTS
 * and one sheet per method that has a payment.
 *
 * Amounts stay in each payment's own currency: one column per currency on the
 * summary, a currency number format per cell on the detail, and never a sum
 * across currencies. A payment Acumatica voided reads CANCELLED, is counted,
 * and is left out of every amount. Sums are centavos in BigInt; the number
 * written to a cell is presentational only (see workbook.ts).
 */

export const PAYMENTS_SUMMARY_SHEET = 'SUMMARY'
export const PAYMENTS_ALL_SHEET = 'ALL PAYMENTS'
export const NO_CURRENCY = '(NO CURRENCY)'
export const TOTAL_LABEL = 'TOTAL (EXCLUDING CANCELLED)'

export const PAYMENT_HEADERS = [
  'CV NO.', 'METHOD', 'MARKING', 'PAYEE', 'COMPANY', 'PAYMENT DATE', 'CURRENCY', 'AMOUNT', 'REFERENCE',
  'BANK ACCOUNT', 'ACUMATICA STATUS', 'PROCESSED ON', 'CLEARED ON', 'BANK REFERENCE', 'REMARKS',
  'DESCRIPTION', 'MARKED BY', 'TENANT',
] as const
const AMOUNT_COL = PAYMENT_HEADERS.indexOf('AMOUNT') + 1
const DATE_COLS = [PAYMENT_HEADERS.indexOf('PAYMENT DATE') + 1, PAYMENT_HEADERS.indexOf('PROCESSED ON') + 1, PAYMENT_HEADERS.indexOf('CLEARED ON') + 1]

/** What MARKED BY says for a marking nobody has set by hand. */
export const ARRIVAL_MARKER = 'ON ARRIVAL (ACUMATICA STATUS)'

const ZERO = BigInt(0)
// Centavos -> an Excel number. Safe: a year of payments is far below 2^53 centavos.
const asNumber = (c: bigint) => Number(c) / 100
const currencyOf = (r: PaymentRow) => r.currency ?? NO_CURRENCY
const live = (r: PaymentRow) => !r.voided
const excelDay = (day: string | null): Date | '' => (day ? new Date(`${day}T00:00:00Z`) : '')

/** Per-currency centavo sums over the live rows with a readable amount. */
function sums(rows: readonly PaymentRow[]): Map<string, bigint> {
  const out = new Map<string, bigint>()
  for (const r of rows) {
    if (!live(r) || r.amount === null) continue
    const c = amountToCentavos(r.amount)
    if (c === null) continue
    out.set(currencyOf(r), (out.get(currencyOf(r)) ?? ZERO) + c)
  }
  return out
}

export function paymentsFilename(now: Date): string {
  return `OTHER PAYMENTS ${manilaToday(now)}.xlsx`
}

function band(row: ExcelJS.Row): void {
  row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } } })
}

function totalStyle(row: ExcelJS.Row, columns: number): void {
  for (let i = 1; i <= columns; i++) {
    const c = row.getCell(i)
    c.font = { bold: true }
    c.border = { top: { style: 'thin', color: { argb: 'FF1E293B' } } }
  }
}

/** One summary block: a caption, a header row, the lines, and a bold total. */
function addBlock(
  ws: ExcelJS.Worksheet,
  args: {
    caption: string
    first: string
    lines: readonly { label: string; rows: readonly PaymentRow[] }[]
    currencies: readonly string[]
    /** Extra count columns between PAYMENTS and the amounts (BY METHOD's markings). */
    counts?: readonly { label: string; of: (rows: readonly PaymentRow[]) => number }[]
    totalRows: readonly PaymentRow[]
  },
): void {
  const { caption, first, lines, currencies, counts = [], totalRows } = args
  const cap = ws.addRow([caption])
  cap.font = { bold: true, size: 11 }
  const head = ws.addRow([])
  const labels = [first, 'PAYMENTS', ...counts.map((c) => c.label), ...currencies.map((c) => `AMOUNT ${c}`)]
  labels.forEach((l, i) => styleHeaderCell(head.getCell(i + 1), l, i === 0 ? 'left' : 'right'))
  const write = (label: string, rows: readonly PaymentRow[], countAll: boolean) => {
    const s = sums(rows)
    const r = ws.addRow([
      label, countAll ? rows.length : rows.filter(live).length, ...counts.map((c) => c.of(rows)),
      ...currencies.map((c) => (s.has(c) ? asNumber(s.get(c)!) : '')),
    ])
    for (let i = 2; i <= 2 + counts.length; i++) r.getCell(i).numFmt = COUNT_FORMAT
    currencies.forEach((c, i) => { r.getCell(3 + counts.length + i).numFmt = currencyNumberFormat(c) })
    return r
  }
  lines.forEach((l, i) => {
    const r = write(l.label, l.rows, true)
    if (i % 2 === 1) band(r)
  })
  totalStyle(write(TOTAL_LABEL, totalRows, false), labels.length)
  ws.addRow([])
}

function addDetailSheet(wb: ExcelJS.Workbook, name: string, rows: readonly PaymentRow[]): void {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] })
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  const head = ws.addRow([])
  head.height = 22
  PAYMENT_HEADERS.forEach((label, i) => styleHeaderCell(head.getCell(i + 1), label, i + 1 === AMOUNT_COL ? 'right' : 'left'))

  const text: string[][] = PAYMENT_HEADERS.map(() => [])
  rows.forEach((r, i) => {
    const cents = r.amount === null ? null : amountToCentavos(r.amount)
    const values: (string | number | Date)[] = [
      r.referenceNbr, methodLabel(r.method), r.display, r.payee ?? '', r.company ?? r.branch ?? '',
      excelDay(r.paymentDate), currencyOf(r),
      // An unreadable amount is blank, never 0: a zero would read as a recorded figure.
      cents === null ? '' : asNumber(cents),
      r.paymentRef ?? '', r.cashAccount ?? '', r.acumaticaStatus ?? '',
      excelDay(r.processedDate), excelDay(r.clearedDate), r.bankReference ?? '', r.remarks ?? '',
      r.description ?? '', r.markedBy ?? ARRIVAL_MARKER, r.tenant,
    ]
    const row = ws.addRow(values)
    row.getCell(AMOUNT_COL).numFmt = currencyNumberFormat(currencyOf(r))
    for (const c of DATE_COLS) row.getCell(c).numFmt = DATE_FORMAT
    row.eachCell({ includeEmpty: true }, (c) => { c.border = { bottom: { style: 'hair', color: { argb: GRID } } } })
    if (i % 2 === 1) band(row)
    if (r.voided) row.eachCell({ includeEmpty: true }, (c) => { c.font = { color: { argb: 'FF94A3B8' }, strike: true } })
    values.forEach((v, c) => { text[c].push(v instanceof Date ? DATE_WIDTH_SAMPLE : typeof v === 'number' ? '000,000,000.00' : v) })
  })
  if (rows.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + rows.length, column: PAYMENT_HEADERS.length } }
  }

  // Under the filter range, so sorting the data never carries a total with it.
  ws.addRow([])
  const s = sums(rows)
  for (const currency of [...s.keys()].sort()) {
    const liveCount = rows.filter((r) => live(r) && currencyOf(r) === currency).length
    const t = ws.addRow([])
    t.getCell(4).value = `${TOTAL_LABEL} — ${liveCount.toLocaleString('en-US')} PAYMENT${liveCount === 1 ? '' : 'S'}`
    t.getCell(AMOUNT_COL - 1).value = currency
    t.getCell(AMOUNT_COL).value = asNumber(s.get(currency)!)
    t.getCell(AMOUNT_COL).numFmt = currencyNumberFormat(currency)
    t.font = { bold: true }
  }
  PAYMENT_HEADERS.forEach((label, i) => { ws.getColumn(i + 1).width = fitColumnWidth(label, text[i]) + 2 })
}

export async function buildPaymentsWorkbook(args: {
  rows: readonly PaymentRow[]
  generatedAt: Date
  generatedBy: string
}): Promise<Buffer> {
  const { rows, generatedAt, generatedBy } = args
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Check Release Monitoring'
  wb.created = generatedAt

  const currencies = [...new Set(rows.filter(live).map(currencyOf))].sort()
  const ws = wb.addWorksheet(PAYMENTS_SUMMARY_SHEET)
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }

  const title = ws.addRow(['OTHER PAYMENTS'])
  title.font = { bold: true, size: 16 }
  ws.addRow(['Telegraphic transfers, letters of credit, DP at sight and manager\'s checks, as recorded in Acumatica (payments dated 2026 onward).'])
  ws.addRow([
    `Generated ${formatManila(generatedAt, { dateStyle: 'medium', timeStyle: 'short' })} by ${generatedBy}. ` +
    `${rows.length.toLocaleString('en-US')} payment${rows.length === 1 ? '' : 's'}.`,
  ])
  const note = ws.addRow(['Amounts are in each payment\'s own currency and are never added across currencies. A CANCELLED payment (voided in Acumatica) is counted and left out of every amount.'])
  note.font = { italic: true, color: { argb: 'FF475569' } }
  ws.addRow([])

  addBlock(ws, {
    caption: 'BY MARKING', first: 'MARKING', currencies, totalRows: rows,
    lines: DISPLAY_MARKINGS.map((label) => ({ label, rows: rows.filter((r) => r.display === label) })),
  })

  const methods = [...new Set([...OTHER_PAYMENT_METHODS, ...rows.map((r) => r.method)])].filter((m) => rows.some((r) => r.method === m))
  addBlock(ws, {
    caption: 'BY METHOD', first: 'METHOD', currencies, totalRows: rows,
    counts: DISPLAY_MARKINGS.map((label) => ({ label, of: (rs: readonly PaymentRow[]) => rs.filter((r) => r.display === label).length })),
    lines: methods.map((m) => ({ label: methodLabel(m), rows: rows.filter((r) => r.method === m) })),
  })

  const months = [...new Set(rows.map((r) => r.paymentDate?.slice(0, 7) ?? ''))].sort()
  addBlock(ws, {
    caption: 'BY PAYMENT MONTH', first: 'MONTH', currencies, totalRows: rows,
    lines: months.map((m) => ({
      label: m === '' ? '(NO PAYMENT DATE)' : formatManila(new Date(`${m}-01T00:00:00Z`), { month: 'long', year: 'numeric' }),
      rows: rows.filter((r) => (r.paymentDate?.slice(0, 7) ?? '') === m),
    })),
  })

  ws.getColumn(1).width = 34
  const widest = 2 + DISPLAY_MARKINGS.length + currencies.length
  for (let i = 2; i <= widest; i++) ws.getColumn(i).width = 20

  addDetailSheet(wb, PAYMENTS_ALL_SHEET, rows)
  for (const m of methods) addDetailSheet(wb, methodLabel(m).slice(0, 31), rows.filter((r) => r.method === m))

  return Buffer.from(await wb.xlsx.writeBuffer())
}
