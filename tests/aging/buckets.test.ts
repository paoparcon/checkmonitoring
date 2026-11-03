import { describe, it, expect } from 'vitest'
import {
  AGING_BUCKETS, AGING_LABELS, OVERDUE_BUCKETS, neverAges, daysPastDue, bucketOfDays, ageCheck,
} from '@/lib/aging/buckets'

// 15 Oct 2026, 10:00 Manila.
const NOW = new Date('2026-10-15T10:00:00+08:00')
const day = (d: string) => new Date(`${d}T00:00:00Z`)

describe('the buckets are the Supplier Portal\'s', () => {
  it('lists them in order with their labels', () => {
    expect(AGING_BUCKETS).toEqual(['current', 'b30', 'b60', 'b90', 'b90plus', 'noDue'])
    expect(AGING_BUCKETS.map((b) => AGING_LABELS[b])).toEqual([
      'CURRENT', '1–30 DAYS', '31–60 DAYS', '61–90 DAYS', 'OVER 90 DAYS', 'NO DUE DATE',
    ])
    expect(OVERDUE_BUCKETS).toEqual(['b30', 'b60', 'b90', 'b90plus'])
  })

  it.each([
    [-5, 'current'], [0, 'current'], [1, 'b30'], [30, 'b30'], [31, 'b60'], [60, 'b60'],
    [61, 'b90'], [90, 'b90'], [91, 'b90plus'], [400, 'b90plus'],
  ] as const)('%i days past due is %s', (d, bucket) => {
    expect(bucketOfDays(d)).toBe(bucket)
  })
})

describe('daysPastDue — Manila calendar days', () => {
  it('counts whole days from the due day to today', () => {
    expect(daysPastDue(day('2026-10-14'), NOW)).toBe(1)
    expect(daysPastDue(day('2026-10-15'), NOW)).toBe(0)
    expect(daysPastDue(day('2026-10-20'), NOW)).toBe(-5)
  })

  it('at 00:30 Manila it is already the 15th (UTC still says the 14th)', () => {
    expect(daysPastDue(day('2026-10-14'), new Date('2026-10-15T00:30:00+08:00'))).toBe(1)
  })

  it('a due date stored at Manila midnight is the same day as one at UTC midnight', () => {
    expect(daysPastDue(new Date('2026-10-14T00:00:00+08:00'), NOW)).toBe(1)
  })
})

describe('neverAges — COD, PDC, dated check, 100PBD', () => {
  it.each(['COD', 'cod', 'PDC7', 'PDC 30', 'DAT CHECK', 'Dated Check', '100PBD', '100 BPD'])('%s never ages', (t) => {
    expect(neverAges(t)).toBe(true)
  })
  it.each(['30D', 'NET 45', '', null, 'C.O.D'])('%s ages', (t) => {
    expect(neverAges(t)).toBe(false)
  })
})

describe('ageCheck — the earliest due date of the bills a check pays', () => {
  it("a never-aging bill beside an undated one is CURRENT (the spec's rule)", () => {
    expect(ageCheck([
      { dueDate: null, termsCode: '30D' },
      { dueDate: null, termsCode: 'COD' },
    ], NOW)).toEqual({ dueDate: null, daysPastDue: 0, bucket: 'current' })
  })

  it('takes the earliest dated bill', () => {
    const a = ageCheck([
      { dueDate: day('2026-09-30'), termsCode: '30D' },
      { dueDate: day('2026-07-01'), termsCode: '30D' },
    ], NOW)
    expect(a.dueDate).toEqual(day('2026-07-01'))
    expect(a.daysPastDue).toBe(106)
    expect(a.bucket).toBe('b90plus')
  })

  it('a never-aging bill gives no date; a dated bill beside it still decides', () => {
    const a = ageCheck([
      { dueDate: day('2026-01-01'), termsCode: 'PDC30' },
      { dueDate: day('2026-10-01'), termsCode: '30D' },
    ], NOW)
    expect(a.dueDate).toEqual(day('2026-10-01'))
    expect(a.bucket).toBe('b30')
  })

  it('only never-aging bills: CURRENT, with no date', () => {
    expect(ageCheck([{ dueDate: day('2026-01-01'), termsCode: 'COD' }], NOW))
      .toEqual({ dueDate: null, daysPastDue: 0, bucket: 'current' })
  })

  it('no bills, or no dates: NO DUE DATE', () => {
    expect(ageCheck([], NOW)).toEqual({ dueDate: null, daysPastDue: null, bucket: 'noDue' })
    expect(ageCheck([{ dueDate: null, termsCode: '30D' }], NOW).bucket).toBe('noDue')
  })
})
