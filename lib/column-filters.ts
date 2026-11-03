import type { CheckStatus } from '@prisma/client'
import type { ColumnFilters } from './queries'
import type { SortKey } from './list-sort'
import { isIsoDay } from './domain/details'
import { manilaDayStart, manilaDayEnd } from './audit-view'
import { LIVE_STATUSES, CLOSED_STATUSES } from './domain/check-status'

/**
 * The LIST screen's filter row (spec 2026-10-01, part C2), as URL parameters.
 *
 * Pure and BROWSER-SAFE: the filter row's controls import it, so it must never
 * import a server-only module or the database client. From `./queries` and
 * `@prisma/client` it takes types only; its runtime imports (`./domain/details`,
 * `./audit-view`, `./domain/check-status`) are pure modules.
 *
 * AN UNREADABLE VALUE REFUSES. An amount `12x` or a day that is not a day is
 * reported against its box and the list shows nothing until it is corrected —
 * never dropped, because a silently ignored filter reads as an applied one.
 */

/** The form the bar and the filter row's controls belong to (`form=` attribute). */
export const LIST_FILTER_FORM = 'list-filters'

export const F_PARAMS = [
  'f.checkNumber', 'f.apv', 'f.po', 'f.payee', 'f.status',
  'f.checkDateFrom', 'f.checkDateTo',
  'f.availablePickupDateFrom', 'f.availablePickupDateTo',
  'f.scheduledPickupDateFrom', 'f.scheduledPickupDateTo',
  'f.amountMin', 'f.amountMax',
] as const
export type FParam = (typeof F_PARAMS)[number]

/**
 * Which parameters filter which column. COMPANY, BANK and DATE RELEASED keep
 * their pre-existing names (`company`, `cashAccount`, `releasedFrom/To`), so
 * `TOTALS_KEYS`, `totalsHref` and the TOTALS screen's own bar are unaffected.
 */
export const COLUMN_FILTER_PARAMS = {
  checkNumber: ['f.checkNumber'],
  apvNumbers: ['f.apv'],
  poNumbers: ['f.po'],
  payeeName: ['f.payee'],
  companyCode: ['company'],
  bank: ['cashAccount'],
  checkDate: ['f.checkDateFrom', 'f.checkDateTo'],
  amount: ['f.amountMin', 'f.amountMax'],
  status: ['f.status'],
  availablePickupDate: ['f.availablePickupDateFrom', 'f.availablePickupDateTo'],
  scheduledPickupDate: ['f.scheduledPickupDateFrom', 'f.scheduledPickupDateTo'],
  releasedAt: ['releasedFrom', 'releasedTo'],
} as const satisfies Record<SortKey, readonly string[]>

export const FILTER_MESSAGES = {
  day: 'NOT A DAY — TYPE YYYY-MM-DD',
  amount: 'NOT AN AMOUNT — DIGITS, AT MOST TWO DECIMALS (E.G. 1250.50)',
  status: 'NOT A STATUS',
} as const

/** The labels a refusal names its box by. */
const PARAM_LABELS: Record<string, string> = {
  'f.checkNumber': 'CHECK NUMBER', 'f.apv': 'APV NUMBER', 'f.po': 'PO NUMBER', 'f.payee': 'SUPPLIER NAME',
  'f.status': 'STATUS', 'f.checkDateFrom': 'CHECK DATE (FROM)', 'f.checkDateTo': 'CHECK DATE (TO)',
  'f.availablePickupDateFrom': 'AVAILABLE DATE (FROM)', 'f.availablePickupDateTo': 'AVAILABLE DATE (TO)',
  'f.scheduledPickupDateFrom': 'PICKUP SCHEDULE (FROM)', 'f.scheduledPickupDateTo': 'PICKUP SCHEDULE (TO)',
  'f.amountMin': 'AMOUNT (MIN)', 'f.amountMax': 'AMOUNT (MAX)',
  releasedFrom: 'DATE RELEASED (FROM)', releasedTo: 'DATE RELEASED (TO)',
}

const STATUSES: readonly CheckStatus[] = [...LIVE_STATUSES, ...CLOSED_STATUSES]

/**
 * Plain digits, or thousands grouped correctly by commas or by spaces (one
 * separator throughout), then at most two decimals. Checked on the typed value
 * BEFORE the separators are stripped: stripping first read "1,5" as 15.
 */
const AMOUNT_SHAPE = /^(?:\d{1,16}|\d{1,3}(?:,\d{3}){1,5}|\d{1,3}(?: \d{3}){1,5})(?:\.\d{1,2})?$/

/** A decimal STRING (rule 8), thousands separators allowed, or null. Never a JS number. */
export function parseAmountBound(raw: string): string | null {
  const t = raw.trim()
  if (!AMOUNT_SHAPE.test(t)) return null
  const v = t.replace(/[, ]/g, '')
  // Grouping can reach 18 integer digits; the column holds 16 (Decimal(18,2)).
  return /^\d{1,16}(\.\d{1,2})?$/.test(v) ? v : null
}

export type ParsedColumnFilters = {
  filters: ColumnFilters
  /**
   * STATUS, on ALL CHEQUES only: the ticked statuses, at least one. It narrows
   * `CheckFilters.status` (one) or `statusIn` (several), not a column filter of its own.
   */
  status: CheckStatus[] | undefined
  /** Every non-empty box as typed (valid or not), for `base` and to render back. */
  values: Record<string, string>
  /** Parameter name → message, for each box that could not be read. */
  errors: Record<string, string>
}

export function parseColumnFilters(
  read: (name: FParam) => string | undefined,
  opts: { statusApplies: boolean },
): ParsedColumnFilters {
  const filters: ColumnFilters = {}
  const values: Record<string, string> = {}
  const errors: Record<string, string> = {}
  let status: CheckStatus[] | undefined

  const take = (name: FParam): string => {
    const v = read(name)?.trim() ?? ''
    if (v) values[name] = v
    return v
  }
  const text = (name: FParam): string | undefined => take(name) || undefined
  const day = (name: FParam, edge: 'start' | 'end'): Date | undefined => {
    const v = take(name)
    if (!v) return undefined
    if (!isIsoDay(v)) { errors[name] = FILTER_MESSAGES.day; return undefined }
    return edge === 'start' ? manilaDayStart(v) : manilaDayEnd(v)
  }
  const amount = (name: FParam): string | undefined => {
    const v = take(name)
    if (!v) return undefined
    const parsed = parseAmountBound(v)
    if (parsed === null) errors[name] = FILTER_MESSAGES.amount
    return parsed ?? undefined
  }

  const parsed: ColumnFilters = {
    checkNumberContains: text('f.checkNumber'),
    apvContains: text('f.apv'),
    poContains: text('f.po'),
    payeeContains: text('f.payee'),
    from: day('f.checkDateFrom', 'start'),
    to: day('f.checkDateTo', 'end'),
    availableFrom: day('f.availablePickupDateFrom', 'start'),
    availableTo: day('f.availablePickupDateTo', 'end'),
    pickupFrom: day('f.scheduledPickupDateFrom', 'start'),
    pickupTo: day('f.scheduledPickupDateTo', 'end'),
    amountMin: amount('f.amountMin'),
    amountMax: amount('f.amountMax'),
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (v !== undefined) (filters as Record<string, unknown>)[k] = v
  }

  if (opts.statusApplies) {
    // The ticked boxes, comma separated. One unreadable value refuses the box
    // whole: dropping it would list more statuses than the reader asked for.
    const picked = [...new Set(take('f.status').split(',').map((s) => s.trim()).filter(Boolean))]
    if (picked.length > 0) {
      if (picked.every((s) => (STATUSES as readonly string[]).includes(s))) status = picked as CheckStatus[]
      else errors['f.status'] = FILTER_MESSAGES.status
    }
  }

  return { filters, status, values, errors }
}

/** The column filters in words, column order, for line 3 of the export's title block. */
export function describeColumnFilters(values: Readonly<Record<string, string>>): string[] {
  const parts: string[] = []
  const contains = (p: string, label: string) => { if (values[p]) parts.push(`${label} CONTAINS "${values[p]}"`) }
  const range = (from: string, to: string, label: string) => {
    const a = values[from]
    const b = values[to]
    if (a && b) parts.push(`${label}: ${a} TO ${b}`)
    else if (a) parts.push(`${label}: FROM ${a}`)
    else if (b) parts.push(`${label}: TO ${b}`)
  }
  contains('f.checkNumber', 'CHECK NO.')
  contains('f.apv', 'APV')
  contains('f.po', 'PO')
  contains('f.payee', 'SUPPLIER')
  range('f.checkDateFrom', 'f.checkDateTo', 'CHECK DATE')
  range('f.amountMin', 'f.amountMax', 'AMOUNT')
  if (values['f.status']) {
    parts.push(`STATUS: ${values['f.status'].split(',').map((s) => s.trim().replace(/_/g, ' ')).filter(Boolean).join(', ')}`)
  }
  range('f.availablePickupDateFrom', 'f.availablePickupDateTo', 'AVAILABLE DATE')
  range('f.scheduledPickupDateFrom', 'f.scheduledPickupDateTo', 'PICKUP SCHEDULE')
  return parts
}

/** The `f.*` pairs of a `base` — what SIGN ALL's confirm form writes back as hidden fields. */
export function columnParamsOf(base: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(base).filter(([k]) => (F_PARAMS as readonly string[]).includes(k)))
}

/** A refusal, in words: the export's 400 body and the print sheet's notice. */
export function describeRefusal(errors: Readonly<Record<string, string>>): string {
  const lines = Object.entries(errors).map(([name, message]) => `${PARAM_LABELS[name] ?? name}: ${message}`)
  return ['A FILTER COULD NOT BE READ, SO NOTHING WAS LISTED.', ...lines].join('\n')
}
