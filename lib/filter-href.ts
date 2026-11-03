/**
 * The dashboard URL a filled-in filter bar means.
 *
 * The bar is still a plain `<form method="get">` and still submits natively
 * when JavaScript has not loaded — that is a real property of this system, not
 * an accident, and it is what keeps the dashboard usable on a Finance
 * workstation whose bundle failed. The auto-submit is an ENHANCEMENT layered
 * over it: the script intercepts the submit and navigates instead, so nothing
 * is lost when the script is not there.
 *
 * Which is exactly why this function exists and is pure. The URL the
 * enhancement builds has to be the URL the browser would have built from the
 * same form, and the only way to be sure is to have one tested definition of
 * it rather than string concatenation inside an event handler.
 *
 * The one deliberate difference from a native submit: an empty control is
 * dropped rather than sent as `q=`. The cards build their links from the
 * non-empty pairs only (`base`, in lib/dashboard-params.ts), and two spellings
 * of the same view would make a card link, a bookmark and a filter submit look
 * like three different pages in the history.
 */
export function filterHref(entries: Iterable<readonly [string, unknown]>, base = '/'): string {
  const qs = new URLSearchParams()
  for (const [key, value] of entries) {
    // FormData can yield a File. It cannot happen on this bar, but ruling it
    // out here is cheaper than a cast that would render "[object File]" into a
    // query string if a file input were ever added.
    if (typeof value !== 'string') continue
    if (value === '') continue
    qs.append(key, value)
  }
  const s = qs.toString()
  return s ? `${base}?${s}` : base
}
