import { Prisma, type PrismaClient, type CheckStatus, type Eligibility, type ReceiptType } from '@prisma/client'
import { LIVE_STATUSES, CLOSED_STATUSES } from './domain/check-status'
import { ELIGIBILITIES } from './domain/eligibility'
// Pure URL/view arithmetic, no database — imported so the READY FOR RELEASE
// card, the table view and TODAY'S RELEASE all read one definition of which
// statuses that view covers. `dashboard-view` does not import this module, so
// there is no cycle.
import { viewStatusFilter } from './dashboard-view'
import { manilaDayStart, manilaToday } from './manila-day'
import {
  DEFAULT_SORT, isAppSorted, dbOrderBy, compareSortValues,
  type SortSpec, type SortDir, type AppSortKey, type SortValue,
} from './list-sort'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * The LIST screen's per-column filters (spec 2026-10-01, part C2). Parsed from
 * the `f.*` URL parameters by `lib/column-filters.ts`; every bound is
 * inclusive. `from`/`to` are the CHECK DATE range — they were already a
 * `checkDate` range here, used by nothing, and one column gets one filter.
 * Amounts are DECIMAL STRINGS (rule 8); Prisma takes them as such.
 */
export type ColumnFilters = {
  checkNumberContains?: string
  apvContains?: string
  poContains?: string
  payeeContains?: string
  from?: Date
  to?: Date
  availableFrom?: Date
  availableTo?: Date
  pickupFrom?: Date
  pickupTo?: Date
  amountMin?: string
  amountMax?: string
}

export type CheckFilters = ColumnFilters & {
  q?: string
  status?: CheckStatus
  /**
   * A set of statuses, for the dashboard's default view of the cheques that
   * still need Finance. Ignored when `status` names a single one — an explicit
   * choice from the dropdown wins over the default scope, otherwise picking
   * RELEASED would return nothing and look like a broken filter.
   *
   * The list itself is never written here: `LIVE_STATUSES` in
   * lib/domain/check-status.ts is the one place it exists, and a restatement is
   * how a ninth status ends up live in one file and closed in another.
   */
  statusIn?: readonly CheckStatus[]
  companyId?: string
  /**
   * The BANK filter. Named for the URL parameter it has always come from, but
   * since 2026-10-06 it is an ACCOUNT id: a cheque book's (Acumatica's
   * CashAccount, which every synced cheque carries) or, for a cheque with no
   * book, a register cash-account label's. `accountWhere` is the one rule.
   */
  cashAccountId?: string
  eligibility?: Eligibility
  /**
   * DATE RELEASED, as a range over `releasedAt` — the instant `markReleased`
   * wrote when the cheque was released THROUGH THIS APP. Both bounds are
   * inclusive instants; the resolver builds them from Manila calendar days.
   *
   * A release nobody recorded here has no instant — every cheque the register
   * load imported at RELEASED and every one the two catch-ups moved — so it
   * never matches a bound on `releasedAt`.
   *
   * Since 2026-09-28 the range also matches `statedReleaseDate` — the day the
   * retired register states for a release the app never recorded — so a
   * cheque matches when EITHER date falls inside it. The two are never merged.
   */
  releasedFrom?: Date
  releasedTo?: Date
  /**
   * The GENERATED view (client, 2026-10-06): cheques generated since this
   * instant — a cheque at GENERATED, or one still at SIGNATURE_PENDING whose
   * row was created on or after it. A synced Acumatica cheque is created at
   * SIGNATURE_PENDING, so nothing ever sat at GENERATED and the count read 0.
   * The resolver sets it to the start of the Manila day; it replaces any
   * status filter, and `getSummary`'s `generated` counts the same set.
   */
  generatedSince?: Date
  /**
   * Only the cheques with NO release date of either kind — `releasedAt` null
   * and `statedReleaseDate` null. The disclosure's count, taken through the
   * same `buildWhere` as the table so it is narrowed by the same company,
   * bank, search and incompleteness. When set it replaces the range, never
   * combines with it — a cheque cannot be both.
   */
  noReleaseDate?: true
  /**
   * The cheques with no recorded amount — 129 in production. A TRI-STATE:
   *
   *   `true`       only those records
   *   `false`      EXCLUDE them
   *   `undefined`  do not filter on this
   *
   * ── WHY `false` NOW HIDES THEM (client decision, 2026-09-06) ─────────────
   * This field used to be two-state, and the comment here argued against a
   * tri-state on the grounds that accidentally hiding 129 cheques from a search
   * is worse than not filtering at all. That reasoning was sound, and the client
   * has overridden it: shown the INCOMPLETE card reading 129, they said
   * "ignore them mean you have to remove them, dont consider them becuase they
   * dont have amount".
   *
   * The warning it replaces still applies, so the risk is paid for rather than
   * ignored:
   *
   *   · NOTHING IS DELETED. These are real cheques — 25 RELEASED, 48 CANCELLED
   *     — and rule 10 forbids a bulk delete path outright. They stay in the
   *     database, in `Check.isIncomplete`, and in every audit row.
   *   · The dashboard states the exclusion ON SCREEN, with the count and a link
   *     that shows them (`?incomplete=1`). A number that quietly got smaller is
   *     how someone concludes money went missing.
   *   · The export and the printed sheet say the same thing in their title
   *     blocks, because they run the same `resolveDashboardQuery`.
   *
   * `undefined` — no filter — is still what a caller gets by leaving the field
   * off, so a query that has no opinion about incompleteness cannot acquire one
   * by accident.
   * ────────────────────────────────────────────────────────────────────────
   */
  incomplete?: boolean
  /**
   * A filter value on the URL could not be read (an amount `12x`, a day that
   * is not a day). The query then matches NOTHING — never "no filter", which
   * would read as an applied one. Enforced here, in `buildWhere`, so every
   * consumer fails closed whether or not it checked.
   */
  refused?: true
}

/**
 * The column filters and nothing else, named one by one — the reason
 * `todaysReleaseFilter` gives: SIGN ALL acts on this set, and a caller holding
 * a whole `CheckFilters` must not be able to override its status or its
 * exclusion of the cheques with no amount by spreading it in.
 */
export function columnFilterFields(c: ColumnFilters): ColumnFilters {
  const out: ColumnFilters = {
    checkNumberContains: c.checkNumberContains, apvContains: c.apvContains, poContains: c.poContains,
    payeeContains: c.payeeContains, from: c.from, to: c.to,
    availableFrom: c.availableFrom, availableTo: c.availableTo, pickupFrom: c.pickupFrom, pickupTo: c.pickupTo,
    amountMin: c.amountMin, amountMax: c.amountMax,
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as ColumnFilters
}

// `total` is null when nothing in the group is known — see getSummary. It is
// not the same fact as a total of zero, and must not be rendered as one.
export type CurrencyTotal = { currency: string; total: string | null; count: number }

/**
 * The dashboard's scope, as a `where` fragment.
 *
 * CLIENT DECISION, 2026-09-06: the cheques with no recorded amount are out of
 * the dashboard's counts as well as out of its table. The counts and the table
 * MUST move together — a PENDING SIGNATURE card reading 213 that opens a table
 * of 208 is the drift this constant exists to make impossible, and it is exactly
 * what would happen if only the table were narrowed.
 *
 * `false`, not the absence of the key: `buildWhere` reads `false` as EXCLUDE and
 * `undefined` as no filter, and the dashboard means the former.
 */
const COMPLETE_ONLY = { isIncomplete: false } as const

/**
 * The narrowing the TOTALS screen applies to every figure on it (client
 * request 2026-09-29: "should have filter in every summary") — the three
 * dropdowns that screen has, and nothing else. A `Pick` of `CheckFilters`
 * rather than a new shape, so the cards and the table cannot disagree about
 * what a company or a bank means.
 */
export type SummaryNarrowing = Pick<CheckFilters, 'companyId' | 'cashAccountId' | 'eligibility'>

/**
 * A cheque's ACCOUNT: its cheque book when it has one (Acumatica's
 * CashAccount — user ruling 2026-10-05 "follow acumatica"), otherwise the
 * register's cash-account label. Only ~1,342 of ~13,000 cheques carry a label
 * and ~12,100 carry a book, so a filter on the label alone hid nine in ten
 * cheques (full check, 2026-10-06). Ids are cuids, unique across both tables.
 */
export function accountWhere(accountId: string): Prisma.CheckWhereInput {
  return { OR: [{ checkBookId: accountId }, { checkBookId: null, cashAccountId: accountId }] }
}

/** GENERATED today: the rung itself, or a SIGNATURE_PENDING cheque created since `since`. */
export function generatedWhere(since: Date): Prisma.CheckWhereInput {
  return { OR: [{ status: 'GENERATED' }, { status: 'SIGNATURE_PENDING', createdAt: { gte: since } }] }
}

function narrowingWhere(narrow: SummaryNarrowing): Prisma.CheckWhereInput {
  const where: Prisma.CheckWhereInput = {}
  if (narrow.companyId) where.companyId = narrow.companyId
  if (narrow.cashAccountId) where.AND = [accountWhere(narrow.cashAccountId)]
  if (narrow.eligibility) where.eligibility = narrow.eligibility
  return where
}

export async function getSummary(db: Db, narrow: SummaryNarrowing = {}, now: Date = new Date()) {
  // Applied to ALL FOUR figures, the disclosure included: a narrowed screen
  // whose "excluding N with no amount" line still counted the whole database
  // would be a number nobody could reconcile with the cards above it.
  const scope = narrowingWhere(narrow)
  const [grouped, currencyAgg, total, incomplete, generatedToday, cancelled, voided] = await Promise.all([
    // Every count on the dashboard is struck over the same population the table
    // shows — see COMPLETE_ONLY.
    db.check.groupBy({ by: ['status'], _count: { _all: true }, where: { ...scope, ...COMPLETE_ONLY } }),
    /**
     * Grouped by currency, never summed across them: adding a PHP amount to a
     * CNY amount produces a number with no meaning, so there is no code path
     * here that could do it — each currency gets its own row.
     *
     * NOT narrowed by COMPLETE_ONLY, and that is deliberate. This block is the
     * answer to "what is the money", and its behaviour towards a cheque with no
     * amount is the property tests/queries.test.ts pins and forbids "fixing":
     * SQL SUM() SKIPS a null rather than reading it as zero. Narrowing the group
     * would leave every figure identical while changing what the count beneath
     * it means, which is the same class of silent redefinition. The cards do not
     * render this count; the export's SUMMARY sheet does, and says what it is.
     */
    db.check.groupBy({
      by: ['currency'],
      _sum: { amount: true },
      _count: { _all: true },
      where: { ...scope, status: { not: 'CANCELLED' } },
    }),
    db.check.count({ where: { ...scope, ...COMPLETE_ONLY } }),
    // The one figure that counts them, because it is the DISCLOSURE: the number
    // the dashboard states on screen, beside the link that shows them. Counted,
    // never subtracted from anything, and never zero just because the rest of
    // this function stopped looking at them.
    db.check.count({ where: { ...scope, isIncomplete: true } }),
    // GENERATED TODAY: the same set the GENERATED view opens (`generatedWhere`).
    db.check.count({ where: { ...scope, ...COMPLETE_ONLY, AND: [generatedWhere(manilaDayStart(manilaToday(now)))] } }),
    // CANCELLED and VOIDED are NOT narrowed by COMPLETE_ONLY: a cancelled cheque
    // is meant to have no amount, so excluding the incomplete would hide
    // exactly the cheques these views exist to show (client, 2026-10-06).
    db.check.count({ where: { ...scope, status: 'CANCELLED' } }),
    db.check.count({ where: { ...scope, status: 'VOIDED' } }),
  ])
  const count = (s: CheckStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0
  // `amount` is nullable and 397 register rows have no amount. Verified against
  // the test database: SQL SUM() skips those rows rather than reading them as 0,
  // while COUNT(*) still counts them — so a currency's total is the sum of the
  // amounts that are actually known, over a count that includes the ones that
  // are not. That is the intended reading, not a defect: absorbing 397 unknowns
  // as zeroes would produce a total that understates reality while looking
  // authoritative.
  //
  // In the degenerate case where every row in a currency group has a null
  // amount, Postgres returns SUM() = NULL for the whole group. That is carried
  // through as null, NOT collapsed to zero: "no amount is known for any of
  // these cheques" and "these cheques are worth nothing" are different facts,
  // and a financial figure that reads ₱0.00 while meaning the former is a lie
  // the reader has no way to detect. `formatMoney` renders null as an em dash.
  // The group still appears, with its count, because hiding it would hide the
  // cheques.
  const totalsByCurrency: CurrencyTotal[] = currencyAgg.map((g) => ({
    currency: g.currency,
    total: g._sum.amount?.toString() ?? null,
    count: g._count._all,
  }))
  return {
    /**
     * The ALL CHECKS card (labelled TOTAL CHECKS until 2026-09-29), and the
     * count the TOTAL VALUE line is struck over.
     *
     * It is the number of cheques the dashboard SHOWS, not the number of rows
     * in the table: since 2026-09-06 it excludes the ones with no recorded
     * amount, because the card links to `?scope=all`, which no longer lists
     * them. `incomplete` below is what it leaves out, and the page prints it.
     */
    total,
    /**
     * The PENDING SIGNATURE card: both rungs, because to Finance a freshly
     * generated cheque is a cheque waiting to be signed.
     *
     * The two rungs are ALSO reported separately below, for the release
     * timeline. No extra query — `grouped` already holds every status — and no
     * change to this figure, which the card and the export's SUMMARY sheet both
     * read.
     */
    pendingSignature: count('GENERATED') + count('SIGNATURE_PENDING'),
    /**
     * The rungs on their own. The timeline shows GENERATED as its own node
     * because a node's count must be the number of rows its link opens, and
     * `?status=SIGNATURE_PENDING` opens only the SIGNATURE_PENDING rows —
     * see lib/release-timeline.ts.
     */
    generated: generatedToday,
    cancelled,
    voided,
    signaturePending: count('SIGNATURE_PENDING'),
    signed: count('SIGNED'),
    readyForRelease: count('READY_FOR_RELEASE'),
    scheduled: count('SCHEDULED'),
    released: count('RELEASED'),
    /**
     * Cheques with no recorded amount — 129 in production. Every OTHER count
     * here now excludes them (client decision, 2026-09-06), which makes this
     * number the disclosure rather than a card: the dashboard prints it above
     * the table, with a link that shows them, so a reader can always tell the
     * difference between "the register is smaller" and "money went missing".
     *
     * This number and the currency totals above are still answers to different
     * questions and must stay that way: flagging a cheque incomplete does NOT
     * enrol it in a total, and "fixing" the totals to count it as zero would
     * leave every figure looking identical while quietly meaning something else.
     */
    incomplete,
    totalsByCurrency,
  }
}

/**
 * The set TODAY'S RELEASE covers, as a filter.
 *
 * READY_FOR_RELEASE **and** SCHEDULED, and the pair is not restated here.
 * `viewStatusFilter` is already the one place that decides what the READY FOR
 * RELEASE card and view mean, and a panel offering to release 81 cheques above
 * a card reading 87 is precisely the drift a second copy of the list invites.
 *
 * `showAll: false` is inert alongside an explicit status — `viewStatusFilter`
 * only consults it when none was given — but it is spelled out because
 * `ViewState` requires it and a reader should not have to check.
 *
 * `incomplete: false` for the same anti-drift reason the pair is not restated:
 * the READY FOR RELEASE card counts `getSummary`, which excludes the cheques
 * with no recorded amount (client decision, 2026-09-06), and a panel offering to
 * RELEASE ALL 86 beneath a card reading 80 is precisely the disagreement this
 * module is arranged to prevent. Six of production's 129 are READY_FOR_RELEASE,
 * so this is a live case, not a hypothetical: they are not released in bulk any
 * more, and are still released one at a time from `/?incomplete=1`.
 */
export const TODAYS_RELEASE_FILTER: CheckFilters = {
  ...viewStatusFilter({ status: 'READY_FOR_RELEASE', showAll: false }),
  incomplete: false,
}

/**
 * The filter behind the panel and RELEASE ALL: the fixed READY FOR RELEASE
 * filter with exactly the three narrowings the dashboard reads, named one by
 * one. Spreading `narrow` instead would let any caller holding a full
 * `CheckFilters` (it is assignable to `SummaryNarrowing`) override
 * `statusIn` or `incomplete` — and RELEASE ALL acts on this set (review,
 * 2026-09-29).
 */
function todaysReleaseFilter(narrow: SummaryNarrowing): CheckFilters {
  return {
    ...TODAYS_RELEASE_FILTER,
    companyId: narrow.companyId,
    cashAccountId: narrow.cashAccountId,
    eligibility: narrow.eligibility,
  }
}

/** What the TODAY'S RELEASE panel shows, and what RELEASE ALL would act on. */
export type TodaysRelease = {
  /**
   * Every cheque in the set. There is no separate `incomplete` figure any more:
   * `TODAYS_RELEASE_FILTER` excludes the cheques with no recorded amount, so the
   * count and the totals below are struck over one population and cannot
   * legitimately disagree.
   */
  count: number
  /** Per currency, never summed across them. */
  totalsByCurrency: CurrencyTotal[]
}

/**
 * What is ready to hand over right now.
 *
 * The count is derived from the same grouping as the totals rather than counted
 * separately, so "81 cheques" and the currency rows beneath it cannot come from
 * two queries that saw different data.
 */
export async function getTodaysRelease(db: Db, narrow: SummaryNarrowing = {}): Promise<TodaysRelease> {
  // The same narrowing the cards read, spread over the same filter RELEASE ALL
  // reads below — the panel and the button are one set, narrowed or not.
  const where = buildWhere(todaysReleaseFilter(narrow))

  const grouped = await db.check.groupBy({
    by: ['currency'],
    _sum: { amount: true },
    _count: { _all: true },
    where,
  })

  // `?.toString() ?? null`, exactly as getSummary does it: a decimal STRING,
  // never a JS number, and null where no amount in the group is known — which
  // is not the same fact as a total of zero and must not render as one.
  const totalsByCurrency: CurrencyTotal[] = grouped.map((g) => ({
    currency: g.currency,
    total: g._sum.amount?.toString() ?? null,
    count: g._count._all,
  }))

  return {
    count: grouped.reduce((n, g) => n + g._count._all, 0),
    totalsByCurrency,
  }
}

/**
 * The ids RELEASE ALL acts on, oldest cheque first.
 *
 * Read here rather than submitted by the browser. The panel's button names a
 * count, not a list, and a form carrying 81 ids is a form somebody can edit —
 * the set has to be the one the server decided, from the same filter the panel
 * counted.
 *
 * Ordered so the longest-waiting cheque is released first, and so the per-cheque
 * outcome list comes back in a stable order a person can read against the pile
 * of paper in front of them. `nulls: 'last'` for the same reason `listChecks`
 * uses it: `checkDate` is nullable and Postgres sorts NULLs first on ascending
 * order too when asked for `nulls: 'first'`; being explicit keeps the undated
 * ones out of the front of the queue.
 */
export async function listTodaysReleaseIds(db: Db, narrow: SummaryNarrowing = {}): Promise<string[]> {
  const rows = await db.check.findMany({
    where: buildWhere(todaysReleaseFilter(narrow)),
    orderBy: [{ checkDate: { sort: 'asc', nulls: 'last' } }, { checkNumber: 'asc' }],
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

/**
 * The set SIGN ALL acts on (client, 2026-10-01): every SIGNATURE_PENDING
 * cheque with an amount, narrowed by exactly the three dropdowns, named one by
 * one for the reason `todaysReleaseFilter` gives. Non-cheques are left out --
 * `markSigned` refuses them, and a confirmed count that includes payments that
 * cannot be signed is a count that will not match what moved. Since part C
 * the column filters on screen narrow it too (spec C2); `columnFilterFields`
 * copies them by name.
 */
async function pendingSignatureWhere(
  db: Db, narrow: SummaryNarrowing, columns: ColumnFilters,
): Promise<Prisma.CheckWhereInput> {
  const where = await whereFor(db, {
    ...columnFilterFields(columns),
    // A refusal is carried through on its own: `columnFilterFields` copies the
    // twelve named filters only, and a refused filter that vanished here would
    // hand SIGN ALL every pending cheque. It can only narrow, so letting it in
    // cannot widen the set.
    refused: (columns as { refused?: unknown }).refused === true ? true : undefined,
    status: 'SIGNATURE_PENDING', incomplete: false,
    companyId: narrow.companyId, cashAccountId: narrow.cashAccountId, eligibility: narrow.eligibility,
  })
  return { AND: [where, { isCheque: true }] }
}

export async function getPendingSignature(
  db: Db, narrow: SummaryNarrowing = {}, columns: ColumnFilters = {},
): Promise<TodaysRelease> {
  const grouped = await db.check.groupBy({
    by: ['currency'], _sum: { amount: true }, _count: { _all: true },
    where: await pendingSignatureWhere(db, narrow, columns),
  })
  return {
    count: grouped.reduce((n, g) => n + g._count._all, 0),
    totalsByCurrency: grouped.map((g) => ({ currency: g.currency, total: g._sum.amount?.toString() ?? null, count: g._count._all })),
  }
}

/** Read here, never from the form -- the same reason as `listTodaysReleaseIds`. Oldest cheque first. */
export async function listPendingSignatureIds(
  db: Db, narrow: SummaryNarrowing = {}, columns: ColumnFilters = {},
): Promise<string[]> {
  const rows = await db.check.findMany({
    where: await pendingSignatureWhere(db, narrow, columns),
    orderBy: [{ checkDate: { sort: 'asc', nulls: 'last' } }, { checkNumber: 'asc' }],
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

// Shared by listChecks and countChecks so the table and its "showing N of M"
// count can never drift apart.
function buildWhere(filters: CheckFilters, extraSearch: readonly Prisma.CheckWhereInput[] = []): Prisma.CheckWhereInput {
  if (filters.refused) return { id: { in: [] } }
  const where: Prisma.CheckWhereInput = {}

  // A single explicit status wins; the scope list applies only when none was
  // chosen. An empty `statusIn` is treated as no filter rather than as "match
  // nothing", so a miscomputed scope can never hide every cheque.
  if (filters.status) where.status = filters.status
  else if (filters.statusIn && filters.statusIn.length > 0) where.status = { in: [...filters.statusIn] }
  if (filters.generatedSince) {
    delete where.status
  }
  if (filters.companyId) where.companyId = filters.companyId
  // Collected under AND, never on `where.OR`, which the search owns below.
  const and: Prisma.CheckWhereInput[] = []
  if (filters.cashAccountId) and.push(accountWhere(filters.cashAccountId))
  if (filters.generatedSince) and.push(generatedWhere(filters.generatedSince))
  if (filters.eligibility) where.eligibility = filters.eligibility
  // The tri-state, spelled out. `true` narrows to the records with no recorded
  // amount, `false` EXCLUDES them (the dashboard's default since 2026-09-06 —
  // see `CheckFilters.incomplete`), and `undefined` leaves the column alone.
  // `!== undefined` rather than a truthiness test, so `false` cannot decay back
  // into "no filter" the way it used to.
  if (filters.incomplete !== undefined) where.isIncomplete = filters.incomplete
  if (filters.from || filters.to) {
    where.checkDate = { gte: filters.from, lte: filters.to }
  }
  if (filters.checkNumberContains) where.checkNumber = { contains: filters.checkNumberContains, mode: 'insensitive' }
  if (filters.payeeContains) where.payeeName = { contains: filters.payeeContains, mode: 'insensitive' }
  if (filters.availableFrom || filters.availableTo) {
    where.availablePickupDate = { gte: filters.availableFrom, lte: filters.availableTo }
  }
  if (filters.pickupFrom || filters.pickupTo) {
    where.scheduledPickupDate = { gte: filters.pickupFrom, lte: filters.pickupTo }
  }
  // Decimal strings, straight through — Prisma takes a string for a Decimal
  // bound, and a JS number would be rule 8 broken one step from the database.
  // A cheque with no amount satisfies no bound and drops out, which is right:
  // nobody knows whether it is above 500.
  if (filters.amountMin || filters.amountMax) {
    where.amount = { gte: filters.amountMin, lte: filters.amountMax }
  }
  if (filters.noReleaseDate) {
    where.releasedAt = null
    where.statedReleaseDate = null
  } else if (filters.releasedFrom || filters.releasedTo) {
    // Either date. Under AND rather than on `where.OR`, which the search owns
    // below — two top-level ORs would not both apply, the second would
    // replace the first. A null date satisfies neither bound, so a cheque with
    // neither date is left out without an extra clause.
    const bounds = { gte: filters.releasedFrom, lte: filters.releasedTo }
    and.push({ OR: [{ releasedAt: bounds }, { statedReleaseDate: bounds }] })
  }
  if (and.length > 0) where.AND = and

  const q = filters.q?.trim()
  if (q) {
    // Prisma ANDs sibling keys with OR, so this narrows within the other
    // filters rather than widening past them.
    where.OR = [
      { checkNumber: { contains: q, mode: 'insensitive' } },
      { cvNumber: { contains: q, mode: 'insensitive' } },
      { payeeName: { contains: q, mode: 'insensitive' } },
      { bills: { some: { apvNumber: { contains: q, mode: 'insensitive' } } } },
      { bills: { some: { poNumber: { contains: q, mode: 'insensitive' } } } },
      // WHOLE VOUCHER, not a substring, and not case-insensitive. Postgres
      // array containment is the only filter available over a `text[]`; there
      // is no `contains` for an array element. Searching "AP-ST042652" finds
      // the cheque, searching "042652" does not — which is worth saying out
      // loud, but is far better than the column not being searchable at all.
      // Upper-cased because the parser stores vouchers upper-cased.
      { apvNumbers: { has: q.toUpperCase() } },
      // Acumatica's POs (AcumaticaBill): ids computed by whereFor, which needs the database.
      ...extraSearch,
    ]
  }

  return where
}

/** `%text%` for ILIKE … ESCAPE '\', with the user's own `\`, `%` and `_` made literal. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/**
 * APV → the POs Acumatica's AP-Bills and Adjustments names for it
 * (`AcumaticaBill`, lib/sync/bill-refs.ts). There is no relation from `Check`
 * — the table is keyed by APV — so it is loaded per request, for exactly the
 * APVs on screen (or, for the PO sort, every matching cheque's).
 */
export type AcumaticaPoIndex = ReadonlyMap<string, readonly string[]>
export const NO_ACUMATICA_POS: AcumaticaPoIndex = new Map()

/** One query however many APVs: the list travels as a single array parameter. */
export async function loadAcumaticaPoIndex(db: Db, apvs: Iterable<string>): Promise<AcumaticaPoIndex> {
  const list = [...new Set(apvs)]
  if (list.length === 0) return NO_ACUMATICA_POS
  // The PO NUMBER IS Acumatica's Vendor Ref, whole (user ruling 2026-10-06:
  // "vendor reference in Acumatica stands as PO number") — not only the refs
  // that look like a PO, which is what the 2026-10-05 "only real POs" read.
  const rows = await db.$queryRaw<{ apvNumber: string; vendorRef: string | null }[]>`
    SELECT "apvNumber", "vendorRef" FROM "AcumaticaBill"
     WHERE "apvNumber" = ANY(${list}::text[]) AND "vendorRef" <> ''`
  return new Map(rows.map((r) => [r.apvNumber, r.vendorRef ? [r.vendorRef] : []]))
}

/**
 * The SQL twin of `displayPoNumbers`' Acumatica half, for a cheque aliased
 * `c`: one of the APVs it SHOWS (its own `apvNumbers`, or a bill's
 * `apvNumber` — `displayApvNumbers`) has an AcumaticaBill with a PO matching
 * `pattern` (ILIKE … ESCAPE '\', from `likePattern`). Used by the PO filter
 * box and the global search, so both match exactly what the column shows.
 *
 * Driven from the cheque's OWN displayed APVs, each looked up on the
 * AcumaticaBill primary key, so the cost per cheque is its handful of APVs
 * whatever the pattern — an `ab.apvNumber = ANY(…) OR IN (…)` predicate
 * cannot be hashed under the OR and costs cheques × matching bills.
 */
function acumaticaPoMatch(pattern: string): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1
      FROM unnest(c."apvNumbers" || ARRAY(SELECT b2."apvNumber" FROM "CheckBill" b2 WHERE b2."checkId" = c."id")) AS v(apv)
      JOIN "AcumaticaBill" ab ON ab."apvNumber" = v.apv
     WHERE ab."vendorRef" ILIKE ${pattern} ESCAPE '\\'
  )`
}

/** The global search's Acumatica-PO arm: substring, any case — as the bills' PO arm is. */
async function idsWithAcumaticaPo(db: Db, text: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT c."id" FROM "Check" c WHERE ${acumaticaPoMatch(likePattern(text))}`
  return rows.map((r) => r.id)
}

/**
 * APV and PO "contains" (part C2). Both columns show a union — the cheque's
 * own `apvNumbers` array and its bills — and Postgres offers no substring
 * match on an array element that Prisma can express (the global search's
 * `has` is whole-voucher only, and says so). So this asks Postgres directly
 * for the ids, case-insensitively, and `whereFor` ANDs `id IN (…)` onto the
 * Prisma `where`. Runs only when one of the two boxes is filled.
 *
 * PO reads both sources the PO NUMBER column shows: the bills' `poNumber` and
 * Acumatica's (`acumaticaPoMatch`). `Check` has no PO column.
 */
async function arrayContainsIds(db: Db, f: ColumnFilters): Promise<string[] | null> {
  const conditions: Prisma.Sql[] = []
  if (f.apvContains) {
    const p = likePattern(f.apvContains)
    conditions.push(Prisma.sql`(
      EXISTS (SELECT 1 FROM unnest(c."apvNumbers") AS v(x) WHERE v.x ILIKE ${p} ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM "CheckBill" b WHERE b."checkId" = c."id" AND b."apvNumber" ILIKE ${p} ESCAPE '\\')
    )`)
  }
  if (f.poContains) {
    const p = likePattern(f.poContains)
    conditions.push(Prisma.sql`(
      EXISTS (SELECT 1 FROM "CheckBill" b WHERE b."checkId" = c."id" AND b."poNumber" ILIKE ${p} ESCAPE '\\')
      OR ${acumaticaPoMatch(p)}
    )`)
  }
  if (conditions.length === 0) return null
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT c."id" FROM "Check" c WHERE ${Prisma.join(conditions, ' AND ')}`
  return rows.map((r) => r.id)
}

/** `buildWhere`, plus the database-backed steps: the search's Acumatica-PO arm and the APV/PO column filters. Every query that can carry a search or column filters goes through this. */
async function whereFor(db: Db, filters: CheckFilters): Promise<Prisma.CheckWhereInput> {
  if (filters.refused) return buildWhere(filters)
  const q = filters.q?.trim()
  const extraSearch: Prisma.CheckWhereInput[] = q ? [{ id: { in: await idsWithAcumaticaPo(db, q) } }] : []
  const where = buildWhere(filters, extraSearch)
  const ids = await arrayContainsIds(db, filters)
  return ids === null ? where : { AND: [where, { id: { in: ids } }] }
}

// All bills, not just the first: search matches APV/PO across every bill on
// a check, so showing only `bills[0]` would display a different APV than the
// one the user searched for — indistinguishable from a false positive.
//
// `cashAccount.bank` feeds the BANK column. One nested include, not a
// second query per row.
const CHECK_ROW_INCLUDE = {
  company: true,
  cashAccount: { include: { bank: true } },
  checkBook: { include: { bank: true } },
  bills: { orderBy: { apvNumber: 'asc' } },
} satisfies Prisma.CheckInclude

/** What the in-app order reads: enough to compute the four keys Prisma cannot order. */
type SortProbe = {
  apvNumbers: string[]
  releasedAt: Date | null
  statedReleaseDate: Date | null
  cashAccount: { code: string } | null
  checkBook: { code: string } | null
  bills: { apvNumber: string; poNumber: string | null }[]
}

export function appSortValue(key: AppSortKey, r: SortProbe, acumatica: AcumaticaPoIndex): SortValue {
  switch (key) {
    case 'apvNumbers': return displayApvNumbers(r)[0] ?? null
    case 'poNumbers': return displayPoNumbers(r, acumatica)[0] ?? null
    case 'bank': return r.checkBook?.code ?? r.cashAccount?.code ?? null
    case 'releasedAt': return (r.releasedAt ?? r.statedReleaseDate)?.getTime() ?? null
    default: {
      const unreachable: never = key
      throw new Error(`No in-app order for ${String(unreachable)}`)
    }
  }
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The ids of the first `limit` matching cheques in an order Prisma cannot
 * express (see APP_SORTED_KEYS). Every matching cheque is read — five small
 * columns and its bills' two references — because the page must be the first
 * `limit` of the WHOLE set. Production holds ~12,000 cheques; ALL CHEQUES
 * reads them all, which is a narrow select, once per request.
 */
async function appSortedIds(
  db: Db, where: Prisma.CheckWhereInput, key: AppSortKey, dir: SortDir, limit: number,
): Promise<string[]> {
  const probes = await db.check.findMany({
    where,
    select: {
      id: true, checkNumber: true, apvNumbers: true, releasedAt: true, statedReleaseDate: true,
      cashAccount: { select: { code: true } },
      checkBook: { select: { code: true } },
      bills: { select: { apvNumber: true, poNumber: true } },
    },
  })
  // PO NUMBER sorts by the first PO SHOWN, Acumatica's included, so the index
  // is loaded over every matching cheque's displayed APVs — one query.
  const acumatica = key === 'poNumbers'
    ? await loadAcumaticaPoIndex(db, probes.flatMap((p) => displayApvNumbers(p)))
    : NO_ACUMATICA_POS
  return probes
    .map((p) => ({ id: p.id, checkNumber: p.checkNumber, value: appSortValue(key, p, acumatica) }))
    .sort((a, b) =>
      compareSortValues(a.value, b.value, dir) || byCodeUnit(a.checkNumber, b.checkNumber) || byCodeUnit(a.id, b.id))
    .slice(0, limit)
    .map((p) => p.id)
}

/** What `displayPoNumbers` reads from a row. */
type PoSource = { apvNumbers: string[]; bills: { apvNumber: string; poNumber: string | null }[] }

/**
 * Each row with its PO NUMBER cell computed: ONE query for the AcumaticaBill
 * rows of every APV on the page. `toTableRow` copies it, so the list, Excel
 * and print show the same value from the same function.
 */
async function withPoNumbers<R extends PoSource>(db: Db, rows: R[]): Promise<(R & { poNumbers: string[] })[]> {
  const acumatica = await loadAcumaticaPoIndex(db, rows.flatMap((r) => displayApvNumbers(r)))
  return rows.map((r) => ({ ...r, poNumbers: displayPoNumbers(r, acumatica) }))
}

/**
 * The LIST screen's rows, ordered by `sort` over EVERY matching cheque before
 * the limit is applied. Nulls go last in both directions (`dbOrderBy`, and
 * `compareSortValues` for the in-app keys), and it is not cosmetic.
 *
 * Postgres sorts NULLs FIRST on a descending sort. `checkDate` is nullable
 * — 38 live cheques carry no date — so a plain `{ checkDate: 'desc' }` put
 * every one of them at the top and the dashboard opened on a first screen
 * of nothing but em dashes, with the cheques Finance actually has to act on
 * pushed below the fold. Pinned by test in tests/queries.test.ts.
 */
export async function listChecks(db: Db, filters: CheckFilters, limit = 200, sort: SortSpec = DEFAULT_SORT) {
  const where = await whereFor(db, filters)
  const { key, dir } = sort
  if (!isAppSorted(key)) {
    return withPoNumbers(
      db,
      await db.check.findMany({ where, include: CHECK_ROW_INCLUDE, orderBy: dbOrderBy(key, dir), take: limit }),
    )
  }
  const ids = await appSortedIds(db, where, key, dir, limit)
  const rows = await db.check.findMany({ where: { id: { in: ids } }, include: CHECK_ROW_INCLUDE })
  const position = new Map(ids.map((id, i) => [id, i]))
  return withPoNumbers(db, rows.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0)))
}

// Companion to `listChecks`: the number of rows the same filters match, ignoring
// the display limit. The table needs this to say "SHOWING 200 OF 12,264" rather
// than silently truncating under a summary card reporting the full count.
export async function countChecks(db: Db, filters: CheckFilters): Promise<number> {
  return db.check.count({ where: await whereFor(db, filters) })
}

/**
 * The values the filter bar's dropdowns offer, read from the database.
 *
 * Loaded, never hardcoded: a ninth company or a seventh cash account has to
 * appear on the filter bar without a code change, and a hardcoded list would
 * quietly stop offering whatever was added last.
 *
 * The shape is plain strings only — this is rendered by a server component but
 * is also the set an id is validated against, and keeping it serialisable means
 * it can cross to the browser unchanged if the filter bar ever becomes
 * interactive.
 */
export type CompanyOption = { id: string; code: string; name: string }
export type CashAccountOption = { id: string; code: string; bankCode: string }
export type FilterOptions = { companies: CompanyOption[]; cashAccounts: CashAccountOption[] }

export async function getFilterOptions(db: Db): Promise<FilterOptions> {
  const [companies, books, cashAccounts] = await Promise.all([
    db.company.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } }),
    db.checkBook.findMany({
      orderBy: { code: 'asc' },
      select: { id: true, code: true, bank: { select: { code: true } } },
    }),
    db.cashAccount.findMany({
      orderBy: { code: 'asc' },
      select: { id: true, code: true, bank: { select: { code: true } } },
    }),
  ])
  // The cheque books first (Acumatica's accounts), then the register's labels,
  // which match only cheques with no book (`accountWhere`).
  return {
    companies,
    cashAccounts: [...books, ...cashAccounts].map((a) => ({ id: a.id, code: a.code, bankCode: a.bank.code })),
  }
}

/**
 * Every status on the ladder, assembled from the two lists that already
 * partition it rather than restated. `lib/domain/check-status.ts` carries a
 * compile-time proof that LIVE and CLOSED cover `CheckStatus` exactly once
 * each, so this can neither miss a status nor offer one twice.
 */
export const ALL_STATUSES: readonly CheckStatus[] = [...LIVE_STATUSES, ...CLOSED_STATUSES]

export { ELIGIBILITIES }

/**
 * The URL parameter validators.
 *
 * Every one of these answers `undefined` for a value it does not recognise,
 * which `buildWhere` reads as "do not filter on this". That is deliberate and
 * is the behaviour `status` already had: a hand-edited or stale bookmarked link
 * must open the dashboard unfiltered rather than hand Prisma an invalid enum
 * value and 500 the page. Never widen these to a cast.
 */
export function parseStatusParam(value: string | undefined): CheckStatus | undefined {
  return value && (ALL_STATUSES as readonly string[]).includes(value)
    ? (value as CheckStatus)
    : undefined
}

export function parseEligibilityParam(value: string | undefined): Eligibility | undefined {
  return value && (ELIGIBILITIES as readonly string[]).includes(value)
    ? (value as Eligibility)
    : undefined
}

/**
 * A company or cash account id, checked against the rows actually loaded from
 * the database. Unlike a status this could not crash Prisma — any string is a
 * legal id — but an unrecognised one returns a silently empty table that reads
 * as "there are no cheques" rather than "that filter no longer exists".
 */
export function parseOptionId(
  value: string | undefined,
  options: readonly { id: string }[],
): string | undefined {
  return value && options.some((o) => o.id === value) ? value : undefined
}

export type CheckRow = Awaited<ReturnType<typeof listChecks>>[number]

/**
 * The dashboard table's row, as it crosses into the browser.
 *
 * The table is a client component (it holds the tick-box selection), and a
 * `CheckRow` cannot cross that boundary: `amount` is a `Prisma.Decimal`, a class
 * instance, and React refuses to serialise one — "only plain objects can be
 * passed to Client Components". Every bill carries a Decimal too.
 *
 * So the amount crosses as a DECIMAL STRING, which is what rule 8 requires
 * anyway: never a JS number, because a float round-trip loses centavos. `Date`
 * survives serialisation intact and is left alone.
 *
 * Narrow on purpose. A whole `Check` row carries fields the table never shows —
 * cancellation reasons, portal sync state, source sheet and row — and shipping
 * them to the browser puts them in the page source of a screen anyone in
 * Finance can leave open on a shared machine.
 */
export type CheckTableRow = {
  id: string
  checkNumber: string
  apvNumbers: string[]
  poNumbers: string[]
  payeeName: string | null
  companyCode: string
  /**
   * The BANK column. `cashAccountCode` is the label Finance uses out loud
   * ("BPI STK"); `bankCode` is the institution behind it. Both are plain
   * strings or null — NOT the `CashAccount` or `Bank` model instance, which is
   * a class and would throw at the server/client boundary. Null because
   * `Check.cashAccountId` is nullable, and an empty string would read as an
   * account whose code is blank.
   */
  cashAccountCode: string | null
  bankCode: string | null
  checkDate: Date | null
  amount: string | null
  currency: string
  status: CheckStatus
  eligibility: Eligibility
  isCheque: boolean
  /** Finance marked it STALED (2026-10-06); shown as a tag beside the status. */
  isStale: boolean
  availablePickupDate: Date | null
  scheduledPickupDate: Date | null
  /** When the release was recorded here; null for every release that was not. */
  releasedAt: Date | null
  /** The register's stated release day, when the app recorded no release. Shown tagged REGISTER. */
  statedReleaseDate: Date | null
  /**
   * The supplier's receipt (rule 11: never `crNumber`). Shown in the OR column,
   * and `hasReceipt` decides whether a RELEASED row may be ticked to add one:
   * a receipt is never overwritten.
   */
  orNumber: string | null
  receiptType: ReceiptType | null
  hasReceipt: boolean
}

/**
 * What the APV NUMBER cell shows: the cheque's own vouchers and its bills',
 * deduplicated and ordered. One definition, because the sort orders by the
 * first value SHOWN — a second copy would sort by something nobody can see.
 *
 * Both sources, folded into one list. `Check.apvNumbers` is what the register
 * states — 11,552 of its 11,779 cheque numbers carry at least one — and
 * `bills` is the approval-for-release workbook's per-bill ledger, which covers
 * 85 rows of one day's working list. They overlap where a cheque is on both,
 * and a cheque is usually on only one, so showing either alone leaves the
 * column empty for most of the register. Every bill, not just the first:
 * search matches APV across all of them, and showing one arbitrary bill would
 * display a different APV than the one the user searched for.
 */
export function displayApvNumbers(r: { apvNumbers: string[]; bills: { apvNumber: string }[] }): string[] {
  return [...new Set([...r.apvNumbers, ...r.bills.map((b) => b.apvNumber)])].sort()
}

/**
 * What the PO NUMBER cell shows: the approval workbook's Vendor Ref on each
 * bill (`CheckBill.poNumber`) and every real PO Acumatica's AP-Bills and
 * Adjustments names for an APV the cheque SHOWS (`displayApvNumbers`;
 * `AcumaticaBill`, spec 2026-10-05), de-duplicated and sorted. The ONE
 * definition: the list, Excel and print read it through `listChecks`, the
 * PO sort reads its first value, and the PO filter box and the search match
 * the same two sources (`acumaticaPoMatch`). `Check` has no PO column.
 */
export function displayPoNumbers(r: PoSource, acumatica: AcumaticaPoIndex): string[] {
  const fromBills = r.bills.map((b) => b.poNumber).filter((p): p is string => p !== null)
  const fromAcumatica = displayApvNumbers(r).flatMap((apv) => acumatica.get(apv) ?? [])
  return [...new Set([...fromBills, ...fromAcumatica])].sort()
}

export function toTableRow(r: CheckRow): CheckTableRow {
  return {
    id: r.id,
    checkNumber: r.checkNumber,
    apvNumbers: displayApvNumbers(r),
    // Computed by listChecks through displayPoNumbers (one AcumaticaBill query per page).
    poNumbers: r.poNumbers,
    payeeName: r.payeeName,
    companyCode: r.company.code,
    // `?? null`, so a cheque with no cash account says so rather than crossing
    // the boundary as `undefined` and rendering as a gap indistinguishable from
    // a rendering fault.
    // The account: the cheque book, else the register label (`accountWhere`).
    cashAccountCode: r.checkBook?.code ?? r.cashAccount?.code ?? null,
    bankCode: r.checkBook?.bank.code ?? r.cashAccount?.bank.code ?? null,
    checkDate: r.checkDate,
    // `?.toString() ?? null`, never `Number(...)`: null is "no amount was
    // recorded" — 129 cheques in production — and it is not zero.
    amount: r.amount?.toString() ?? null,
    currency: r.currency,
    status: r.status,
    eligibility: r.eligibility,
    isCheque: r.isCheque,
    isStale: r.isStale,
    availablePickupDate: r.availablePickupDate,
    scheduledPickupDate: r.scheduledPickupDate,
    releasedAt: r.releasedAt,
    statedReleaseDate: r.statedReleaseDate,
    orNumber: r.orNumber,
    receiptType: r.receiptType,
    hasReceipt: r.orNumber !== null,
  }
}

/**
 * The cheques with these ids, in the list's row shape (PO numbers resolved the
 * same way), in no particular order. For a caller that holds a hand-picked set —
 * the transmittal — rather than a filter.
 */
export async function listChecksByIds(db: Db, ids: readonly string[]) {
  if (ids.length === 0) return []
  return withPoNumbers(db, await db.check.findMany({ where: { id: { in: [...ids] } }, include: CHECK_ROW_INCLUDE }))
}
