import ExcelJS from 'exceljs'
import type { CheckTableRow } from '../queries'
import { formatMoney } from '../money'
import { manilaToday } from '../manila-day'
import {
  bankLabel, currencyNumberFormat, describeScope, fitColumnWidth,
  statusWords, totalsByCurrency,
} from './report'
import {
  HEADER_FILL, BAND_FILL, GRID, DATE_FORMAT, COUNT_FORMAT, DATE_WIDTH_SAMPLE, styleHeaderCell,
} from './sheet-style'
import { COLUMN_LABELS, type ColumnKey } from '../table-columns'

/**
 * The Excel export, as a workbook.
 *
 * "DON'T JUST EXTRACT IT, EXTRACTION SHOULD LOOK PROFESSIONAL AND CAN BE
 * PRESENTED TO MANAGEMENT" — the client. The formatting below is therefore the
 * requirement, not decoration: a title block that says what the reader is
 * looking at and what was excluded, a frozen header, columns fitted to their
 * own content, amounts that Excel can sum, and totals that never add two
 * currencies together.
 *
 * No database, no session, no request. Everything it needs is passed in, which
 * is what lets the whole file be generated into a buffer and read back cell by
 * cell in `tests/export/workbook.test.ts`.
 */

export const REGISTER_SHEET = 'CHECK REGISTER'
export const SUMMARY_SHEET = 'SUMMARY'

/**
 * The file's columns, in their default order — the table's columns less ACTION
 * and AVAILABLE DATE. DATE RELEASED stands where AVAILABLE DATE stood (user
 * request 2026-10-19: "replace AVAILABLE DATE to DATE RELEASED"). Since part C
 * (2026-10-01) the viewer's on-screen order reorders them (`cols=`), but never
 * removes one: a file missing AMOUNT because somebody hid it on screen would be
 * read as complete.
 *
 * PAYMENT REFERENCE stands where PICKUP SCHEDULE stood (user request
 * 2026-10-22: "Payment reference should be include in reports extraction of
 * checks released. Remove pick up schedule column."), so AMOUNT stays column H.
 * It is the supplier's receipt as encoded in the OR / CR box — type and
 * reference, "OR 4471", "OTHERS ACK-12" (user, 2026-10-22: "OR/CR or any
 * reference encoded") — never Acumatica's CV and never `crNumber` (rule 11).
 * A file-only column, so `cols=` never names it and it keeps its place after
 * the named ones.
 */
export const EXPORT_COLUMN_KEYS = [
  'checkNumber', 'apvNumbers', 'poNumbers', 'payeeName', 'companyCode', 'bank',
  'checkDate', 'amount', 'status', 'releasedAt', 'paymentReference',
] as const satisfies readonly (ColumnKey | 'paymentReference')[]
export type ExportColumnKey = (typeof EXPORT_COLUMN_KEYS)[number]

const exportLabel = (k: ExportColumnKey): string =>
  k === 'paymentReference' ? 'PAYMENT REFERENCE' : COLUMN_LABELS[k]

export const REGISTER_HEADERS: readonly string[] = EXPORT_COLUMN_KEYS.map(exportLabel)

/** The named columns first, in the order named; every other file column after, in default order. */
export function exportColumnOrder(cols: string | null | undefined): ExportColumnKey[] {
  const isExport = (k: string): k is ExportColumnKey => (EXPORT_COLUMN_KEYS as readonly string[]).includes(k)
  const named = [...new Set((cols ?? '').split(',').map((s) => s.trim()).filter(isExport))]
  return [...named, ...EXPORT_COLUMN_KEYS.filter((k) => !named.includes(k))]
}

/**
 * Four lines of title block, one blank row, then the header on row 6 and the
 * first cheque on row 7. Fixed — never conditional — so a reader opening two
 * exports side by side finds the table in the same place in both, and so the
 * tests address cells by name rather than by arithmetic over optional rows.
 */
export const TITLE_ROWS = 4
export const HEADER_ROW = TITLE_ROWS + 2
export const FIRST_DATA_ROW = HEADER_ROW + 1

/**
 * The figures `getSummary` returns, structurally.
 *
 * Written out rather than imported as `Awaited<ReturnType<typeof getSummary>>`
 * so this module needs nothing from Prisma, and so a test can hand it a literal.
 */
export type ExportSummary = {
  total: number
  pendingSignature: number
  signed: number
  readyForRelease: number
  scheduled: number
  released: number
  incomplete: number
  totalsByCurrency: readonly { currency: string; total: string | null; count: number }[]
}

export type ExportMeta = {
  /** The view's short name — "READY FOR RELEASE", "ALL CHEQUES". */
  viewLabel: string
  /** The narrowing filters in words, or "No filters applied". */
  filterDescription: string
  generatedAt: Date
  generatedBy: string
  /** How many cheques the filters match in total, before the row cap. */
  totalMatching: number
}

export type ExportInput = {
  rows: readonly CheckTableRow[]
  summary: ExportSummary
  meta: ExportMeta
  /** The column order (`exportColumnOrder`); default order when absent. */
  columns?: readonly ExportColumnKey[]
}

/**
 * A cheque's amount as an Excel number.
 *
 * THE ONE PLACE in this system where a JS number is an acceptable carrier for
 * money, and the exemption is narrow. Rule 8 exists because a float round-trip
 * loses centavos in arithmetic and in storage; this value does neither. It is
 * written straight into a cell as a presentational figure, never added to
 * anything here (`totalsByCurrency` does the adding in `bigint` centavos and
 * hands back a decimal string), and never read back into the database. A
 * `Decimal(18,2)` peso amount is at most 16 digits before the point — inside
 * IEEE-754's 15-to-17 significant digits, and orders of magnitude inside it for
 * any cheque this company has ever written.
 *
 * The alternative is a text cell, and a text cell is the whole reason this
 * function exists: management has to be able to sum and sort the column.
 */
function amountAsNumber(amount: string): number {
  return Number(amount)
}

type ExportCell = {
  kind: 'text' | 'date' | 'amount'
  value: (r: CheckTableRow) => ExcelJS.CellValue
  /** What the column's width is fitted to — the formatted figure for AMOUNT. */
  sample: (r: CheckTableRow) => string
}

const listOrNull = (xs: readonly string[]) => (xs.length ? xs.join(', ') : null)
const receiptReference = (r: CheckTableRow): string | null =>
  r.orNumber === null ? null : r.receiptType ? `${r.receiptType} ${r.orNumber}` : r.orNumber
/** The Manila calendar day of an instant, as that day's UTC midnight — the convention `checkDate` follows. */
const manilaDayAsDate = (d: Date) => new Date(`${manilaToday(d)}T00:00:00Z`)
const dateCell = (pick: (r: CheckTableRow) => Date | null): ExportCell =>
  ({ kind: 'date', value: pick, sample: (r) => (pick(r) ? DATE_WIDTH_SAMPLE : '') })

/**
 * Every file column: what its cell holds, and what its width is fitted to.
 * Keyed rather than positional, so `cols=` can put them in any order.
 */
const EXPORT_CELLS: Record<ExportColumnKey, ExportCell> = {
  checkNumber: { kind: 'text', value: (r) => r.checkNumber, sample: (r) => r.checkNumber },
  apvNumbers: { kind: 'text', value: (r) => listOrNull(r.apvNumbers), sample: (r) => listOrNull(r.apvNumbers) ?? '' },
  poNumbers: { kind: 'text', value: (r) => listOrNull(r.poNumbers), sample: (r) => listOrNull(r.poNumbers) ?? '' },
  payeeName: { kind: 'text', value: (r) => r.payeeName, sample: (r) => r.payeeName ?? '' },
  companyCode: { kind: 'text', value: (r) => r.companyCode, sample: (r) => r.companyCode },
  bank: {
    kind: 'text',
    value: (r) => bankLabel(r.cashAccountCode, r.bankCode),
    sample: (r) => bankLabel(r.cashAccountCode, r.bankCode) ?? '',
  },
  checkDate: dateCell((r) => r.checkDate),
  /**
   * BLANK, never 0, when the register recorded no amount — wherever AMOUNT stands.
   *
   * 129 production cheques are in this state. A zero here would be read as a
   * cheque genuinely drawn for nothing, and once the file is on somebody's
   * laptop there is no way left to tell the two apart. The dashboard renders
   * the same fact as an em dash; a spreadsheet cell has a better answer,
   * which is nothing at all — it also keeps the cheque out of any SUM the
   * reader writes themselves.
   *
   * The width is measured on the FORMATTED figure ("₱1,234,567,890.12"), not on
   * the raw decimal string, because the formatted one is what has to fit.
   */
  amount: {
    kind: 'amount',
    value: (r) => (r.amount === null ? null : amountAsNumber(r.amount)),
    sample: (r) => (r.amount === null ? '' : formatMoney(r.amount, r.currency)),
  },
  status: { kind: 'text', value: (r) => statusWords(r.status), sample: (r) => statusWords(r.status) },
  /**
   * The day the release was recorded in this app, as a MANILA day (an evening
   * release is 10:00+ UTC and must not slip to the next or previous day); for a
   * release the app never recorded, the register's stated day — the two the
   * screen shows in this column (the latter tagged REGISTER there). Blank when
   * neither exists: unknown is not a date.
   */
  releasedAt: dateCell((r) => (r.releasedAt ? manilaDayAsDate(r.releasedAt) : r.statedReleaseDate)),
  /** Blank when no receipt is recorded; the bare reference when its type was never stated. */
  paymentReference: { kind: 'text', value: (r) => receiptReference(r), sample: (r) => receiptReference(r) ?? '' },
}

/**
 * The four lines above the table.
 *
 * NOT merged, deliberately. A merged cell CLIPS text that is wider than the
 * merge; an unmerged one spills across the empty cells to its right, which is
 * what every spreadsheet does with a report title and is the only behaviour
 * that cannot silently cut the filter line — the longest and the most important
 * of the four — in half.
 */
function titleBlock(
  ws: ExcelJS.Worksheet,
  lines: readonly [string, string, string, string],
) {
  lines.forEach((text, i) => {
    ws.getCell(i + 1, 1).value = text
  })

  const title = ws.getCell(1, 1)
  title.font = { bold: true, size: 16, color: { argb: 'FF0F172A' } }
  ws.getRow(1).height = 24

  ws.getCell(2, 1).font = { bold: true, size: 12, color: { argb: 'FF0F172A' } }
  ws.getCell(3, 1).font = { size: 10, color: { argb: 'FF475569' } }
  ws.getCell(4, 1).font = { size: 10, color: { argb: 'FF475569' } }
}

/** `Generated 06 Sep 2026 at 2:30 PM by Paolo Parcon`. */
function generatedLine(meta: ExportMeta): string {
  const stamp = meta.generatedAt.toLocaleString('en-PH', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
  return `Generated ${stamp} by ${meta.generatedBy}`
}

function buildRegisterSheet(wb: ExcelJS.Workbook, { rows, meta, columns }: ExportInput) {
  const ws = wb.addWorksheet(REGISTER_SHEET, {
    views: [{ state: 'frozen', ySplit: HEADER_ROW }],
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      // The header repeats at the top of every printed page. A management pack
      // whose second page is eleven unlabelled columns is not a report.
      printTitlesRow: `${HEADER_ROW}:${HEADER_ROW}`,
    },
  })

  titleBlock(ws, [
    'CHECK RELEASE MONITORING',
    describeScope(meta.viewLabel, rows.length, meta.totalMatching),
    meta.filterDescription,
    generatedLine(meta),
  ])

  // Always a full order, whatever the caller passed: `exportColumnOrder` puts
  // back any column a partial list left out.
  const order = exportColumnOrder((columns ?? EXPORT_COLUMN_KEYS).join(','))
  const amountColumn = order.indexOf('amount') + 1

  const header = ws.getRow(HEADER_ROW)
  order.forEach((key, i) => {
    styleHeaderCell(header.getCell(i + 1), exportLabel(key), key === 'amount' ? 'right' : 'left')
  })
  header.height = 20

  // The text each column will actually show, gathered as the rows are written
  // so the widths are fitted to real content rather than to a guess.
  const widthSamples: string[][] = order.map(() => [])

  rows.forEach((r, i) => {
    const excelRow = ws.getRow(FIRST_DATA_ROW + i)
    order.forEach((key, c) => {
      const spec = EXPORT_CELLS[key]
      const cell = excelRow.getCell(c + 1)
      cell.value = spec.value(r)
      cell.border = {
        bottom: { style: 'thin', color: { argb: GRID } },
        left: { style: 'thin', color: { argb: GRID } },
        right: { style: 'thin', color: { argb: GRID } },
      }
      // Banded, so a wide row can be followed across the columns on paper.
      if (i % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } }
      if (spec.kind === 'date') cell.numFmt = DATE_FORMAT
      if (spec.kind === 'amount') {
        cell.numFmt = currencyNumberFormat(r.currency)
        cell.alignment = { horizontal: 'right' }
      }
      widthSamples[c].push(spec.sample(r))
    })
  })

  order.forEach((key, i) => {
    ws.getColumn(i + 1).width = fitColumnWidth(exportLabel(key), widthSamples[i])
  })

  // Over the header and the data only. Extending it across the totals would let
  // a filter hide or strand them.
  ws.autoFilter = {
    from: { row: HEADER_ROW, column: 1 },
    to: { row: HEADER_ROW + rows.length, column: order.length },
  }

  writeTotals(ws, rows, amountColumn)
  return ws
}

/**
 * The totals block: the count, then ONE LINE PER CURRENCY.
 *
 * There is no grand total and there is no code path that could produce one —
 * the same rule `getSummary` and `getTodaysRelease` are built on. Adding a PHP
 * figure to a CNY figure yields a number with no meaning, and a spreadsheet is
 * exactly where somebody would otherwise be tempted to.
 *
 * These are the totals OF THE ROWS IN THIS SHEET, including any CANCELLED ones
 * the chosen view admits. That is what a totals row under a table means, and
 * what a reader gets if they select the column in Excel. The SUMMARY sheet's
 * value figures answer a different question and say so on their own line.
 */
function writeTotals(ws: ExcelJS.Worksheet, rows: readonly CheckTableRow[], amountColumn: number) {
  // The labels sit left of AMOUNT, merged across the columns before it — or,
  // when the reader put AMOUNT first, in the column right of it, unmerged.
  const labelColumn = amountColumn > 1 ? 1 : 2
  const mergeLabel = (row: number) => { if (amountColumn > 2) ws.mergeCells(row, 1, row, amountColumn - 1) }

  const totals = totalsByCurrency(rows)
  let r = FIRST_DATA_ROW + rows.length + 1 // one blank row below the table

  const countCell = ws.getCell(r, 1)
  countCell.value = `TOTAL — ${rows.length.toLocaleString('en-PH')} CHECKS EXPORTED`
  countCell.font = { bold: true, size: 11 }
  mergeLabel(r)
  r += 1

  for (const t of totals) {
    const label = ws.getCell(r, labelColumn)
    label.value = `TOTAL VALUE — ${t.currency} (${t.count.toLocaleString('en-PH')} CHECK${t.count === 1 ? '' : 'S'})`
    label.font = { bold: true }
    label.alignment = { horizontal: amountColumn > 1 ? 'right' : 'left' }
    mergeLabel(r)

    const value = ws.getCell(r, amountColumn)
    // null, not 0. Where no amount in the currency is known there is nothing to
    // total, and a ₱0.00 on a totals row is a figure a reader cannot challenge.
    value.value = t.total === null ? null : amountAsNumber(t.total)
    value.numFmt = currencyNumberFormat(t.currency)
    value.font = { bold: true }
    value.alignment = { horizontal: 'right' }
    value.border = { top: { style: 'double', color: { argb: HEADER_FILL } } }
    r += 1
  }

  // Named only when there is one, and never subtracted from anything above: the
  // count includes these cheques and the totals do not, and a reader who is not
  // told that has a count and a total that silently disagree.
  const missing = rows.filter((row) => row.amount === null).length
  if (missing > 0) {
    const note = ws.getCell(r, 1)
    note.value = missing === 1
      ? '1 OF THESE CHECKS HAS NO RECORDED AMOUNT AND IS ABSENT FROM THE TOTALS ABOVE. IT IS NOT WORTH ZERO — THE AMOUNT WAS NEVER RECORDED.'
      : `${missing.toLocaleString('en-PH')} OF THESE CHECKS HAVE NO RECORDED AMOUNT AND ARE ABSENT FROM THE TOTALS ABOVE. THEY ARE NOT WORTH ZERO — THE AMOUNTS WERE NEVER RECORDED.`
    note.font = { italic: true, size: 9, color: { argb: 'FF92400E' } }
    // Not merged: a merged cell clips, and this note must never be half-read.
  }
}

const SUMMARY_COLUMNS = 3

function sectionHeader(ws: ExcelJS.Worksheet, row: number, labels: readonly string[]) {
  labels.forEach((label, i) => {
    const cell = ws.getCell(row, i + 1)
    cell.value = label
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } }
  })
  for (let i = labels.length; i < SUMMARY_COLUMNS; i++) {
    ws.getCell(row, i + 1).fill = {
      type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL },
    }
  }
}

/**
 * The SUMMARY sheet.
 *
 * These figures come from `getSummary`, which takes NO filters — they cover
 * every cheque in the system, exactly as the dashboard's summary cards do. Line
 * 3 says so outright rather than repeating the register's filter line, because
 * a total that quietly reported a filtered subset would read as the whole and a
 * manager would have no way to tell.
 */
function buildSummarySheet(wb: ExcelJS.Workbook, { summary, meta }: ExportInput) {
  const ws = wb.addWorksheet(SUMMARY_SHEET, {
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  })

  titleBlock(ws, [
    'CHECK RELEASE MONITORING',
    'SUMMARY — THE WHOLE SYSTEM, NOT THIS FILE’S FILTERS',
    'These figures are not narrowed by the filters on the CHECK REGISTER sheet. They cover every check the system holds EXCEPT those with no recorded amount, exactly as the dashboard cards do — those are counted on their own line below.',
    generatedLine(meta),
  ])

  const labelWidths: string[] = []
  const valueWidths: string[] = []
  const totalWidths: string[] = []

  let r = HEADER_ROW
  sectionHeader(ws, r, ['CHECKS BY STATUS', 'COUNT'])
  labelWidths.push('CHECKS BY STATUS')
  valueWidths.push('COUNT')
  r += 1

  const statusLines: readonly [string, number][] = [
    ['PENDING SIGNATURE', summary.pendingSignature],
    ['SIGNED', summary.signed],
    ['READY FOR RELEASE', summary.readyForRelease],
    ['SCHEDULED', summary.scheduled],
    ['RELEASED', summary.released],
    ['TOTAL CHECKS', summary.total],
  ]
  for (const [label, value] of statusLines) {
    ws.getCell(r, 1).value = label
    const cell = ws.getCell(r, 2)
    cell.value = value
    cell.numFmt = COUNT_FORMAT
    cell.alignment = { horizontal: 'right' }
    if (label === 'TOTAL CHECKS') {
      ws.getCell(r, 1).font = { bold: true }
      cell.font = { bold: true }
      cell.border = { top: { style: 'double', color: { argb: HEADER_FILL } } }
    }
    labelWidths.push(label)
    valueWidths.push(value.toLocaleString('en-PH'))
    r += 1
  }

  r += 1
  sectionHeader(ws, r, ['RECORDS WITH NO RECORDED AMOUNT', 'COUNT'])
  labelWidths.push('RECORDS WITH NO RECORDED AMOUNT')
  r += 1
  ws.getCell(r, 1).value = 'NO RECORDED AMOUNT'
  const incompleteCell = ws.getCell(r, 2)
  incompleteCell.value = summary.incomplete
  incompleteCell.numFmt = COUNT_FORMAT
  incompleteCell.alignment = { horizontal: 'right' }
  labelWidths.push('NO RECORDED AMOUNT')
  valueWidths.push(summary.incomplete.toLocaleString('en-PH'))
  r += 1
  const note = ws.getCell(r, 1)
  // Counted HERE and nowhere else above, since 2026-09-06: the client asked for
  // the cheques with no recorded amount to be left out of the dashboard's
  // figures, and this sheet reports the dashboard. Nothing was deleted, so the
  // number is stated rather than dropped — a register that shrinks by 129 with
  // no line explaining it is how a reader concludes money went missing.
  note.value = 'Real checks whose amount the register never recorded. They are NOT counted in the figures above and are NOT in the values below — there is nothing of theirs to add, and they are not worth zero. They are still in the system: open the dashboard with the INCOMPLETE ONLY filter to list them. The CURRENCY counts below are the population each total was struck over and do include them.'
  note.font = { italic: true, size: 9, color: { argb: 'FF475569' } }
  // Not merged, for the same reason the title block is not: merges clip.
  r += 2

  sectionHeader(ws, r, ['CURRENCY', 'CHECKS', 'TOTAL VALUE'])
  valueWidths.push('CHECKS')
  totalWidths.push('TOTAL VALUE')
  r += 1

  // One line per currency, never one grand total. Same rule as the register's
  // totals block, and as getSummary itself.
  for (const t of summary.totalsByCurrency) {
    ws.getCell(r, 1).value = t.currency
    const countCell = ws.getCell(r, 2)
    countCell.value = t.count
    countCell.numFmt = COUNT_FORMAT
    countCell.alignment = { horizontal: 'right' }
    const totalCell = ws.getCell(r, 3)
    // null stays null. See getSummary: a group whose every amount is unknown
    // returns SUM() = NULL, and rendering that as ₱0.00 would be a lie the
    // reader has no way to detect.
    totalCell.value = t.total === null ? null : amountAsNumber(t.total)
    totalCell.numFmt = currencyNumberFormat(t.currency)
    totalCell.alignment = { horizontal: 'right' }
    labelWidths.push(t.currency)
    valueWidths.push(t.count.toLocaleString('en-PH'))
    totalWidths.push(t.total === null ? '' : formatMoney(t.total, t.currency))
    r += 1
  }

  const excluded = ws.getCell(r, 1)
  excluded.value = 'Values exclude CANCELLED checks. Each currency is totalled on its own line — two currencies are never added together.'
  excluded.font = { italic: true, size: 9, color: { argb: 'FF475569' } }
  // Not merged, for the same reason the title block is not: merges clip.

  ws.getColumn(1).width = fitColumnWidth('CHECKS BY STATUS', labelWidths)
  ws.getColumn(2).width = fitColumnWidth('COUNT', valueWidths)
  ws.getColumn(3).width = fitColumnWidth('TOTAL VALUE', totalWidths)

  return ws
}

/** The finished .xlsx, ready to be handed to a browser. */
export async function buildExportWorkbook(input: ExportInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Check Release Monitoring'
  wb.created = input.meta.generatedAt
  wb.modified = input.meta.generatedAt

  buildRegisterSheet(wb, input)
  buildSummarySheet(wb, input)

  return Buffer.from(await wb.xlsx.writeBuffer())
}
