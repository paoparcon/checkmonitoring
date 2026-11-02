// lib/export/numbering-workbook.ts
import ExcelJS from 'exceljs'
import { currencyNumberFormat } from './report'
import { BAND_FILL, COUNT_FORMAT, DATE_FORMAT, styleHeaderCell } from './sheet-style'
import type { NumberingAccount } from '@/lib/numbering/query'
import { strayEnds, type SeriesCheque, type SeriesStaged, type StrayEnd } from '@/lib/numbering/series'
import type { InventoryNote } from '@/lib/numbering/inventory'
import { visibleEntries, registerOnlyLine, NUMBERING_SCOPE_NOTE } from '@/lib/numbering-view'

/**
 * The numbering report as a workbook: SUMMARY, TO FIX IN ACUMATICA (spec §G3), then one sheet per cheque book with
 * every cheque in number order, each MISSING number as one row (spec §H — a
 * run of more than INVENTORY_LIST_MAX numbers stays one row) whose FROM, TO
 * and COUNT have their own columns, and each number Acumatica re-used with a
 * trailing dot as a STAGED row (spec §C) — so a filter on STATUS = MISSING works
 * (spec 2026-10-01-cheque-numbering-and-cancel-guard-design §B4). Finance's
 * inventory tick and remark, with who recorded them and when, are the last
 * four columns — the file is the inventory as the screen shows it. Cheque
 * numbers are text cells. Amounts are Excel numbers in the cells, the one
 * sanctioned use of a JS number for money, as in `recon-workbook.ts`.
 */
export const NUMBERING_SUMMARY_SHEET = 'SUMMARY'
export const NUMBERING_ACCOUNT_HEADERS = [
  'CHECK NUMBER', 'CHECK DATE', 'PAYEE', 'STATUS', 'CURRENCY', 'AMOUNT', 'FROM', 'TO', 'COUNT', 'NOTE',
  'TICKED', 'REMARKS', 'RECORDED BY', 'RECORDED AT',
] as const
/**
 * TO FIX IN ACUMATICA (spec §G3): every OUT OF PATTERN cheque or staged line and
 * each book's stray ends, with the CV to correct in Acumatica. A short to-do
 * list: never cut by the row limit, written under MISSING ONLY too.
 */
export const NUMBERING_TO_FIX_SHEET = 'TO FIX IN ACUMATICA'
export const NUMBERING_TO_FIX_HEADERS = ['CHECK BOOK', 'CHECK NUMBER', 'CV', 'CHECK DATE', 'PAYEE', 'STATUS', 'REASON'] as const
const SUMMARY_HEADERS =['CHECK BOOK', 'BANK', 'COMPANY', 'FIRST', 'LAST', 'HELD', 'VOIDED', 'CANCELLED', 'STAGED', 'MISSING NUMBERS', 'MISSING RUNS', 'TICKED', 'NOT NUMERIC', 'OUT OF PATTERN'] as const

export type NumberingMeta = {
  generatedAt: Date; generatedBy: string; filterDescription: string
  missingOnly: boolean
  /** null when an account is open: the count is not measured there, so no line is printed. */
  noAccountCount: number | null
  /** Register-only cheques not shown (spec §G2); null when an account is open, so no line is printed. */
  registerOnlyCount: number | null
  /** `caps.exportRows`: cheque and MISSING lines across all cheque-book sheets. */
  rowLimit: number
}

const TITLE_INK = 'FF0F172A'
const MUTED_INK = 'FF475569'
const fmt = (n: number) => n.toLocaleString('en-PH')
/** A count as a cell: a number while exact, else its decimal string. */
const countCell = (s: string): number | string => (s.length <= 15 ? Number(s) : s)

/** Excel: ≤31 chars, none of []:*?/\, unique case-insensitively within the book. */
export function sheetNameFor(code: string, used: Set<string>): string {
  const cleaned = code.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31).replace(/^'+|'+$/g, '').trim()
  const base = cleaned || 'ACCOUNT'
  let name = base
  let i = 2
  while (used.has(name.toUpperCase())) {
    const suffix = ` (${i++})`
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`
  }
  used.add(name.toUpperCase())
  return name
}

function generatedLine(meta: NumberingMeta): string {
  const stamp = meta.generatedAt.toLocaleString('en-PH', {
    day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila',
  })
  return `Generated ${stamp} by ${meta.generatedBy}`
}

export async function buildNumberingWorkbook(
  { accounts, meta }: { accounts: readonly NumberingAccount[]; meta: NumberingMeta },
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Check Release Monitoring'
  wb.created = meta.generatedAt

  const lines = accounts.map((a) => ({ a, entries: visibleEntries(a.lines, meta.missingOnly) }))
  const totalLines = lines.reduce(
    (n, l) => n + l.entries.length + (meta.missingOnly ? 0 : l.a.series.notNumeric.length + l.a.series.outOfPattern.length), 0)

  const ws = wb.addWorksheet(NUMBERING_SUMMARY_SHEET)
  ws.getCell('A1').value = 'CHECK NUMBERING — CHECK RELEASE MONITORING'
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: TITLE_INK } }
  ws.getCell('A2').value = meta.filterDescription
  ws.getCell('A2').font = { bold: true, size: 12, color: { argb: TITLE_INK } }
  ws.getCell('A3').value = totalLines > meta.rowLimit
    ? `${generatedLine(meta)}  ·  the check-book sheets hold the first ${fmt(meta.rowLimit)} of ${fmt(totalLines)} lines`
    : `${generatedLine(meta)}  ·  ${fmt(accounts.length)} check book${accounts.length === 1 ? '' : 's'}`
  ws.getCell('A3').font = { size: 10, color: { argb: MUTED_INK } }
  ws.getCell('A4').value = [
    NUMBERING_SCOPE_NOTE,
    meta.noAccountCount === null ? null
      : `Not in any series: ${fmt(meta.noAccountCount)} check${meta.noAccountCount === 1 ? '' : 's'} with no check book.`,
    meta.registerOnlyCount === null ? null : registerOnlyLine(meta.registerOnlyCount),
  ].filter((s) => s !== null).join(' ')
  ws.getCell('A4').font = { size: 10, color: { argb: MUTED_INK } }

  const header = ws.getRow(6)
  SUMMARY_HEADERS.forEach((label, i) => styleHeaderCell(header.getCell(i + 1), label, i >= 5 ? 'right' : 'left'))
  accounts.forEach((a, i) => {
    const s = a.series.summary
    const row = ws.getRow(7 + i)
    const values: (string | number | null)[] = [
      a.account, a.bank, a.company, s.first, s.last, s.held, s.voided, s.cancelled, s.staged,
      countCell(s.missingNumbers), s.missingRuns, countCell(a.inventory.ticked), s.notNumeric, s.outOfPattern,
    ]
    values.forEach((v, col) => {
      row.getCell(col + 1).value = v
      if (col >= 5) row.getCell(col + 1).numFmt = COUNT_FORMAT
    })
    if (i % 2 === 1) row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } } })
  })
  ;[22, 10, 10, 14, 14, 10, 10, 12, 10, 18, 14, 10, 14, 16].forEach((w, i) => { ws.getColumn(i + 1).width = w })

  const fix = wb.addWorksheet(NUMBERING_TO_FIX_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] })
  NUMBERING_TO_FIX_HEADERS.forEach((label, i) => styleHeaderCell(fix.getRow(1).getCell(i + 1), label, 'left'))
  let fr = 2
  const fixRow = (book: string, number: string, cv: string | null, date: Date | null, payee: string | null, status: string, reason: string) => {
    const row = fix.getRow(fr++)
    ;[book, number, cv, date, payee, status, reason].forEach((v, col) => { row.getCell(col + 1).value = v })
    if (date) row.getCell(4).numFmt = DATE_FORMAT
  }
  // Newest cheque date first (user request 2026-10-06): the entry most likely to still be
  // corrected before it is signed or released heads the list. Undated last; ties by
  // cheque book, then cheque number, so the order is stable.
  type FixLine = { book: string; number: string; cv: string | null; date: Date | null; payee: string | null; status: string; reason: string }
  const fixLines: FixLine[] = []
  for (const a of accounts) {
    const p = a.series.pattern
    const outReason = p ? `OUT OF PATTERN — expected ${p.digits} digits starting ${p.lead}` : 'OUT OF PATTERN'
    const items: StrayEnd[] = [
      ...a.series.outOfPattern.flatMap((o): StrayEnd[] => (o.kind === 'CHECK' ? [{ cheque: o.cheque, staged: null, reason: outReason }]
        : o.kind === 'STAGED' ? [{ cheque: null, staged: o.staged, reason: outReason }] : [])),
      ...strayEnds(a.series),
    ]
    for (const { cheque: c, staged: s, reason } of items) {
      if (c) fixLines.push({ book: a.account, number: c.checkNumber, cv: c.cv, date: c.checkDate, payee: c.payeeName, status: c.status, reason })
      else if (s) fixLines.push({ book: a.account, number: s.statedCheckRef, cv: s.acumaticaRef, date: s.checkDate, payee: s.payeeName, status: 'STAGED', reason })
    }
  }
  fixLines.sort((x, y) => {
    if (x.date && y.date && x.date.getTime() !== y.date.getTime()) return y.date.getTime() - x.date.getTime()
    if (x.date && !y.date) return -1
    if (!x.date && y.date) return 1
    return x.book.localeCompare(y.book) || x.number.localeCompare(y.number)
  })
  for (const l of fixLines) fixRow(l.book, l.number, l.cv, l.date, l.payee, l.status, l.reason)
  fix.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(fr - 1, 1), column: NUMBERING_TO_FIX_HEADERS.length } }
  ;[22, 16, 16, 14, 36, 18, 48].forEach((w, i) => { fix.getColumn(i + 1).width = w })

  const used = new Set([NUMBERING_SUMMARY_SHEET.toUpperCase(), NUMBERING_TO_FIX_SHEET.toUpperCase()])
  let budget = meta.rowLimit
  for (const { a, entries } of lines) {
    if (budget <= 0) break
    if (meta.missingOnly && entries.length === 0) continue // nothing missing: no empty sheet
    const sheet = wb.addWorksheet(sheetNameFor(a.account, used), { views: [{ state: 'frozen', ySplit: 1 }] })
    const h = sheet.getRow(1)
    NUMBERING_ACCOUNT_HEADERS.forEach((label, i) => styleHeaderCell(h.getCell(i + 1), label, label === 'AMOUNT' || label === 'COUNT' ? 'right' : 'left'))
    let r = 2
    // The inventory columns (spec §H): the tick as YES/NO, the remark, who and when (Manila).
    const noteCells = (row: ExcelJS.Row, n: InventoryNote | null) => {
      if (!n) return
      row.getCell(11).value = n.ticked ? 'YES' : 'NO'
      row.getCell(12).value = n.remarks
      row.getCell(13).value = n.updatedBy
      row.getCell(14).value = new Date(n.updatedAt.getTime() + 8 * 60 * 60 * 1000)
      row.getCell(14).numFmt = 'dd mmm yyyy hh:mm'
    }
    const chequeRow = (c: SeriesCheque, note: string | null, inventory: InventoryNote | null = null) => {
      const row = sheet.getRow(r++)
      row.getCell(1).value = c.checkNumber
      row.getCell(2).value = c.checkDate
      if (c.checkDate) row.getCell(2).numFmt = DATE_FORMAT
      row.getCell(3).value = c.payeeName
      row.getCell(4).value = c.status
      row.getCell(5).value = c.currency
      row.getCell(6).value = c.amount === null ? null : Number(c.amount)
      row.getCell(6).numFmt = currencyNumberFormat(c.currency)
      row.getCell(10).value = inventory ? [note, 'INVENTORY NOTE RECORDED WHILE MISSING'].filter(Boolean).join('; ') : note
      noteCells(row, inventory)
    }
    const stagedRow = (s: SeriesStaged, note?: string) => {
      const row = sheet.getRow(r++)
      row.getCell(1).value = s.statedCheckRef
      row.getCell(2).value = s.checkDate
      if (s.checkDate) row.getCell(2).numFmt = DATE_FORMAT
      row.getCell(3).value = s.payeeName
      row.getCell(4).value = 'STAGED'
      row.getCell(5).value = s.currency
      row.getCell(6).value = s.amount === null ? null : Number(s.amount)
      if (s.currency) row.getCell(6).numFmt = currencyNumberFormat(s.currency)
      row.getCell(10).value = note ?? `Acumatica ${s.acumaticaRef}: the same check number used again (staged)`
    }
    const pattern = a.series.pattern
    const outNote = pattern ? `OUT OF PATTERN (expected ${pattern.digits} digits starting ${pattern.lead})` : 'OUT OF PATTERN'
    const rows = [
      ...entries.map((e) => ({ e })),
      ...(meta.missingOnly ? [] : a.series.notNumeric.map((c) => ({ c }))),
      ...(meta.missingOnly ? [] : a.series.outOfPattern.map((o) => ({ o }))),
    ]
    for (const item of rows.slice(0, budget)) {
      if ('c' in item) { chequeRow(item.c, 'NOT NUMERIC'); continue }
      if ('o' in item) {
        const o = item.o
        if (o.kind === 'CHECK') chequeRow(o.cheque, o.duplicate ? `${outNote}; DUPLICATE NUMBER` : outNote)
        else if (o.kind === 'STAGED') stagedRow(o.staged, `${outNote}; Acumatica ${o.staged.acumaticaRef}: the same check number used again (staged)`)
        continue
      }
      const e = item.e
      if (e.kind === 'CHECK') { chequeRow(e.cheque, e.duplicate ? 'DUPLICATE NUMBER' : null, e.note); continue }
      if (e.kind === 'STAGED') { stagedRow(e.staged); continue }
      const row = sheet.getRow(r++)
      const from = e.kind === 'MISSING_NUMBER' ? e.number : e.from
      const to = e.kind === 'MISSING_NUMBER' ? e.number : e.to
      row.getCell(1).value = from === to ? from : `${from} – ${to}`
      row.getCell(4).value = 'MISSING'
      row.getCell(7).value = from
      row.getCell(8).value = to
      row.getCell(9).value = countCell(e.kind === 'MISSING_NUMBER' ? '1' : e.count)
      row.getCell(9).numFmt = COUNT_FORMAT
      row.font = { bold: true }
      row.getCell(10).value = e.kind === 'MISSING' ? 'RUN TOO LONG TO LIST ONE BY ONE; ONE TICK AND REMARK FOR THE WHOLE RUN' : null
      noteCells(row, e.note)
      row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } } })
    }
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: r - 1, column: NUMBERING_ACCOUNT_HEADERS.length } }
    budget -= Math.min(rows.length, budget)
    ;[22, 14, 36, 18, 10, 18, 14, 14, 12, 28, 8, 36, 18, 18].forEach((w, i) => { sheet.getColumn(i + 1).width = w })
  }

  return wb.xlsx.writeBuffer()
}
