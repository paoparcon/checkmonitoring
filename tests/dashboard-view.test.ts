import { describe, it, expect } from 'vitest'
import {
  isCardSelected, cardHref, incompleteHref, clearFiltersHref, describeView, viewStatusFilter,
  releaseConfirmHref, releaseCancelHref, signAllConfirmHref, signAllCancelHref, TODAYS_RELEASE_ANCHOR,
  exportHref, EXPORT_PATH, dashboardHref, printHref,
  dashboardScreen, totalsHref, signAllOffered,
  type DashboardSelection,
} from '@/lib/dashboard-view'
import { LIVE_STATUSES } from '@/lib/domain/check-status'

/**
 * Pure. No database, no DOM, no browser.
 *
 * The summary cards are the dashboard's VIEW SELECTOR — which set of cheques
 * you are looking at — and the dropdowns narrow within the selected view. All
 * of that is URL arithmetic, so all of it is testable here rather than by
 * clicking around a rendered page.
 */

const NOTHING: DashboardSelection = { status: null, showAll: false, incomplete: false, live: false, base: {} }
const NARROWED: DashboardSelection = {
  ...NOTHING,
  base: { q: 'ACME', company: 'c1', cashAccount: 'a1', eligibility: 'ELIGIBLE' },
}

describe('the default view', () => {
  it('is NEEDS ACTION when no card is selected, not "everything"', () => {
    // 7,433 of 9,287 production cheques are RELEASED. A default of "everything"
    // buries the ~1,200 somebody has to act on today.
    expect(viewStatusFilter(NOTHING)).toEqual({ status: undefined, statusIn: LIVE_STATUSES })
  })

  it('names itself above the table so the scope is never a silent default', () => {
    expect(describeView(NOTHING)).toBe(
      'NEEDS ACTION — GENERATED, SIGNATURE PENDING, SIGNED, READY FOR RELEASE, SCHEDULED',
    )
  })

  it('lists exactly the live statuses, taken from the domain rather than restated', () => {
    for (const s of LIVE_STATUSES) expect(describeView(NOTHING)).toContain(s.replace(/_/g, ' '))
  })

  it('selects no view card', () => {
    for (const card of ['READY_FOR_RELEASE', 'SIGNATURE_PENDING', 'SIGNED', 'RELEASED', 'TOTAL_CHECKS'] as const) {
      expect(isCardSelected(card, NOTHING)).toBe(false)
    }
  })
})

describe('selecting a view', () => {
  it('writes the status and lights the card', () => {
    expect(cardHref('SIGNED', NOTHING)).toBe('/?status=SIGNED')
    expect(isCardSelected('SIGNED', { ...NOTHING, status: 'SIGNED' })).toBe(true)
  })

  it('filters to that status alone', () => {
    expect(viewStatusFilter({ ...NOTHING, status: 'SIGNED' }))
      .toEqual({ status: 'SIGNED', statusIn: undefined })
  })

  it('folds SCHEDULED into READY FOR RELEASE, so the card and the table agree', () => {
    // A card reading 406 that opens a table of 396 is a bug report waiting to
    // happen. The SCHEDULED status itself is untouched.
    expect(viewStatusFilter({ ...NOTHING, status: 'READY_FOR_RELEASE' }))
      .toEqual({ status: undefined, statusIn: ['READY_FOR_RELEASE', 'SCHEDULED'] })
    expect(describeView({ ...NOTHING, status: 'READY_FOR_RELEASE' }))
      .toBe('READY FOR RELEASE — INCLUDING SCHEDULED')
  })

  it('shows RELEASED without needing the all-checks scope', () => {
    // RELEASED is excluded from the NEEDS ACTION default, and an explicit
    // status wins over that default — so the card opens a full table.
    expect(cardHref('RELEASED', NOTHING)).toBe('/?status=RELEASED')
    expect(viewStatusFilter({ ...NOTHING, status: 'RELEASED' }))
      .toEqual({ status: 'RELEASED', statusIn: undefined })
  })

  it('does not light one status card while another is the view', () => {
    expect(isCardSelected('SIGNED', { ...NOTHING, status: 'RELEASED' })).toBe(false)
  })
})

describe('deselecting a view', () => {
  it('returns to the NEEDS ACTION list rather than to everything', () => {
    expect(cardHref('SIGNED', { ...NOTHING, status: 'SIGNED' })).toBe('/?scope=live')
    expect(cardHref('READY_FOR_RELEASE', { ...NOTHING, status: 'READY_FOR_RELEASE' })).toBe('/?scope=live')
    expect(cardHref('RELEASED', { ...NOTHING, status: 'RELEASED' })).toBe('/?scope=live')
  })

  it('keeps the narrowing filters, which are not part of the view', () => {
    expect(cardHref('SIGNED', { ...NARROWED, status: 'SIGNED' }))
      .toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&scope=live')
  })
})

describe('the narrowing filters survive a change of view', () => {
  it('carries the search, company, bank and eligibility into the selected view', () => {
    expect(cardHref('SIGNED', NARROWED))
      .toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=SIGNED')
  })

  it('carries them from one view straight to another', () => {
    expect(cardHref('RELEASED', { ...NARROWED, status: 'SIGNED' }))
      .toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=RELEASED')
  })
})

describe('TOTAL CHECKS', () => {
  it('shows every status', () => {
    expect(viewStatusFilter({ ...NOTHING, showAll: true }))
      .toEqual({ status: undefined, statusIn: undefined })
    expect(describeView({ ...NOTHING, showAll: true }))
      .toBe('ALL CHECKS — EVERY STATUS, INCLUDING RELEASED, CANCELLED AND VOIDED')
  })

  /**
   * Client request 2026-09-29: ALL CHECKS is the cheque INVENTORY — "every
   * cheque STK holds at BPI, any status" — so it keeps the narrowing filters
   * like every other card. It used to clear them ("show me everything, start
   * again"); RESET on either filter bar is the way to do that now.
   */
  it('carries the search, the dropdowns and the incomplete toggle into the all-checks view', () => {
    const messy: DashboardSelection = { ...NARROWED, status: 'SIGNED', incomplete: true }
    expect(cardHref('TOTAL_CHECKS', messy))
      .toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&scope=all&incomplete=1')
    expect(cardHref('TOTAL_CHECKS', NOTHING)).toBe('/?scope=all')
  })

  it('is selected only when it is the view, never beside a status card', () => {
    expect(isCardSelected('TOTAL_CHECKS', { ...NOTHING, showAll: true })).toBe(true)
    expect(isCardSelected('TOTAL_CHECKS', { ...NOTHING, showAll: true, status: 'SIGNED' })).toBe(false)
  })

  it('goes back to the NEEDS ACTION list when clicked again', () => {
    expect(cardHref('TOTAL_CHECKS', { ...NOTHING, showAll: true })).toBe('/?scope=live')
  })
})

/**
 * INCOMPLETE (NO AMOUNT).
 *
 * CLIENT DECISION, 2026-09-06: the 129 cheques with no recorded amount come out
 * of the dashboard's counts and its table, so this stopped being a CARD and the
 * toggle's OFF position stopped meaning "do not filter". These tests were
 * written against `cardHref('INCOMPLETE', …)`; they now exercise
 * `incompleteHref`, which is the same URL arithmetic reached from the notice the
 * page prints above the table instead of from a card. `?incomplete=1` is
 * unchanged, so every bookmark that named it still opens what it named.
 */
describe('INCOMPLETE (NO AMOUNT) is a toggle, and no longer a card', () => {
  it('composes with the view instead of replacing it', () => {
    // The 129 cheques with no recorded amount cut across every status
    // (50 SIGNATURE_PENDING, 48 CANCELLED, 25 RELEASED, 6 READY_FOR_RELEASE),
    // so SIGNED + INCOMPLETE has to mean "signed cheques with no amount".
    expect(incompleteHref({ ...NOTHING, status: 'SIGNED' }))
      .toBe('/?status=SIGNED&incomplete=1')
  })

  it('leaves the status filter of the view alone', () => {
    const both: DashboardSelection = { ...NOTHING, status: 'SIGNED', incomplete: true }
    expect(viewStatusFilter(both)).toEqual({ status: 'SIGNED', statusIn: undefined })
  })

  it('lights the view card and says the toggle is on above the table', () => {
    const both: DashboardSelection = { ...NOTHING, status: 'SIGNED', incomplete: true }
    expect(isCardSelected('SIGNED', both)).toBe(true)
    expect(describeView(both)).toBe('SIGNED + INCOMPLETE (NO AMOUNT)')
  })

  it('turns off without disturbing the view', () => {
    expect(incompleteHref({ ...NARROWED, status: 'SIGNED', incomplete: true }))
      .toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=SIGNED')
  })

  it('survives a change of view, because it is independent of one', () => {
    expect(cardHref('RELEASED', { ...NOTHING, status: 'SIGNED', incomplete: true }))
      .toBe('/?status=RELEASED&incomplete=1')
    expect(cardHref('SIGNED', { ...NOTHING, status: 'SIGNED', incomplete: true }))
      .toBe('/?scope=live&incomplete=1')
  })

  it('composes with the all-checks view too', () => {
    expect(incompleteHref({ ...NOTHING, showAll: true })).toBe('/?scope=all&incomplete=1')
  })

  /**
   * The link the page prints under VIEWING, and the reason hiding 129 cheques is
   * a decision the reader can see and undo. Without a way back, a register that
   * quietly got smaller is how somebody concludes money went missing.
   */
  it('offers a way back to them from the plain dashboard', () => {
    expect(incompleteHref(NOTHING)).toBe('/?scope=live&incomplete=1')
  })

  /**
   * The link is only ever rendered on the TOTALS screen or the list, and both
   * destinations are lists: on NEEDS ACTION it writes `scope=live` so a URL
   * that carries only a company (`/?company=c1`, now the TOTALS) cannot come
   * back from a click as the totals it was meant to leave.
   */
  it('keeps the NEEDS ACTION view on the list in both directions', () => {
    expect(incompleteHref({ ...NOTHING, incomplete: true, base: { company: 'c1' } }))
      .toBe('/?company=c1&scope=live')
    expect(incompleteHref({ ...NOTHING, base: { company: 'c1' } }))
      .toBe('/?company=c1&scope=live&incomplete=1')
  })
})

describe('CLEAR FILTERS', () => {
  it('drops the narrowing filters and keeps the view being read', () => {
    expect(clearFiltersHref({ ...NARROWED, status: 'SIGNED', incomplete: true })).toBe('/?status=SIGNED')
    expect(clearFiltersHref({ ...NARROWED, showAll: true })).toBe('/?scope=all')
    // On NEEDS ACTION the URL that is left would be a bare `/` — the TOTALS.
    // RESET sits on the list's filter bar, so it writes `scope=live`.
    expect(clearFiltersHref(NARROWED)).toBe('/?scope=live')
    expect(clearFiltersHref({ ...NOTHING, base: { q: 'ACME' } })).toBe('/?scope=live')
  })
})

/**
 * TODAY'S RELEASE puts its confirmation in the URL rather than in a `confirm()`
 * dialog, so the step exists before any JavaScript does — on the one action in
 * the system that hands money over.
 */
describe('the RELEASE ALL confirmation step', () => {
  it('adds confirm=release and lands on the panel', () => {
    expect(releaseConfirmHref(NOTHING)).toBe(`/?confirm=release#${TODAYS_RELEASE_ANCHOR}`)
  })

  it('carries the view and the narrowing filters, so cancelling returns you where you were', () => {
    const sel: DashboardSelection = { ...NARROWED, status: 'SIGNED', incomplete: true }
    expect(releaseConfirmHref(sel)).toBe(
      '/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=SIGNED&incomplete=1' +
      `&confirm=release#${TODAYS_RELEASE_ANCHOR}`,
    )
    expect(releaseCancelHref(sel)).toBe(
      '/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=SIGNED&incomplete=1' +
      `#${TODAYS_RELEASE_ANCHOR}`,
    )
  })

  /**
   * The confirmation must not survive a click on anything else. A `confirm=release`
   * left in the URL by a card link would put a half-made release back on screen
   * after the user had visibly moved on from it.
   */
  it('is dropped by every other control', () => {
    const confirming: DashboardSelection = { ...NARROWED, status: 'SIGNED' }
    for (const url of [
      cardHref('SIGNED', confirming),
      cardHref('TOTAL_CHECKS', confirming),
      incompleteHref(confirming),
      clearFiltersHref(confirming),
    ]) {
      expect(url).not.toContain('confirm=')
    }
  })
})

/**
 * EXPORT TO EXCEL points at the same view the reader is in. If these two ever
 * disagree, the file is a copy of a table nobody was looking at.
 */
describe('exportHref', () => {
  it('is the bare endpoint on an untouched dashboard', () => {
    expect(exportHref(NOTHING)).toBe(EXPORT_PATH)
  })

  it('carries the narrowing filters', () => {
    expect(exportHref(NARROWED)).toBe(
      `${EXPORT_PATH}?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE`,
    )
  })

  it('carries the view and the incomplete toggle', () => {
    expect(exportHref({ ...NOTHING, status: 'SIGNED', incomplete: true }))
      .toBe(`${EXPORT_PATH}?status=SIGNED&incomplete=1`)
    expect(exportHref({ ...NOTHING, showAll: true })).toBe(`${EXPORT_PATH}?scope=all`)
  })

  it('carries exactly the parameters the dashboard link carries', () => {
    const sel: DashboardSelection = { ...NARROWED, status: 'READY_FOR_RELEASE', incomplete: true }
    // The "Show them" link is the same view as `sel`, so the two URLs must
    // differ only in their path.
    const dashboard = incompleteHref({ ...sel, incomplete: false })
    expect(exportHref(sel)).toBe(dashboard.replace('/?', `${EXPORT_PATH}?`))
  })

  // A half-made release is a state of the screen, not of the data.
  it('never carries the release confirmation', () => {
    expect(exportHref({ ...NARROWED, status: 'READY_FOR_RELEASE' })).not.toContain('confirm=')
  })
})

describe('dashboardScreen', () => {
  it('opens on TOTALS when nothing narrows the view', () => {
    expect(dashboardScreen(NOTHING)).toBe('TOTALS')
  })

  /**
   * Client request 2026-09-29: "should have filter in every summary". The
   * company, bank and eligibility dropdowns now live on the TOTALS screen too,
   * and choosing one narrows the cards rather than opening the list.
   */
  it('stays on TOTALS when only the company, bank or eligibility narrows it', () => {
    expect(dashboardScreen({ ...NOTHING, base: { company: 'c1' } })).toBe('TOTALS')
    expect(dashboardScreen({ ...NOTHING, base: { cashAccount: 'a1' } })).toBe('TOTALS')
    expect(dashboardScreen({ ...NOTHING, base: { eligibility: 'SUPPLIER' } })).toBe('TOTALS')
    expect(dashboardScreen({
      ...NOTHING, base: { company: 'c1', cashAccount: 'a1', eligibility: 'SUPPLIER' },
    })).toBe('TOTALS')
  })

  it('opens the LIST for a card, all checks, the incomplete toggle, the live list, or a search', () => {
    expect(dashboardScreen({ ...NOTHING, status: 'SIGNED' })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, showAll: true })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, incomplete: true })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, live: true })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, base: { q: '6000351234' } })).toBe('LIST')
    // A search on a narrowed TOTALS screen opens the list narrowed the same way.
    expect(dashboardScreen({ ...NOTHING, base: { company: 'c1', q: '6000351234' } })).toBe('LIST')
  })

  // Fails closed: a filter the TOTALS screen does not read must open the list,
  // or the next filter added to `base` silently renders as unnarrowed totals.
  it('opens the LIST for any base key other than the three TOTALS filters', () => {
    expect(dashboardScreen({ ...NOTHING, base: { payee: 'X' } })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, base: { releasedFrom: '2026-09-01' } })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, base: { company: 'c1', payee: 'X' } })).toBe('LIST')
  })
})

/**
 * BACK TO TOTALS keeps the narrowing (review, 2026-09-29). Narrowing to STK,
 * opening SIGNED and coming back must land on STK's totals — the bare `/` it
 * used to link to lost the filter the reader had just chosen on every round trip.
 */
describe('totalsHref', () => {
  it('keeps the company, bank and eligibility and nothing else', () => {
    const sel: DashboardSelection = {
      ...NOTHING, status: 'SIGNED', incomplete: true, live: true,
      base: { q: 'ACME', company: 'c1', cashAccount: 'a1', eligibility: 'SUPPLIER', releasedFrom: '2026-09-01' },
    }
    expect(totalsHref(sel)).toBe('/?company=c1&cashAccount=a1&eligibility=SUPPLIER')
  })

  it('is the bare dashboard when nothing was narrowed', () => {
    expect(totalsHref(NOTHING)).toBe('/')
    expect(totalsHref({ ...NOTHING, showAll: true, base: { q: 'ACME' } })).toBe('/')
  })

  it('is a URL that opens the TOTALS screen', () => {
    const back = new URL(totalsHref({ ...NARROWED, status: 'SIGNED' }), 'http://x')
    const base = Object.fromEntries(back.searchParams)
    expect(dashboardScreen({ ...NOTHING, base })).toBe('TOTALS')
  })
})

/**
 * `scope=live`: the NEEDS ACTION list, said out loud.
 *
 * NEEDS ACTION has no card. Before the TOTALS screen had filters it was reached
 * only by the search box, and `/?company=c1` opened it narrowed; now that URL is
 * the TOTALS for one company, so the list's filter bar carries this marker and
 * filtering inside the list cannot bounce the reader back to the totals.
 */
describe('scope=live', () => {
  const LIVE: DashboardSelection = { ...NOTHING, live: true }

  it('changes no filter and no wording: it is NEEDS ACTION, as a list', () => {
    expect(viewStatusFilter(LIVE)).toEqual(viewStatusFilter(NOTHING))
    expect(describeView(LIVE)).toBe(describeView(NOTHING))
  })

  it('is carried by every link that rebuilds the selection', () => {
    expect(dashboardHref(LIVE)).toBe('/?scope=live')
    expect(clearFiltersHref({ ...LIVE, base: { q: 'ACME', company: 'c1' } })).toBe('/?scope=live')
    expect(incompleteHref(LIVE)).toBe('/?scope=live&incomplete=1')
    expect(exportHref(LIVE)).toBe('/api/export?scope=live')
    expect(printHref(LIVE)).toBe('/print?scope=live')
    expect(dashboardHref({ ...LIVE, base: { company: 'c1' } })).toBe('/?company=c1&scope=live')
  })

  it('is not written beside a status or the all-checks scope, which already open the list', () => {
    expect(dashboardHref({ ...LIVE, status: 'SIGNED' })).toBe('/?status=SIGNED')
    expect(dashboardHref({ ...LIVE, showAll: true })).toBe('/?scope=all')
    expect(cardHref('SIGNED', LIVE)).toBe('/?status=SIGNED')
  })

  it('is dropped by the RELEASE ALL links, which live on the totals screen', () => {
    // Fed a selection that HAS `live` set, so the test fails if either link
    // ever starts passing it: the panel sits on the TOTALS, and `scope=live`
    // there would turn the screen the reader is confirming on into the list.
    expect(releaseConfirmHref(LIVE)).toBe(`/?confirm=release#${TODAYS_RELEASE_ANCHOR}`)
    expect(releaseCancelHref(LIVE)).toBe(`/#${TODAYS_RELEASE_ANCHOR}`)
    expect(releaseConfirmHref({ ...LIVE, base: { company: 'c1' } }))
      .toBe(`/?company=c1&confirm=release#${TODAYS_RELEASE_ANCHOR}`)
    expect(releaseCancelHref({ ...LIVE, base: { company: 'c1' } }))
      .toBe(`/?company=c1#${TODAYS_RELEASE_ANCHOR}`)
  })
})

describe('SIGN ALL links', () => {
  it('confirm keeps the view and the narrowing and adds confirm=sign', () => {
    const s: DashboardSelection = { status: 'SIGNATURE_PENDING', showAll: false, incomplete: false, live: false, base: { company: 'c1' } }
    expect(signAllConfirmHref(s)).toBe('/?company=c1&status=SIGNATURE_PENDING&confirm=sign')
    expect(signAllCancelHref(s)).toBe('/?company=c1&status=SIGNATURE_PENDING')
  })
})

describe('signAllOffered', () => {
  const PENDING = { status: 'SIGNATURE_PENDING' as const, showAll: false, q: '', incomplete: false, refused: false }

  it('is offered on SIGNATURE PENDING with nothing else set', () => {
    expect(signAllOffered(PENDING)).toBe(true)
  })
  it('is not offered while a filter is refused', () => {
    expect(signAllOffered({ ...PENDING, refused: true })).toBe(false)
  })
  it('is not offered with a search', () => {
    expect(signAllOffered({ ...PENDING, q: 'acme' })).toBe(false)
  })
  it('is not offered with the incomplete toggle on', () => {
    expect(signAllOffered({ ...PENDING, incomplete: true })).toBe(false)
  })
  it('is not offered on ALL CHECKS', () => {
    expect(signAllOffered({ ...PENDING, status: null, showAll: true })).toBe(false)
    expect(signAllOffered({ ...PENDING, showAll: true })).toBe(false)
  })
  it('is not offered on another status', () => {
    expect(signAllOffered({ ...PENDING, status: 'SIGNED' })).toBe(false)
    expect(signAllOffered({ ...PENDING, status: 'READY_FOR_RELEASE' })).toBe(false)
  })
})

describe('the sort in the URL', () => {
  const SORTED: DashboardSelection = { ...NARROWED, status: 'SIGNED', sort: { key: 'amount', dir: 'asc' } }

  it('rides along on a card, after the view', () => {
    expect(cardHref('RELEASED', SORTED))
      .toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=RELEASED&sort=amount&dir=asc')
  })

  it('rides along on the incomplete toggle, the export, the print and the way back', () => {
    expect(incompleteHref(SORTED))
      .toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=SIGNED&incomplete=1&sort=amount&dir=asc')
    expect(exportHref(SORTED)).toBe(`${EXPORT_PATH}?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=SIGNED&sort=amount&dir=asc`)
    expect(dashboardHref(SORTED)).toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=SIGNED&sort=amount&dir=asc')
  })

  it('rides along on SIGN ALL confirm and cancel', () => {
    expect(signAllConfirmHref(SORTED)).toContain('sort=amount&dir=asc')
    expect(signAllConfirmHref(SORTED)).toContain('confirm=sign')
    expect(signAllCancelHref(SORTED)).toContain('sort=amount&dir=asc')
    expect(signAllCancelHref(SORTED)).not.toContain('confirm')
  })

  it('is dropped by RESET and by BACK TO TOTALS', () => {
    expect(clearFiltersHref(SORTED)).toBe('/?status=SIGNED')
    expect(totalsHref(SORTED)).toBe('/?company=c1&cashAccount=a1&eligibility=ELIGIBLE')
  })

  it('opens the LIST on its own, and so does any f.* filter', () => {
    expect(dashboardScreen({ ...NOTHING, sort: { key: 'amount', dir: 'asc' } })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, base: { company: 'c1', 'f.payee': 'henkel' } })).toBe('LIST')
  })
})
