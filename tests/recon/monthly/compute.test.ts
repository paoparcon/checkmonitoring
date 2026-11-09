import { describe, it, expect } from 'vitest'
import { computeReconciliation, type ComputeInput, type ComputeCheck, type ComputeLine, type ComputeBookEntry, type ComputeAdjustment } from '@/lib/recon/monthly/compute'

const d = (day: string) => new Date(`${day}T00:00:00.000Z`)

function check(over: Partial<ComputeCheck> & { id: string }): ComputeCheck {
  return {
    checkNumber: over.id, payee: 'HENKEL PHILIPPINES INC.', amount: '1000.00',
    checkDate: d('2026-10-05'), releasedAt: null, clearingStatus: 'NONE', clearedDate: null, status: 'RELEASED',
    ...over,
  }
}
function line(over: Partial<ComputeLine> & { id: string }): ComputeLine {
  return {
    month: '2026-10', lineDay: '2026-10-10', description: 'X', reference: null, checkNumber: null,
    debit: null, credit: null, kind: 'UNIDENTIFIED_DEBIT', matchMethod: null, checkId: null, bookEntryId: null,
    remarks: null, resolvedMonth: null, resolution: null, ...over,
  }
}
function entry(over: Partial<ComputeBookEntry> & { id: string }): ComputeBookEntry {
  return {
    month: '2026-10', kind: 'DEPOSIT', entryDay: '2026-10-20', amount: '500.00', reference: over.id,
    description: null, matchedLineDay: null, matchedLineId: null, ...over,
  }
}
function adj(over: Partial<ComputeAdjustment> & { id: string }): ComputeAdjustment {
  return {
    month: '2026-10', side: 'BANK', direction: 'ADD', amount: '100.00', description: over.id, reference: null,
    resolvedMonth: null, resolution: null, ...over,
  }
}
const base = (over: Partial<ComputeInput> = {}): ComputeInput => ({
  month: '2026-10', openingMonth: '2026-10', beginningBank: '10000.00', beginningBook: '10000.00',
  statementBeginningBalance: null, statementEndingBalance: null,
  checks: [], lines: [], bookEntries: [], adjustments: [], ...over,
})

describe('computeReconciliation — the two calculations', () => {
  it('balances a clean month: deposit cleared, check cleared, a charge, one OC and one DIT', () => {
    const r = computeReconciliation(base({
      checks: [
        check({ id: 'C1', amount: '3000.00', clearingStatus: 'CLEARED', clearedDate: d('2026-10-12') }),
        check({ id: 'C2', amount: '2000.00' }), // outstanding
      ],
      bookEntries: [
        entry({ id: 'D1', amount: '4000.00', entryDay: '2026-10-03', matchedLineDay: '2026-10-04', matchedLineId: 'L1' }),
        entry({ id: 'D2', amount: '500.00', entryDay: '2026-10-31' }), // in transit
      ],
      lines: [
        line({ id: 'L1', lineDay: '2026-10-04', credit: '4000.00', kind: 'BOOK_ENTRY', bookEntryId: 'D1' }),
        line({ id: 'L2', lineDay: '2026-10-12', debit: '3000.00', kind: 'CHECK', checkId: 'C1' }),
        line({ id: 'L3', lineDay: '2026-10-31', debit: '50.00', kind: 'BANK_CHARGE' }),
      ],
      statementEndingBalance: '10950.00',
    }))
    const f = r.figures
    expect(f.totalBankCredits).toBe('4000.00')
    expect(f.totalBankDebits).toBe('3050.00')
    expect(f.computedEndingBank).toBe('10950.00')
    expect(f.statementFootingDifference).toBe('0.00')
    expect(f.totalBookDeposits).toBe('4500.00')
    expect(f.totalChecksReleased).toBe('5000.00')
    expect(f.totalClearedChecks).toBe('3000.00')
    expect(f.totalOutstandingChecks).toBe('2000.00')
    expect(f.depositsInTransit).toBe('500.00')
    expect(f.bankCharges).toBe('50.00')
    // Bank: 10,950 + 500 − 2,000 = 9,450. Book: 10,000 + 4,500 − 5,000 − 50 = 9,450.
    expect(f.adjustedBank).toBe('9450.00')
    expect(f.bookBalanceBeforeAdjustments).toBe('9500.00')
    expect(f.adjustedBook).toBe('9450.00')
    expect(f.endingBook).toBe('9450.00')
    expect(f.difference).toBe('0.00')
    expect(r.counts).toMatchObject({ outstandingChecks: 1, depositsInTransit: 1, checksReleased: 2, clearedChecks: 1 })
  })

  it('carries an outstanding check and a deposit in transit into the next month without counting them again', () => {
    const checks = [check({ id: 'C2', amount: '2000.00' })]
    const bookEntries = [entry({ id: 'D2', amount: '500.00', entryDay: '2026-10-31', matchedLineDay: '2026-11-02', matchedLineId: 'L9' })]
    const nov = computeReconciliation(base({
      month: '2026-11', beginningBank: '10950.00', beginningBook: '9450.00',
      checks: [{ ...checks[0], clearingStatus: 'CLEARED', clearedDate: d('2026-11-05') }],
      bookEntries,
      lines: [
        line({ id: 'L9', month: '2026-11', lineDay: '2026-11-02', credit: '500.00', kind: 'BOOK_ENTRY', bookEntryId: 'D2' }),
        line({ id: 'L10', month: '2026-11', lineDay: '2026-11-05', debit: '2000.00', kind: 'CHECK', checkId: 'C2' }),
      ],
      statementEndingBalance: '9450.00',
    }))
    expect(nov.figures.totalChecksReleased).toBe('0.00') // released in October, not again
    expect(nov.figures.totalBookDeposits).toBe('0.00')   // booked in October
    expect(nov.figures.totalClearedChecks).toBe('2000.00')
    expect(nov.figures.totalOutstandingChecks).toBe('0.00')
    expect(nov.figures.depositsInTransit).toBe('0.00')
    expect(nov.figures.adjustedBank).toBe('9450.00')
    expect(nov.figures.adjustedBook).toBe('9450.00')
    expect(nov.figures.difference).toBe('0.00')
  })

  it('keeps a check outstanding month after month until it clears — never reset by a new month', () => {
    const c = check({ id: 'C3', amount: '700.00', checkDate: d('2026-09-15') })
    for (const month of ['2026-10', '2026-11', '2026-12']) {
      const r = computeReconciliation(base({ month, openingMonth: '2026-09', checks: [c] }))
      expect(r.outstanding.map((x) => x.id)).toEqual(['C3'])
      expect(r.figures.totalChecksReleased).toBe('0.00')
    }
  })

  it('does not count a check released before the beginning balance date as released in the first month', () => {
    const r = computeReconciliation(base({ checks: [check({ id: 'OLD', checkDate: d('2026-08-01') })] }))
    expect(r.figures.totalChecksReleased).toBe('0.00')
    expect(r.counts.outstandingBeforeOpening).toBe(1)
    expect(r.variance.some((v) => v.kind === 'OUTSTANDING_BEFORE_OPENING')).toBe(true)
  })

  it('counts unrecorded credits and unidentified lines on the book side, in their own month only', () => {
    const lines = [
      line({ id: 'I', lineDay: '2026-10-31', credit: '12.34', kind: 'BANK_CREDIT' }),
      line({ id: 'U', lineDay: '2026-10-20', debit: '99.00', kind: 'UNIDENTIFIED_DEBIT' }),
    ]
    const oct = computeReconciliation(base({ lines, statementEndingBalance: '9913.34' }))
    expect(oct.figures.adjustedBook).toBe('9913.34')
    expect(oct.figures.difference).toBe('0.00')
    expect(oct.counts.unidentified).toBe(1)
    const nov = computeReconciliation(base({ month: '2026-11', beginningBank: '9913.34', beginningBook: '9913.34', lines, statementEndingBalance: '9913.34' }))
    expect(nov.figures.bankCreditsUnrecorded).toBe('0.00')
    expect(nov.figures.difference).toBe('0.00')
    expect(nov.carriedUnidentified.map((l) => l.id)).toEqual(['U'])
  })

  it('reverses an open bank error out of the bank balance until the month it is resolved', () => {
    const err = line({ id: 'E', lineDay: '2026-10-15', credit: '300.00', kind: 'BANK_ERROR' })
    const oct = computeReconciliation(base({ lines: [err], statementEndingBalance: '10300.00' }))
    expect(oct.figures.bankAdjustments).toBe('-300.00')
    expect(oct.figures.difference).toBe('0.00')
    // Still open in November (the bank has not reversed it): carried.
    const nov = computeReconciliation(base({ month: '2026-11', beginningBank: '10300.00', lines: [err], statementEndingBalance: '10300.00' }))
    expect(nov.carriedBankErrors.map((l) => l.id)).toEqual(['E'])
    expect(nov.figures.difference).toBe('0.00')
    // Resolved in November with the reversing line: neither counts there; October is unchanged.
    const reversal = line({ id: 'R', month: '2026-11', lineDay: '2026-11-03', debit: '300.00', kind: 'BANK_ERROR', resolvedMonth: '2026-11' })
    const resolved = { ...err, resolvedMonth: '2026-11' }
    const nov2 = computeReconciliation(base({ month: '2026-11', beginningBank: '10300.00', lines: [resolved, reversal], statementEndingBalance: '10000.00' }))
    expect(nov2.figures.bankAdjustments).toBe('0.00')
    expect(nov2.figures.difference).toBe('0.00')
    expect(computeReconciliation(base({ lines: [resolved], statementEndingBalance: '10300.00' })).figures.bankAdjustments).toBe('-300.00')
  })

  it('applies bank adjustments while open and book adjustments in their month only, signed by direction', () => {
    const r = computeReconciliation(base({
      statementEndingBalance: '10000.00',
      adjustments: [
        adj({ id: 'BA', side: 'BANK', direction: 'LESS', amount: '25.00' }),
        adj({ id: 'KA', side: 'BOOK', direction: 'LESS', amount: '25.00' }),
        adj({ id: 'OLD', side: 'BOOK', month: '2026-09', direction: 'ADD', amount: '999.00' }),
      ],
    }))
    expect(r.figures.bankAdjustments).toBe('-25.00')
    expect(r.figures.bookAdjustments).toBe('-25.00')
    expect(r.figures.difference).toBe('0.00')
  })

  it('names the item equal to, or half of, the difference', () => {
    // Balanced: bank 10,000 − OC 250 = 9,750 = book 10,000 − released 250.
    expect(computeReconciliation(base({ checks: [check({ id: 'C9', amount: '250.00' })], statementEndingBalance: '10000.00' })).figures.difference).toBe('0.00')
    const off = computeReconciliation(base({ checks: [check({ id: 'C9', amount: '250.00' })], statementEndingBalance: '10250.00' }))
    expect(off.figures.difference).toBe('250.00')
    expect(off.variance.find((v) => v.kind === 'EQUALS_DIFFERENCE')?.ref).toBe('C9')
    const half = computeReconciliation(base({ checks: [check({ id: 'C9', amount: '250.00' })], statementEndingBalance: '10500.00' }))
    expect(half.variance.find((v) => v.kind === 'HALF_DIFFERENCE')?.ref).toBe('C9')
  })

  it('flags a statement that does not foot, a manual match at another amount, and a cleared check missing from the statement', () => {
    const r = computeReconciliation(base({
      checks: [
        check({ id: 'C1', amount: '100.00', clearingStatus: 'CLEARED', clearedDate: d('2026-10-09') }),
        check({ id: 'C2', amount: '200.00', clearingStatus: 'CLEARED', clearedDate: d('2026-10-09') }),
      ],
      lines: [line({ id: 'L', lineDay: '2026-10-09', debit: '101.00', kind: 'CHECK', checkId: 'C1', matchMethod: 'MANUAL' })],
      statementEndingBalance: '9700.00',
    }))
    const kinds = r.variance.map((v) => v.kind)
    expect(kinds).toContain('STATEMENT_DOES_NOT_FOOT')
    expect(kinds).toContain('CHECK_AMOUNT_DIFFERS')
    expect(r.variance.find((v) => v.kind === 'CLEARED_NOT_ON_STATEMENT')?.ref).toBe('C2')
  })

  it('takes the computed ending balance when no statement balance is entered, and states the statement beginning mismatch', () => {
    const r = computeReconciliation(base({ lines: [line({ id: 'X', credit: '5.00', kind: 'BANK_CREDIT' })], statementBeginningBalance: '10001.00' }))
    expect(r.figures.endingBank).toBe('10005.00')
    expect(r.figures.statementFootingDifference).toBeNull()
    expect(r.figures.statementBeginningDifference).toBe('1.00')
  })

  it('is centavo-exact over many small amounts (no float drift)', () => {
    const checks = Array.from({ length: 1000 }, (_, i) => check({ id: `F${i}`, amount: '0.10' }))
    const r = computeReconciliation(base({ checks }))
    expect(r.figures.totalOutstandingChecks).toBe('100.00')
  })
})
