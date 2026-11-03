import { describe, it, expect } from 'vitest'
import { filterHref } from '@/lib/filter-href'
import {
  printHref, PRINT_PATH, exportHref, dashboardHref, type DashboardSelection,
} from '@/lib/dashboard-view'

const NOTHING: DashboardSelection = { status: null, showAll: false, incomplete: false, live: false, base: {} }

/**
 * `filterHref` is the auto-submitting filter bar's whole contract.
 *
 * The bar is still a plain `<form method="get">` and still submits natively
 * when JavaScript has not loaded. The enhancement intercepts that submit and
 * navigates instead — so the URL it builds has to be the URL the browser would
 * have built, or the two paths quietly disagree about what the filters mean.
 */
describe('filterHref', () => {
  it('builds the same URL a native GET submit would', () => {
    expect(filterHref([['q', 'ACME'], ['company', 'c1']])).toBe('/?q=ACME&company=c1')
  })

  it('builds the URL for the page the form is on, so every filter page can submit softly', () => {
    expect(filterHref([['bank', 'BPI'], ['company', '']], '/recon')).toBe('/recon?bank=BPI')
    expect(filterHref([['company', '']], '/admin/audit')).toBe('/admin/audit')
  })

  it('keeps the order the form gives, so the URL is stable across submits', () => {
    expect(filterHref([['company', 'c1'], ['q', 'ACME']])).toBe('/?company=c1&q=ACME')
  })

  /**
   * A native submit sends `q=` for an empty box. Dropped here, because the
   * cards build their links from the same non-empty pairs (`base` in
   * lib/dashboard-params.ts) and two spellings of the same view make a
   * bookmark, a card link and a filter submit look like three different pages.
   */
  it('drops the controls the user left empty', () => {
    expect(filterHref([['q', ''], ['company', 'c1'], ['eligibility', '']])).toBe('/?company=c1')
  })

  it('is the bare dashboard when nothing is set at all', () => {
    expect(filterHref([])).toBe('/')
    expect(filterHref([['q', ''], ['company', '']])).toBe('/')
  })

  /**
   * The view survives a search. The hidden `status` and `scope` fields are the
   * whole reason the status dropdown could be removed: without them, searching
   * inside SIGNED would drop the view and throw the reader back to NEEDS ACTION.
   */
  it('carries the view along, because the hidden fields are part of the form', () => {
    expect(filterHref([['status', 'SIGNED'], ['q', 'ACME']])).toBe('/?status=SIGNED&q=ACME')
    expect(filterHref([['scope', 'all']])).toBe('/?scope=all')
  })

  it('passes the list\'s hidden scope=live through unchanged, like the other hidden view fields', () => {
    expect(filterHref([['scope', 'live'], ['company', 'c1']])).toBe('/?scope=live&company=c1')
  })

  it('escapes what a user typed rather than pasting it into the query string', () => {
    expect(filterHref([['q', 'A & B']])).toBe('/?q=A+%26+B')
  })

  // The two date boxes are ordinary form controls: an empty one is dropped like
  // an empty search, a filled one is carried as the day the browser typed.
  it('carries a filled DATE RELEASED box and drops an empty one', () => {
    expect(filterHref([['status', 'RELEASED'], ['releasedFrom', ''], ['releasedTo', '2026-09-15']]))
      .toBe('/?status=RELEASED&releasedTo=2026-09-15')
  })

  // The checkbox submits `incomplete=1`, and only "1" turns the filter on.
  it('passes the incomplete toggle through as the value the page reads', () => {
    expect(filterHref([['incomplete', '1']])).toBe('/?incomplete=1')
  })

  // A file input would give a File here. It cannot happen on this bar, but the
  // signature accepts FormData's own entry type, so it is ruled out rather than
  // cast away.
  it('ignores an entry that is not text', () => {
    expect(filterHref([['q', 'ACME'], ['x', new File([], 'f.txt')]])).toBe('/?q=ACME')
  })
})

/**
 * PRINT RELEASE LIST, as a URL. Same reasoning as `exportHref`: the printed
 * page has to hold exactly what the reader is looking at, so it carries the
 * same parameters and one function decides what they are.
 */
describe('printHref', () => {
  it('is the print page with the dashboard\'s own parameters', () => {
    const sel: DashboardSelection = {
      status: 'READY_FOR_RELEASE', showAll: false, incomplete: false, live: false,
      base: { q: 'ACME', company: 'c1' },
    }
    expect(printHref(sel)).toBe('/print?q=ACME&company=c1&status=READY_FOR_RELEASE')
  })

  it('is the bare print page when no filter and no view is set', () => {
    expect(printHref(NOTHING)).toBe(PRINT_PATH)
  })

  it('carries the incomplete toggle and the ALL CHECKS scope', () => {
    expect(printHref({ ...NOTHING, showAll: true, incomplete: true }))
      .toBe('/print?scope=all&incomplete=1')
  })

  it('describes the same selection the export does', () => {
    const sel: DashboardSelection = { ...NOTHING, status: 'SIGNED', base: { q: 'ACME' } }
    expect(printHref(sel).replace(PRINT_PATH, '')).toBe(exportHref(sel).replace('/api/export', ''))
  })
})

/**
 * The way back from the print sheet: the view the reader left, not `/`.
 */
describe('dashboardHref', () => {
  it('is the bare dashboard when nothing at all is selected', () => {
    // Never "/?": an empty query string is a different URL to look at in a
    // history list and a different one to bookmark.
    expect(dashboardHref(NOTHING)).toBe('/')
  })

  it('rebuilds the view and every narrowing filter exactly as it stands', () => {
    const sel: DashboardSelection = {
      status: 'SIGNED', showAll: false, incomplete: true, live: false,
      base: { q: 'ACME', company: 'c1' },
    }
    expect(dashboardHref(sel)).toBe('/?q=ACME&company=c1&status=SIGNED&incomplete=1')
  })

  it('carries the DATE RELEASED range the resolver put in `base`', () => {
    const sel: DashboardSelection = {
      status: 'RELEASED', showAll: false, incomplete: false, live: false,
      base: { releasedFrom: '2026-09-01', releasedTo: '2026-09-15' },
    }
    expect(dashboardHref(sel)).toBe('/?releasedFrom=2026-09-01&releasedTo=2026-09-15&status=RELEASED')
    expect(exportHref(sel)).toBe('/api/export?releasedFrom=2026-09-01&releasedTo=2026-09-15&status=RELEASED')
  })

  it('does not toggle anything off on the way back', () => {
    // The distinction from `cardHref`: this is "where I was", not "what would
    // happen if I clicked the lit card again".
    const sel: DashboardSelection = { ...NOTHING, showAll: true }
    expect(dashboardHref(sel)).toBe('/?scope=all')
  })

  it('carries no half-made release confirmation back with it', () => {
    const sel: DashboardSelection = { ...NOTHING, status: 'READY_FOR_RELEASE' }
    expect(dashboardHref(sel)).not.toContain('confirm')
  })
})

describe('printHref carries the sort', () => {
  it('as the screen had it', () => {
    expect(printHref({ ...NOTHING, showAll: true, sort: { key: 'status', dir: 'desc' } }))
      .toBe(`${PRINT_PATH}?scope=all&sort=status&dir=desc`)
  })
})
