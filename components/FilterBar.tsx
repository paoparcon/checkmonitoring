import { ELIGIBILITIES } from '@/lib/queries'
import type { SortSpec } from '@/lib/list-sort'
import { LIST_FILTER_FORM } from '@/lib/column-filters'
import { FilterForm } from './FilterForm'
import { ResetLink } from './ResetLink'

/** The APPLY button's id, so the enhancement can find and hide it. */
const APPLY_ID = 'filter-apply'

/**
 * The dashboard's filter bar: SEARCH · ELIGIBILITY · INCOMPLETE · RESET. Every
 * other filter is set from the table's header menus (components/CheckTable.tsx),
 * carried into this form by hidden `form="list-filters"` inputs — a native submit still sends them.
 *
 * A plain `<form method="get">`, deliberately, and still one. Every control
 * writes a URL parameter, which is what makes a filtered view linkable,
 * bookmarkable and survivable across a refresh — and it keeps working on a
 * Finance workstation whose JavaScript has failed, the same reasoning as the
 * sign-out form.
 *
 * ── AUTO-SUBMIT, WITHOUT LOSING THAT ──────────────────────────────────────
 * The client asked for the APPLY button to go: the dropdowns should submit on
 * change and the search box should debounce. That is `FilterForm` (`auto`), an
 * enhancement that is the form itself.
 *
 * The button is still in the markup. It is hidden by the enhancement on mount,
 * so a reader with a working bundle never sees it, and a reader whose bundle
 * failed still has a way to submit. Deleting it outright would have left the
 * dropdowns inert without JavaScript — the no-JS path is the one property here
 * that is not negotiable, so the button is hidden rather than removed.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The company and bank options reach the filter row from the page, loaded from
 * the database — nothing hardcoded. The eligibilities come from the domain's
 * own list for the same reason — a restatement is how one file ends up with a
 * value another one has never heard of.
 *
 * The page validates every value it reads back, so an unrecognised parameter is
 * ignored rather than passed to Prisma. See `parseStatusParam` and friends.
 *
 * There is NO status dropdown. The summary cards and the release timeline above
 * are the view selector — which set of cheques you are looking at — and
 * everything on this bar narrows WITHIN that view. The dropdown wrote the same
 * `?status=` the cards do, which is two controls for one thing, and the client
 * did not read the cards as filters while a dropdown was competing with them.
 */
export function FilterBar({
  showAll, q, status, eligibility, incomplete, hasColumnFilter, clearHref, sort, hasSort,
}: {
  showAll: boolean
  q: string
  status: string
  eligibility: string
  incomplete: boolean
  /** A box in the table's filter row is in force, so RESET has something to clear. */
  hasColumnFilter: boolean
  clearHref: string
  /** The URL's own sort (`selection.sort`), carried by the hidden inputs — never the cookie's. */
  sort: SortSpec | undefined
  /** A sort is in force from the URL or the cookie, so RESET has something to clear. */
  hasSort: boolean
}) {
  // A RESET control that is always there is furniture, and on an unfiltered
  // screen it invites the user to wonder what it would clear.
  // The status is NOT counted. It is the view, not a filter, and RESET
  // deliberately keeps it: a bar offering RESET on an otherwise untouched
  // SIGNED view would promise to clear something it does not clear.
  const anyFilter = Boolean(q || eligibility || incomplete || hasColumnFilter || hasSort)

  const field = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

  return (
    // Not keyed on the values: a key built from them remounted the whole bar —
    // the filter row's boxes included — on every change the reader made, which
    // was the blinking (2026-10-12). `FilterForm` remounts only when the URL
    // changed from somewhere else (Back, a card, "Show them"), the one case
    // where `defaultValue` has to be re-applied. RESET is still a full
    // navigation.
    <FilterForm
      id={LIST_FILTER_FORM}
      className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline"
      auto
      applyButtonId={APPLY_ID}
    >
      {/* The VIEW survives a search. These hidden fields are the whole
          reason the status dropdown could be removed safely: a GET submit sends
          only the form's own controls, so without them searching inside SIGNED
          would drop `status` and silently throw the user back to NEEDS ACTION.
          `filterHref` reads the same FormData, so the enhanced path carries the
          view for exactly the same reason. */}
      {status && <input type="hidden" name="status" value={status} />}
      {showAll && <input type="hidden" name="scope" value="all" />}
      {/* The NEEDS ACTION list, said out loud. Without it, clearing the search
          and choosing a company would submit `/?company=…`, which since
          2026-09-29 is the TOTALS screen for that company — the reader would
          be thrown off the list they were filtering. `status` and `scope=all`
          already open the list, so the marker is only needed when neither is
          set. See `DashboardSelection.live`. */}
      {!status && !showAll && <input type="hidden" name="scope" value="live" />}
      {/* A filter change keeps the order the URL chose — a GET submit sends only the form's own controls. */}
      {sort && <><input type="hidden" name="sort" value={sort.key} /><input type="hidden" name="dir" value={sort.dir} /></>}

      <label className="sr-only" htmlFor="filter-q">SEARCH</label>
      <input
        id="filter-q" name="q" type="text" defaultValue={q}
        placeholder="SEARCH CHECK NO., APV, PO OR SUPPLIER"
        className={`${field} min-w-[16rem] flex-1`}
      />

      <label className="sr-only" htmlFor="filter-eligibility">ELIGIBILITY</label>
      <select id="filter-eligibility" name="eligibility" defaultValue={eligibility} className={field}>
        <option value="">ALL ELIGIBILITIES</option>
        {ELIGIBILITIES.map((e) => (
          <option key={e} value={e}>{e}</option>
        ))}
      </select>

      {/* The 129 cheques whose amount the register never recorded. A narrowing
          filter, never a view: incompleteness cuts across every status (50
          SIGNATURE_PENDING, 48 CANCELLED, 25 RELEASED, 6 READY_FOR_RELEASE), so
          it composes with the selected view rather than replacing it.

          UNTICKED NOW MEANS "EXCLUDE THEM", not "do not filter" (client
          decision, 2026-09-06) — the dashboard's counts and its table both leave
          them out, and the page states the number above the table. This checkbox
          is the way back to them, and there is no INCOMPLETE card above it any
          more; that card was removed in the same change. */}
      <label className={`flex items-center gap-2 whitespace-nowrap ${field}`}>
        <input type="checkbox" name="incomplete" value="1" defaultChecked={incomplete} />
        INCOMPLETE ONLY
      </label>

      {/* Present for the no-script path, hidden by FilterForm on mount.
          See the note at the top of this file. */}
      <button
        id={APPLY_ID}
        type="submit"
        className="h-10 rounded-lg bg-navy px-4 text-sm font-medium text-white"
      >
        APPLY
      </button>

      {anyFilter && (
        // A link, not a reset button: reset would restore the form's defaults,
        // which ARE the current filters, and appear to do nothing. This goes to
        // an unfiltered URL and keeps only the VIEW the user is reading in.
        //
        // A plain anchor, not `next/link`, on purpose: a soft navigation leaves
        // this form mounted, and React does not re-apply `defaultValue` to a
        // mounted input, so the cleared URL would sit above a box still holding
        // the old search. One full page load, only on RESET, is the price of a
        // form the search box can be typed into without being remounted.
        //
        // It also forgets the remembered sort.
        <ResetLink href={clearHref} />
      )}

    </FilterForm>
  )
}
