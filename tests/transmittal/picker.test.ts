import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PREFS, NO_FILTERS, PICK_COLUMNS, filterCandidates, filterErrors, moveColumn, readPrefs, sortCandidates,
  visibleColumns, type TransmittalCandidate,
} from '@/lib/transmittal-picker'

const row = (o: Partial<TransmittalCandidate>): TransmittalCandidate => ({
  id: o.checkNumber ?? 'x', checkNumber: '1', cashAccount: 'BPI-S-4636', poNumber: '', voucher: '', payee: 'ACME',
  amount: '100.00', currency: 'PHP', status: 'SIGNED', company: 'STK', ...o,
})
const ROWS = [
  row({ checkNumber: '1791406000', payee: 'Save Plus', amount: '180521.15', voucher: 'AP-A1015281', poNumber: '23X09-0341' }),
  row({ checkNumber: '600033188', payee: 'PLDT, Inc.', amount: '8960.00', company: 'HAMFI', status: 'SIGNATURE_PENDING' }),
  row({ checkNumber: '1790405938', payee: 'Garisons Enterprise', amount: '3928.57' }),
  row({ checkNumber: '1791259540', payee: 'Starkson Packaging', amount: null }),
  row({ checkNumber: '1700000001', payee: 'Old Release', amount: '10.00', status: 'RELEASED' }),
]
const ids = (rs: readonly TransmittalCandidate[]) => rs.map((r) => r.checkNumber)

describe('filterCandidates', () => {
  it('ALL is pending + signed; RELEASED only on its own choice', () => {
    expect(ids(filterCandidates(ROWS, 'ALL', NO_FILTERS))).not.toContain('1700000001')
    expect(ids(filterCandidates(ROWS, 'RELEASED', NO_FILTERS))).toEqual(['1700000001'])
    expect(ids(filterCandidates(ROWS, 'SIGNATURE_PENDING', NO_FILTERS))).toEqual(['600033188'])
  })

  it('text boxes are case-insensitive "contains", and combine', () => {
    expect(ids(filterCandidates(ROWS, 'ALL', { ...NO_FILTERS, payee: 'plus' }))).toEqual(['1791406000'])
    expect(ids(filterCandidates(ROWS, 'ALL', { ...NO_FILTERS, voucher: 'a1015', payee: 'save' }))).toEqual(['1791406000'])
    expect(ids(filterCandidates(ROWS, 'ALL', { ...NO_FILTERS, checkNumber: '4059' }))).toEqual(['1790405938'])
  })

  it('company is exact', () => {
    expect(ids(filterCandidates(ROWS, 'ALL', { ...NO_FILTERS, company: 'HAMFI' }))).toEqual(['600033188'])
  })

  it('an amount range compares in centavos, accepts grouped input and excludes a no-amount row', () => {
    expect(ids(filterCandidates(ROWS, 'ALL', { ...NO_FILTERS, amountMin: '3,928.57', amountMax: '8960' })).sort())
      .toEqual(['1790405938', '600033188'])
    expect(ids(filterCandidates(ROWS, 'ALL', { ...NO_FILTERS, amountMin: '0' }))).not.toContain('1791259540')
  })

  it('an unreadable amount box matches nothing instead of widening', () => {
    expect(filterErrors({ ...NO_FILTERS, amountMin: '12x' })).toEqual({ amountMin: true, amountMax: false })
    expect(filterCandidates(ROWS, 'ALL', { ...NO_FILTERS, amountMin: '12x' })).toEqual([])
  })
})

describe('sortCandidates', () => {
  it('orders check numbers numerically and amounts by value, a missing amount last either way', () => {
    const base = filterCandidates(ROWS, 'ALL', NO_FILTERS)
    expect(ids(sortCandidates(base, { column: 'checkNumber', dir: 'asc' }))[0]).toBe('600033188')
    expect(ids(sortCandidates(base, { column: 'amount', dir: 'desc' }))).toEqual(['1791406000', '600033188', '1790405938', '1791259540'])
    expect(ids(sortCandidates(base, { column: 'amount', dir: 'asc' }))).toEqual(['1790405938', '600033188', '1791406000', '1791259540'])
  })
})

describe('column preferences', () => {
  it('the default shows every column once, the sheet columns first', () => {
    expect([...DEFAULT_PREFS.order].sort()).toEqual([...PICK_COLUMNS].sort())
    expect(visibleColumns(DEFAULT_PREFS)).toHaveLength(PICK_COLUMNS.length)
  })

  it('reads a stored value defensively', () => {
    expect(readPrefs(null)).toEqual(DEFAULT_PREFS)
    expect(readPrefs('nonsense')).toEqual(DEFAULT_PREFS)
    const p = readPrefs({ order: ['amount', 'bogus', 'amount', 'payee'], hidden: ['status', 'nope'], widths: { payee: 9999, amount: 5, status: 'x' } })
    expect(p.order.slice(0, 2)).toEqual(['amount', 'payee'])
    expect(p.order).toHaveLength(PICK_COLUMNS.length) // missing columns appended
    expect(p.hidden).toEqual(['status'])
    expect(p.widths).toEqual({ payee: 600, amount: 60 })
  })

  it('never hides every column', () => {
    expect(readPrefs({ hidden: [...PICK_COLUMNS] }).hidden).toEqual([])
  })

  it('moves a column one place and stops at the ends', () => {
    expect(moveColumn(['checkNumber', 'payee', 'amount'] as never, 'payee', -1)).toEqual(['payee', 'checkNumber', 'amount'])
    expect(moveColumn(['checkNumber', 'payee'] as never, 'checkNumber', -1)).toEqual(['checkNumber', 'payee'])
  })
})
