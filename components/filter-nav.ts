import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'

/**
 * WHO CHANGED THE URL — so a filter bar is remounted only when it has to be.
 *
 * A filter bar's controls are uncontrolled (`defaultValue`), and React does not
 * re-apply `defaultValue` to a control that is already mounted. So when the URL
 * changes from somewhere else — the browser's Back button, a summary card, a
 * link — the bar has to be REMOUNTED to show the new values. The bars used to
 * do that with a `key` built from the values on the server, which also
 * remounted them on every change the reader made THEMSELVES: choose a company
 * and the whole bar, filter row included, was torn down and rebuilt as the new
 * table arrived. That rebuild is the blinking (client report, 2026-10-12).
 *
 * The rule now: a navigation the bar made itself (`markOwnNavigation`, called
 * just before `router.replace`) leaves everything mounted — the DOM already
 * holds what the reader typed. Any other change to the query string bumps the
 * epoch, which the bars use as their `key`.
 *
 * Module state rather than a React context: the filter bar and the table's
 * filter row are siblings, rendered by different components, and both need the
 * answer for the same URL change.
 */
let ownSearch: string | null = null

/** Called with the query string of a navigation the filter form is about to make. */
export function markOwnNavigation(search: string): void {
  ownSearch = search
}

/** Bumps once for each change to the query string that the filter form did not make. */
export function useExternalNavEpoch(): number {
  const search = useSearchParams().toString()
  const [seen, setSeen] = useState({ search, epoch: 0 })

  // Derived during render (the supported "adjust state on prop change" pattern),
  // so the remount lands in the same paint as the new page, not a frame later.
  // Read-only here: the module flag is cleared in the effect below.
  if (seen.search !== search) {
    setSeen({ search, epoch: search === ownSearch ? seen.epoch : seen.epoch + 1 })
  }

  useEffect(() => {
    // An external change forgets the flag, so coming back to the same query
    // string later by Back is not mistaken for the form's own navigation.
    if (search !== ownSearch) ownSearch = null
  }, [search])

  return seen.epoch
}
