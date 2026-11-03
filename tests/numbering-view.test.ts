import { describe, it, expect } from 'vitest'
import {
  numberingHref, isMissingOnly, visibleEntries, describeNumberingFilters, missingLabel, numberingFilename,
  registerOnlyLine, noBookLine, unbookedShown, numberingTotals, totalChecksLine, NUMBERING_EXPORT_PATH, NUMBERING_SCOPE_NOTE,
} from '@/lib/numbering-view'
import type { SeriesEntry } from '@/lib/numbering/series'

describe('Acumatica only (spec §G2)', () => {
  it('the scope note says each series is built from Acumatica and register-only checks are not shown', () => {
    expect(NUMBERING_SCOPE_NOTE).toContain(
      "Each series is one check book, built from Acumatica's own check numbers and cash accounts (e.g. BPI-S-4636); checks that exist only in the old register are not shown.")
    expect(NUMBERING_SCOPE_NOTE).not.toContain('CashAccount column')
  })
  it('registerOnlyLine states the count, singular and plural', () => {
    expect(registerOnlyLine(1)).toBe('1 REGISTER-ONLY CHECK (NOT IN ACUMATICA) IS NOT SHOWN.')
    expect(registerOnlyLine(1102)).toBe('1,102 REGISTER-ONLY CHECKS (NOT IN ACUMATICA) ARE NOT SHOWN.')
    expect(registerOnlyLine(0)).toBe('0 REGISTER-ONLY CHECKS (NOT IN ACUMATICA) ARE NOT SHOWN.')
  })
})

describe('numberingHref', () => {
  it('writes only what is set, in a fixed order', () => {
    expect(numberingHref({})).toBe('/numbering')
    expect(numberingHref({ company: 'c1', account: 'a1', missing: true })).toBe('/numbering?company=c1&account=a1&missing=1')
    expect(numberingHref({ account: ' ', missing: false })).toBe('/numbering')
    expect(numberingHref({ account: 'a1' }, NUMBERING_EXPORT_PATH)).toBe('/api/export/numbering?account=a1')
  })
})

describe('isMissingOnly', () => {
  it('is true only for exactly 1', () => {
    expect(isMissingOnly('1')).toBe(true)
    expect(isMissingOnly(' 1 ')).toBe(true)
    expect(isMissingOnly('true')).toBe(false)
    expect(isMissingOnly(undefined)).toBe(false)
    expect(isMissingOnly(null)).toBe(false)
  })
})

describe('visibleEntries', () => {
  const cheque: SeriesEntry = { kind: 'CHECK', duplicate: false, noBook: false, cheque: { id: 'x', checkNumber: '1', checkDate: null, payeeName: null, amount: null, currency: 'PHP', status: 'VOIDED', cv: null } }
  const gap: SeriesEntry = { kind: 'MISSING', from: '2', to: '3', count: '2' }
  it('keeps everything, or only the MISSING lines', () => {
    expect(visibleEntries([cheque, gap], false)).toEqual([cheque, gap])
    expect(visibleEntries([cheque, gap], true)).toEqual([gap])
  })
  it('MISSING ONLY keeps a MISSING number listed on its own line too (spec §H)', () => {
    const number = { kind: 'MISSING_NUMBER', number: '2', note: null } as const
    const staged = { kind: 'STAGED' } as const
    expect(visibleEntries([cheque, number, staged, gap], true)).toEqual([number, gap])
  })
})

describe('labels', () => {
  it('describes the filters', () => {
    expect(describeNumberingFilters({})).toBe('No filters applied')
    expect(describeNumberingFilters({ company: 'STK', account: 'BPI STK', missingOnly: true })).toBe('COMPANY: STK  ·  CHECK BOOK: BPI STK  ·  MISSING ONLY')
  })
  it('a missing run reads as a range, a single number as itself', () => {
    expect(missingLabel({ from: '6000354301', to: '6000354349', count: '49' })).toBe('6000354301 – 6000354349 · MISSING · 49')
    expect(missingLabel({ from: '102', to: '102', count: '1' })).toBe('102 · MISSING · 1')
  })
  it('names the file by the Manila day', () => {
    expect(numberingFilename('2026-10-01')).toBe('check-numbering-2026-10-01.xlsx')
  })
})

describe('NO CHECK BOOK (spec §I)', () => {
  const entry = (id: string, noBook: boolean): SeriesEntry =>
    ({ kind: 'CHECK', duplicate: false, noBook, cheque: { id, checkNumber: '1', checkDate: null, payeeName: null, amount: null, currency: 'PHP', status: 'SIGNED', cv: null } })
  it('unbookedShown counts distinct no-book checks across the series — one in two books counts once', () => {
    const a = { series: { entries: [entry('own', false), entry('p1', true), entry('p2', true)] } }
    const b = { series: { entries: [entry('p1', true), { kind: 'MISSING', from: '2', to: '3', count: '2' } as SeriesEntry] } }
    expect(unbookedShown([a, b])).toBe(2)
    expect(unbookedShown([])).toBe(0)
  })
  it('noBookLine states the count and how many are shown, singular and plural', () => {
    expect(noBookLine(1027, 1026)).toBe(
      '1,027 CHECKS WITH NO CHECK BOOK (ACUMATICA POSTED THEM ON A CASH ACCOUNT SUCH AS PAYROLL): 1,026 SHOWN IN THE SERIES THEIR NUMBER FALLS IN, TAGGED NO CHECK BOOK; THE REST ARE OUTSIDE EVERY BOOK\'S RANGE AND IN NO SERIES.')
    expect(noBookLine(1, 1)).toContain('1 CHECK WITH NO CHECK BOOK')
    expect(noBookLine(1, 1)).toContain('1 SHOWN IN THE SERIES ITS NUMBER FALLS IN')
  })
  it('the scope note says a no-book check is shown where its number falls', () => {
    expect(NUMBERING_SCOPE_NOTE).toContain('tagged NO CHECK BOOK, in every series whose numbers span it')
  })
})

describe('TOTAL over the books (user request 2026-11-03)', () => {
  const book = (held: number, missingNumbers: string, ticked: string, extra: Partial<Record<string, number>> = {}) => ({
    series: { summary: { held, voided: 0, cancelled: 0, staged: 0, missingNumbers, missingRuns: 0, notNumeric: 0, outOfPattern: 0, noBook: 0, ...extra } },
    inventory: { ticked },
  })
  it('numberingTotals sums every count column, big ones as decimal strings', () => {
    const t = numberingTotals([
      book(5000, '11913041270', '3', { voided: 2, missingRuns: 4, noBook: 1 }),
      book(6043, '12', '9007199254740993', { cancelled: 1, staged: 3, notNumeric: 1, outOfPattern: 2, missingRuns: 1 }),
    ])
    expect(t).toEqual({
      books: 2, held: 11043, voided: 2, cancelled: 1, staged: 3, missingNumbers: '11913041282', missingRuns: 5,
      ticked: '9007199254740996', notNumeric: 1, outOfPattern: 2, noBook: 1,
    })
    expect(numberingTotals([])).toMatchObject({ books: 0, held: 0, missingNumbers: '0', ticked: '0' })
  })
  it('totalChecksLine reads the held total and the book count, singular and plural', () => {
    expect(totalChecksLine({ books: 9, held: 11043 })).toBe('TOTAL CHECKS: 11,043 HELD IN 9 CHECK BOOKS')
    expect(totalChecksLine({ books: 1, held: 1 })).toBe('TOTAL CHECKS: 1 HELD IN 1 CHECK BOOK')
  })
})
