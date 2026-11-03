import Link from 'next/link'
import { cookies } from 'next/headers'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import {
  getSummary, getTodaysRelease, getPendingSignature, listChecks, countChecks, toTableRow, getFilterOptions,
  columnFilterFields, type ColumnFilters,
} from '@/lib/queries'
import { resolveDashboardQuery, type RawDashboardSearchParams } from '@/lib/dashboard-params'
import { SORT_COOKIE } from '@/lib/list-sort'
import { columnParamsOf } from '@/lib/column-filters'
import {
  clearFiltersHref, dashboardScreen, describeView, incompleteHref,
  cardHref, releaseConfirmHref, releaseCancelHref, signAllConfirmHref, signAllCancelHref, totalsHref,
  signAllOffered as isSignAllOffered,
} from '@/lib/dashboard-view'
import { AppHeader } from '@/components/AppHeader'
import { TotalsFilterBar } from '@/components/TotalsFilterBar'
import { StatusSelect } from '@/components/StatusSelect'
import { buildStatusOptions } from '@/lib/status-options'
import { WorkflowRow } from '@/components/WorkflowRow'
import { TodaysReleasePanel } from '@/components/TodaysReleasePanel'
import { DashboardHero } from '@/components/DashboardHero'
import { ConfirmAllForm } from '@/components/ConfirmAllForm'
import { signAllPendingAction } from '@/app/checks/bulk-actions'
import { QuickActions } from '@/components/QuickActions'
import { FilterBar } from '@/components/FilterBar'
import { CheckTable } from '@/components/CheckTable'
import { getSyncOverview } from '@/lib/admin/sync-overview'
import { describeStaleness } from '@/lib/sync/staleness'
import { SyncStatusLine } from '@/components/SyncStatusLine'
import { DashboardSyncControls } from '@/components/DashboardSyncControls'
import { loadSettings } from '@/lib/settings/read'
import { formatMoney } from '@/lib/money'

/**
 * THE DASHBOARD.
 *
 * ── THE ORDER OF THIS PAGE (client brief, 2026-09-06) ─────────────────────
 * "Everything has the same weight, so users don't immediately know what needs
 * to be released today. Since this is an internal finance tool, I'd design it
 * around action first, data second."
 *
 * So the screen is ordered by what it has to answer, and the first three
 * answers are on it before anything is scrolled:
 *
 *   1  KPI ROW          what is ready, what is signed and waiting, what is with
 *                       a signatory, what is in the inventory, what is it all
 *                       worth. Five cards — INCOMPLETE was removed on
 *                       2026-09-06 and ALL CHECKS moved up on 2026-09-29.
 *   2  TODAY'S RELEASE  the action itself, and the only control that hands
 *                       money over.
 *   3  RELEASE TIMELINE where the queue is jammed — 1,034 on SIGNED beside 80
 *                       on READY is the fact no single card states.
 *   4  the secondary row, the quick actions, the filters, the table.
 *
 * RELEASED (9,545) is the largest number in the system and the least
 * actionable. It is the RELEASED step of `WorkflowRow` —
 * still a clickable view, because the cards ARE the view selector and that model
 * has not changed. ALL CHECKS (labelled TOTAL CHECKS until 2026-09-29) is not
 * demoted any more: it is the cheque inventory, and sits in the primary row.
 *
 * ── TWO SCREENS (client, 2026-09-25) ──────────────────────────────────────
 * "Just only show the totals. Once it is click, it will only the list so i
 * can have more space." A bare `/` renders TOTALS — the KPI row, TODAY'S
 * RELEASE, the timeline and a search box. Since 2026-09-29 the TOTALS screen
 * has its own COMPANY / BANK / ELIGIBILITY dropdowns, and those three narrow
 * every figure on it without leaving it. Choosing a card, a timeline node, a
 * search or any other filter writes a parameter that switches the page to
 * LIST — the full-width table with its filter bar, quick actions and export.
 * `dashboardScreen` is the one place that reads the resolved selection and says
 * which screen a URL is; neither screen loads the other's data.
 * ──────────────────────────────────────────────────────────────────────────
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<RawDashboardSearchParams & {
    /**
     * TODAY'S RELEASE's confirmation step. It lives in the URL rather than in a
     * `confirm()` dialog so the step exists before any JavaScript does — on the
     * one action in this system that hands money over.
     */
    confirm?: string | string[]
  }>
}) {
  const user = await requireUser()
  const params = await searchParams

  // The dropdown options and the settings do not depend on the URL, so they
  // are fetched first; the summary does, since 2026-09-29 ("should have filter
  // in every summary"), so it is fetched once the URL is resolved below — in
  // the same `Promise.all` as the rest of the screen's queries, not on its own.
  // `settings` rides along so the sync overview's thresholds, and everything
  // below that reads a setting, come from the same read every screen shares
  // rather than a hard-coded default nobody can change.
  const [options, settings] = await Promise.all([
    getFilterOptions(prisma),
    loadSettings(prisma),
  ])

  /**
   * Every URL parameter is validated, the view is resolved and the filters are
   * assembled — all of it in `resolveDashboardQuery`, which is the ONE place
   * that turns a dashboard URL into a query.
   *
   * It lives outside this file because `app/api/export/route.ts` and
   * `app/print/page.tsx` run it too. The Excel export and the printed sheet
   * have to hold exactly what the reader is looking at, and the only way to
   * guarantee that is for all three to run the same code: a second parser that
   * agreed today would drift the first time a filter is added to one of them.
   *
   * The company and cash account ids are checked against the options loaded
   * above — the same list the dropdowns render, so the two cannot disagree
   * about what is selectable.
   *
   * The cards share THREE narrowings with the table — company, bank and
   * eligibility (client request 2026-09-29) — and the exclusion of the cheques
   * with no recorded amount. They do NOT share the view, the search or the
   * incomplete toggle: those open the list. `getSummary` applies the
   * exclusion itself, `buildWhere` applies it for the table, and a PENDING
   * SIGNATURE card whose table opened five rows short is the drift that would
   * otherwise appear the moment the table stopped showing them. The count that
   * is left out is printed on screen with a link that shows it.
   */
  // The remembered order (part C4): read here so the list opens on it with no
  // flicker. The export and print read the same cookie.
  const sortCookie = (await cookies()).get(SORT_COOKIE)?.value

  const {
    q, status, companyId, cashAccountId, eligibility, incomplete, showAll, selection, filters,
    narrowingDescription, sort, activeSort, columnValues, filterErrors, refused,
  } = resolveDashboardQuery(params, options, { sortCookie })

  const narrow = { companyId, cashAccountId, eligibility }

  const screen = dashboardScreen(selection)

  if (screen === 'TOTALS') {
    // The summary, TODAY'S RELEASE and the sync overview are the queries this
    // screen needs, run together; `listChecks` and `countChecks` belong to the
    // LIST screen and do not run here.
    const [summary, todaysRelease, syncOverview] = await Promise.all([
      // The cards and TODAY'S RELEASE narrow with the dropdowns; the sync
      // overview is system-wide.
      getSummary(prisma, narrow),
      getTodaysRelease(prisma, narrow),
      // Two cheap findFirsts per tenant on an indexed column, for the staleness
      // line below. It reads `settings` from the first fetch above.
      getSyncOverview(prisma, undefined, settings.values['sync.abandonedAfterMinutes']),
    ])

    const staleness = describeStaleness(
      // The latest run that finished with no failed row — `lastSuccess` — is the
      // read; a run that never reached the feed read nothing.
      syncOverview.tenants.map((t) => ({ tenant: t.tenant, lastReadAt: t.lastSuccess?.startedAt ?? null })),
      new Date(),
      settings.values['sync.staleAfterHours'],
    )

    return (
      <main className="space-y-4 px-4 py-5">
        <AppHeader user={user} title="CHECK RELEASE" />

        {/* When Acumatica was last read. Above the cards, because every number
            on them is only as current as this line says. */}
        <SyncStatusLine staleness={staleness} />
        <DashboardSyncControls />

        {/* The day's job, and the ONE place READY FOR RELEASE is shown. */}
        <DashboardHero
          name={user.name}
          todays={todaysRelease}
          readyHref={cardHref('READY_FOR_RELEASE', selection)}
          canRelease={user.role === 'FINANCE_ADMIN'}
          confirming={params.confirm === 'release'}
          confirmHref={releaseConfirmHref(selection)}
        />

        <TotalsFilterBar
          options={options}
          companyId={companyId ?? ''}
          cashAccountId={cashAccountId ?? ''}
          eligibility={eligibility ?? ''}
          description={narrowingDescription}
          statusOptions={buildStatusOptions(selection, { ...summary, total: summary.total })}
        />

        {/* ONE ROW, every figure once (2026-10-07, "this looks redundant"): the
            release ladder with each step linking to its list, READY carrying the
            day's money and RELEASE ALL, then ALL CHECKS and the no-amount
            disclosure as one line. Replaces the four cards, the RELEASED bar,
            the TODAY'S RELEASE panel and the RELEASE WORKFLOW strip. */}
        <WorkflowRow
          summary={summary}
          total={summary.total}
          incomplete={summary.incomplete}
          incompleteHref={incompleteHref(selection)}
          selection={selection}
        />

        {/* The confirmation step only: an exact string match, so an unrecognised
            value never guesses its way into a confirmation. Stays mounted while
            confirming so the "N OF N RELEASED" report survives the revalidation. */}
        {params.confirm === 'release' && (
          <TodaysReleasePanel
            todays={todaysRelease}
            canRelease={user.role === 'FINANCE_ADMIN'}
            confirming
            confirmHref={releaseConfirmHref(selection)}
            cancelHref={releaseCancelHref(selection)}
            narrow={{ company: companyId ?? '', cashAccount: cashAccountId ?? '', eligibility: eligibility ?? '' }}
          />
        )}

        {/* Finding one cheque by its number is the commonest reason to open the
            list, so the totals keep one box for it. It submits to `/?q=…`, which
            `dashboardScreen` reads as the LIST. */}
        <form action="/" method="get" className="flex max-w-xl items-center gap-2" role="search">
          {/* A search from a narrowed TOTALS opens a list narrowed the same way. */}
          {companyId && <input type="hidden" name="company" value={companyId} />}
          {cashAccountId && <input type="hidden" name="cashAccount" value={cashAccountId} />}
          {eligibility && <input type="hidden" name="eligibility" value={eligibility} />}
          <label htmlFor="totals-search" className="sr-only">Search checks</label>
          <input
            id="totals-search" name="q" type="search"
            placeholder="Search check no., payee, CV or AP voucher"
            className="w-full rounded-xl border border-hairline bg-white px-4 py-2.5 text-sm shadow-sm focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy"
          />
          <button type="submit" className="rounded-lg bg-navy px-4 py-2 text-sm font-semibold tracking-wide text-white">
            SEARCH
          </button>
        </form>
      </main>
    )
  }

  // LIST never loads TODAY'S RELEASE or the sync overview — that state belongs
  // to the totals screen, and this table has its own row counts to state. It
  // does not read the summary: the EXCLUDING N WITH NO RECORDED AMOUNT line
  // counts the cheques with no amount that this list's own filters match.
  //
  // With a DATE RELEASED range in force, a third count: the released cheques
  // in this same view that carry NO release instant and so cannot match any
  // range. Same filters, range removed, narrowed to RELEASED with a null
  // `releasedAt` — so the number is the number of rows the reader's own view
  // would have shown had those releases been recorded here.
  const releasedRange = Boolean(filters.releasedFrom || filters.releasedTo)
  // SIGN ALL is offered only when the rows shown are exactly the set it would
  // act on (`signAllOffered` in lib/dashboard-view.ts says when).
  const signAllOffered = isSignAllOffered({ status, showAll, q, incomplete, refused })
  // The column filters by name, plus the refusal on its own so the query
  // layer's defence applies here too: a refused box can only empty the count.
  const signColumns: ColumnFilters & { refused?: true } = {
    ...columnFilterFields(filters), ...(filters.refused ? { refused: true as const } : {}),
  }
  const [excludedIncomplete, rows, matching, undatedReleases, pendingSign] = await Promise.all([
    countChecks(prisma, { ...filters, incomplete: true }),
    listChecks(prisma, filters, 200, sort),
    countChecks(prisma, filters),
    releasedRange
      ? countChecks(prisma, {
          ...filters,
          releasedFrom: undefined,
          releasedTo: undefined,
          status: 'RELEASED',
          statusIn: undefined,
          noReleaseDate: true,
        })
      : Promise.resolve(0),
    signAllOffered ? getPendingSignature(prisma, narrow, signColumns) : Promise.resolve(null),
  ])

  return (
    <main className="space-y-4 px-4 py-5">
      <AppHeader user={user} title="CHECK RELEASE" />

      {/* The list gets the page (client, 2026-09-25): one slim bar says where
          you are and how to get back, and the export and print act on exactly
          what is listed below it. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 ring-1 ring-hairline">
        <div className="flex flex-wrap items-center gap-3">
          <Link href={totalsHref(selection)} className="text-sm font-semibold tracking-wide text-navy underline-offset-2 hover:underline">
            ← BACK TO TOTALS
          </Link>
          <StatusSelect options={buildStatusOptions(selection)} />
          <span className="text-xs font-medium tracking-wide text-slate-600">
            {describeView(selection)} · {matching.toLocaleString('en-PH')} CHECK{matching === 1 ? '' : 'S'}
          </span>
        </div>
        <QuickActions selection={selection} refused={refused} />
      </div>

      {/* Kept mounted while ?confirm=sign is on the URL even at a count of zero:
          the action revalidates this page, and when every cheque signed the
          count IS zero — unmounting would throw the "N OF N SIGNED" report away. */}
      {pendingSign && (pendingSign.count > 0 || params.confirm === 'sign') && (
        <div className="rounded-2xl bg-white px-4 py-3 ring-1 ring-hairline">
          {params.confirm === 'sign' ? (
            <ConfirmAllForm
              action={signAllPendingAction}
              confirm="sign"
              count={pendingSign.count}
              cancelHref={signAllCancelHref(selection)}
              narrow={{ company: companyId ?? '', cashAccount: cashAccountId ?? '', eligibility: eligibility ?? '' }}
              columnParams={columnParamsOf(selection.base)}
              labels={{ submit: 'SIGN ALL', pending: 'SIGNING…', done: 'SIGNED', back: 'BACK TO THE LIST' }}
              tone="navy"
              prompt={
                <p className="text-sm font-semibold tracking-wide text-slate-900">
                  SIGN {pendingSign.count.toLocaleString('en-PH')} CHECK{pendingSign.count === 1 ? '' : 'S'}
                  {pendingSign.totalsByCurrency.length > 0 && ' — '}
                  {pendingSign.totalsByCurrency.map((t) => formatMoney(t.total, t.currency)).join(' + ')}?
                </p>
              }
            />
          ) : (
            <Link href={signAllConfirmHref(selection)}
              className="inline-block rounded-lg bg-navy px-4 py-2 text-sm font-semibold tracking-wide text-white hover:bg-navy/90">
              SIGN ALL {pendingSign.count.toLocaleString('en-PH')}
            </Link>
          )}
          {matching > pendingSign.count && (
            <p className="mt-2 text-xs text-slate-500">
              {(matching - pendingSign.count).toLocaleString('en-PH')} NON-CHECK PAYMENT(S) (DEBIT ADV, TT) IN THIS VIEW ARE NOT SIGNED.
            </p>
          )}
        </div>
      )}

      {/* A box that could not be read lists NOTHING rather than being dropped
          (part C2): an ignored filter reads as an applied one. The box itself
          says what is wrong; this says why the table is empty. */}
      {refused && (
        <p role="alert" className="rounded-lg bg-warning-bg px-4 py-2 text-sm font-semibold text-warning-ink">
          A FILTER COULD NOT BE READ, SO NOTHING IS LISTED. Correct the box marked in red, or press RESET.
        </p>
      )}

      {/* ── THE DISCLOSURE ──────────────────────────────────────────────────
          The client asked for the cheques with no recorded amount to be
          taken out of the counts and the table: "ignore them mean you have
          to remove them, dont consider them becuase they dont have amount"
          (2026-09-06). They are still in the database — 25 of them RELEASED
          — and nothing was deleted.

          This line is the price of hiding them, and it is not optional. A
          register that shrinks by 129 with no explanation is how somebody
          concludes money went missing, and by the time they ask, the number
          they remember is a month old. So the count is stated, and the link
          beside it opens exactly those cheques.

          Only when the toggle is OFF: with it on, the reader is already
          looking at them and `describeView` above says so. */}
      {/* The cheques with no amount THIS list's own filters match — view,
          search, column filters — so the count is exactly what 'Show them'
          opens (part C2). */}
      {!incomplete && excludedIncomplete > 0 && (
        <p className="text-xs font-medium tracking-wide text-slate-500">
          EXCLUDING {excludedIncomplete.toLocaleString('en-PH')} CHECK
          {excludedIncomplete === 1 ? '' : 'S'} WITH NO RECORDED AMOUNT — not counted in the
          totals and not listed below.{' '}
          <Link href={incompleteHref(selection)} className="underline underline-offset-2">
            Show them
          </Link>.
        </p>
      )}

      {/* ── THE OTHER DISCLOSURE ────────────────────────────────────────────
          `releasedAt` is written only by `markReleased`, when a cheque is
          released THROUGH THIS APP. Every release the register load imported
          and every one the two catch-ups moved has none — on purpose: a
          timestamp fabricated from a spreadsheet on a release record is worse
          than none (CLAUDE.md). Since 2026-09-28 the register's stated day
          fills the gap for the cheques it names (`statedReleaseDate`, its own
          column); what is left is the cheques with neither date, and this line
          counts exactly those, or a short table reads as the whole picture. */}
      {releasedRange && undatedReleases > 0 && (
        <p className="text-xs font-medium tracking-wide text-slate-500">
          NOT MATCHED: {undatedReleases.toLocaleString('en-PH')} RELEASED{' '}
          {undatedReleases === 1 ? 'CHECK CARRIES' : 'CHECKS CARRY'} NO RELEASE DATE — neither recorded
          here nor stated in the register. Only a check with one of those dates can fall inside a range.
        </p>
      )}

      <FilterBar
        showAll={showAll}
        q={q}
        status={status ?? ''}
        eligibility={eligibility ?? ''}
        incomplete={incomplete}
        hasColumnFilter={Object.keys(columnValues).length > 0}
        clearHref={clearFiltersHref(selection)}
        sort={selection.sort}
        hasSort={activeSort !== null}
      />

      {incomplete && (
        <p className="rounded-lg bg-warning-bg px-4 py-2 text-sm text-warning-ink">
          SHOWING ONLY THE INCOMPLETE RECORDS — checks whose amount the register never recorded.
          They are real checks and they are still here; they are simply left out of the
          dashboard&rsquo;s counts and its table, and out of every currency total, because there
          is no figure of theirs to add.{' '}
          {/* The toggle's own off-link, so clearing it keeps the view. */}
          <Link href={incompleteHref(selection)} className="underline underline-offset-2">
            Back to the checks with amounts
          </Link>.
        </p>
      )}

      {matching > rows.length && (
        <p className="rounded-lg bg-warning-bg px-4 py-2 text-sm text-warning-ink">
          SHOWING {rows.length.toLocaleString('en-PH')} OF {matching.toLocaleString('en-PH')} MATCHING CHECKS.
          Narrow the search or filters to see the rest.
        </p>
      )}

      {/* Mapped, not passed straight through: the table is a client component
          and a Prisma Decimal cannot be serialised across that boundary. See
          toTableRow in lib/queries.ts. */}
      <CheckTable
        rows={rows.map(toTableRow)}
        // MARK RELEASED on the list is every Finance user's (client, 2026-10-16).
        canRelease
        bulkCap={settings.values['caps.bulkSelection']}
        sort={sort}
        filters={{
          options,
          values: columnValues,
          errors: filterErrors,
          showStatus: showAll && !status,
          showReleasedRange: status === 'RELEASED' || showAll,
        }}
      />
    </main>
  )
}
