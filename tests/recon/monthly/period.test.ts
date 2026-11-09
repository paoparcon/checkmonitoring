import { describe, it, expect } from 'vitest'
import {
  workflowVerdict, reopenRequestVerdict, reopenDecisionVerdict, parseAmount, lastDay, nextMonth, previousMonth,
  isMonth, monthHasBegun, monthLabel, type WorkflowPeriod,
} from '@/lib/recon/monthly/period'

const preparer = { id: 'u1', role: 'FINANCE_USER' as const }
const reviewer = { id: 'u2', role: 'FINANCE_USER' as const }
const admin = { id: 'a1', role: 'FINANCE_ADMIN' as const }
const admin2 = { id: 'a2', role: 'FINANCE_ADMIN' as const }
const p = (over: Partial<WorkflowPeriod> = {}): WorkflowPeriod => ({
  status: 'DRAFT', submittedById: null, reviewedById: null, statementEndingBalance: '1.00', difference: '0.00',
  previousApproved: true, previousClosed: true, ...over,
})

describe('months', () => {
  it('knows month ends, rollover and validity', () => {
    expect(lastDay('2026-02')).toBe('2026-02-28')
    expect(lastDay('2028-02')).toBe('2028-02-29')
    expect(lastDay('2026-12')).toBe('2026-12-31')
    expect(nextMonth('2026-12')).toBe('2027-01')
    expect(previousMonth('2027-01')).toBe('2026-12')
    expect(isMonth('2026-13')).toBe(false)
    expect(isMonth('2026-11')).toBe(true)
    expect(monthHasBegun('2026-12', '2026-11-30')).toBe(false)
    expect(monthHasBegun('2026-11', '2026-11-01')).toBe(true)
    expect(monthLabel('2026-11')).toBe('NOVEMBER 2026')
  })
})

describe('parseAmount', () => {
  it('reads typed money as a two-decimal string and refuses anything else', () => {
    expect(parseAmount('1,234,567.8')).toBe('1234567.80')
    expect(parseAmount('0')).toBe('0.00')
    expect(parseAmount('-5', { allowNegative: true })).toBe('-5.00')
    expect(parseAmount('-5')).toBeNull()
    expect(parseAmount('1.234')).toBeNull()
    expect(parseAmount('12abc')).toBeNull()
    expect(parseAmount('')).toBeNull()
  })
})

describe('workflowVerdict — the ladder and separation of duties', () => {
  it('submits a draft with a statement balance, and refuses one without', () => {
    expect(workflowVerdict('SUBMIT', p(), preparer)).toEqual({ ok: true, to: 'FOR_REVIEW' })
    expect(workflowVerdict('SUBMIT', p({ statementEndingBalance: null }), preparer)).toMatchObject({ ok: false, code: 'NO_STATEMENT_BALANCE' })
    expect(workflowVerdict('SUBMIT', p({ status: 'FOR_REVIEW' }), preparer)).toMatchObject({ ok: false, code: 'NOT_DRAFT' })
  })

  it('refuses a review by the submitter', () => {
    const q = p({ status: 'FOR_REVIEW', submittedById: 'u1' })
    expect(workflowVerdict('REVIEW', q, preparer)).toMatchObject({ ok: false, code: 'SAME_PERSON' })
    expect(workflowVerdict('REVIEW', q, reviewer)).toEqual({ ok: true, to: 'FOR_APPROVAL' })
  })

  it('approves only as an admin who neither submitted nor reviewed, only when balanced and in order', () => {
    const q = p({ status: 'FOR_APPROVAL', submittedById: 'u1', reviewedById: 'a2' })
    expect(workflowVerdict('APPROVE', q, reviewer)).toMatchObject({ code: 'ADMIN_ONLY' })
    expect(workflowVerdict('APPROVE', q, admin2)).toMatchObject({ code: 'SAME_PERSON' })
    expect(workflowVerdict('APPROVE', { ...q, difference: '0.01' }, admin)).toMatchObject({ code: 'NOT_BALANCED' })
    expect(workflowVerdict('APPROVE', { ...q, previousApproved: false }, admin)).toMatchObject({ code: 'PREVIOUS_NOT_APPROVED' })
    expect(workflowVerdict('APPROVE', q, admin)).toEqual({ ok: true, to: 'RECONCILED' })
  })

  it('returns to draft from review by anyone, from approval by an admin only', () => {
    expect(workflowVerdict('RETURN', p({ status: 'FOR_REVIEW' }), reviewer)).toEqual({ ok: true, to: 'DRAFT' })
    expect(workflowVerdict('RETURN', p({ status: 'FOR_APPROVAL' }), reviewer)).toMatchObject({ code: 'ADMIN_ONLY' })
    expect(workflowVerdict('RETURN', p({ status: 'RECONCILED' }), admin)).toMatchObject({ code: 'NOT_IN_REVIEW' })
  })

  it('closes a reconciled month, as an admin, after the month before', () => {
    expect(workflowVerdict('CLOSE', p({ status: 'RECONCILED' }), admin)).toEqual({ ok: true, to: 'CLOSED' })
    expect(workflowVerdict('CLOSE', p({ status: 'RECONCILED', previousClosed: false }), admin)).toMatchObject({ code: 'PREVIOUS_NOT_CLOSED' })
    expect(workflowVerdict('CLOSE', p({ status: 'FOR_APPROVAL' }), admin)).toMatchObject({ code: 'NOT_RECONCILED' })
  })
})

describe('re-opening an approved month', () => {
  it('needs an admin, a reason, no pending request and the next month still in draft', () => {
    const ok = { status: 'CLOSED' as const, nextStatus: 'DRAFT' as const, hasPendingRequest: false }
    expect(reopenRequestVerdict(ok, admin, 'typo in statement balance')).toEqual({ ok: true })
    expect(reopenRequestVerdict(ok, preparer, 'x')).toMatchObject({ code: 'ADMIN_ONLY' })
    expect(reopenRequestVerdict(ok, admin, ' ')).toMatchObject({ code: 'REASON_REQUIRED' })
    expect(reopenRequestVerdict({ ...ok, hasPendingRequest: true }, admin, 'x')).toMatchObject({ code: 'ALREADY_REQUESTED' })
    expect(reopenRequestVerdict({ ...ok, nextStatus: 'FOR_REVIEW' }, admin, 'x')).toMatchObject({ code: 'NEXT_MONTH_MOVED' })
    expect(reopenRequestVerdict({ ...ok, status: 'DRAFT' }, admin, 'x')).toMatchObject({ code: 'NOT_APPROVED' })
  })

  it('is decided by a different admin; a rejection needs a note', () => {
    const req = { status: 'PENDING' as const, requestedById: 'a1' }
    expect(reopenDecisionVerdict(req, admin, 'APPROVE', '')).toMatchObject({ code: 'SAME_PERSON' })
    expect(reopenDecisionVerdict(req, admin2, 'APPROVE', '')).toEqual({ ok: true })
    expect(reopenDecisionVerdict(req, admin2, 'REJECT', '')).toMatchObject({ code: 'NOTE_REQUIRED' })
    expect(reopenDecisionVerdict({ ...req, status: 'APPROVED' }, admin2, 'APPROVE', '')).toMatchObject({ code: 'NOT_PENDING' })
  })
})
