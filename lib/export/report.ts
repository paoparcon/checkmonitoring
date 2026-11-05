import type { CheckStatus } from '@prisma/client'
import { DEFAULT_EXPORT_ROW_LIMIT } from '@/lib/settings/defaults'

/**
 * The arithmetic behind the Excel export. Pure: no ExcelJS, no database, no
 * clock, no filesystem — every value it needs is passed in.
 *
 * It lives apart from `workbook.ts` for the same reason `dashboard-view.ts`
 * lives apart from the page: the decisions worth pinning by test — which
 * currencies get their own total, how wide a column may grow, what the file is
 * called — are decisions, not rendering, and a test that has to open a
 * spreadsheet to check them is a test nobody runs.
 */

/**
 * The most rows one export will contain.
 *
 * A CAP, not streaming, and the choice is deliberate. The workbook is assembled
 * whole in memory inside a serverless function: ExcelJS's `WorkbookWriter` can
 * stream to a file descriptor, but the freeze pane, the fitted column widths
 * and the per-currency totals row all need the full row set decided before the
 * first byte is written, so streaming would buy nothing here and cost the
 * layout. The production table holds 21,817 rows; 10,000 covers every realistic
 * filtered view a manager asks for with room to spare, and stays well inside
 * the function's memory budget.
 *
 * Measured 2026-09-06 on this machine: 10,000 rows build in 2.4 seconds, cost
 * 162 MB of heap and produce a 0.4 MB file — inside Vercel's 1 GB function
 * memory with room for the three queries that feed it. Twice that would not be.
 *
 * The cap is never silent. When it bites, `buildExportWorkbook` writes the
 * truncation into the title block of the sheet itself, so a short file cannot
 * be mistaken for a small result.
 */
export const EXPORT_ROW_LIMIT = DEFAULT_EXPORT_ROW_LIMIT

/**
 * Column widths, in Excel's character units.
 *
 * The maximum is the load-bearing one: a single 200-character payee name would
 * otherwise produce a 200-character column that pushes every other column off
 * the printed page. Excel wraps or clips the outlier instead.
 */
export const MIN_COLUMN_WIDTH = 10
export const MAX_COLUMN_WIDTH = 42
/** Room for the bold header and the autofilter's dropdown arrow. */
export const COLUMN_PADDING = 2

/** A status as the screen spells it. `READY_FOR_RELEASE` is not a word. */
export function statusWords(status: CheckStatus | string): string {
  return String(status).replace(/_/g, ' ')
}

/**
 * The view's name, for the title block and the filename.
 *
 * Short on purpose — `describeView` in dashboard-view.ts is the long form for
 * the screen, and "ALL CHEQUES — EVERY STATUS, INCLUDING RELEASED, CANCELLED
 * AND VOIDED" does not belong in a filename. The precedence is the same one
 * `viewStatusFilter` applies, so the name and the contents cannot disagree: an
 * explicit status wins over the scope flag.
 */
export function exportViewLabel(view: { status: string | null; showAll: boolean }): string {
  if (view.status) return statusWords(view.status)
  return view.showAll ? 'ALL CHECKS' : 'NEEDS ACTION'
}

/** A filename-safe fragment. Never empty — a nameless file is worse than a dull one. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'export'
}

/**
 * `check-register-ready-for-release-2026-09-06.xlsx`.
 *
 * The date is read in LOCAL time. `toISOString()` would name a file generated
 * at 08:00 in Manila for the previous day, which is exactly the sort of thing
 * that gets noticed a month later when two exports appear to be out of order.
 */
export function exportFilename(viewLabel: string, generatedAt: Date): string {
  const y = generatedAt.getFullYear()
  const m = String(generatedAt.getMonth() + 1).padStart(2, '0')
  const d = String(generatedAt.getDate()).padStart(2, '0')
  return `check-register-${slugify(viewLabel)}-${y}-${m}-${d}.xlsx`
}

/** Thousands-separated, the way every count on the dashboard is written. */
const count = (n: number) => n.toLocaleString('en-PH')

/**
 * Line 2 of the title block: the view, and how much of it this file holds.
 *
 * The truncation is stated HERE rather than left implicit, because
 * `EXPORT_ROW_LIMIT` is the one thing about this feature that can mislead: a
 * file of 10,000 rows that says nothing reads as the complete answer, and a
 * manager has no way to tell it apart from one. "NO CHEQUES MATCH" is spelled
 * out for the same reason — an empty table and a broken export look identical.
 */
export function describeScope(viewLabel: string, exported: number, totalMatching: number): string {
  if (exported === 0) return `${viewLabel} — NO CHECKS MATCH`
  if (exported < totalMatching) {
    return `${viewLabel} — FIRST ${count(exported)} OF ${count(totalMatching)} MATCHING CHECKS`
  }
  return `${viewLabel} — ${count(exported)} CHECK${exported === 1 ? '' : 'S'}`
}

export type FilterDescription = {
  company?: string | null
  bank?: string | null
  eligibility?: string | null
  q?: string | null
  incomplete?: boolean
  /** DATE RELEASED bounds, as the days the reader typed (`YYYY-MM-DD`). */
  releasedFrom?: string | null
  releasedTo?: string | null
  /** The column filters in words (`describeColumnFilters`), after the search. */
  columns?: readonly string[]
  /** A non-default sort in words (`describeSort`), stated last. */
  sort?: string | null
}

/**
 * The filters in force, in words, for line 3 of the title block.
 *
 * A printed report that does not say what it excludes is a report that will be
 * read as the whole picture. `No filters applied` is stated rather than left
 * blank for the same reason: an empty line is indistinguishable from a
 * rendering fault.
 */
export function describeFilters(f: FilterDescription): string {
  const parts: string[] = []
  const company = f.company?.trim()
  const bank = f.bank?.trim()
  const eligibility = f.eligibility?.trim()
  const q = f.q?.trim()
  if (company) parts.push(`COMPANY: ${company}`)
  if (bank) parts.push(`BANK / CASH ACCOUNT: ${bank}`)
  if (eligibility) parts.push(`ELIGIBILITY: ${eligibility}`)
  if (q) parts.push(`SEARCH: "${q}"`)
  for (const c of f.columns ?? []) parts.push(c)
  // As typed, never as an instant: the bounds are Manila days and the reader
  // is in Manila. Either side may stand alone.
  const releasedFrom = f.releasedFrom?.trim()
  const releasedTo = f.releasedTo?.trim()
  if (releasedFrom && releasedTo) parts.push(`DATE RELEASED: ${releasedFrom} TO ${releasedTo}`)
  else if (releasedFrom) parts.push(`DATE RELEASED: FROM ${releasedFrom}`)
  else if (releasedTo) parts.push(`DATE RELEASED: TO ${releasedTo}`)
  /**
   * The tri-state, announced on BOTH sides — matching `buildWhere`, where
   * `true` narrows to the records with no recorded amount and `false` excludes
   * them (client decision, 2026-09-06).
   *
   * `false` was silent while it meant "do not narrow on this". It now removes
   * 129 cheques from the file, and a report that does not say what it excludes
   * is a report that will be read as the whole picture — the same reason "No
   * filters applied" is spelled out rather than left blank. `undefined` still
   * says nothing, because it still filters nothing.
   */
  if (f.incomplete === true) parts.push('INCOMPLETE RECORDS ONLY (NO AMOUNT)')
  else if (f.incomplete === false) parts.push('EXCLUDES RECORDS WITH NO AMOUNT')
  if (f.sort) parts.push(`SORTED BY ${f.sort}`)
  return parts.length ? parts.join('  ·  ') : 'No filters applied'
}

/** The width a column needs to show its longest value, within bounds. */
export function fitColumnWidth(header: string, values: readonly string[]): number {
  const longest = values.reduce((n, v) => Math.max(n, v.length), header.length)
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, longest + COLUMN_PADDING))
}

/**
 * A decimal amount string as an exact integer number of centavos.
 *
 * `bigint`, not `number`, and not for show: the column is `Decimal(18,2)`, so a
 * legal amount can reach 16 digits before the point — past `Number.MAX_SAFE_INTEGER`
 * once expressed in centavos. Rule 8 says amounts are decimal strings end to
 * end; this is how they are added without ever becoming a float.
 *
 * Rounds half up at the third decimal, exactly as `formatMoney` does. The
 * database never stores a third decimal, but a total that truncates would
 * understate every figure it touches, and that is the wrong direction for a
 * Finance system to be wrong in.
 */
export function toCentavos(amount: string): bigint {
  const trimmed = amount.trim()
  const negative = trimmed.startsWith('-')
  const abs = negative ? trimmed.slice(1) : trimmed
  const [rawWhole, fraction = ''] = abs.split('.')
  const whole = rawWhole === '' ? '0' : rawWhole
  const padded = (fraction + '000').slice(0, 3)
  let cents = BigInt(whole) * 100n + BigInt(padded.slice(0, 2))
  if (padded.charCodeAt(2) - 48 >= 5) cents += 1n
  return negative ? -cents : cents
}

/** The inverse, always with exactly two decimal places. */
export function fromCentavos(cents: bigint): string {
  const negative = cents < 0n
  const abs = negative ? -cents : cents
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`
}

/** One currency's line on the totals row. `total` is null when nothing is known. */
export type ExportTotal = { currency: string; total: string | null; count: number }

/**
 * The totals row, per currency, NEVER summed across them.
 *
 * The same rule `getSummary` and `getTodaysRelease` follow, and for the same
 * reason: a PHP amount added to a CNY amount is a number with no meaning. Each
 * currency present gets its own line.
 *
 * A cheque with no recorded amount is COUNTED and left out of the total — the
 * 129 production records whose amount the register never held. Where no amount
 * in a currency is known at all the total is `null`, not `0`: "we do not know"
 * and "it is worth nothing" are different facts, and the caller renders the
 * former as a blank cell rather than a figure a reader cannot challenge.
 */
export function totalsByCurrency(
  rows: readonly { currency: string; amount: string | null }[],
): ExportTotal[] {
  const groups = new Map<string, { cents: bigint; known: boolean; count: number }>()
  for (const row of rows) {
    const g = groups.get(row.currency) ?? { cents: 0n, known: false, count: 0 }
    g.count += 1
    if (row.amount !== null) {
      g.cents += toCentavos(row.amount)
      g.known = true
    }
    groups.set(row.currency, g)
  }
  return [...groups.entries()]
    // Sorted so two exports of the same data list their currencies in the same
    // order. A totals block that reshuffles between runs invites a reader to
    // wonder what else moved.
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, g]) => ({
      currency,
      total: g.known ? fromCentavos(g.cents) : null,
      count: g.count,
    }))
}

// The same three symbols `formatMoney` knows. Restated here rather than
// exported from money.ts because these are Excel format codes, not rendered
// text, and the two are free to diverge — a symbol that must be quoted in a
// number format is not a symbol that must be quoted on screen.
const SYMBOLS: Readonly<Record<string, string>> = { PHP: '₱', CNY: '¥', USD: '$' }

/**
 * The Excel number format for an amount in a given currency.
 *
 * The value in the cell stays a NUMBER — management sorts and sums it — and the
 * currency rides along in the format so a mixed-currency export cannot be read
 * as one pile of pesos. An unknown currency shows its ISO code rather than a
 * guessed symbol, the rule `formatMoney` already follows: a wrong symbol on a
 * financial figure is worse than an unfamiliar one.
 */
export function currencyNumberFormat(currency: string): string {
  const symbol = SYMBOLS[currency?.toUpperCase()] ?? `${currency} `
  return `"${symbol}"#,##0.00`
}

/**
 * The BANK column's text.
 *
 * `cashAccountCode` is the label Finance says out loud ("BPI STK"); the
 * institution is appended only when the account code does not already carry it,
 * which is the same rule the filter bar's dropdown uses. On screen the bank is
 * a tooltip; a printed sheet has no tooltips, so it is spelled out.
 */
export function bankLabel(cashAccountCode: string | null, bankCode: string | null): string | null {
  if (!cashAccountCode) return bankCode ?? null
  if (!bankCode || cashAccountCode.includes(bankCode)) return cashAccountCode
  return `${cashAccountCode} (${bankCode})`
}
