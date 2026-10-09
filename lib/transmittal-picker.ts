import { amountToCentavos, compareCheckNumbers } from '@/lib/transmittal'

/**
 * The transmittal's pick list: its columns, their order, width and visibility,
 * and the per-column filter row. Pure — the picker component renders it and
 * decides nothing (client, 2026-10-09: "include also filter and customizable
 * and adjustable columns").
 *
 * Amounts compare in centavos as BigInt, never as JS numbers (rule 8). A filter
 * box that cannot be read REFUSES — the list empties and the box is marked —
 * and never widens, the same rule as the dashboard's filter row.
 */

export type TransmittalStatus = 'SIGNATURE_PENDING' | 'SIGNED' | 'RELEASED'

export type TransmittalCandidate = {
  id: string
  checkNumber: string
  cashAccount: string
  poNumber: string
  voucher: string
  payee: string
  amount: string | null
  currency: string
  status: TransmittalStatus
  company: string
}

export const PICK_COLUMNS = [
  'checkNumber', 'cashAccount', 'poNumber', 'voucher', 'payee', 'company', 'status', 'amount',
] as const
export type PickColumn = (typeof PICK_COLUMNS)[number]

export const PICK_LABELS: Record<PickColumn, string> = {
  checkNumber: 'CHECK NUMBER',
  cashAccount: 'CASH ACCOUNT',
  poNumber: 'PO NUMBER / VENDOR REF',
  voucher: 'VOUCHER NUMBER',
  payee: 'PAYEE',
  company: 'COMPANY',
  status: 'STATUS',
  amount: 'AMOUNT',
}

/** Starting widths, in pixels. */
export const DEFAULT_WIDTHS: Record<PickColumn, number> = {
  checkNumber: 130, cashAccount: 120, poNumber: 150, voucher: 130, payee: 280, company: 90, status: 140, amount: 130,
}
export const MIN_WIDTH = 60
export const MAX_WIDTH = 600

/** What a viewer chose for the columns; stored per browser. */
export type ColumnPrefs = {
  /** Every column once, in display order. */
  order: PickColumn[]
  hidden: PickColumn[]
  widths: Partial<Record<PickColumn, number>>
}

export const DEFAULT_PREFS: ColumnPrefs = {
  // The sheet's own order first, then the extras the sheet does not carry.
  order: ['checkNumber', 'cashAccount', 'poNumber', 'voucher', 'payee', 'amount', 'company', 'status'],
  hidden: [],
  widths: {},
}

const isColumn = (v: unknown): v is PickColumn => typeof v === 'string' && (PICK_COLUMNS as readonly string[]).includes(v)

/**
 * A stored value read back, whatever it holds. Unknown columns are dropped, a
 * column the stored order lacks is appended (so a column added later appears),
 * widths are clamped, and anything unreadable is the default.
 */
export function readPrefs(raw: unknown): ColumnPrefs {
  if (raw === null || typeof raw !== 'object') return DEFAULT_PREFS
  const r = raw as Record<string, unknown>
  const order: PickColumn[] = []
  for (const c of Array.isArray(r.order) ? r.order : []) if (isColumn(c) && !order.includes(c)) order.push(c)
  for (const c of DEFAULT_PREFS.order) if (!order.includes(c)) order.push(c)
  const hidden = (Array.isArray(r.hidden) ? r.hidden : []).filter(isColumn)
  const widths: Partial<Record<PickColumn, number>> = {}
  if (r.widths !== null && typeof r.widths === 'object') {
    for (const [k, v] of Object.entries(r.widths as Record<string, unknown>)) {
      if (isColumn(k) && typeof v === 'number' && Number.isFinite(v)) widths[k] = clampWidth(v)
    }
  }
  // At least one column stays visible: a table of nothing is not a choice.
  return { order, hidden: hidden.length >= PICK_COLUMNS.length ? [] : [...new Set(hidden)], widths }
}

export const clampWidth = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)))

/** The visible columns, in the viewer's order. */
export function visibleColumns(prefs: ColumnPrefs): PickColumn[] {
  return prefs.order.filter((c) => !prefs.hidden.includes(c))
}

export const widthOf = (prefs: ColumnPrefs, c: PickColumn) => prefs.widths[c] ?? DEFAULT_WIDTHS[c]

/** Move a column one place left or right in the order. */
export function moveColumn(order: readonly PickColumn[], column: PickColumn, by: -1 | 1): PickColumn[] {
  const i = order.indexOf(column)
  const j = i + by
  if (i < 0 || j < 0 || j >= order.length) return [...order]
  const next = [...order]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

/** The filter row. Text boxes are "contains", case-insensitive; COMPANY is exact; amount is a range. */
export type PickFilters = {
  checkNumber: string
  cashAccount: string
  poNumber: string
  voucher: string
  payee: string
  company: string
  amountMin: string
  amountMax: string
}
export const NO_FILTERS: PickFilters = {
  checkNumber: '', cashAccount: '', poNumber: '', voucher: '', payee: '', company: '', amountMin: '', amountMax: '',
}

const TEXT_FILTERS = ['checkNumber', 'cashAccount', 'poNumber', 'voucher', 'payee'] as const

export function hasFilters(f: PickFilters): boolean {
  return (Object.keys(NO_FILTERS) as (keyof PickFilters)[]).some((k) => f[k].trim() !== '')
}

/** Which amount boxes cannot be read (blank is fine). */
export function filterErrors(f: PickFilters): { amountMin: boolean; amountMax: boolean } {
  const bad = (v: string) => v.trim() !== '' && amountToCentavos(v.trim().replace(/,/g, '')) === null
  return { amountMin: bad(f.amountMin), amountMax: bad(f.amountMax) }
}

export type StatusChoice = 'ALL' | TransmittalStatus

/**
 * The rows the list shows. ALL is SIGNATURE PENDING + SIGNED — RELEASED only on
 * its own choice — and an unreadable amount box matches nothing.
 */
export function filterCandidates(
  rows: readonly TransmittalCandidate[], status: StatusChoice, f: PickFilters,
): TransmittalCandidate[] {
  const errors = filterErrors(f)
  if (errors.amountMin || errors.amountMax) return []
  const min = f.amountMin.trim() ? amountToCentavos(f.amountMin.trim().replace(/,/g, '')) : null
  const max = f.amountMax.trim() ? amountToCentavos(f.amountMax.trim().replace(/,/g, '')) : null
  const needles = TEXT_FILTERS.map((k) => [k, f[k].trim().toLowerCase()] as const).filter(([, v]) => v !== '')
  return rows.filter((c) => {
    if (status === 'ALL' ? c.status === 'RELEASED' : c.status !== status) return false
    if (f.company && c.company !== f.company) return false
    for (const [k, v] of needles) if (!c[k].toLowerCase().includes(v)) return false
    if (min !== null || max !== null) {
      const a = c.amount === null ? null : amountToCentavos(c.amount)
      if (a === null) return false
      if (min !== null && a < min) return false
      if (max !== null && a > max) return false
    }
    return true
  })
}

export type SortSpec = { column: PickColumn; dir: 'asc' | 'desc' }

/** Header-click order; nulls last both ways, check number as the tiebreak. */
export function sortCandidates(rows: readonly TransmittalCandidate[], sort: SortSpec): TransmittalCandidate[] {
  const sign = sort.dir === 'asc' ? 1 : -1
  const cmp = (a: TransmittalCandidate, b: TransmittalCandidate): number => {
    if (sort.column === 'checkNumber') return compareCheckNumbers(a.checkNumber, b.checkNumber)
    if (sort.column === 'amount') {
      const x = a.amount === null ? null : amountToCentavos(a.amount)
      const y = b.amount === null ? null : amountToCentavos(b.amount)
      if (x === null || y === null) return x === y ? 0 : x === null ? 2 : -2 // sentinel: handled below
      return x < y ? -1 : x > y ? 1 : 0
    }
    return a[sort.column].localeCompare(b[sort.column])
  }
  return [...rows].sort((a, b) => {
    const c = cmp(a, b)
    if (Math.abs(c) === 2) return c > 0 ? 1 : -1 // a null amount sorts last in either direction
    return c !== 0 ? c * sign : compareCheckNumbers(a.checkNumber, b.checkNumber)
  })
}
