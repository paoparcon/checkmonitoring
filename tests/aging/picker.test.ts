import { describe, it, expect } from 'vitest'
import {
  agingColumns, agingValue, stripTotals, inBucket, selectionTotal, effectiveSelection, bucketColumnTotals, BUCKET_COLUMN_KEYS,
} from '@/lib/aging-picker'
import { AGING_BUCKETS } from '@/lib/aging/buckets'
import type { AgingRow } from '@/lib/aging/query'

const row = (o: Partial<AgingRow>): AgingRow => ({
  id: 'x', checkNumber: '6000000001', cvNumber: 'CV-1', apvNumbers: ['AP-1'], poNumbers: ['PO-1'],
  payee: 'HENKEL', company: 'STK', bank: 'BPI-S-4636', checkDate: '2026-09-01', dueDate: '2026-10-01',
  daysPastDue: 14, bucket: 'b30', amount: '1000.10', currency: 'PHP', status: 'SIGNED', ...o,
})

const ROWS = [
  row({ id: 'a', bucket: 'current', amount: '0.10', daysPastDue: -3 }),
  row({ id: 'b', bucket: 'b30', amount: '1000.25' }),
  row({ id: 'c', bucket: 'b90plus', amount: '2000.65', daysPastDue: 120 }),
  row({ id: 'd', bucket: 'noDue', amount: '5.00', dueDate: null, daysPastDue: null }),
  row({ id: 'e', bucket: 'b30', amount: '99.00', currency: 'USD' }),
]

describe('stripTotals — every check counted, peso amounts centavo-exact', () => {
  it('counts every bucket, OVERDUE and ALL', () => {
    const t = stripTotals(ROWS)
    expect(t.buckets.current).toEqual({ count: 1, amount: '0.10' })
    expect(t.buckets.b30).toEqual({ count: 2, amount: '1,000.25' })
    expect(t.buckets.b60).toEqual({ count: 0, amount: '0.00' })
    expect(t.buckets.b90plus).toEqual({ count: 1, amount: '2,000.65' })
    expect(t.buckets.noDue).toEqual({ count: 1, amount: '5.00' })
    expect(t.overdue).toEqual({ count: 3, amount: '3,000.90' })
    expect(t.all).toEqual({ count: 5, amount: '3,006.00' })
    expect(t.nonPhp).toBe(1)
    expect(t.unpriced).toBe(0)
  })
})

describe('stripTotals — what the peso amounts leave out is counted, never dropped', () => {
  it('a null or unreadable PHP amount is counted and reported as unpriced', () => {
    const t = stripTotals([
      row({ id: 'p', bucket: 'b30', amount: '100.00' }),
      row({ id: 'q', bucket: 'b30', amount: null }),
      row({ id: 'r', bucket: 'b30', amount: '1,000.00' }),
    ])
    expect(t.buckets.b30).toEqual({ count: 3, amount: '100.00' })
    expect(t.unpriced).toBe(2)
    expect(t.nonPhp).toBe(0)
  })

  it('a negative amount is subtracted, and a negative sum keeps its sign', () => {
    const t = stripTotals([
      row({ id: 'p', bucket: 'b30', amount: '100.00' }),
      row({ id: 'q', bucket: 'b30', amount: '-250.50' }),
    ])
    expect(t.buckets.b30).toEqual({ count: 2, amount: '-150.50' })
  })
})

describe('inBucket', () => {
  it('ALL, OVERDUE and one bucket', () => {
    expect(inBucket(ROWS, 'ALL').map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(inBucket(ROWS, 'OVERDUE').map((r) => r.id)).toEqual(['b', 'c', 'e'])
    expect(inBucket(ROWS, 'noDue').map((r) => r.id)).toEqual(['d'])
  })
})

describe('selectionTotal', () => {
  it('sums the selected PHP rows', () => {
    expect(selectionTotal(ROWS, new Set(['b', 'c']))).toEqual({ count: 2, amount: '3,000.90' })
    expect(selectionTotal(ROWS, new Set(['b', 'e']))).toEqual({ count: 2, amount: '1,000.25' })
  })
})

describe('agingColumns / agingValue', () => {
  it('has the spec\'s columns in order, with dropdowns for company, bank and bucket', () => {
    const cols = agingColumns(['STK'], ['BPI-S-4636'])
    expect(cols.map((c) => c.key)).toEqual([
      'checkNumber', 'status', 'cvNumber', 'apvNumbers', 'poNumbers', 'payee', 'company', 'bank',
      'checkDate', 'dueDate', 'daysPastDue',
      'b_current', 'b_b30', 'b_b60', 'b_b90', 'b_b90plus', 'b_noDue', 'bucket', 'amount',
    ])
    expect(cols.find((c) => c.key === 'bucket')!.defaultHidden).toBe(true)
    expect(cols.find((c) => c.key === 'amount')!.defaultHidden).toBe(true)
    for (const b of AGING_BUCKETS) expect(cols.find((c) => c.key === BUCKET_COLUMN_KEYS[b])!.kind).toBe('amount')
    expect(cols.find((c) => c.key === 'bucket')!.kind).toBe('enum')
    const status = cols.find((c) => c.key === 'status')!
    expect(status.kind).toBe('enum')
    expect(status.label).toBe('STATUS')
    expect(status.defaultHidden).toBeFalsy()
    expect(status.options).toEqual([
      { value: 'SIGNED', label: 'SIGNED' },
      { value: 'READY_FOR_RELEASE', label: 'READY FOR RELEASE' },
    ])
    expect(cols.find((c) => c.key === 'company')!.options).toEqual([{ value: 'STK', label: 'STK' }])
  })

  it('reads values as the kit sorts and filters them', () => {
    const r = row({ apvNumbers: ['AP-1', 'AP-2'] })
    expect(agingValue(r, 'apvNumbers')).toBe('AP-1, AP-2')
    expect(agingValue(r, 'daysPastDue')).toBe('14')
    expect(agingValue(r, 'bucket')).toBe('b30')
    expect(agingValue(r, 'status')).toBe('SIGNED')
    expect(agingValue(row({ status: 'READY_FOR_RELEASE' }), 'status')).toBe('READY_FOR_RELEASE')
    expect(agingValue(row({ daysPastDue: null }), 'daysPastDue')).toBeNull()
  })

  it('every non-bucket column reads a value from a full row', () => {
    const r = row({})
    const bucketKeys = new Set(Object.values(BUCKET_COLUMN_KEYS))
    for (const c of agingColumns(['STK'], ['BPI-S-4636'])) {
      if (bucketKeys.has(c.key)) continue
      expect(agingValue(r, c.key), c.key).not.toBeNull()
    }
    expect(agingValue(r, 'checkDate')).toBe('2026-09-01')
    expect(agingValue(r, 'amount')).toBe('1000.10')
  })

  it('a bucket column reads the amount only for a check in that bucket', () => {
    const r = row({ bucket: 'b30', amount: '1000.10' })
    expect(agingValue(r, 'b_b30')).toBe('1000.10')
    for (const b of AGING_BUCKETS.filter((x) => x !== 'b30')) expect(agingValue(r, BUCKET_COLUMN_KEYS[b]), b).toBeNull()
  })
})

describe('bucketColumnTotals', () => {
  it('counts every row in the bucket and sums PHP amounts only', () => {
    const t = bucketColumnTotals(ROWS)
    expect(t.b30).toEqual({ count: 2, amount: '1,000.25' })
    expect(t.b90plus).toEqual({ count: 1, amount: '2,000.65' })
    expect(t.b60).toEqual({ count: 0, amount: '0.00' })
  })
})

describe('both statuses are counted', () => {
  const mixed = [
    row({ id: 's', bucket: 'b30', amount: '10.00', status: 'SIGNED' }),
    row({ id: 'r', bucket: 'b30', amount: '5.00', status: 'READY_FOR_RELEASE' }),
  ]
  it('stripTotals counts and sums both', () => {
    const t = stripTotals(mixed)
    expect(t.buckets.b30).toEqual({ count: 2, amount: '15.00' })
    expect(t.all).toEqual({ count: 2, amount: '15.00' })
  })
  it('bucketColumnTotals counts and sums both', () => {
    expect(bucketColumnTotals(mixed).b30).toEqual({ count: 2, amount: '15.00' })
  })
})

describe('effectiveSelection', () => {
  it('drops a READY_FOR_RELEASE row even when selected and on the page', () => {
    const rows = [row({ id: 's' }), row({ id: 'r', status: 'READY_FOR_RELEASE' })]
    expect(effectiveSelection(rows, new Set(['s', 'r'])).map((r) => r.id)).toEqual(['s'])
  })
  it('keeps only ids still on the page, in the rows\' order', () => {
    expect(effectiveSelection(ROWS, new Set(['c', 'gone', 'a'])).map((r) => r.id)).toEqual(['a', 'c'])
  })
  it('an empty selection submits nothing', () => {
    expect(effectiveSelection(ROWS, new Set())).toEqual([])
  })
})
