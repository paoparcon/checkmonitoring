import type { CheckStatus, Eligibility } from '@prisma/client'
import type { CheckFilters, FilterOptions } from './queries'
import { parseStatusParam, parseEligibilityParam, parseOptionId } from './queries'
import { viewStatusFilter, type DashboardSelection } from './dashboard-view'
import { bankLabel, describeFilters, exportViewLabel } from './export/report'
import { isIsoDay } from './domain/details'
import { manilaDayEnd, manilaDayStart, manilaToday } from './manila-day'
import { parseColumnFilters, describeColumnFilters, FILTER_MESSAGES, type FParam } from './column-filters'
import { parseSort, parseSortCookie, DEFAULT_SORT, sameSort, describeSort, type SortSpec } from './list-sort'

/**
 * The dashboard's URL parameters, resolved into the one filter object that
 * reaches Prisma.
 *
 * Extracted from `app/page.tsx` when the Excel export arrived. The export is
 * required to hold EXACTLY what the reader is looking at, and the only way to
 * guarantee that is for the page and the route handler to run the same code —
 * a second parser that agreed today would drift the first time a filter is
 * added to one of them. So the page reads its filters from here, and so does
 * `app/api/export/route.ts`.
 *
 * Pure. `options` is passed in — the ids are validated against the rows the
 * dropdowns actually offer, not against the database directly — so every branch
 * below is testable without one.
 *
 * Since part C (2026-10-01) it also resolves the order (URL, then the `cm_sort`
 * cookie passed in `context`, then the default) and the filter row's `f.*`
 * boxes; an unreadable box sets `refused`, which `buildWhere` reads as
 * match-nothing.
 */

export type DashboardSearchParams = {
  q?: string
  status?: string
  company?: string
  cashAccount?: string
  eligibility?: string
  incomplete?: string
  scope?: string
  /** DATE RELEASED bounds, `YYYY-MM-DD` Manila days. */
  releasedFrom?: string
  releasedTo?: string
  /** The order (part C1): both or neither. */
  sort?: string
  dir?: string
} & Partial<Record<FParam, string>>

/**
 * What Next actually hands a page: a key repeated in the URL arrives as a
 * `string[]`. `resolveDashboardQuery` accepts this and reads the FIRST value
 * of each, as the export route does, so `?f.payee=a&f.payee=b` cannot throw.
 */
export type RawDashboardSearchParams = Readonly<Record<string, string | readonly string[] | undefined>>

/** Every parameter reduced to its first value, in one place. */
function firstValues(raw: RawDashboardSearchParams): DashboardSearchParams {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    const first = typeof v === 'string' ? v : v?.[0]
    if (first !== undefined) out[k] = first
  }
  return out
}

export type DashboardQuery = {
  /** The trimmed search text, as the search box should render it back. */
  q: string
  /** The DATE RELEASED boxes as typed (valid or not), `''` when empty or off-view. */
  releasedFrom: string
  releasedTo: string
  status: CheckStatus | undefined
  eligibility: Eligibility | undefined
  companyId: string | undefined
  cashAccountId: string | undefined
  incomplete: boolean
  showAll: boolean
  /** What the cards are lit against, and what every dashboard link is built from. */
  selection: DashboardSelection
  /** The one object `buildWhere` ANDs together. */
  filters: CheckFilters
  /** The order in force: the URL's, else the cookie's, else `DEFAULT_SORT`. */
  sort: SortSpec
  /** The URL's or the cookie's sort, null under the default — what the header cycle starts from. */
  activeSort: SortSpec | null
  /** Every filter-row box's value as typed (company/bank as validated ids), for the filter row to render back. */
  columnValues: Readonly<Record<string, string>>
  /** Parameter name → message for every box that could not be read. */
  filterErrors: Readonly<Record<string, string>>
  /** True when any box could not be read: `filters.refused` is set and the list shows nothing. */
  refused: boolean
  /** The view's short name — "READY FOR RELEASE", "ALL CHEQUES". */
  viewLabel: string
  /** The narrowing filters in words, for the export's title block. */
  filterDescription: string
  /**
   * The narrowing the TOTALS screen applies, in words — the three dropdowns
   * it has and nothing else. 'No filters applied' when none is set; the page
   * prints it only when one is.
   */
  narrowingDescription: string
}

export function resolveDashboardQuery(
  raw: DashboardSearchParams | RawDashboardSearchParams,
  options: FilterOptions,
  context: { sortCookie?: string } = {},
): DashboardQuery {
  // The first value of each key before anything reads one — see RawDashboardSearchParams.
  const params = firstValues(raw)
  const showAll = params.scope === 'all'
  const live = params.scope === 'live'

  /**
   * Every parameter is validated before it reaches Prisma. Casting
   * `params.status` straight to `CheckStatus` would hand Prisma an invalid enum
   * value on a hand-edited or stale bookmarked link and crash the request; a
   * company id nobody recognises would return an empty result that reads as
   * "there are no cheques". Each parser answers `undefined` for anything it
   * does not recognise, which `buildWhere` reads as no filter.
   */
  const status = parseStatusParam(params.status)
  const eligibility = parseEligibilityParam(params.eligibility)
  const companyId = parseOptionId(params.company, options.companies)
  const cashAccountId = parseOptionId(params.cashAccount, options.cashAccounts)

  /**
   * The checkbox submits `incomplete=1`; the dashboard's "Show them" link
   * writes the same. Only "1" turns it on — an unrecognised value leaves it off
   * rather than guessing, which is how every parameter above behaves too.
   *
   * OFF is not "no filter" any more. `CheckFilters.incomplete` is a tri-state,
   * and this boolean feeds it directly: `true` shows only the cheques with no
   * recorded amount, `false` EXCLUDES them, which is the dashboard's default
   * since the client asked for it on 2026-09-06. The bookmark behaviour is
   * unchanged — `?incomplete=1` still opens exactly what it always did — but a
   * URL WITHOUT the parameter now opens a smaller register than it used to, and
   * the page says so above the table.
   */
  const incomplete = params.incomplete === '1'

  const q = params.q?.trim() ?? ''

  const errors: Record<string, string> = {}

  /**
   * DATE RELEASED applies only where a released cheque can be: the RELEASED
   * view and ALL CHEQUES. On any other view the two are dropped exactly as an
   * unrecognised company id is — a live cheque has no release instant, so the
   * range could only empty the table without saying why — and, being dropped
   * here, they leave `base` and the description too, so a card link out of
   * RELEASED does not carry a filter the destination cannot honour.
   */
  // ON its two views, a value that is not a real day now REFUSES (part C2)
  // instead of opening the view unfiltered.
  const releasedRangeApplies = status === 'RELEASED' || showAll
  const releasedBound = (name: 'releasedFrom' | 'releasedTo') => {
    const raw = releasedRangeApplies ? (params[name]?.trim() ?? '') : ''
    const day = raw && isIsoDay(raw) ? raw : undefined
    if (raw && !day) errors[name] = FILTER_MESSAGES.day
    return { raw, day }
  }
  const releasedFrom = releasedBound('releasedFrom')
  const releasedTo = releasedBound('releasedTo')

  // STATUS has a box only on ALL CHEQUES; a card fixes it everywhere else.
  const column = parseColumnFilters((name) => params[name], { statusApplies: showAll && !status })
  Object.assign(errors, column.errors)
  const refused = Object.keys(errors).length > 0

  const urlSort = parseSort(params.sort, params.dir)
  const activeSort = urlSort ?? parseSortCookie(context.sortCookie)
  const sort = activeSort ?? DEFAULT_SORT

  const nonEmpty = (o: Record<string, string>) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ''))

  const selection: DashboardSelection = {
    status: status ?? null,
    showAll,
    incomplete,
    live,
    ...(urlSort ? { sort: urlSort } : {}),
    // Validated company/bank/eligibility (an unrecognised id is still dropped),
    // and every other box AS TYPED — a refused value must survive into the
    // export and print links, or EXPORT would hand over what the screen refused.
    base: nonEmpty({
      q,
      company: companyId ?? '',
      cashAccount: cashAccountId ?? '',
      eligibility: eligibility ?? '',
      releasedFrom: releasedFrom.raw,
      releasedTo: releasedTo.raw,
      ...column.values,
    }),
  }

  const filters: CheckFilters = {
    ...column.filters,
    q: q || undefined,
    companyId,
    cashAccountId,
    eligibility,
    // CANCELLED and VOIDED cheques are meant to have no amount; the default
    // exclusion of those would empty exactly the views that show them.
    incomplete: (status === 'CANCELLED' || status === 'VOIDED') && !incomplete ? undefined : incomplete,
    // GENERATED is "generated today" (Manila day) — see CheckFilters.generatedSince.
    ...(status === 'GENERATED' ? { generatedSince: manilaDayStart(manilaToday(new Date())) } : {}),
    // Manila calendar days become inclusive instants: the day's first and last
    // millisecond in UTC+8. FROM after TO is passed through as given.
    releasedFrom: releasedFrom.day ? manilaDayStart(releasedFrom.day) : undefined,
    releasedTo: releasedTo.day ? manilaDayEnd(releasedTo.day) : undefined,
    ...viewStatusFilter(selection),
    // One ticked status is `status`; several are `statusIn`, which `buildWhere`
    // reads only while `status` is unset — so it is cleared here explicitly.
    ...(column.status?.length === 1 ? { status: column.status[0], statusIn: undefined } : {}),
    ...(column.status && column.status.length > 1 ? { status: undefined, statusIn: column.status } : {}),
    ...(refused ? { refused: true as const } : {}),
  }

  // The labels a reader recognises, not the ids. A title block reading
  // "COMPANY: cmf3x9..." tells a manager nothing.
  const company = options.companies.find((c) => c.id === companyId)
  const account = options.cashAccounts.find((a) => a.id === cashAccountId)

  return {
    q,
    releasedFrom: releasedFrom.raw,
    releasedTo: releasedTo.raw,
    status,
    eligibility,
    companyId,
    cashAccountId,
    incomplete,
    showAll,
    selection,
    filters,
    sort,
    activeSort,
    columnValues: nonEmpty({
      company: companyId ?? '',
      cashAccount: cashAccountId ?? '',
      releasedFrom: releasedFrom.raw,
      releasedTo: releasedTo.raw,
      ...column.values,
    }),
    filterErrors: errors,
    refused,
    viewLabel: exportViewLabel(selection),
    filterDescription: describeFilters({
      company: company?.code ?? null,
      bank: account ? bankLabel(account.code, account.bankCode) : null,
      eligibility: eligibility ?? null,
      q,
      columns: describeColumnFilters(column.values),
      incomplete,
      releasedFrom: releasedFrom.raw || null,
      releasedTo: releasedTo.raw || null,
      sort: activeSort && !sameSort(activeSort, DEFAULT_SORT) ? describeSort(activeSort) : null,
    }),
    narrowingDescription: describeFilters({
      company: company?.code ?? null,
      bank: account ? bankLabel(account.code, account.bankCode) : null,
      eligibility: eligibility ?? null,
      q: '',
      incomplete: undefined,
      releasedFrom: null,
      releasedTo: null,
    }),
  }
}
