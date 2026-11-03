import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import {
  markSigned, markReadyForRelease, revertAvailability, markReleased,
  recordClearing, cancelCheck, applyPickupConfirmation, voidCheck,
  VOID_AFTER_RELEASE_WARNING,
} from '@/lib/domain/actions'
import { DomainError } from '@/lib/domain/errors'

const NOW = new Date('2026-09-01T13:32:00+08:00')
const PICKUP = new Date('2026-09-03')

beforeEach(resetDb)

describe('markSigned', () => {
  it('moves SIGNATURE_PENDING to SIGNED and records who and when', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const out = await markSigned(testDb, { checkId: check.id, userId: user.id, now: NOW })
    expect(out.status).toBe('SIGNED')
    expect(out.signedById).toBe(user.id)
    expect(out.signedAt).toEqual(NOW)
  })

  it('writes an audit row', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNATURE_PENDING' })
    await markSigned(testDb, { checkId: check.id, userId: user.id, now: NOW })
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id } })
    expect(audit.action).toBe('marked_signed')
    expect(audit.userId).toBe(user.id)
  })

  it('refuses a non-check payment and leaves it untouched', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNATURE_PENDING', isCheque: false })
    await expect(markSigned(testDb, { checkId: check.id, userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'NOT_A_CHEQUE' })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('SIGNATURE_PENDING')
    expect(after.signedById).toBeNull()
    expect(await testDb.auditLog.count({ where: { checkId: check.id } })).toBe(0)
  })
})

describe('markReadyForRelease', () => {
  it('sets status, actor, timestamp and the availability date', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    const out = await markReadyForRelease(testDb, {
      checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW,
    })
    expect(out.status).toBe('READY_FOR_RELEASE')
    expect(out.readyById).toBe(user.id)
    expect(out.readyAt).toEqual(NOW)
    expect(out.availablePickupDate).toEqual(PICKUP)
  })

  it('queues a portal event for a SUPPLIER check', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    const events = await testDb.portalEvent.findMany({ where: { checkId: check.id } })
    expect(events).toHaveLength(1)
    expect(events[0].direction).toBe('OUT')
    expect(events[0].status).toBe('PENDING')
    const updated = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(updated.portalSyncStatus).toBe('PENDING')
  })

  // 397 register rows carry no amount and 153 no payee, so these are real
  // cheques, not hypotheticals. A SUPPLIER cheque missing either must not reach
  // the portal: telling a supplier a cheque is ready and showing them a blank
  // where the amount belongs is worse than telling them nothing.
  //
  // Note this is the OUTER protection — checkReadyForRelease refuses the whole
  // action, so nothing is written at all. The assertion guarding the payload
  // inside markReadyForRelease is defence in depth behind this, and is
  // deliberately unreachable while this guard stands.
  it.each([
    ['amount', { amount: null }],
    ['payee', { payeeName: null }],
  ])('refuses to publish a SUPPLIER check with no %s, and writes nothing', async (_field, missing) => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER', ...missing })

    await expect(markReadyForRelease(testDb, {
      checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW,
    })).rejects.toBeInstanceOf(DomainError)

    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('SIGNED')                 // the transaction rolled back
    expect(after.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
  })

  it('queues NO portal event for an INTERNAL check but still changes status', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL' })
    const out = await markReadyForRelease(testDb, {
      checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW,
    })
    expect(out.status).toBe('READY_FOR_RELEASE')
    expect(out.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
  })

  it('refuses a check that is not SIGNED and leaves it untouched', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNATURE_PENDING' })
    await expect(markReadyForRelease(testDb, {
      checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW,
    })).rejects.toMatchObject({ code: 'NOT_SIGNED' })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('SIGNATURE_PENDING')
    expect(await testDb.auditLog.count({ where: { checkId: check.id } })).toBe(0)
  })

  it('refuses when the availability date is missing', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await expect(markReadyForRelease(testDb, {
      checkId: check.id, userId: user.id, availablePickupDate: null, now: NOW,
    })).rejects.toMatchObject({ code: 'MISSING_FIELDS' })
  })

  it('refuses a non-check payment and leaves it untouched', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', isCheque: false })
    await expect(markReadyForRelease(testDb, {
      checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW,
    })).rejects.toMatchObject({ code: 'NOT_A_CHEQUE' })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('SIGNED')
    expect(await testDb.auditLog.count({ where: { checkId: check.id } })).toBe(0)
  })
})

describe('revertAvailability', () => {
  it('returns the check to SIGNED, requires a reason, and never deletes it', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    const out = await revertAvailability(testDb, {
      checkId: check.id, userId: user.id,
      reason: 'Check temporarily unavailable due to operational circumstances.', now: NOW,
    })
    expect(out.status).toBe('SIGNED')
    expect(out.availablePickupDate).toBeNull()
    expect(await testDb.check.count({ where: { id: check.id } })).toBe(1)
    const audit = await testDb.auditLog.findFirst({
      where: { checkId: check.id, action: 'reverted_availability' },
    })
    expect(audit?.remarks).toContain('operational circumstances')
  })

  it('clears any supplier-confirmed pickup so no phantom schedule survives', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await applyPickupConfirmation(testDb, {
      checkId: check.id, pickupDate: PICKUP, pickupTime: '10:00', pickupRep: 'Juan', confirmedAt: NOW,
    })
    const out = await revertAvailability(testDb, { checkId: check.id, userId: user.id, reason: 'x', now: NOW })
    expect(out.status).toBe('SIGNED')
    expect(out.scheduledPickupDate).toBeNull()
    expect(out.portalConfirmedAt).toBeNull()
    expect(out.pickupRep).toBeNull()
  })

  it('rejects a blank reason', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await expect(revertAvailability(testDb, {
      checkId: check.id, userId: user.id, reason: '   ', now: NOW,
    })).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
  })

  // Regression test for the bug: markReadyForRelease routes on eligibility,
  // but a seeded check can reach READY_FOR_RELEASE with portalSyncStatus still
  // at its schema default of NOT_APPLICABLE (the seed never set it). If revert
  // routed on portalSyncStatus instead of eligibility, this would emit no
  // retract event and leave the portal advertising a withdrawn check.
  it('emits a REVERT event for a SUPPLIER check even when portalSyncStatus was left at its default', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    // Reproduce the seeded shape: portalSyncStatus back at the schema default.
    await testDb.check.update({ where: { id: check.id }, data: { portalSyncStatus: 'NOT_APPLICABLE' } })

    await revertAvailability(testDb, { checkId: check.id, userId: user.id, reason: 'x', now: NOW })

    const events = await testDb.portalEvent.findMany({ where: { checkId: check.id } })
    expect(events.some((e) => (e.payload as { action?: string }).action === 'REVERT')).toBe(true)
  })

  // Regression test for the other half of the bug: an INTERNAL check must
  // never produce a supplier-route portal event (ruling 2026-10-19: only its
  // quiet RELEASED / RELEASE_REVERSED / CANCELLED status events go out, flagged
  // internal). This used to be proved by forcing
  // portalSyncStatus to 'PENDING' on an INTERNAL check via testDb, but that
  // state is now unreachable: the database's own CHECK constraint
  // (check_internal_never_routes_to_portal) rejects it directly, which is a
  // stronger guarantee than the original test asserted.
  it('rejects an attempt to force an INTERNAL check into a portal-routed state', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })

    await expect(testDb.check.update({
      where: { id: check.id }, data: { portalSyncStatus: 'PENDING' },
    })).rejects.toThrow()
  })

  it('emits no event when reverting an INTERNAL check marked ready then reverted', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })

    await revertAvailability(testDb, { checkId: check.id, userId: user.id, reason: 'x', now: NOW })

    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
  })
})

describe('applyPickupConfirmation', () => {
  it('moves READY_FOR_RELEASE to SCHEDULED', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    const out = await applyPickupConfirmation(testDb, {
      checkId: check.id, pickupDate: PICKUP, pickupTime: '10:00', pickupRep: 'Juan Dela Cruz', confirmedAt: NOW,
    })
    expect(out.status).toBe('SCHEDULED')
    expect(out.scheduledPickupTime).toBe('10:00')
    const audit = await testDb.auditLog.findFirstOrThrow({
      where: { checkId: check.id, action: 'supplier_pickup_confirmed' },
    })
    expect(audit.actorType).toBe('SYSTEM')
  })

  it('cannot mark a check RELEASED', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    const out = await applyPickupConfirmation(testDb, { checkId: check.id, pickupDate: PICKUP, confirmedAt: NOW })
    expect(out.status).toBe('SCHEDULED')
  })

  it('refuses to confirm against a check that is not available', async () => {
    const check = await makeCheck({ status: 'SIGNED' })
    await expect(applyPickupConfirmation(testDb, {
      checkId: check.id, pickupDate: PICKUP, confirmedAt: NOW,
    })).rejects.toBeInstanceOf(DomainError)
  })
})

describe('markReleased', () => {
  it('releases directly from READY_FOR_RELEASE without a confirmed slot', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    const out = await markReleased(testDb, {
      checkId: check.id, userId: user.id, remarks: 'Picked up by supplier', now: NOW,
    })
    expect(out.status).toBe('RELEASED')
    expect(out.releasedById).toBe(user.id)
    expect(out.releasedAt).toEqual(NOW)
    expect(out.remarks).toBe('Picked up by supplier')
  })

  it('refuses to release a check that was never made available', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await expect(markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' })
  })

  it('refuses a non-check payment and leaves it untouched', async () => {
    // A non-cheque check can never reach READY_FOR_RELEASE through the normal
    // ladder (markSigned and markReadyForRelease both refuse it), so this
    // reproduces the state directly to prove markReleased is its own,
    // independent guard rather than relying on an earlier step to have caught it.
    const user = await makeUser()
    const check = await makeCheck({ status: 'READY_FOR_RELEASE', isCheque: false })
    await expect(markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'NOT_A_CHEQUE' })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('READY_FOR_RELEASE')
    expect(after.releasedById).toBeNull()
    expect(await testDb.auditLog.count({ where: { checkId: check.id } })).toBe(0)
  })

  it('queues a RELEASED portal event for a SUPPLIER check', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await markReleased(testDb, { checkId: check.id, userId: user.id, orNumber: 'OR-1', receiptType: 'OR', now: NOW })

    const events = await testDb.portalEvent.findMany({ where: { checkId: check.id } })
    const released = events.find((e) => (e.payload as { action?: string }).action === 'RELEASED')
    expect(released).toBeDefined()
    expect(released?.direction).toBe('OUT')
    expect(released?.status).toBe('PENDING')
    const updated = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(updated.portalSyncStatus).toBe('PENDING')
  })

  it('queues a RELEASED event for an INTERNAL check but writes no portal state on it (ruling 2026-10-19)', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL', apvNumbers: ['AP-ST044602'] })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW })

    const events = await testDb.portalEvent.findMany({ where: { checkId: check.id } })
    expect(events.map((e) => e.kind)).toEqual(['RELEASED'])
    const updated = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(updated.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(updated.portalDomain).toBeNull()
  })

  it('queues nothing for an INTERNAL check with no APV', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL', apvNumbers: [] })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
  })
})

describe('recordClearing', () => {
  it('records DEPOSITED then CLEARED with a CR number', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW })
    const dep = await recordClearing(testDb, {
      checkId: check.id, userId: user.id, clearingStatus: 'DEPOSITED', now: NOW,
    })
    expect(dep.clearingStatus).toBe('DEPOSITED')
    const cleared = await recordClearing(testDb, {
      checkId: check.id, userId: user.id, clearingStatus: 'CLEARED',
      crNumber: 'CR 6336', clearedDate: new Date('2026-09-10'), now: NOW,
    })
    expect(cleared.clearingStatus).toBe('CLEARED')
    expect(cleared.crNumber).toBe('CR 6336')
  })

  it('refuses clearing before the check is released', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await expect(recordClearing(testDb, {
      checkId: check.id, userId: user.id, clearingStatus: 'DEPOSITED', now: NOW,
    })).rejects.toMatchObject({ code: 'ILLEGAL_CLEARING' })
  })
})

describe('cancelCheck', () => {
  it('cancels with a reason and keeps the record', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    const out = await cancelCheck(testDb, {
      checkId: check.id, userId: user.id, reason: 'Spoiled check', now: NOW,
    })
    expect(out.status).toBe('CANCELLED')
    expect(out.cancelReason).toBe('Spoiled check')
    expect(await testDb.check.count({ where: { id: check.id } })).toBe(1)
  })

  it('refuses to cancel an already released check', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW })
    await expect(cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'x', now: NOW }))
      .rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' })
  })
})

describe('voidCheck', () => {
  it('voids from a pending status and records when, with no user attached', async () => {
    const check = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const out = await voidCheck(testDb, {
      checkId: check.id, reason: 'Voided in Acumatica (Voided Payment, status Closed).', now: NOW,
    })
    expect(out.status).toBe('VOIDED')
    expect(out.voidedAt).toEqual(NOW)

    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id } })
    // A void is an Acumatica fact, not a Finance decision, so it is attributed
    // to SYSTEM and there is no user to name.
    expect(audit.actorType).toBe('SYSTEM')
    expect(audit.userId).toBeNull()
    expect(audit.action).toBe('voided')
  })

  it('voids a SIGNED check without disturbing who signed it', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNATURE_PENDING' })
    await markSigned(testDb, { checkId: check.id, userId: user.id, now: NOW })
    const out = await voidCheck(testDb, { checkId: check.id, reason: 'Voided in Acumatica.', now: NOW })
    expect(out.status).toBe('VOIDED')
    expect(out.signedById).toBe(user.id)
  })

  // The plan said a void applies "from any non-RELEASED status". That is
  // superseded: `check-status.ts` permits RELEASED -> VOIDED deliberately,
  // because a stop-payment on a cheque already handed over is a real event and
  // Acumatica is the source of truth for it. This system showing RELEASED for a
  // cheque the ERP says no longer exists is the worse failure.
  it('voids a RELEASED check, because Acumatica can stop a check already handed over', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW })

    const out = await voidCheck(testDb, { checkId: check.id, reason: 'Stop payment.', now: NOW })
    expect(out.status).toBe('VOIDED')
    // The release facts survive: they are what makes this void alarming.
    expect(out.releasedById).toBe(user.id)
    expect(out.releasedAt).toEqual(NOW)
  })

  // Because a released-then-voided cheque means money may already have moved,
  // this one transition must be conspicuous in the audit trail rather than
  // reading like any other void.
  it('marks a void after release conspicuously, not like any other void', async () => {
    const user = await makeUser()
    const released = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: released.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await markReleased(testDb, { checkId: released.id, userId: user.id, now: NOW })
    await voidCheck(testDb, { checkId: released.id, reason: 'Stop payment.', now: NOW })

    const audit = await testDb.auditLog.findFirstOrThrow({
      where: { checkId: released.id, action: { startsWith: 'voided' } },
    })
    expect(audit.action).toBe('voided_after_release')
    expect(audit.remarks).toContain(VOID_AFTER_RELEASE_WARNING)
    expect(audit.details).toMatchObject({ fromStatus: 'RELEASED' })

    // And the contrast: an ordinary void carries neither the distinct action
    // nor the warning, so the alarming case cannot be lost among the routine ones.
    const pending = await makeCheck({ status: 'SIGNATURE_PENDING' })
    await voidCheck(testDb, { checkId: pending.id, reason: 'Voided in Acumatica.', now: NOW })
    const ordinary = await testDb.auditLog.findFirstOrThrow({ where: { checkId: pending.id } })
    expect(ordinary.action).toBe('voided')
    expect(ordinary.remarks).not.toContain(VOID_AFTER_RELEASE_WARNING)
  })

  it('refuses to void a cancelled check, which is a terminal Finance decision', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'Spoiled check', now: NOW })
    await expect(voidCheck(testDb, { checkId: check.id, reason: 'Voided in Acumatica.', now: NOW }))
      .rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' })
  })

  it('refuses a blank reason, as cancelCheck does', async () => {
    const check = await makeCheck({ status: 'SIGNATURE_PENDING' })
    await expect(voidCheck(testDb, { checkId: check.id, reason: '   ', now: NOW }))
      .rejects.toMatchObject({ code: 'REASON_REQUIRED' })
  })

  // Superseded 2026-09-26 (plan `portal-outbox-delivery`, task 2): a void now
  // queues the same CANCELLED event `cancelCheck` does for a portal-routed
  // cheque, so the supplier portal stops showing a cheque the ERP says no
  // longer exists.
  it('queues a CANCELLED portal event for a portal-routed check', async () => {
    const check = await makeCheck({ status: 'SIGNATURE_PENDING', eligibility: 'SUPPLIER', apvNumbers: ['AP-ST000003'] })
    await voidCheck(testDb, { checkId: check.id, reason: 'Voided in Acumatica.', now: NOW })
    const event = await testDb.portalEvent.findFirstOrThrow({ where: { checkId: check.id } })
    expect(event.kind).toBe('CANCELLED')
    expect(event.status).toBe('PENDING')
    expect(event.payload).toEqual({ action: 'CANCELLED', checkNumber: check.checkNumber })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.portalSyncStatus).toBe('PENDING')
    expect(after.portalDomain).toBe('LOCAL')
  })

  it('writes no portal event for an INTERNAL check', async () => {
    const check = await makeCheck({ status: 'SIGNATURE_PENDING', eligibility: 'INTERNAL' })
    await voidCheck(testDb, { checkId: check.id, reason: 'Voided in Acumatica.', now: NOW })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.portalSyncStatus).toBe('NOT_APPLICABLE')
  })
})

// What makes `PortalEvent` a queue rather than a log: every event says what it
// instructs (`kind`) and carries a key the outbox can refuse a duplicate of.
describe('portal event identity', () => {
  // A second ready-for-release, which is what makes this a NEW instruction
  // rather than a repeat of the first.
  const LATER = new Date('2026-09-02T09:15:00+08:00')

  // The key's timestamp is the action's own `now`. That is the whole design:
  // a revert genuinely retracts what the portal was told, so marking the cheque
  // ready again is a fresh instruction the supplier must be told about, and it
  // must not be swallowed by the unique key as though it were a double submit.
  //
  // The opposite direction — the same instruction refused twice — is asserted
  // against the database in tests/schema.test.ts, because `TRANSITIONS` blocks
  // a repeat submit before it can ever build an event. See the comment there.
  //
  // `lib/domain/actions.ts` has four `portalEvent.create` sites. Three are
  // exercised here on purpose — the plan was drafted against two of them and
  // `markReleased` was nearly left without a `kind` — and the fourth,
  // `reverseRelease`'s RELEASE_REVERSED, is covered the same way in
  // `tests/actions/reverse-release.test.ts` instead of being duplicated here.
  it('stamps a kind and a per-action key on all three call sites, and re-keys a re-ready', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })

    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await revertAvailability(testDb, { checkId: check.id, userId: user.id, reason: 'Wrong pickup date', now: NOW })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: LATER })
    await markReleased(testDb, { checkId: check.id, userId: user.id, orNumber: 'OR-1', receiptType: 'OR', now: LATER })

    const events = await testDb.portalEvent.findMany({ where: { checkId: check.id } })
    // Keyed by idempotencyKey rather than compared as an ordered list: all four
    // rows take their `createdAt` from the database clock, and asserting an
    // order the schema does not guarantee is how a test starts flaking.
    expect(Object.fromEntries(events.map((e) => [e.idempotencyKey, e.kind]))).toEqual({
      [`${check.id}:MARK_AVAILABLE:${NOW.toISOString()}`]: 'MARK_AVAILABLE',
      [`${check.id}:REVERT:${NOW.toISOString()}`]: 'REVERT',
      // The re-ready: a different key from the first MARK_AVAILABLE, so the
      // outbox queues it instead of discarding it as already-sent.
      [`${check.id}:MARK_AVAILABLE:${LATER.toISOString()}`]: 'MARK_AVAILABLE',
      [`${check.id}:RELEASED:${LATER.toISOString()}`]: 'RELEASED',
      // No RECEIPT although this release records one: the cheque has no APV,
      // so the portal could never match it (review 2026-10-02; covered with
      // APVs in tests/actions/receipt-file.test.ts).
    })
  })
})
