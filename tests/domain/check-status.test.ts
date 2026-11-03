import { describe, it, expect } from 'vitest'
import {
  canTransition, assertTransition, checkReadyForRelease,
  canSetClearing, assertClearing, assertReleasable, clearingTargets,
  isLiveStatus, LIVE_STATUSES, CLOSED_STATUSES,
} from '@/lib/domain/check-status'
import type { CheckStatus } from '@/lib/domain/check-status'
import { DomainError } from '@/lib/domain/errors'

describe('release ladder transitions', () => {
  it('allows the forward path', () => {
    expect(canTransition('GENERATED', 'SIGNATURE_PENDING')).toBe(true)
    expect(canTransition('SIGNATURE_PENDING', 'SIGNED')).toBe(true)
    expect(canTransition('SIGNED', 'READY_FOR_RELEASE')).toBe(true)
    expect(canTransition('READY_FOR_RELEASE', 'SCHEDULED')).toBe(true)
    expect(canTransition('SCHEDULED', 'RELEASED')).toBe(true)
  })

  it('allows release without a confirmed pickup slot', () => {
    expect(canTransition('READY_FOR_RELEASE', 'RELEASED')).toBe(true)
  })

  it('forbids releasing a check that was never made available', () => {
    expect(canTransition('SIGNED', 'RELEASED')).toBe(false)
  })

  it('allows revert back to SIGNED from both available states', () => {
    expect(canTransition('READY_FOR_RELEASE', 'SIGNED')).toBe(true)
    expect(canTransition('SCHEDULED', 'SIGNED')).toBe(true)
  })

  it('allows cancellation from any pre-released state', () => {
    for (const s of ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED'] as const) {
      expect(canTransition(s, 'CANCELLED')).toBe(true)
    }
  })

  it('treats RELEASED as closed; CANCELLED only restores to SIGNED', () => {
    expect(canTransition('RELEASED', 'SIGNED')).toBe(false)
    expect(canTransition('RELEASED', 'CANCELLED')).toBe(false)
    expect(canTransition('CANCELLED', 'SIGNED')).toBe(true) // restoreCancelled, 2026-10-06
  })

  /**
   * The one edge out of RELEASED that is a correction rather than a fact from
   * the bank. A FINANCE_ADMIN who ticked the wrong row goes back exactly one
   * rung, to where the cheque was available — not to SIGNED, which would
   * withdraw it from the supplier. RELEASED is still CLOSED for every scope.
   */
  it('allows a release to be reversed back to READY_FOR_RELEASE, and nowhere else', () => {
    expect(canTransition('RELEASED', 'READY_FOR_RELEASE')).toBe(true)
    expect(canTransition('RELEASED', 'SIGNED')).toBe(false)
    expect(canTransition('RELEASED', 'SCHEDULED')).toBe(false)
    expect(canTransition('RELEASED', 'VOIDED')).toBe(true)
  })

  it('forbids skipping the signature step', () => {
    expect(canTransition('GENERATED', 'READY_FOR_RELEASE')).toBe(false)
    // Signing straight from GENERATED is allowed (releaseDirectly, 2026-10-16).
    expect(canTransition('GENERATED', 'SIGNED')).toBe(true)
  })

  it('assertTransition throws a coded DomainError on an illegal move', () => {
    expect(() => assertTransition('SIGNED', 'RELEASED')).toThrow(DomainError)
    try { assertTransition('SIGNED', 'RELEASED') }
    catch (e) { expect((e as DomainError).code).toBe('ILLEGAL_TRANSITION') }
  })
})

describe('VOIDED', () => {
  it('is reachable from every pre-terminal state, including RELEASED', () => {
    for (const s of [
      'GENERATED', 'SIGNATURE_PENDING', 'SIGNED',
      'READY_FOR_RELEASE', 'SCHEDULED', 'RELEASED',
    ] as const) {
      expect(canTransition(s, 'VOIDED')).toBe(true)
    }
  })

  it('is not reachable from CANCELLED', () => {
    expect(canTransition('CANCELLED', 'VOIDED')).toBe(false)
  })

  it('is itself terminal', () => {
    for (const s of [
      'GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE',
      'SCHEDULED', 'RELEASED', 'CANCELLED', 'VOIDED',
    ] as const) {
      expect(canTransition('VOIDED', s)).toBe(false)
    }
  })
})

const validReady = {
  status: 'SIGNED' as const,
  checkNumber: '6000329924',
  payeeName: 'HENKEL PHILIPPINES INC.',
  amount: '197715.42',
  checkDate: new Date('2026-09-01'),
  cashAccountCode: 'BPI STK',
  availablePickupDate: new Date('2026-09-03'),
  isCheque: true,
}

describe('READY FOR RELEASE guards', () => {
  it('passes when signed and complete', () => {
    expect(checkReadyForRelease(validReady)).toEqual({ ok: true })
  })

  it('blocks a check that is not SIGNED, with the exact spec message', () => {
    const r = checkReadyForRelease({ ...validReady, status: 'SIGNATURE_PENDING' })
    expect(r).toEqual({
      ok: false,
      code: 'NOT_SIGNED',
      message: 'This check cannot be released because it has not yet been marked as SIGNED.',
    })
  })

  it('blocks a check that is already RELEASED', () => {
    const r = checkReadyForRelease({ ...validReady, status: 'RELEASED' })
    expect(r).toEqual({
      ok: false,
      code: 'ALREADY_RELEASED',
      message: 'This check cannot be released because it has already been RELEASED.',
    })
  })

  it('names every missing required field', () => {
    const r = checkReadyForRelease({ ...validReady, checkNumber: null, availablePickupDate: null })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('MISSING_FIELDS')
    expect(r.message).toBe(
      'This check cannot be released because required information is missing: CHECK NUMBER, AVAILABLE PICKUP DATE.')
  })

  it('treats an empty string as missing', () => {
    const r = checkReadyForRelease({ ...validReady, payeeName: '   ' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('MISSING_FIELDS')
    expect(r.message).toBe(
      'This check cannot be released because required information is missing: PAYEE.')
  })

  it('reports ALREADY_RELEASED ahead of missing fields', () => {
    const r = checkReadyForRelease({ ...validReady, status: 'RELEASED', checkNumber: null })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('ALREADY_RELEASED')
  })

  it('blocks a non-check payment, ahead of every other guard', () => {
    const r = checkReadyForRelease({
      ...validReady, isCheque: false, status: 'RELEASED', checkNumber: null,
    })
    expect(r).toEqual({
      ok: false,
      code: 'NOT_A_CHEQUE',
      message:
        'This payment is not a check, so it cannot be signed or released. It is tracked here for visibility only.',
    })
  })
})

describe('assertReleasable', () => {
  it('passes silently for a check', () => {
    expect(() => assertReleasable({ isCheque: true })).not.toThrow()
  })

  it('throws a coded DomainError for a non-check payment', () => {
    expect(() => assertReleasable({ isCheque: false })).toThrow(DomainError)
    try { assertReleasable({ isCheque: false }) }
    catch (e) {
      expect((e as DomainError).code).toBe('NOT_A_CHEQUE')
      expect((e as DomainError).message).toBe(
        'This payment is not a check, so it cannot be signed or released. It is tracked here for visibility only.')
    }
  })
})

describe('clearing axis', () => {
  it('permits clearing only once the check is RELEASED', () => {
    expect(canSetClearing('RELEASED', 'NONE', 'DEPOSITED')).toBe(true)
    expect(canSetClearing('SCHEDULED', 'NONE', 'DEPOSITED')).toBe(false)
    expect(canSetClearing('READY_FOR_RELEASE', 'NONE', 'ENCASHED')).toBe(false)
  })

  it('allows DEPOSITED or ENCASHED then CLEARED', () => {
    expect(canSetClearing('RELEASED', 'NONE', 'ENCASHED')).toBe(true)
    expect(canSetClearing('RELEASED', 'DEPOSITED', 'CLEARED')).toBe(true)
    expect(canSetClearing('RELEASED', 'ENCASHED', 'CLEARED')).toBe(true)
  })

  // A bank statement is proof of clearing whether or not a deposit was recorded
  // first. Refusing NONE → CLEARED would make Finance invent a DEPOSITED they
  // never observed. Decided 2026-09-11.
  it('allows CLEARED straight from NONE, and never a move off CLEARED', () => {
    expect(canSetClearing('RELEASED', 'NONE', 'CLEARED')).toBe(true)
    expect(canSetClearing('RELEASED', 'CLEARED', 'DEPOSITED')).toBe(false)
    expect(canSetClearing('RELEASED', 'CLEARED', 'NONE')).toBe(false)
    expect(canSetClearing('RELEASED', 'DEPOSITED', 'ENCASHED')).toBe(false)
  })

  it('lists the forward moves from each rung', () => {
    expect(clearingTargets('NONE')).toEqual(['DEPOSITED', 'ENCASHED', 'CLEARED'])
    expect(clearingTargets('DEPOSITED')).toEqual(['CLEARED'])
    expect(clearingTargets('CLEARED')).toEqual([])
  })

  it('assertClearing throws a coded DomainError', () => {
    expect(() => assertClearing('SIGNED', 'NONE', 'DEPOSITED')).toThrow(DomainError)
    try { assertClearing('SIGNED', 'NONE', 'DEPOSITED') }
    catch (e) { expect((e as DomainError).code).toBe('ILLEGAL_CLEARING') }
  })
})

describe('live and closed statuses', () => {
  // The staged queue is built on this partition, and a status belonging to
  // neither list would silently vanish from every scope of it.
  const ALL: CheckStatus[] = [
    'GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE',
    'SCHEDULED', 'RELEASED', 'CANCELLED', 'VOIDED',
  ]

  it('partitions every status into exactly one of the two lists', () => {
    expect([...LIVE_STATUSES, ...CLOSED_STATUSES].sort()).toEqual([...ALL].sort())
    for (const s of ALL) {
      const live = (LIVE_STATUSES as readonly CheckStatus[]).includes(s)
      const closed = (CLOSED_STATUSES as readonly CheckStatus[]).includes(s)
      expect(live).not.toBe(closed)
    }
  })

  it('counts a released check as closed even though it can still be voided', () => {
    // RELEASED keeps an outgoing edge to VOIDED, so a terminality test derived
    // from TRANSITIONS would read it as live. It is not: the money has moved.
    expect(canTransition('RELEASED', 'VOIDED')).toBe(true)
    expect(isLiveStatus('RELEASED')).toBe(false)
    expect(isLiveStatus('READY_FOR_RELEASE')).toBe(true)
  })

  it('allows a signature to be reverted, and only from SIGNED', () => {
    expect(canTransition('SIGNED', 'SIGNATURE_PENDING')).toBe(true)
    for (const s of ['GENERATED', 'READY_FOR_RELEASE', 'SCHEDULED', 'RELEASED', 'CANCELLED', 'VOIDED'] as const) {
      expect(canTransition(s, 'SIGNATURE_PENDING'), s).toBe(s === 'GENERATED')
    }
  })
})
