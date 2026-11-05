import type { PrismaClient } from '@prisma/client'
import { recordClearing } from '@/lib/domain/actions'
import { previewClearing, type PreviewVerdict } from '@/lib/clearing-preview'
import { canonicalCheckNumber } from '@/lib/import/normalise'
import { sheetsFromWorkbook } from '@/lib/admin/ready-upload'

/**
 * MARK CLEARED FROM A FILE (user request 2026-11-05: "CLEARED check should
 * have import files button. I can upload excel, pdf from banks and any other
 * related documents that contains check number reference that are cleared").
 *
 * The paste box on `/clearing` takes one check number per line. A bank's own
 * file is not shaped like that — a statement PDF, a cleared-items workbook, a
 * CSV export — so this reads the WHOLE file as text, one line (a sheet row, a
 * CSV line, a PDF line rebuilt from text positions) at a time, and takes every
 * number on a line that names a check this system holds.
 *
 * A statement is full of numbers that are not checks: account numbers,
 * amounts, references, dates. So a number becomes a row only when a check
 * HAS that number; the rest are counted and a sample shown, never written.
 * Three things help a reader trust a match before confirming, and the preview
 * shows all three: the verdict (`previewClearing`'s, the same as the paste
 * box), the check's own account (a BDO check matched out of a BPI statement
 * stands out), and whether the check's amount appears on the same line.
 *
 * THE CLEARED DATE. Taken from the line only when it is unambiguous: an Excel
 * date cell, `YYYY-MM-DD`, a month spelled out, or a numeric date whose order
 * the file itself settles (a day above 12 somewhere in the file). A line with
 * two different dates, or a numeric date nobody can order, takes the batch
 * date typed beside the upload, else none. Never "today", never a guess — the
 * rule `clearing-paste.ts` holds.
 *
 * WHAT IS WRITTEN. Only WILL_CLEAR rows, through `recordClearing` — the same
 * domain action as the check page and the paste box, one transaction and one
 * `clearing_recorded` audit row per check, which names the file and the line.
 * The confirmation re-sends and re-plans the same file, so it can never apply
 * to a file other than the one previewed. The loop stops at its deadline and
 * says how many it did not reach; the same file uploaded again finishes it
 * (cleared rows read ALREADY CLEARED). A scanned image has no text: it is
 * refused by name rather than read as an empty statement.
 */

/** One line of the file, as text, with what the line's cells said when they were typed values. */
export type TextUnit = {
  /** Where it is, for the reader and the audit row: "Sheet1 row 14", "page 2 line 31", "line 7". */
  place: string
  text: string
  /** Date cells on a workbook row, read as the calendar day they show. */
  dates: Date[]
  /** Numeric cells on a workbook row, as written — so an amount cell can be compared exactly. */
  numbers: string[]
}

export type FileKind = 'XLSX' | 'CSV' | 'TEXT' | 'PDF'

export type ReadFileResult =
  | { ok: true; kind: FileKind; units: TextUnit[] }
  | { ok: false; message: string }

/** Every bank file seen so far fits; the server action's body limit is 4 MB. */
export const MAX_CLEARING_FILE_BYTES = 4 * 1024 * 1024
export const CLEARING_UPLOAD_BUDGET_MS = 30_000

const EXT = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase()

/** What a reader is told when the file is not one this can read. */
export const UNREADABLE_FILE =
  'Upload an Excel workbook (.xlsx), a CSV or text file, or a PDF that has text in it. ' +
  'An old .xls must be saved as .xlsx first; a photo or a scanned PDF has no text to read.'

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((t) => t.text ?? '').join('')
    if ('result' in o) return cellText(o.result)
    if ('text' in o) return cellText(o.text)
    return ''
  }
  return String(v)
}

/**
 * The file's lines. PDF lines are rebuilt from where each piece of text sits:
 * pieces on the same baseline (within 2 points) are one line, read left to
 * right — the shape of a statement's table row.
 */
export async function readClearingFile(name: string, buffer: Buffer): Promise<ReadFileResult> {
  const ext = EXT(name)
  if (ext === 'xlsx' || ext === 'xlsm') {
    const sheets = await sheetsFromWorkbook(buffer)
    const units: TextUnit[] = []
    for (const s of sheets) {
      s.rows.forEach((cells, i) => {
        const text = cells.map(cellText).filter((t) => t !== '').join(' | ')
        if (text === '') return
        units.push({
          place: `${s.name} row ${i + 1}`,
          text,
          dates: cells.filter((c): c is Date => c instanceof Date),
          numbers: cells.filter((c): c is number => typeof c === 'number').map((n) => String(n)),
        })
      })
    }
    return { ok: true, kind: 'XLSX', units }
  }
  if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
    const units = buffer.toString('utf8').split(/\r?\n/).flatMap((line, i) =>
      line.trim() === '' ? [] : [{ place: `line ${i + 1}`, text: line, dates: [], numbers: [] }])
    return { ok: true, kind: ext === 'csv' ? 'CSV' : 'TEXT', units }
  }
  if (ext === 'pdf') {
    const { extractTextItems } = await import('unpdf')
    const { items } = await extractTextItems(new Uint8Array(buffer))
    const units: TextUnit[] = []
    items.forEach((page, p) => {
      const lines: { y: number; parts: { x: number; s: string }[] }[] = []
      for (const it of page) {
        if (!it.str || it.str.trim() === '') continue
        let line = lines.find((l) => Math.abs(l.y - it.y) <= 2)
        if (!line) { line = { y: it.y, parts: [] }; lines.push(line) }
        line.parts.push({ x: it.x, s: it.str })
      }
      // Top of the page first: PDF y grows upwards.
      lines.sort((a, b) => b.y - a.y).forEach((l, i) => {
        const text = l.parts.sort((a, b) => a.x - b.x).map((x) => x.s.trim()).join(' | ')
        units.push({ place: `page ${p + 1} line ${i + 1}`, text, dates: [], numbers: [] })
      })
    })
    if (units.length === 0) {
      return { ok: false, message: 'This PDF has no text in it — it is a scan or a picture. Ask the bank for the PDF or Excel export, or type the check numbers into the paste box.' }
    }
    return { ok: true, kind: 'PDF', units }
  }
  return { ok: false, message: UNREADABLE_FILE }
}

/**
 * The numbers on a line that could be a check number: 6 to 13 digits standing
 * alone. Not part of a word (`CV-ST021234`), an amount (`1234567.89`; a
 * thousands group is three digits, so `1,234,567` never reaches six), a date
 * (`11/03/2026`) or a hyphenated reference. A comma is a CSV separator. A bank
 * prefix (`BPI 6000354602`) and `NO.6000354602` still read.
 */
const CANDIDATE = /(?<!\d\.)(?<![\w/-])(\d{6,13})(?![\w])(?![./-]\d)/g

export function candidateNumbers(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(CANDIDATE)) {
    const n = canonicalCheckNumber(m[1])
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const monthOf = (s: string) => {
  const i = MONTHS.indexOf(s.slice(0, 3).toLowerCase())
  return i < 0 || (s.length > 3 && !/^[a-z]+\.?$/i.test(s)) ? -1 : i
}
const yearOf = (s: string) => (s.length === 2 ? 2000 + Number(s) : Number(s))

function utcDay(y: number, m: number, d: number): Date | null {
  const date = new Date(Date.UTC(y, m, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m || date.getUTCDate() !== d) return null
  return date
}

/** A clearing happened between 2015 and next year; anything else on a line is not a clearing date. */
function plausible(d: Date | null, now: Date): d is Date {
  return d !== null && d.getUTCFullYear() >= 2015 && d.getUTCFullYear() <= now.getUTCFullYear() + 1
}

const NUMERIC_DATE = /(?<![\d/-])(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})(?![\d/-])/g

/**
 * Which way round the file writes a numeric date: DMY when some first part is
 * above 12, MDY when some second part is, null when nothing settles it or the
 * file says both.
 */
export function numericDateOrder(units: readonly TextUnit[]): 'DMY' | 'MDY' | null {
  let dmy = false
  let mdy = false
  for (const u of units) {
    for (const m of u.text.matchAll(NUMERIC_DATE)) {
      if (Number(m[1]) > 12) dmy = true
      if (Number(m[2]) > 12) mdy = true
    }
  }
  return dmy === mdy ? null : dmy ? 'DMY' : 'MDY'
}

/** The distinct calendar days a line states, read only where the reading is certain. */
export function datesOnLine(u: TextUnit, order: 'DMY' | 'MDY' | null, now: Date): Date[] {
  const found: Date[] = []
  const add = (d: Date | null) => {
    if (plausible(d, now) && !found.some((f) => f.getTime() === d.getTime())) found.push(d)
  }
  // An Excel date cell holds the day it shows at UTC midnight.
  for (const d of u.dates) add(utcDay(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const text = u.dates.length > 0 ? u.text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ') : u.text
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(utcDay(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  for (const m of text.matchAll(/\b(\d{1,2})[\s-]([A-Za-z]{3,9}\.?)[\s,-]+(\d{4}|\d{2})\b/g)) {
    const mo = monthOf(m[2])
    if (mo >= 0) add(utcDay(yearOf(m[3]), mo, Number(m[1])))
  }
  for (const m of text.matchAll(/\b([A-Za-z]{3,9}\.?)\s+(\d{1,2}),?\s+(\d{4})\b/g)) {
    const mo = monthOf(m[1])
    if (mo >= 0) add(utcDay(Number(m[3]), mo, Number(m[2])))
  }
  for (const m of text.matchAll(NUMERIC_DATE)) {
    const a = Number(m[1])
    const b = Number(m[2])
    const y = yearOf(m[3])
    if (a === b) add(utcDay(y, a - 1, b))
    else if (order === 'DMY') add(utcDay(y, b - 1, a))
    else if (order === 'MDY') add(utcDay(y, a - 1, b))
  }
  return found
}

/** Whether the check's amount is written on the line: "197,715.42", "197715.42", or "5000" for 5,000.00. */
export function amountOnLine(u: TextUnit, amount: string | null): boolean | null {
  if (amount === null) return null
  const [whole, cents = '00'] = amount.replace(/^-/, '').split('.')
  const fixed = `${whole}.${cents.padEnd(2, '0').slice(0, 2)}`
  const forms = new Set([fixed])
  if (fixed.endsWith('.00')) forms.add(whole)
  if (u.numbers.some((n) => forms.has(n) || Number(n).toFixed(2) === fixed)) return true
  const flat = u.text.replace(/(\d),(?=\d{3}\b)/g, '$1')
  return [...forms].some((f) => new RegExp(`(?<![\\d.])${f.replace('.', '\\.')}(?![\\d])`).test(flat))
}

export type ClearingUploadRow = {
  place: string
  /** The line as read, cut to 160 characters — so the reader can see what was matched. */
  lineText: string
  checkNumber: string
  clearedDate: Date | null
  /** Where the date came from: the line, the batch date typed beside the upload, or neither. */
  dateFrom: 'FILE' | 'BATCH' | 'NONE'
  verdict: PreviewVerdict
  checkId: string | null
  companyCode: string | null
  payeeName: string | null
  /** The check's account — its check book, else its register label. */
  account: string | null
  /** True when the check's amount is on the same line; null when the check has no amount. */
  amountSeen: boolean | null
  detail: string
}

export type ClearingUploadPlan = {
  fileName: string
  kind: FileKind
  lines: number
  rows: ClearingUploadRow[]
  willClear: number
  /** Numbers on the file that name no check here — counted, a sample shown, never written. */
  unmatchedCount: number
  unmatchedSample: string[]
  dateOrder: 'DMY' | 'MDY' | null
}

/** Plans what CONFIRM would do. Reads only. */
export async function planClearingUpload(
  db: PrismaClient,
  args: { fileName: string; kind: FileKind; units: readonly TextUnit[]; batchDate: Date | null; now: Date },
): Promise<ClearingUploadPlan> {
  const order = numericDateOrder(args.units)
  const bare = (n: string) => n.replace(/^0+(?=\d)/, '')
  // Pass 1: every number on the file, in both forms — a leading-zero number may be held bare.
  const perUnit = args.units.map((u) => ({ u, numbers: candidateNumbers(u.text) }))
  const forms = new Set(perUnit.flatMap(({ numbers }) => numbers.flatMap((n) => [n, bare(n)])))
  const held = await db.check.findMany({
    where: { checkNumber: { in: [...forms] } },
    select: {
      checkNumber: true, amount: true,
      checkBook: { select: { code: true } }, cashAccount: { select: { code: true } },
    },
  })
  const heldNumbers = new Set(held.map((c) => c.checkNumber))

  // Pass 2: each number resolved to the form a check holds, on the first line it appears.
  const firstSeen = new Map<string, TextUnit>()
  const unmatchedSet = new Set<string>()
  for (const { u, numbers } of perUnit) {
    for (const n of numbers) {
      const resolved = heldNumbers.has(n) ? n : heldNumbers.has(bare(n)) ? bare(n) : null
      if (resolved === null) unmatchedSet.add(n)
      else if (!firstSeen.has(resolved)) firstSeen.set(resolved, u)
    }
  }
  const matched = [...firstSeen.entries()]
  const unmatched = [...unmatchedSet]

  const lines = matched.map(([checkNumber, u], i) => {
    const days = datesOnLine(u, order, args.now)
    const clearedDate = days.length === 1 ? days[0] : args.batchDate
    return { line: i + 1, checkNumber, clearedDate, crNumber: null, unit: u, dateFrom: (days.length === 1 ? 'FILE' : args.batchDate ? 'BATCH' : 'NONE') as ClearingUploadRow['dateFrom'] }
  })
  const preview = await previewClearing(db, lines)
  const byNumber = new Map<string, typeof held>()
  for (const c of held) byNumber.set(c.checkNumber, [...(byNumber.get(c.checkNumber) ?? []), c])

  const rows: ClearingUploadRow[] = preview.map((p, i) => {
    const l = lines[i]
    const only = (byNumber.get(p.checkNumber) ?? []).length === 1 ? byNumber.get(p.checkNumber)![0] : null
    return {
      place: l.unit.place,
      lineText: l.unit.text.length > 160 ? `${l.unit.text.slice(0, 157)}…` : l.unit.text,
      checkNumber: p.checkNumber,
      clearedDate: p.clearedDate,
      dateFrom: l.dateFrom,
      verdict: p.verdict,
      checkId: p.checkId,
      companyCode: p.companyCode,
      payeeName: p.payeeName,
      account: only ? (only.checkBook?.code ?? only.cashAccount?.code ?? null) : null,
      amountSeen: only ? amountOnLine(l.unit, only.amount?.toString() ?? null) : null,
      detail: p.detail,
    }
  })
  return {
    fileName: args.fileName,
    kind: args.kind,
    lines: args.units.length,
    rows,
    willClear: rows.filter((r) => r.verdict === 'WILL_CLEAR').length,
    unmatchedCount: unmatched.length,
    unmatchedSample: unmatched.slice(0, 30),
    dateOrder: order,
  }
}

export type ClearingUploadSummary = {
  cleared: number
  failed: { checkNumber: string; message: string }[]
  /** WILL_CLEAR rows the deadline left; uploading the same file again finishes them. */
  notReached: number
}

/** Writes the plan's WILL_CLEAR rows through `recordClearing`, one check at a time, until the deadline. */
export async function applyClearingUpload(
  db: PrismaClient,
  plan: ClearingUploadPlan,
  args: { userId: string; now: Date; deadline: Date },
): Promise<ClearingUploadSummary> {
  const todo = plan.rows.filter((r) => r.verdict === 'WILL_CLEAR' && r.checkId !== null)
  const summary: ClearingUploadSummary = { cleared: 0, failed: [], notReached: 0 }
  for (let i = 0; i < todo.length; i++) {
    if (Date.now() >= args.deadline.getTime()) { summary.notReached = todo.length - i; break }
    const r = todo[i]
    try {
      await recordClearing(db, {
        checkId: r.checkId!, userId: args.userId, clearingStatus: 'CLEARED',
        clearedDate: r.clearedDate ?? undefined, now: args.now,
        source: { file: plan.fileName, place: r.place },
      })
      summary.cleared++
    } catch (e) {
      summary.failed.push({ checkNumber: r.checkNumber, message: e instanceof Error ? e.message : String(e) })
    }
  }
  return summary
}
