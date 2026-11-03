import { amountToCentavos } from '@/lib/transmittal'
import { isIsoDay } from '@/lib/domain/details'
import { FILTER_MESSAGES, parseAmountBound } from '@/lib/column-filters'
import { RANGE_OPS, type KitColumn, type KitFilters, type KitSort, type RangeOp } from './types'

/**
 * Matching and ordering for the table kit (spec 2026-10-13). Pure and
 * browser-safe — the same imports `lib/column-filters.ts` already makes.
 *
 * Needles, one string per column (the Supplier Portal's encoding):
 *   text    the typed text, "contains"
 *   enum    "=<value>", exact
 *   range   "~<op>:<a>[:<b>]" for date and amount columns
 * A needle that cannot be read REFUSES the whole table (`applyKit` returns
 * nothing), never widens it — the rule the dashboard's filters already follow.
 */

export type RangeNeedle = { op: RangeOp; a: string; b: string }

const RANGE = /^~([a-z]+):([^:]*)(?::([^:]*))?$/

export function parseRangeNeedle(needle: string): RangeNeedle | null {
  const m = RANGE.exec(needle.trim())
  if (!m || !(RANGE_OPS as readonly string[]).includes(m[1])) return null
  return { op: m[1] as RangeOp, a: m[2] ?? '', b: m[3] ?? '' }
}

/** The values an "=…" needle picks: one, or (a `multi` column) each ticked box. */
export function enumValues(column: Pick<KitColumn, 'multi'>, needle: string): string[] {
  const v = needle.trim().replace(/^=/, '')
  if (!column.multi) return v ? [v] : []
  return v.split(',').map((s) => s.trim()).filter(Boolean)
}

/** '' when nothing was picked: an empty range is no filter. */
export function rangeNeedle(op: RangeOp, a: string, b = ''): string {
  if (!a && !b) return ''
  return op === 'between' ? `~between:${a}:${b}` : `~${op}:${a}`
}

const isRange = (c: KitColumn) => c.kind === 'date' || c.kind === 'amount'

/** A typed bound as centavos; null when unreadable. Grouping commas allowed. */
const boundCentavos = (v: string): bigint | null => {
  const parsed = parseAmountBound(v)
  return parsed === null ? null : amountToCentavos(parsed)
}

export function needleError(column: KitColumn, needle: string): string | null {
  const n = needle.trim()
  if (!n || !isRange(column)) return null
  const r = parseRangeNeedle(n)
  const message = column.kind === 'date' ? FILTER_MESSAGES.day : FILTER_MESSAGES.amount
  if (!r) return message
  // `~ge:` or `~eq::5`: a one-bound operator with no bound is unreadable, not "no filter".
  if (r.op !== 'between' && (!r.a || r.b)) return message
  for (const v of [r.a, r.b]) {
    if (!v) continue
    if (column.kind === 'date' && !isIsoDay(v)) return FILTER_MESSAGES.day
    if (column.kind === 'amount' && boundCentavos(v) === null) return FILTER_MESSAGES.amount
  }
  return null
}

const norm = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/[,₱]/g, '').replace(/\s+/g, ' ').trim()

function compareBy<T>(op: RangeOp, x: T, a: T | null, b: T | null, lt: (p: T, q: T) => boolean): boolean {
  const eq = (p: T, q: T) => !lt(p, q) && !lt(q, p)
  switch (op) {
    case 'eq': return a === null || eq(x, a)
    case 'ne': return a === null || !eq(x, a)
    case 'gt': return a === null || lt(a, x)
    case 'ge': return a === null || !lt(x, a)
    case 'lt': return a === null || lt(x, a)
    case 'le': return a === null || !lt(a, x)
    case 'between': return (a === null || !lt(x, a)) && (b === null || !lt(b, x))
  }
}

/** Does one row's value satisfy one needle? Assumes `needleError` is null. */
export function matches(column: KitColumn, value: string | null, needle: string): boolean {
  const n = needle.trim()
  if (!n) return true
  if (column.kind === 'date') {
    const r = parseRangeNeedle(n)
    const d = value?.trim().slice(0, 10) ?? ''
    if (!r || !d) return false
    return compareBy(r.op, d, r.a || null, r.b || null, (p, q) => p < q)
  }
  if (column.kind === 'amount') {
    const r = parseRangeNeedle(n)
    const x = value === null ? null : amountToCentavos(value.trim())
    if (!r || x === null) return false
    const a = r.a ? boundCentavos(r.a) : null
    const b = r.b ? boundCentavos(r.b) : null
    // An unreadable bound refuses the row; it must never read as "no bound".
    if ((r.a && a === null) || (r.b && b === null)) return false
    return compareBy(r.op, x, a, b, (p, q) => p < q)
  }
  if (value === null) return false
  if (n.startsWith('=')) return enumValues(column, n).some((v) => norm(value) === norm(v))
  return norm(value).includes(norm(n))
}

function compareValues(column: KitColumn, a: string, b: string): number {
  if (column.kind === 'amount') {
    const x = amountToCentavos(a)
    const y = amountToCentavos(b)
    if (x !== null && y !== null) return x < y ? -1 : x > y ? 1 : 0
  }
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })
}

/**
 * The rows a table shows: every active filter, then the sort. Empty values
 * sort last in both directions; ties keep their original order.
 */
export function applyKit<R>(
  rows: readonly R[],
  columns: readonly KitColumn[],
  valueOf: (row: R, key: string) => string | null,
  filters: KitFilters,
  sort: KitSort,
): R[] {
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const active = Object.entries(filters).filter(([k, v]) => v.trim() !== '' && byKey.has(k))
  if (active.some(([k, v]) => needleError(byKey.get(k)!, v) !== null)) return []
  const kept = rows.filter((r) => active.every(([k, v]) => matches(byKey.get(k)!, valueOf(r, k), v)))
  const col = sort ? byKey.get(sort.key) : undefined
  if (!sort || !col) return kept
  const sign = sort.dir === 'desc' ? -1 : 1
  return kept
    .map((r, i) => [r, i] as const)
    .sort(([x, xi], [y, yi]) => {
      const a = valueOf(x, sort.key)?.trim() ?? ''
      const b = valueOf(y, sort.key)?.trim() ?? ''
      if (!a || !b) return !a && !b ? xi - yi : !a ? 1 : -1
      return sign * compareValues(col, a, b) || xi - yi
    })
    .map(([r]) => r)
}

const MANILA_MS = 8 * 60 * 60 * 1000

/** The Manila calendar day of an instant. */
export function manilaDay(d: Date): string {
  return new Date(d.getTime() + MANILA_MS).toISOString().slice(0, 10)
}

export function manilaToday(now: Date = new Date()): string {
  return manilaDay(now)
}

export function thisMonth(day: string): [string, string] {
  const [y, m] = day.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return [`${day.slice(0, 8)}01`, `${day.slice(0, 8)}${String(last).padStart(2, '0')}`]
}

export function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + by)
  return d.toISOString().slice(0, 10)
}

/** A stored calendar date (`@db.Date`, UTC midnight) as the row value. */
export const dateValue = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null)

/** An instant (a timestamp) as the row value: its Manila day. */
export const instantValue = (d: Date | null): string | null => (d ? manilaDay(d) : null)

const OP_WORD: Record<Exclude<RangeOp, 'between'>, string> = { eq: '=', ne: '≠', gt: '>', ge: '≥', lt: '<', le: '≤' }

/** A chip's text for a needle. */
export function humanNeedle(column: KitColumn, needle: string): string {
  const n = needle.trim()
  const r = isRange(column) ? parseRangeNeedle(n) : null
  if (r) {
    if (r.op !== 'between') return `${OP_WORD[r.op]} ${r.a}`
    if (r.a && r.b) return r.a === r.b ? r.a : `${r.a} TO ${r.b}`
    return r.a ? `FROM ${r.a}` : `UNTIL ${r.b}`
  }
  if (n.startsWith('=')) {
    return enumValues(column, n).map((v) => column.options?.find((o) => o.value === v)?.label ?? v).join(', ')
  }
  return n
}
