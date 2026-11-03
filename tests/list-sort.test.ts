import { describe, it, expect } from 'vitest'
import {
  SORT_KEYS, DEFAULT_SORT, APP_SORTED_KEYS, isAppSorted, SORT_COOKIE,
  parseSort, formatSortCookie, parseSortCookie, sortCookieString, readCookie,
  sameSort, describeSort, compareSortValues, dbOrderBy,
} from '@/lib/list-sort'

describe('the sort keys', () => {
  it('are every column but ACTION', () => {
    expect(SORT_KEYS).not.toContain('action')
    expect(SORT_KEYS).toContain('checkNumber')
    expect(SORT_KEYS).toContain('poNumbers')
    expect(SORT_KEYS).toContain('releasedAt')
  })

  it('order APV, PO, BANK and DATE RELEASED in the application, the rest in the database', () => {
    expect([...APP_SORTED_KEYS]).toEqual(['apvNumbers', 'poNumbers', 'bank', 'releasedAt'])
    expect(isAppSorted('bank')).toBe(true)
    expect(isAppSorted('amount')).toBe(false)
  })

  it('default to check date, newest first', () => {
    expect(DEFAULT_SORT).toEqual({ key: 'checkDate', dir: 'desc' })
  })
})

describe('parseSort', () => {
  it('reads a known key and direction', () => {
    expect(parseSort('amount', 'asc')).toEqual({ key: 'amount', dir: 'asc' })
    expect(parseSort(' payeeName ', 'desc')).toEqual({ key: 'payeeName', dir: 'desc' })
  })

  // Sort cannot widen anything, so it falls back rather than refusing.
  it('ignores an unknown key, an unknown direction, ACTION, or half a pair', () => {
    expect(parseSort('action', 'asc')).toBeNull()
    expect(parseSort('sourceSheet', 'asc')).toBeNull()
    expect(parseSort('amount', 'up')).toBeNull()
    expect(parseSort('amount', undefined)).toBeNull()
    expect(parseSort(undefined, 'asc')).toBeNull()
  })
})

describe('the remembered sort', () => {
  it('round-trips through the cookie value', () => {
    expect(formatSortCookie({ key: 'amount', dir: 'desc' })).toBe('amount:desc')
    expect(parseSortCookie('amount:desc')).toEqual({ key: 'amount', dir: 'desc' })
  })

  it('ignores a cookie it cannot read', () => {
    for (const bad of [undefined, '', 'amount', 'amount:', 'amount:desc:x', 'action:asc', 'nope:asc']) {
      expect(parseSortCookie(bad), String(bad)).toBeNull()
    }
  })

  it('writes one year, path /, SameSite=Lax — and deletes with Max-Age=0', () => {
    expect(SORT_COOKIE).toBe('cm_sort')
    expect(sortCookieString({ key: 'amount', dir: 'asc' }))
      .toBe('cm_sort=amount:asc; Path=/; Max-Age=31536000; SameSite=Lax')
    expect(sortCookieString(null)).toBe('cm_sort=; Path=/; Max-Age=0; SameSite=Lax')
  })

  it('reads one cookie out of a Cookie header', () => {
    expect(readCookie('a=1; cm_sort=amount:desc; b=2', 'cm_sort')).toBe('amount:desc')
    expect(readCookie('a=1', 'cm_sort')).toBeUndefined()
    expect(readCookie(null, 'cm_sort')).toBeUndefined()
  })
})

describe('describeSort and sameSort', () => {
  it('says the sort in words', () => {
    expect(describeSort({ key: 'amount', dir: 'asc' })).toBe('AMOUNT (ASCENDING)')
    expect(describeSort({ key: 'checkDate', dir: 'desc' })).toBe('CHECK DATE (DESCENDING)')
    expect(sameSort(DEFAULT_SORT, { key: 'checkDate', dir: 'desc' })).toBe(true)
    expect(sameSort(DEFAULT_SORT, { key: 'checkDate', dir: 'asc' })).toBe(false)
  })
})

describe('compareSortValues', () => {
  it('puts nulls last in BOTH directions', () => {
    const values = [3, null, 1, 2]
    expect([...values].sort((a, b) => compareSortValues(a, b, 'asc'))).toEqual([1, 2, 3, null])
    expect([...values].sort((a, b) => compareSortValues(a, b, 'desc'))).toEqual([3, 2, 1, null])
    expect(['B', null, 'A'].sort((a, b) => compareSortValues(a, b, 'asc'))).toEqual(['A', 'B', null])
  })
})

describe('dbOrderBy', () => {
  it('is the old default order, with id as the last tiebreak', () => {
    expect(dbOrderBy('checkDate', 'desc')).toEqual([
      { checkDate: { sort: 'desc', nulls: 'last' } }, { checkNumber: 'asc' }, { id: 'asc' },
    ])
  })

  it('puts nulls last on every nullable column, both ways', () => {
    expect(dbOrderBy('amount', 'asc')[0]).toEqual({ amount: { sort: 'asc', nulls: 'last' } })
    expect(dbOrderBy('payeeName', 'desc')[0]).toEqual({ payeeName: { sort: 'desc', nulls: 'last' } })
    expect(dbOrderBy('scheduledPickupDate', 'desc')[0]).toEqual({ scheduledPickupDate: { sort: 'desc', nulls: 'last' } })
  })

  it('orders the company by its code and the status by the ladder', () => {
    expect(dbOrderBy('companyCode', 'desc')[0]).toEqual({ company: { code: 'desc' } })
    expect(dbOrderBy('status', 'asc')[0]).toEqual({ status: 'asc' })
    expect(dbOrderBy('checkNumber', 'desc')).toEqual([{ checkNumber: 'desc' }, { id: 'asc' }])
  })
})
