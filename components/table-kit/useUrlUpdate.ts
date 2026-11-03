'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { filterHref } from '@/lib/filter-href'
import { markOwnNavigation } from '../filter-nav'

/**
 * Rewrite some of the URL's parameters and navigate softly (spec 2026-10-13 §2).
 * `updates` maps a parameter to its new value; '' removes it. `drop` names
 * parameters that any change invalidates (Audit's `before` cursor).
 *
 * `markOwn`: true when nothing else on the page shows these parameters in an
 * uncontrolled control (the main list — its hidden inputs are controlled), so
 * the filter bar is not remounted. False where the page's own filter bar shows
 * the same parameter (Audit's ACTION and USER selects): the bar must remount
 * to show the menu's choice.
 */
export function useUrlUpdate(opts: { markOwn: boolean; drop?: readonly string[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  return (updates: Readonly<Record<string, string>>) => {
    const entries = [...search.entries()].filter(([k]) => !(k in updates) && !(opts.drop ?? []).includes(k))
    for (const [k, v] of Object.entries(updates)) if (v) entries.push([k, v])
    const href = filterHref(entries, pathname)
    if (opts.markOwn) markOwnNavigation(href.includes('?') ? href.slice(href.indexOf('?') + 1) : '')
    router.replace(href, { scroll: false })
  }
}
