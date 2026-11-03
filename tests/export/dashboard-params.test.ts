import { describe, it, expect } from 'vitest'
import { resolveDashboardQuery } from '@/lib/dashboard-params'
import { LIVE_STATUSES } from '@/lib/domain/check-status'
import type { FilterOptions } from '@/lib/queries'
import { FILTER_MESSAGES } from '@/lib/column-filters'
import { DEFAULT_SORT } from '@/lib/list-sort'
import { dashboardScreen } from '@/lib/dashboard-view'

const options: FilterOptions = {
  companies: [
    { id: 'co-stk', code: 'STK', name: 'Starkson Packaging Inc.' },
    { id: 'co-a1', code: 'A1+', name: 'A1 Plus' },
  ],
  cashAccounts: [
    { id: 'ca-bpi', code: 'BPI STK', bankCode: 'BPI' },
    { id: 'ca-main', code: 'STK MAIN', bankCode: 'BDO' },
  ],
}

describe('resolveDashboardQuery', () => {
  it('defaults to NEEDS ACTION with nothing narrowing it', () => {
    const r = resolveDashboardQuery({}, options)
    expect(r.filters.statusIn).toEqual(LIVE_STATUSES)
    expect(r.filters.status).toBeUndefined()
    expect(r.selection).toEqual({ status: null, showAll: false, incomplete: false, live: false, base: {} })
    expect(r.viewLabel).toBe('NEEDS ACTION')
    /**
     * SUPERSEDED BY A CLIENT DECISION, 2026-09-06: this was 'No filters
     * applied'. The default view now EXCLUDES the 129 cheques with no recorded
     * amount, so the export's title block has something to declare even when the
     * reader has touched nothing. `filters.incomplete` is `false`, not
     * `undefined` — the tri-state's "exclude", not its "do not filter".
     */
    expect(r.filters.incomplete).toBe(false)
    expect(r.filterDescription).toBe('EXCLUDES RECORDS WITH NO AMOUNT')
  })

  it('reads scope=live as the NEEDS ACTION list, as a list, and nothing more', () => {
    const r = resolveDashboardQuery({ scope: 'live' }, options)
    expect(r.selection.live).toBe(true)
    expect(r.selection.showAll).toBe(false)
    expect(r.filters.statusIn).toEqual(LIVE_STATUSES)
    expect(r.filters.status).toBeUndefined()
    expect(r.viewLabel).toBe('NEEDS ACTION')
  })

  it('does not read scope=all, or any other scope, as live', () => {
    expect(resolveDashboardQuery({ scope: 'all' }, options).selection.live).toBe(false)
    expect(resolveDashboardQuery({ scope: 'everything' }, options).selection.live).toBe(false)
  })

  /**
   * The line the TOTALS screen prints under its filter bar. Only the three
   * dropdowns that screen has — never the search, never the incomplete toggle,
   * which the screen states on its own line with a count.
   */
  it('describes the narrowing the totals screen applies', () => {
    const r = resolveDashboardQuery(
      { company: 'co-stk', cashAccount: 'ca-bpi', eligibility: 'SUPPLIER', q: 'henkel', incomplete: '1' },
      options,
    )
    expect(r.narrowingDescription).toBe('COMPANY: STK  ·  BANK / CASH ACCOUNT: BPI STK  ·  ELIGIBILITY: SUPPLIER')
    expect(resolveDashboardQuery({ cashAccount: 'ca-main' }, options).narrowingDescription)
      .toBe('BANK / CASH ACCOUNT: STK MAIN (BDO)')
    expect(resolveDashboardQuery({}, options).narrowingDescription).toBe('No filters applied')
  })

  it('folds SCHEDULED into the READY FOR RELEASE view', () => {
    const r = resolveDashboardQuery({ status: 'READY_FOR_RELEASE' }, options)
    expect(r.filters.statusIn).toEqual(['READY_FOR_RELEASE', 'SCHEDULED'])
    expect(r.viewLabel).toBe('READY FOR RELEASE')
  })

  it('opens every status for scope=all', () => {
    const r = resolveDashboardQuery({ scope: 'all' }, options)
    expect(r.filters.status).toBeUndefined()
    expect(r.filters.statusIn).toBeUndefined()
    expect(r.viewLabel).toBe('ALL CHECKS')
  })

  // The parsers answer `undefined` for anything they do not recognise, which
  // buildWhere reads as "do not filter". A stale bookmark must open the
  // dashboard unfiltered, never hand Prisma an invalid enum value.
  it('drops an unrecognised status, company, cash account and eligibility', () => {
    const r = resolveDashboardQuery({
      status: 'DELETED', company: 'co-gone', cashAccount: 'ca-gone', eligibility: 'MAYBE',
    }, options)
    expect(r.filters.status).toBeUndefined()
    expect(r.filters.companyId).toBeUndefined()
    expect(r.filters.cashAccountId).toBeUndefined()
    expect(r.filters.eligibility).toBeUndefined()
    // Dropped from the carried-forward filters too, not only from the query.
    expect(r.selection.base).toEqual({})
    // The one thing left to declare is the default exclusion — see above.
    expect(r.filterDescription).toBe('EXCLUDES RECORDS WITH NO AMOUNT')
  })

  it('resolves a company and cash account to the labels a reader recognises', () => {
    const r = resolveDashboardQuery(
      { company: 'co-stk', cashAccount: 'ca-main', eligibility: 'SUPPLIER', q: '  henkel  ' },
      options,
    )
    expect(r.filters.companyId).toBe('co-stk')
    expect(r.filters.cashAccountId).toBe('ca-main')
    expect(r.filters.q).toBe('henkel')
    expect(r.filterDescription).toBe(
      'COMPANY: STK  ·  BANK / CASH ACCOUNT: STK MAIN (BDO)  ·  ELIGIBILITY: SUPPLIER  ·  SEARCH: "henkel"'
      + '  ·  EXCLUDES RECORDS WITH NO AMOUNT',
    )
  })

  it('turns the incomplete toggle on only for the exact value the checkbox submits', () => {
    expect(resolveDashboardQuery({ incomplete: '1' }, options).filters.incomplete).toBe(true)
    expect(resolveDashboardQuery({ incomplete: 'true' }, options).filters.incomplete).toBe(false)
    expect(resolveDashboardQuery({ incomplete: '0' }, options).filters.incomplete).toBe(false)
  })

  it('leaves an empty search out of the query rather than filtering on nothing', () => {
    expect(resolveDashboardQuery({ q: '   ' }, options).filters.q).toBeUndefined()
    expect(resolveDashboardQuery({ q: '   ' }, options).q).toBe('')
  })

  it('carries the narrowing filters, but not the view, in `base`', () => {
    const r = resolveDashboardQuery(
      { q: 'henkel', company: 'co-stk', status: 'SIGNED', scope: 'all', incomplete: '1' },
      options,
    )
    expect(r.selection.base).toEqual({ q: 'henkel', company: 'co-stk' })
    expect(r.selection.status).toBe('SIGNED')
    expect(r.selection.showAll).toBe(true)
    expect(r.selection.incomplete).toBe(true)
  })

  /**
   * DATE RELEASED. Honoured on the two views that can contain a released
   * cheque — RELEASED and ALL CHEQUES — and dropped everywhere else exactly as
   * an unrecognised company id is: a live cheque has no release instant, and a
   * range on SIGNED could only empty the table without saying why.
   */
  describe('the DATE RELEASED range', () => {
    it('becomes inclusive Manila-day bounds on the RELEASED view, and rides in `base`', () => {
      const r = resolveDashboardQuery(
        { status: 'RELEASED', releasedFrom: '2026-09-01', releasedTo: '2026-09-15' },
        options,
      )
      expect(r.filters.releasedFrom).toEqual(new Date('2026-08-31T16:00:00.000Z'))
      expect(r.filters.releasedTo).toEqual(new Date('2026-09-15T15:59:59.999Z'))
      expect(r.releasedFrom).toBe('2026-09-01')
      expect(r.releasedTo).toBe('2026-09-15')
      expect(r.selection.base).toEqual({ releasedFrom: '2026-09-01', releasedTo: '2026-09-15' })
      expect(r.filterDescription).toBe('DATE RELEASED: 2026-09-01 TO 2026-09-15  ·  EXCLUDES RECORDS WITH NO AMOUNT')
    })

    it('accepts either bound alone', () => {
      const from = resolveDashboardQuery({ status: 'RELEASED', releasedFrom: '2026-09-01' }, options)
      expect(from.filters.releasedFrom).toEqual(new Date('2026-08-31T16:00:00.000Z'))
      expect(from.filters.releasedTo).toBeUndefined()
      expect(from.selection.base).toEqual({ releasedFrom: '2026-09-01' })

      const to = resolveDashboardQuery({ status: 'RELEASED', releasedTo: '2026-09-15' }, options)
      expect(to.filters.releasedFrom).toBeUndefined()
      expect(to.filters.releasedTo).toEqual(new Date('2026-09-15T15:59:59.999Z'))
      expect(to.selection.base).toEqual({ releasedTo: '2026-09-15' })
    })

    it('applies on ALL CHECKS too', () => {
      const r = resolveDashboardQuery({ scope: 'all', releasedFrom: '2026-09-01' }, options)
      expect(r.filters.releasedFrom).toEqual(new Date('2026-08-31T16:00:00.000Z'))
      expect(r.selection.base).toEqual({ releasedFrom: '2026-09-01' })
    })

    it('is dropped — from the filters, `base` and the description — on every other view', () => {
      for (const params of [
        { releasedFrom: '2026-09-01', releasedTo: '2026-09-15' },                       // NEEDS ACTION
        { status: 'SIGNED', releasedFrom: '2026-09-01', releasedTo: '2026-09-15' },
        { status: 'READY_FOR_RELEASE', releasedFrom: '2026-09-01' },
        { status: 'SIGNATURE_PENDING', releasedTo: '2026-09-15' },
      ]) {
        const r = resolveDashboardQuery(params, options)
        expect(r.filters.releasedFrom).toBeUndefined()
        expect(r.filters.releasedTo).toBeUndefined()
        expect(r.releasedFrom).toBe('')
        expect(r.releasedTo).toBe('')
        expect(r.selection.base).toEqual({})
        expect(r.filterDescription).toBe('EXCLUDES RECORDS WITH NO AMOUNT')
      }
    })

    // A hand-edited or half-typed value opens the view unfiltered, never a 500
    // — the same contract every other parameter on this URL has.
    // Since part C (2026-10-01) a day that is not a day REFUSES rather than
    // silently opening the view unfiltered — an ignored filter reads as applied.
    it('refuses a value that is not a real calendar day, and keeps it to render back', () => {
      for (const bad of ['2026-02-30', '25/09/2026', '2026-9-1', 'today']) {
        const r = resolveDashboardQuery({ status: 'RELEASED', releasedFrom: bad }, options)
        expect(r.refused, bad).toBe(true)
        expect(r.filters.refused).toBe(true)
        expect(r.filterErrors).toEqual({ releasedFrom: FILTER_MESSAGES.day })
        expect(r.selection.base).toEqual({ releasedFrom: bad })
      }
      expect(resolveDashboardQuery({ status: 'RELEASED', releasedFrom: '' }, options).refused).toBe(false)
    })

    it('refuses a TO that is not a real calendar day, and keeps it to render back', () => {
      for (const bad of ['2026-02-30', '25/09/2026', '2026-9-1', 'today']) {
        const r = resolveDashboardQuery({ status: 'RELEASED', releasedTo: bad }, options)
        expect(r.refused, bad).toBe(true)
        expect(r.filters.refused).toBe(true)
        expect(r.filterErrors).toEqual({ releasedTo: FILTER_MESSAGES.day })
        expect(r.selection.base).toEqual({ releasedTo: bad })
      }
      expect(resolveDashboardQuery({ status: 'RELEASED', releasedTo: '' }, options).refused).toBe(false)
    })

    // Not swapped: the honest answer to a backwards question is an empty table,
    // and the title block says what was asked.
    it('keeps FROM after TO as given rather than swapping them', () => {
      const r = resolveDashboardQuery(
        { status: 'RELEASED', releasedFrom: '2026-09-15', releasedTo: '2026-09-01' },
        options,
      )
      expect(r.filters.releasedFrom).toEqual(new Date('2026-09-14T16:00:00.000Z'))
      expect(r.filters.releasedTo).toEqual(new Date('2026-09-01T15:59:59.999Z'))
      expect(r.filterDescription).toBe('DATE RELEASED: 2026-09-15 TO 2026-09-01  ·  EXCLUDES RECORDS WITH NO AMOUNT')
    })
  })

  // The URL parameters `URLSearchParams` hands back are strings or null; the
  // page's own searchParams give strings or undefined. One resolver takes both.
  it('reads a URLSearchParams as readily as a plain object', () => {
    const sp = new URLSearchParams('status=SIGNED&company=co-stk&incomplete=1')
    const r = resolveDashboardQuery(
      {
        status: sp.get('status') ?? undefined,
        company: sp.get('company') ?? undefined,
        incomplete: sp.get('incomplete') ?? undefined,
      },
      options,
    )
    expect(r.filters.status).toBe('SIGNED')
    expect(r.filters.companyId).toBe('co-stk')
    expect(r.filters.incomplete).toBe(true)
  })

  describe('the column filters', () => {
    it('reads the FIRST value of a repeated key (Next hands it to the page as string[]) and never throws', () => {
      const r = resolveDashboardQuery(
        { status: 'SIGNED', 'f.payee': ['henkel', 'other'], q: ['  first  ', 'second'] },
        options,
      )
      expect(r.filters.payeeContains).toBe('henkel')
      expect(r.columnValues).toEqual({ 'f.payee': 'henkel' })
      expect(r.q).toBe('first')
      expect(r.filters.q).toBe('first')
      expect(r.refused).toBe(false)
    })

    it('reach the filters, ride in base and open the list', () => {
      const r = resolveDashboardQuery({ status: 'SIGNED', 'f.payee': ' henkel ', 'f.amountMin': '1,000' }, options)
      expect(r.filters.payeeContains).toBe('henkel')
      expect(r.filters.amountMin).toBe('1000')
      expect(r.selection.base).toEqual({ 'f.payee': 'henkel', 'f.amountMin': '1,000' })
      expect(r.columnValues).toEqual({ 'f.payee': 'henkel', 'f.amountMin': '1,000' })
      expect(r.refused).toBe(false)
      expect(dashboardScreen(resolveDashboardQuery({ 'f.payee': 'henkel' }, options).selection)).toBe('LIST')
    })

    it('refuses an unreadable value: nothing listed, the value kept everywhere', () => {
      const r = resolveDashboardQuery({ scope: 'all', 'f.amountMax': '12x' }, options)
      expect(r.refused).toBe(true)
      expect(r.filters.refused).toBe(true)
      expect(r.filterErrors).toEqual({ 'f.amountMax': FILTER_MESSAGES.amount })
      expect(r.selection.base).toEqual({ 'f.amountMax': '12x' })
    })

    it('applies STATUS on ALL CHECKS only, without changing the view', () => {
      const all = resolveDashboardQuery({ scope: 'all', 'f.status': 'SIGNED' }, options)
      expect(all.filters.status).toBe('SIGNED')
      expect(all.selection.status).toBeNull()
      expect(all.selection.base).toEqual({ 'f.status': 'SIGNED' })
      const signed = resolveDashboardQuery({ status: 'RELEASED', 'f.status': 'SIGNED' }, options)
      expect(signed.filters.status).toBe('RELEASED')
      expect(signed.selection.base).toEqual({})
      expect(signed.refused).toBe(false)
    })

    it('applies several ticked STATUS boxes on ALL CHECKS as a set', () => {
      const r = resolveDashboardQuery({ scope: 'all', 'f.status': 'SIGNED,RELEASED' }, options)
      expect(r.filters.status).toBeUndefined()
      expect(r.filters.statusIn).toEqual(['SIGNED', 'RELEASED'])
      expect(r.selection.base).toEqual({ 'f.status': 'SIGNED,RELEASED' })
      expect(r.refused).toBe(false)
    })

    it('carries company, bank and the release range in columnValues for the filter row', () => {
      const r = resolveDashboardQuery({ status: 'RELEASED', company: 'co-stk', cashAccount: 'ca-bpi', releasedTo: '2026-09-30' }, options)
      expect(r.columnValues).toEqual({ company: 'co-stk', cashAccount: 'ca-bpi', releasedTo: '2026-09-30' })
    })

    it('describes them for the title block', () => {
      const r = resolveDashboardQuery({ scope: 'all', 'f.payee': 'henkel' }, options)
      expect(r.filterDescription).toBe('SUPPLIER CONTAINS "henkel"  ·  EXCLUDES RECORDS WITH NO AMOUNT')
    })
  })

  describe('the sort', () => {
    it('defaults to check date, newest first, with nothing in force', () => {
      const r = resolveDashboardQuery({ status: 'SIGNED' }, options)
      expect(r.sort).toEqual(DEFAULT_SORT)
      expect(r.activeSort).toBeNull()
      expect(r.selection.sort).toBeUndefined()
    })

    it('reads the URL, and says a non-default sort in the title block', () => {
      const r = resolveDashboardQuery({ status: 'SIGNED', sort: 'amount', dir: 'asc' }, options)
      expect(r.sort).toEqual({ key: 'amount', dir: 'asc' })
      expect(r.selection.sort).toEqual({ key: 'amount', dir: 'asc' })
      expect(r.filterDescription).toBe('EXCLUDES RECORDS WITH NO AMOUNT  ·  SORTED BY AMOUNT (ASCENDING)')
    })

    it('falls back to the cookie when the URL names none — without putting it in the URL', () => {
      const r = resolveDashboardQuery({ status: 'SIGNED' }, options, { sortCookie: 'payeeName:desc' })
      expect(r.sort).toEqual({ key: 'payeeName', dir: 'desc' })
      expect(r.activeSort).toEqual({ key: 'payeeName', dir: 'desc' })
      expect(r.selection.sort).toBeUndefined()
    })

    it('lets the URL win over the cookie, and ignores an invalid either', () => {
      expect(resolveDashboardQuery({ sort: 'amount', dir: 'desc' }, options, { sortCookie: 'payeeName:asc' }).sort)
        .toEqual({ key: 'amount', dir: 'desc' })
      expect(resolveDashboardQuery({ sort: 'action', dir: 'asc' }, options, { sortCookie: 'payeeName:asc' }).sort)
        .toEqual({ key: 'payeeName', dir: 'asc' })
      expect(resolveDashboardQuery({}, options, { sortCookie: 'garbage' }).sort).toEqual(DEFAULT_SORT)
    })
  })
})
