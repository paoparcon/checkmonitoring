import { describe, it, expect } from 'vitest'
import {
  isTickable, takesReceipt, liveIds, releasedIds, revertableIds, signedIds, draftTypeMissing, receiptEntries,
  EMPTY_DRAFT, type RowFacts,
} from '@/lib/row-receipts'

const row = (o: Partial<RowFacts> = {}): RowFacts => ({ id: 'x', isCheque: true, status: 'SIGNED', hasReceipt: false, ...o })

describe('isTickable', () => {
  it('ticks a live check, and a released one that has no receipt yet', () => {
    for (const status of ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED'] as const) {
      expect(isTickable(row({ status })), status).toBe(true)
    }
    expect(isTickable(row({ status: 'RELEASED' }))).toBe(true)
  })

  it('never ticks a released check with a receipt, a closed one, or a non-check', () => {
    expect(isTickable(row({ status: 'RELEASED', hasReceipt: true }))).toBe(false)
    expect(isTickable(row({ status: 'CANCELLED' }))).toBe(false)
    expect(isTickable(row({ status: 'VOIDED' }))).toBe(false)
    expect(isTickable(row({ isCheque: false }))).toBe(false)
  })
})

describe('takesReceipt', () => {
  it('opens a box only where a receipt can exist: any live rung, or released without one', () => {
    expect(takesReceipt(row({ status: 'READY_FOR_RELEASE' }))).toBe(true)
    expect(takesReceipt(row({ status: 'SCHEDULED' }))).toBe(true)
    expect(takesReceipt(row({ status: 'RELEASED' }))).toBe(true)
    expect(takesReceipt(row({ status: 'RELEASED', hasReceipt: true }))).toBe(false)
    // SIGNED opens one too (client, 2026-10-09): MARK RELEASED readies and releases it.
    expect(takesReceipt(row({ status: 'SIGNED' }))).toBe(true)
    expect(takesReceipt(row({ status: 'SIGNED', hasReceipt: true }))).toBe(false)
    // GENERATED and SIGNATURE PENDING too (client, 2026-10-16): signed and readied on the way.
    expect(takesReceipt(row({ status: 'SIGNATURE_PENDING' }))).toBe(true)
    expect(takesReceipt(row({ status: 'GENERATED' }))).toBe(true)
    expect(takesReceipt(row({ status: 'CANCELLED' }))).toBe(false)
    expect(takesReceipt(row({ status: 'VOIDED' }))).toBe(false)
  })

  it('never opens a box on a row that already carries a receipt, whatever its status', () => {
    expect(takesReceipt(row({ status: 'READY_FOR_RELEASE', hasReceipt: true }))).toBe(false)
    expect(takesReceipt(row({ status: 'SCHEDULED', hasReceipt: true }))).toBe(false)
  })
})

describe('liveIds / releasedIds', () => {
  it('splits a selection by what each action may act on', () => {
    const rows = [row({ id: 'a', status: 'SIGNED' }), row({ id: 'b', status: 'READY_FOR_RELEASE' }), row({ id: 'c', status: 'RELEASED' })]
    expect(liveIds(rows)).toEqual(['a', 'b'])
    expect(releasedIds(rows)).toEqual(['c'])
  })
})

describe('draftTypeMissing', () => {
  it('is true only when a reference is typed with no OR/CR', () => {
    expect(draftTypeMissing(EMPTY_DRAFT)).toBe(false)
    expect(draftTypeMissing({ orNumber: '4471', receiptType: '' })).toBe(true)
    expect(draftTypeMissing({ orNumber: '  ', receiptType: '' })).toBe(false)
    expect(draftTypeMissing({ orNumber: '4471', receiptType: 'CR' })).toBe(false)
  })
})

describe('receiptEntries', () => {
  it('keys each typed receipt to its own check, and sends nothing for a blank box or an unlisted id', () => {
    const drafts = {
      a: { orNumber: ' OR-1 ', receiptType: 'OR' as const },
      b: EMPTY_DRAFT,
      z: { orNumber: 'CR 9', receiptType: 'CR' as const },
    }
    expect(receiptEntries(['a', 'b'], drafts)).toEqual([['orNumber:a', 'OR-1'], ['receiptType:a', 'OR']])
  })
})

describe('revertableIds', () => {
  it('keeps only READY_FOR_RELEASE and SCHEDULED rows', () => {
    expect(revertableIds([
      row({ id: 'a', status: 'READY_FOR_RELEASE' }), row({ id: 'b', status: 'SCHEDULED' }),
      row({ id: 'c', status: 'SIGNED' }), row({ id: 'd', status: 'RELEASED' }),
    ])).toEqual(['a', 'b'])
  })
})

describe('signedIds', () => {
  it('is the ticked SIGNED rows only', () => {
    const rows = [row({ id: 'a', status: 'SIGNED' }), row({ id: 'b', status: 'SIGNATURE_PENDING' }), row({ id: 'c', status: 'READY_FOR_RELEASE' })]
    expect(signedIds(rows)).toEqual(['a'])
  })
})
