import { describe, it, expect } from 'vitest'
import type { KitColumn } from '@/lib/table-kit/types'
import {
  applyKit, dateValue, humanNeedle, instantValue, manilaToday, matches, needleError, parseRangeNeedle,
  rangeNeedle, shiftDay, thisMonth,
} from '@/lib/table-kit/match'

const text: KitColumn = { key: 'payee', label: 'PAYEE', kind: 'text' }
const status: KitColumn = {
  key: 'status', label: 'STATUS', kind: 'enum',
  options: [{ value: 'SIGNED', label: 'SIGNED' }, { value: 'SIGNATURE_PENDING', label: 'SIGNATURE PENDING' }],
}
const statuses: KitColumn = { ...status, multi: true }
const date: KitColumn = { key: 'checkDate', label: 'CHECK DATE', kind: 'date' }
const amount: KitColumn = { key: 'amount', label: 'AMOUNT', kind: 'amount' }

describe('needles', () => {
  it('parses and builds range needles', () => {
    expect(parseRangeNeedle('~between:2026-10-01:2026-10-13')).toEqual({ op: 'between', a: '2026-10-01', b: '2026-10-13' })
    expect(parseRangeNeedle('~ge:1250.50')).toEqual({ op: 'ge', a: '1250.50', b: '' })
    expect(parseRangeNeedle('~between::500')).toEqual({ op: 'between', a: '', b: '500' })
    expect(parseRangeNeedle('~xx:1')).toBeNull()
    expect(parseRangeNeedle('acme')).toBeNull()
    expect(rangeNeedle('between', '2026-10-01', '2026-10-13')).toBe('~between:2026-10-01:2026-10-13')
    expect(rangeNeedle('ge', '5')).toBe('~ge:5')
    expect(rangeNeedle('between', '', '')).toBe('')
  })

  it('refuses an unreadable date or amount, and accepts grouped amounts', () => {
    expect(needleError(date, '~eq:2026-02-30')).not.toBeNull()
    expect(needleError(date, 'oct')).not.toBeNull()
    expect(needleError(amount, '~ge:12x')).not.toBeNull()
    expect(needleError(amount, '~ge:1,250.50')).toBeNull()
    expect(needleError(text, 'anything')).toBeNull()
    expect(needleError(date, '')).toBeNull()
  })

  it('refuses a one-bound operator without exactly one bound, rather than reading it as no filter', () => {
    expect(needleError(date, '~ge:')).not.toBeNull()
    expect(needleError(amount, '~eq::5')).not.toBeNull()
    expect(needleError(amount, '~le:1:2')).not.toBeNull()
    expect(applyKit([{ amount: '1.00' }], [amount], (r, k) => r[k as 'amount'], { amount: '~ge:' }, null)).toEqual([])
    // An open side of a range is still a range.
    expect(needleError(date, '~between:2026-10-01:')).toBeNull()
    expect(needleError(amount, '~between::5')).toBeNull()
  })
})

describe('matches', () => {
  it('text is contains, case-insensitive, ignoring commas and underscores', () => {
    expect(matches(text, 'PLDT, Inc.', 'pldt inc')).toBe(true)
    expect(matches(text, 'SIGNATURE_PENDING', 'signature pend')).toBe(true)
    expect(matches(text, null, 'x')).toBe(false)
  })

  it('enum is exact', () => {
    expect(matches(status, 'SIGNED', '=SIGNED')).toBe(true)
    expect(matches(status, 'SIGNATURE_PENDING', '=SIGNED')).toBe(false)
    expect(matches(status, 'signed', '=SIGNED')).toBe(true)
  })

  it('a multi enum matches any ticked value; a single enum reads the comma literally', () => {
    expect(matches(statuses, 'SIGNED', '=SIGNATURE_PENDING,SIGNED')).toBe(true)
    expect(matches(statuses, 'RELEASED', '=SIGNATURE_PENDING,SIGNED')).toBe(false)
    expect(matches(status, 'SIGNED', '=SIGNATURE_PENDING,SIGNED')).toBe(false)
  })

  it('dates honour every operator; an empty date never matches', () => {
    const d = '2026-10-05'
    expect(matches(date, d, '~eq:2026-10-05')).toBe(true)
    expect(matches(date, d, '~ne:2026-10-05')).toBe(false)
    expect(matches(date, d, '~gt:2026-10-04')).toBe(true)
    expect(matches(date, d, '~gt:2026-10-05')).toBe(false)
    expect(matches(date, d, '~ge:2026-10-05')).toBe(true)
    expect(matches(date, d, '~lt:2026-10-05')).toBe(false)
    expect(matches(date, d, '~le:2026-10-05')).toBe(true)
    expect(matches(date, d, '~between:2026-10-01:2026-10-31')).toBe(true)
    expect(matches(date, d, '~between::2026-10-04')).toBe(false)
    expect(matches(date, null, '~ge:2000-01-01')).toBe(false)
  })

  it('amounts compare in centavos, never as floats', () => {
    expect(matches(amount, '0.30', '~eq:0.3')).toBe(true)
    expect(matches(amount, '180521.15', '~between:180,000:181,000')).toBe(true)
    expect(matches(amount, '99999999999999.99', '~gt:99999999999999.98')).toBe(true)
    expect(matches(amount, null, '~ge:0')).toBe(false)
  })

  it('an unreadable amount bound refuses the row rather than reading as no bound', () => {
    expect(matches(amount, '5', '~ge:12x')).toBe(false)
    expect(matches(amount, '5', '~between:1:12x')).toBe(false)
  })
})

describe('applyKit', () => {
  type Row = { payee: string | null; amount: string | null; checkDate: string | null }
  const rows: Row[] = [
    { payee: 'Save Plus', amount: '180521.15', checkDate: '2026-10-02' },
    { payee: 'PLDT, Inc.', amount: '8960.00', checkDate: null },
    { payee: null, amount: '3928.57', checkDate: '2026-09-30' },
    { payee: 'Garisons', amount: null, checkDate: '2026-10-05' },
  ]
  const cols = [text, amount, date]
  const valueOf = (r: Row, k: string) => r[k as keyof Row]

  it('filters on every active column together', () => {
    const out = applyKit(rows, cols, valueOf, { payee: 's', amount: '~ge:1000' }, null)
    expect(out.map((r) => r.payee)).toEqual(['Save Plus'])
  })

  it('an unreadable needle matches nothing instead of widening', () => {
    expect(applyKit(rows, cols, valueOf, { amount: '~ge:12x' }, null)).toEqual([])
  })

  it('sorts amounts by value and puts empties last in both directions', () => {
    const asc = applyKit(rows, cols, valueOf, {}, { key: 'amount', dir: 'asc' }).map((r) => r.amount)
    expect(asc).toEqual(['3928.57', '8960.00', '180521.15', null])
    const desc = applyKit(rows, cols, valueOf, {}, { key: 'amount', dir: 'desc' }).map((r) => r.amount)
    expect(desc).toEqual(['180521.15', '8960.00', '3928.57', null])
  })

  it('sorts digit strings numerically and keeps ties in their original order', () => {
    const nums = [{ n: '600033188' }, { n: '1791406000' }, { n: '600033188' }]
    const col: KitColumn = { key: 'n', label: 'N', kind: 'text' }
    const out = applyKit(nums, [col], (r, k) => r[k as 'n'], {}, { key: 'n', dir: 'asc' })
    expect(out).toEqual([nums[0], nums[2], nums[1]])
  })
})

describe('Manila days', () => {
  it('today is the Manila calendar day', () => {
    expect(manilaToday(new Date('2026-10-12T16:30:00Z'))).toBe('2026-10-13')
    expect(manilaToday(new Date('2026-10-12T15:59:59Z'))).toBe('2026-10-12')
  })
  it('this month spans the first to the last day', () => {
    expect(thisMonth('2026-02-14')).toEqual(['2026-02-01', '2026-02-28'])
    expect(thisMonth('2028-02-03')).toEqual(['2028-02-01', '2028-02-29'])
  })
  it('shifts a day across a month end', () => {
    expect(shiftDay('2026-10-31', 1)).toBe('2026-11-01')
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28')
  })
  it('a stored date reads as its own day; an instant as its Manila day', () => {
    expect(dateValue(new Date('2026-10-05T00:00:00Z'))).toBe('2026-10-05')
    expect(instantValue(new Date('2026-10-04T17:00:00Z'))).toBe('2026-10-05')
    expect(dateValue(null)).toBeNull()
  })
})

describe('humanNeedle', () => {
  it('says what a chip means', () => {
    expect(humanNeedle(date, '~between:2026-10-01:2026-10-13')).toBe('2026-10-01 TO 2026-10-13')
    expect(humanNeedle(date, '~between:2026-10-01:2026-10-01')).toBe('2026-10-01')
    expect(humanNeedle(date, '~between:2026-10-01:')).toBe('FROM 2026-10-01')
    expect(humanNeedle(date, '~between::2026-10-01')).toBe('UNTIL 2026-10-01')
    expect(humanNeedle(amount, '~ge:1000')).toBe('≥ 1000')
    expect(humanNeedle(status, '=SIGNATURE_PENDING')).toBe('SIGNATURE PENDING')
    expect(humanNeedle(statuses, '=SIGNED,SIGNATURE_PENDING')).toBe('SIGNED, SIGNATURE PENDING')
    expect(humanNeedle(text, 'acme')).toBe('acme')
  })
})
