import type { CheckStatus } from '@prisma/client'
import { LIVE_STATUSES } from './domain/check-status'
import type { SortSpec } from './list-sort'

/**
 * The dashboard's filtering model, as URL arithmetic.
 *
 * Pure: no database, no DOM, no `window`. Every card on the dashboard is a link
 * to a URL, so what each card does — and which one is lit — is decided here and
 * tested without rendering anything.
 *
 * THE MODEL (client decision, 2026-09-06). The summary cards are not a shortcut
 * to a dropdown; they are the VIEW SELECTOR — which set of cheques you are
 * looking at. The dropdowns on the filter bar then NARROW WITHIN the selected
 * view. There used to be a STATUS dropdown as well as the cards, both writing
 * `?status=`, and a NEEDS ACTION / ALL CHEQUES pair of tabs duplicating TOTAL
 * CHECKS: two controls for one thing, twice over.
 *
 * There are three views and one toggle:
 *
 *   NEEDS ACTION   the default, with no card selected. `LIVE_STATUSES` only.
 *   a status       one rung of the ladder; READY FOR RELEASE folds in SCHEDULED.
 *   ALL CHEQUES    the ALL CHECKS card. Every status, narrowed like any other view.
 *   INCOMPLETE     a toggle that COMPOSES with whichever view is selected.
 *
 * THE INCOMPLETE TOGGLE IS NOW OFF BY DEFAULT AND MEANS "EXCLUDE" (client
 * decision, 2026-09-06): `incomplete: false` hides the 129 cheques with no
 * recorded amount from the counts and the table, `incomplete: true` shows only
 * them. It stopped being a CARD in the same change — the client asked for the
 * card to go — but it is still a toggle in the URL, `?incomplete=1` still opens
 * exactly what it always did, and `incompleteHref` below is the link the
 * dashboard prints above the table so the exclusion is never silent.
 *
 * NEEDS ACTION stays the default deliberately. Production holds 9,287 cheques,
 * 7,433 of them RELEASED; opening on everything buries the cheques somebody has
 * to act on today under eight thousand nobody will touch again, and the row
 * limit means the live ones may not even be on the first page. Removing the
 * scope tabs removed the control, not the default — `describeView` exists so
 * the default is stated on screen rather than silently applied.
 *
 * The URL parameters are unchanged (`status`, `scope=all`, `incomplete=1`), so
 * a bookmark saved before this change still opens the view it named.
 */

/** The statuses the READY FOR RELEASE card and view cover. */
const AVAILABLE = ['READY_FOR_RELEASE', 'SCHEDULED'] as const satisfies readonly CheckStatus[]

/**
 * The cards that select a view, plus the one that does not.
 *
 * TOTAL VALUE is absent: it is not clickable, and giving it an id here
 * would invite a future edit to make it one.
 */
export const VIEW_CARDS = [
  'READY_FOR_RELEASE', 'SIGNATURE_PENDING', 'SIGNED', 'RELEASED', 'TOTAL_CHECKS',
  /**
   * GENERATED has no card of its own and is not meant to get one — the PENDING
   * SIGNATURE card counts it, because to Finance a freshly generated cheque is
   * a cheque waiting to be signed.
   *
   * It is a VIEW nonetheless: the release timeline shows the rung separately,
   * since a node's count has to be the number of rows its link opens and
   * `?status=SIGNATURE_PENDING` opens only the SIGNATURE_PENDING rows. Listing
   * it here means the timeline links through `cardHref` like every card does,
   * rather than concatenating a URL of its own.
   */
  'GENERATED',
  // The two dead rungs, reached from the STATUS dropdown (client, 2026-10-06).
  'CANCELLED', 'VOIDED',
] as const satisfies readonly string[]

export type ViewCardId = (typeof VIEW_CARDS)[number]
/**
 * There is no `'INCOMPLETE'` member any more. It was one, back when the
 * dashboard had an INCOMPLETE card; the card is gone (client decision,
 * 2026-09-06) and the toggle it wrote is reached through `incompleteHref`
 * instead. Leaving a card id for a card that does not exist would have kept
 * `isCardSelected` and `cardHref` carrying a branch nothing calls.
 */
export type CardId = ViewCardId

/**
 * What the dashboard is currently showing, as the page read it back from the
 * validated URL parameters.
 *
 * `base` holds the filters that are NOT part of the view and that a card must
 * therefore never throw away: the search box, the company and cash-account
 * dropdowns, the eligibility. Before this existed, every card linked to an
 * absolute URL, so narrowing to one company and then clicking SIGNED silently
 * dropped the company and widened the table.
 *
 * `status` is already validated by `parseStatusParam` — an unrecognised value
 * arrives here as null, never as a string this module would pass on.
 */
export type DashboardSelection = {
  status: CheckStatus | null
  showAll: boolean
  incomplete: boolean
  /**
   * `scope=live`: the NEEDS ACTION list asked for AS A LIST.
   *
   * NEEDS ACTION has no card, and since 2026-09-29 the TOTALS screen has the
   * company, bank and eligibility dropdowns too, so `/?company=c1` is the
   * totals for one company and no longer the list. The list's filter bar
   * carries this marker on the NEEDS ACTION view — exactly as it carries
   * `status` or `scope=all` on every other — so that clearing the search and
   * choosing a company keeps the reader on the list they were reading.
   *
   * It changes no filter: `viewStatusFilter` never reads it, and
   * `describeView` says what it says. `status` and `scope=all` win over it.
   */
  live: boolean
  /**
   * The order the URL asked for (`sort` + `dir`), and ONLY that — absent when
   * the URL names none, even if the `cm_sort` cookie supplied one. A cookie
   * sort never enters a link; the export and print read the cookie
   * themselves. Optional so the many literal selections in tests stay valid.
   */
  sort?: SortSpec
  base: Readonly<Record<string, string>>
}

type ViewState = Pick<DashboardSelection, 'status' | 'showAll'>
type LinkState = ViewState & { incomplete: boolean; live?: boolean; confirmRelease?: boolean; confirmSign?: boolean; sort?: SortSpec | null }

/**
 * A dashboard URL. `base` first so the narrowing filters keep a stable order,
 * then the view, then the toggle. An empty query string becomes `/` rather than
 * `/?`.
 */
function query(base: Readonly<Record<string, string>>, view: LinkState): string {
  const qs = new URLSearchParams(base)
  if (view.status) qs.set('status', view.status)
  if (view.showAll) qs.set('scope', 'all')
  // The NEEDS ACTION list, said out loud — only when nothing else already
  // opens the list. `status` and `scope=all` win.
  else if (view.live && !view.status) qs.set('scope', 'live')
  if (view.incomplete) qs.set('incomplete', '1')
  if (view.sort) { qs.set('sort', view.sort.key); qs.set('dir', view.sort.dir) }
  // Only ever set by `releaseConfirmHref`. Every other caller omits it, which is
  // how choosing a card or clearing the filters also steps back out of a
  // half-made release rather than carrying the confirmation along.
  if (view.confirmRelease) qs.set('confirm', 'release')
  if (view.confirmSign) qs.set('confirm', 'sign')
  return qs.toString()
}

function href(base: Readonly<Record<string, string>>, view: LinkState): string {
  const s = query(base, view)
  return s ? `/?${s}` : '/'
}

/** NEEDS ACTION: the view a deselected card falls back to. */
const NEEDS_ACTION: ViewState = { status: null, showAll: false }

export function isCardSelected(card: CardId, sel: DashboardSelection): boolean {
  // ALL CHECKS (`TOTAL_CHECKS`, labelled TOTAL CHECKS until 2026-09-29) is the
  // absence of a status, so it must not light up beside a status card that is
  // also on.
  if (card === 'TOTAL_CHECKS') return sel.showAll && sel.status === null
  return sel.status === card
}

/**
 * Where a card points.
 *
 * A selected view card links back to the NEEDS ACTION list, so clicking it
 * again turns it off: a filter you can switch on and cannot switch off sends
 * people to the browser's Back button to undo a click they just made.
 *
 * ALL CHECKS (`TOTAL_CHECKS`) is no longer an exception on the way in. It used
 * to clear the search, the dropdowns and the incomplete toggle — "show me
 * everything, start again". Since 2026-09-29 it is the cheque inventory: every
 * status, narrowed by whatever the reader chose, so "every cheque STK holds at
 * BPI" is one click. RESET on the filter bar is what clears.
 */
export function cardHref(card: CardId, sel: DashboardSelection): string {
  const selected = isCardSelected(card, sel)

  // A deselected card lands on the NEEDS ACTION LIST, not on the totals: the
  // reader was looking at a table and clicked to widen it, not to leave it.
  if (selected) return href(sel.base, { ...NEEDS_ACTION, incomplete: sel.incomplete, live: true, sort: sel.sort })

  if (card === 'TOTAL_CHECKS') return href(sel.base, { status: null, showAll: true, incomplete: sel.incomplete, sort: sel.sort })

  return href(sel.base, { status: card, showAll: false, incomplete: sel.incomplete, sort: sel.sort })
}

/**
 * The INCOMPLETE toggle, as a link. What the removed card's href used to be.
 *
 * A toggle, not a view, so it keeps whichever view is selected in BOTH
 * directions: from the default dashboard it opens `?incomplete=1`, the 129
 * cheques with no recorded amount that the counts and the table now leave out;
 * from there it goes back to the view without them.
 *
 * This is the link the dashboard prints beside its exclusion notice, and it is
 * why hiding those cheques is a decision the reader can see and undo rather than
 * a number that quietly got smaller.
 */
export function incompleteHref(sel: DashboardSelection): string {
  // Both directions of this link open a LIST — the incomplete toggle itself is
  // one, and coming back out of it lands on the view being read. On NEEDS ACTION
  // that view has no parameter of its own, so the URL left after switching the
  // toggle off could be a bare `/?company=c1`, which since 2026-09-29 is the
  // TOTALS for one company. `live` writes `scope=live` there (review, 2026-09-29).
  return href(sel.base, {
    status: sel.status, showAll: sel.showAll, incomplete: !sel.incomplete,
    live: sel.live || (!sel.status && !sel.showAll), sort: sel.sort,
  })
}

/**
 * CLEAR FILTERS on the filter bar: drop everything the bar controls and keep
 * the view being read. It is not a link to `/` — clearing a search should not
 * also throw the user back to a different set of cheques.
 */
// RESET also drops the sort; the button deletes the remembered one too — components/ResetLink.tsx.
export function clearFiltersHref(sel: DashboardSelection): string {
  // RESET sits on the list's filter bar, so what it leaves must still be the
  // list: on NEEDS ACTION, with every filter gone, that is a bare `/` — the
  // TOTALS — unless `scope=live` says otherwise (review, 2026-09-29).
  return href({}, {
    status: sel.status, showAll: sel.showAll, incomplete: false,
    live: sel.live || (!sel.status && !sel.showAll),
  })
}

/** The three filters the TOTALS screen reads. Exactly these keep a URL on TOTALS. */
export const TOTALS_KEYS = ['company', 'cashAccount', 'eligibility'] as const

/**
 * BACK TO TOTALS: the totals for the company, bank and eligibility the reader
 * chose, and nothing else — no view, no search, no incomplete toggle, no
 * `scope=live`. Narrowing to STK, opening SIGNED and coming back must land on
 * STK's totals, or every round trip loses the filter the reader just chose.
 */
export function totalsHref(sel: DashboardSelection): string {
  const base = Object.fromEntries(
    Object.entries(sel.base).filter(([k]) => (TOTALS_KEYS as readonly string[]).includes(k)),
  )
  return href(base, { status: null, showAll: false, incomplete: false })
}

/**
 * The anchor TODAY'S RELEASE is rendered under, so stepping into and out of the
 * confirmation returns the reader to the panel rather than to the top of a page
 * they have already scrolled past.
 */
export const TODAYS_RELEASE_ANCHOR = 'todays-release'

/**
 * RELEASE ALL's confirmation step, as a URL.
 *
 * Server-rendered, deliberately. The alternative — a `confirm()` dialog — is a
 * control that exists only once the bundle has loaded, on the one action in the
 * system that hands money over; and the whole page is server-rendered already.
 * The view and the narrowing filters are carried along, so cancelling puts the
 * reader back exactly where they were.
 */
export function releaseConfirmHref(sel: DashboardSelection): string {
  const url = href(sel.base, {
    status: sel.status, showAll: sel.showAll, incomplete: sel.incomplete, confirmRelease: true,
  })
  return `${url}#${TODAYS_RELEASE_ANCHOR}`
}

/** CANCEL: the same view, with the confirmation dropped. */
export function releaseCancelHref(sel: DashboardSelection): string {
  const url = href(sel.base, {
    status: sel.status, showAll: sel.showAll, incomplete: sel.incomplete,
  })
  return `${url}#${TODAYS_RELEASE_ANCHOR}`
}

export const EXPORT_PATH = '/api/export'

/**
 * EXPORT TO EXCEL, as a URL.
 *
 * The SAME parameters the dashboard is reading, so the file holds exactly what
 * is on screen — the view, the search, the dropdowns and the incomplete toggle.
 * Built here rather than in the page for the reason every other link on this
 * screen is: one function decides what a dashboard URL means, and the export
 * cannot drift from the table it claims to be a copy of.
 *
 * `confirm` is deliberately not carried. A half-made release is a state of the
 * screen, not of the data, and it has no business in a filename or a file.
 */
export function exportHref(sel: DashboardSelection): string {
  const s = query(sel.base, {
    status: sel.status, showAll: sel.showAll, incomplete: sel.incomplete, live: sel.live, sort: sel.sort,
  })
  return s ? `${EXPORT_PATH}?${s}` : EXPORT_PATH
}

/**
 * The dashboard URL for the selection as it stands — no card toggled, nothing
 * cleared. The way back from a page that was opened FROM the dashboard, so the
 * reader lands on the view they left rather than on `/` or on whatever the
 * Back button happens to hold.
 */
export function dashboardHref(sel: DashboardSelection): string {
  return href(sel.base, {
    status: sel.status, showAll: sel.showAll, incomplete: sel.incomplete, live: sel.live, sort: sel.sort,
  })
}

export const PRINT_PATH = '/print'

/**
 * PRINT RELEASE LIST, as a URL.
 *
 * The SAME parameters the dashboard is reading, for the same reason
 * `exportHref` carries them: a sheet somebody prints and walks to the vault
 * with has to hold exactly the cheques that were on screen when they pressed
 * the link. Two parsers that agreed today would drift the first time a filter
 * was added to one of them.
 *
 * `confirm` is not carried, exactly as the export does not carry it: a
 * half-made release is a state of the screen, not of the data, and it has no
 * business on a piece of paper.
 */
export function printHref(sel: DashboardSelection): string {
  const s = query(sel.base, {
    status: sel.status, showAll: sel.showAll, incomplete: sel.incomplete, live: sel.live, sort: sel.sort,
  })
  return s ? `${PRINT_PATH}?${s}` : PRINT_PATH
}

/**
 * The status filter the selected view implies, in the shape `CheckFilters`
 * wants. `status` and `statusIn` are both returned so a caller cannot forget
 * one and leave a stale value behind.
 */
export function viewStatusFilter(view: ViewState): {
  status: CheckStatus | undefined
  statusIn: readonly CheckStatus[] | undefined
} {
  /**
   * READY FOR RELEASE means both rungs. To Finance the cheque is available and
   * waiting to be handed over; whether a supplier has booked a pickup slot in
   * the portal is a detail, not a separate queue. The card counts both, and the
   * filter has to agree — a card reading 406 that opens a table of 396 is a bug
   * report waiting to happen.
   */
  if (view.status === 'READY_FOR_RELEASE') return { status: undefined, statusIn: AVAILABLE }
  // An explicit status wins over the NEEDS ACTION default, including RELEASED,
  // which the live list excludes.
  if (view.status) return { status: view.status, statusIn: undefined }
  if (view.showAll) return { status: undefined, statusIn: undefined }
  return { status: undefined, statusIn: LIVE_STATUSES }
}

const words = (s: string) => s.replace(/_/g, ' ')

/**
 * The line above the table: which view is active, in words.
 *
 * The scope tabs used to say this. They are gone, and the default they carried
 * is not — so it is stated here instead of applied silently. The live statuses
 * are read from `LIVE_STATUSES` rather than restated: a ninth live status must
 * not be filtered in while going unmentioned.
 *
 * The OTHER default this line does not carry is the exclusion of the cheques
 * with no recorded amount. That one needs a count and a link, and this function
 * is pure — so `app/page.tsx` prints it immediately beneath, off
 * `summary.incomplete` and `incompleteHref`. It is not optional there: it is the
 * price of hiding them. This function still names the toggle when it is ON,
 * because SIGNED + INCOMPLETE is a narrower set than either.
 */
export function describeView(sel: DashboardSelection): string {
  const view = sel.status === 'READY_FOR_RELEASE'
    ? 'READY FOR RELEASE — INCLUDING SCHEDULED'
    : sel.status
      ? words(sel.status)
      : sel.showAll
        ? 'ALL CHECKS — EVERY STATUS, INCLUDING RELEASED, CANCELLED AND VOIDED'
        : `NEEDS ACTION — ${LIVE_STATUSES.map(words).join(', ')}`

  // The toggle is named alongside the view, never instead of it: SIGNED +
  // INCOMPLETE is a narrower set than either, and a reader who sees only one of
  // the two has no way to explain the row count.
  return sel.incomplete ? `${view} + INCOMPLETE (NO AMOUNT)` : view
}

/**
 * Which of the dashboard's two screens a URL opens (client, 2026-09-25: "just
 * only show the totals. Once it is click, it will only the list so i can have
 * more space").
 *
 * The URL IS the screen. A bare `/` is the TOTALS, and so — since 2026-09-29,
 * "should have filter in every summary" — is a URL that carries only the
 * company, bank or eligibility (`TOTALS_KEYS`): those three dropdowns now sit
 * above the cards and narrow the whole screen. A card, `scope=all`, the
 * incomplete toggle, the list's own `scope=live` marker, and ANY other `base`
 * key (the search, a DATE RELEASED range, whatever is added next) opens the
 * LIST. It fails closed on purpose: a filter the TOTALS screen does not read
 * must not render as totals it silently does not narrow. `base` is only ever
 * built from validated, non-empty values (`resolveDashboardQuery`), so an
 * empty search box does not count as one. A `sort` on the URL is a LIST
 * parameter too: the TOTALS screen does not sort.
 */
export type DashboardScreen = 'TOTALS' | 'LIST'

export function dashboardScreen(sel: DashboardSelection): DashboardScreen {
  const listed = sel.status !== null || sel.showAll || sel.incomplete || sel.live || sel.sort !== undefined
    || Object.keys(sel.base).some((k) => !(TOTALS_KEYS as readonly string[]).includes(k))
  return listed ? 'LIST' : 'TOTALS'
}

/**
 * Whether the list offers SIGN ALL. Only when the rows shown are exactly the
 * set it would act on: the SIGNATURE PENDING view (not ALL CHEQUES, not another
 * status), no search and the incomplete toggle off — its set takes the column
 * filters (part C2) but neither of those — and never while a box is refused,
 * because a refused list shows nothing and a count beside it would be a count
 * of a set nobody can see.
 */
export function signAllOffered(v: {
  status: CheckStatus | null | undefined
  showAll: boolean
  q: string | null | undefined
  incomplete: boolean
  refused: boolean
}): boolean {
  return v.status === 'SIGNATURE_PENDING' && !v.showAll && !v.q && !v.incomplete && !v.refused
}

/** SIGN ALL's confirmation: the same list, with `confirm=sign`. */
export function signAllConfirmHref(sel: DashboardSelection): string {
  return href(sel.base, { status: sel.status, showAll: sel.showAll, incomplete: sel.incomplete, confirmSign: true, sort: sel.sort })
}

/** CANCEL: the same list, confirmation dropped. */
export function signAllCancelHref(sel: DashboardSelection): string {
  return href(sel.base, { status: sel.status, showAll: sel.showAll, incomplete: sel.incomplete, sort: sel.sort })
}
