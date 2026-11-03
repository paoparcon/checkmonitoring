import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import {
  markReadyForRelease, markReleased, applyPickupConfirmation, reverseRelease,
} from '@/lib/domain/actions'

const NOW = new Date('2026-09-01T13:32:00+08:00')
const LATER = new Date('2026-09-02T09:00:00+08:00')
const PICKUP = new Date('2026-09-03')

beforeEach(resetDb)

/**
 * A cheque released through the app, the way every future release will be —
 * and, unless `told: false`, its RELEASED event delivered to the portal, as the
 * outbox does within seconds of a release. The reversal tells the portal only
 * what it was told (2026-11-03), so the delivered state is what the portal
 * cases below rely on.
 */
async function released(opts: { eligibility?: 'SUPPLIER' | 'INTERNAL'; withReceipt?: boolean; apvNumbers?: string[]; told?: boolean } = {}) {
  const user = await makeUser()
  const check = await makeCheck({ status: 'SIGNED', eligibility: opts.eligibility ?? 'SUPPLIER', ...(opts.apvNumbers ? { apvNumbers: opts.apvNumbers } : {}) })
  await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
  await markReleased(testDb, {
    checkId: check.id, userId: user.id, now: NOW, remarks: 'Handed to the courier',
    ...(opts.withReceipt ? { orNumber: 'OR-000123', receiptType: 'OR' as const } : {}),
  })
  if (opts.told !== false) await delivered(check.id)
  return { user, check }
}

/** The portal received the cheque's RELEASED: the outbox's own mark for a delivery. */
async function delivered(checkId: string) {
  await testDb.portalEvent.updateMany({ where: { checkId, kind: 'RELEASED' }, data: { status: 'SYNCED', lastError: null } })
}

const REVERSED_TO_READY = { destination: 'READY_FOR_RELEASE', portalTold: true, portalEvent: 'RELEASE_REVERSED' }

describe('reverseRelease — the happy path', () => {
  it('returns the check to READY_FOR_RELEASE, clears the release and the collection, keeps the availability', async () => {
    const { user, check } = await released()
    const admin = await makeUser('FINANCE_ADMIN')
    const out = await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'Ticked the wrong row', now: LATER })

    expect(out.status).toBe('READY_FOR_RELEASE')
    expect(out.releasedAt).toBeNull()
    expect(out.releasedById).toBeNull()
    expect(out.scheduledPickupDate).toBeNull()
    expect(out.scheduledPickupTime).toBeNull()
    expect(out.pickupRep).toBeNull()
    expect(out.portalConfirmedAt).toBeNull()
    // Still available: the cheque simply was not handed over after all.
    expect(out.availablePickupDate).toEqual(PICKUP)
    expect(out.readyById).toBe(user.id)
    expect(out.readyAt).toEqual(NOW)
    // Finance's own note is not overwritten; the reason goes on the audit row.
    expect(out.remarks).toBe('Handed to the courier')
  })

  it('clears a collection the supplier had booked', async () => {
    // The honest path: available → booked in the portal (SCHEDULED) → released
    // from SCHEDULED, which the ladder allows → reversed.
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await applyPickupConfirmation(testDb, {
      checkId: check.id, pickupDate: PICKUP, pickupTime: '10:00', pickupRep: 'Juan', confirmedAt: NOW,
    })
    await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW })
    const admin = await makeUser('FINANCE_ADMIN')
    const out = await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER })
    expect(out.status).toBe('READY_FOR_RELEASE')
    expect(out.scheduledPickupDate).toBeNull()
    expect(out.scheduledPickupTime).toBeNull()
    expect(out.pickupRep).toBeNull()
    expect(out.portalConfirmedAt).toBeNull()
  })

  it('writes one audit row carrying the reason and what was undone', async () => {
    const { user, check } = await released()
    const admin = await makeUser('FINANCE_ADMIN')
    await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'Ticked the wrong row', now: LATER })
    const rows = await testDb.auditLog.findMany({ where: { checkId: check.id, action: 'release_reversed' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].userId).toBe(admin.id)
    expect(rows[0].remarks).toBe('Ticked the wrong row')
    expect(rows[0].details).toEqual({ releasedAt: NOW.toISOString(), releasedById: user.id, ...REVERSED_TO_READY })
  })
})

describe('reverseRelease — the portal', () => {
  it('queues exactly one RELEASE_REVERSED event for a SUPPLIER check, keyed on this action', async () => {
    const { check } = await released({ eligibility: 'SUPPLIER' })
    const admin = await makeUser('FINANCE_ADMIN')
    const out = await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER })

    const events = await testDb.portalEvent.findMany({ where: { checkId: check.id, kind: 'RELEASE_REVERSED' } })
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('PENDING')
    expect(events[0].direction).toBe('OUT')
    expect(events[0].idempotencyKey).toBe(`${check.id}:RELEASE_REVERSED:${LATER.toISOString()}`)
    expect(events[0].payload).toEqual({ action: 'RELEASE_REVERSED', checkNumber: check.checkNumber })
    expect(out.portalSyncStatus).toBe('PENDING')
  })

  /**
   * Rule 2. An INTERNAL cheque — payroll, tax, an inter-company transfer —
   * queues its RELEASE_REVERSED flagged internal so the portal bill ages again
   * (ruling 2026-10-19), but carries no routing state: the database's own CHECK
   * constraint refuses portalSyncStatus / portalDomain on one. Pinned here the
   * way the other three sites pin it.
   */
  it('queues a RELEASE_REVERSED for an INTERNAL check and writes no portal state (ruling 2026-10-19)', async () => {
    const { check } = await released({ eligibility: 'INTERNAL', apvNumbers: ['AP-1'] })
    const admin = await makeUser('FINANCE_ADMIN')
    const out = await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER })
    const kinds = (await testDb.portalEvent.findMany({ where: { checkId: check.id }, orderBy: { createdAt: 'asc' } })).map((e) => e.kind)
    expect(kinds).toEqual(['RELEASED', 'RELEASE_REVERSED'])
    expect(out.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(out.portalDomain).toBeNull()
  })

  /**
   * User ruling 2026-11-03 (`6000353139`, "this should not reach the portal"):
   * a reversal undoes a RELEASED the portal received. When none was delivered
   * — never queued, still pending, or closed unsent — the portal holds nothing
   * to undo, and nothing is queued.
   */
  it('queues nothing when the portal was never told of the release', async () => {
    const { check } = await released({ told: false })
    const admin = await makeUser('FINANCE_ADMIN')
    const out = await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER })
    expect(out.status).toBe('READY_FOR_RELEASE')
    expect(out.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(await testDb.portalEvent.count({ where: { checkId: check.id, kind: 'RELEASE_REVERSED' } })).toBe(0)
    const rows = await testDb.auditLog.findMany({ where: { checkId: check.id, action: 'release_reversed' } })
    expect(rows[0].details).toMatchObject({ destination: 'READY_FOR_RELEASE', portalTold: false, portalEvent: null })
  })

  it('a RELEASED closed unsent does not count as told; one the portal answered "unmatched" does', async () => {
    const { check } = await released({ told: false })
    await testDb.portalEvent.updateMany({ where: { checkId: check.id, kind: 'RELEASED' }, data: { status: 'SYNCED', lastError: 'superseded by x' } })
    const admin = await makeUser('FINANCE_ADMIN')
    await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id, kind: 'RELEASE_REVERSED' } })).toBe(0)

    const second = await released({ told: false })
    await testDb.portalEvent.updateMany({ where: { checkId: second.check.id, kind: 'RELEASED' }, data: { status: 'SYNCED', lastError: 'unmatched: AP-9' } })
    await reverseRelease(testDb, { checkId: second.check.id, userId: admin.id, reason: 'x', now: LATER })
    expect(await testDb.portalEvent.count({ where: { checkId: second.check.id, kind: 'RELEASE_REVERSED' } })).toBe(1)
  })
})

/**
 * The destination (user request 2026-11-03: "make a selection where the checks
 * will reside next after reversal"). SIGNED withdraws the cheque: the
 * availability is cleared as `revertAvailability` clears it, and the portal —
 * when it was told of the release — gets one REVERT, which it applies to a
 * RELEASED bill since the same day. An INTERNAL cheque gets the quiet
 * RELEASE_REVERSED instead, REVERT being never sent for one (rule 2).
 */
describe('reverseRelease — destination SIGNED', () => {
  it('withdraws the cheque, clears its availability, and queues one REVERT when the portal was told', async () => {
    const { user, check } = await released()
    const admin = await makeUser('FINANCE_ADMIN')
    const out = await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'Still in the vault', now: LATER, destination: 'SIGNED' })
    expect(out.status).toBe('SIGNED')
    expect(out.releasedAt).toBeNull()
    expect(out.availablePickupDate).toBeNull()
    expect(out.readyAt).toBeNull()
    expect(out.readyById).toBeNull()
    expect(out.scheduledPickupDate).toBeNull()
    expect(out.portalSyncStatus).toBe('PENDING')
    const events = await testDb.portalEvent.findMany({ where: { checkId: check.id, kind: 'REVERT' } })
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('PENDING')
    expect(events[0].idempotencyKey).toBe(`${check.id}:REVERT:${LATER.toISOString()}`)
    expect(await testDb.portalEvent.count({ where: { checkId: check.id, kind: 'RELEASE_REVERSED' } })).toBe(0)
    const rows = await testDb.auditLog.findMany({ where: { checkId: check.id, action: 'release_reversed' } })
    expect(rows[0].details).toEqual({
      releasedAt: NOW.toISOString(), releasedById: user.id,
      destination: 'SIGNED', portalTold: true, portalEvent: 'REVERT',
      availabilityCleared: { availablePickupDate: PICKUP.toISOString(), readyAt: NOW.toISOString(), readyById: user.id },
    })
  })

  it('queues nothing when the portal was never told, and needs no pickup date', async () => {
    const check = await makeCheck({ status: 'RELEASED', eligibility: 'SUPPLIER', availablePickupDate: null, apvNumbers: ['AP-1'] })
    const admin = await makeUser('FINANCE_ADMIN')
    const out = await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'recon', now: LATER, destination: 'SIGNED' })
    expect(out.status).toBe('SIGNED')
    expect(out.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    const rows = await testDb.auditLog.findMany({ where: { checkId: check.id, action: 'release_reversed' } })
    expect(rows[0].details).toEqual({ releasedAt: null, releasedById: null, destination: 'SIGNED', portalTold: false, portalEvent: null })
  })

  it('an INTERNAL cheque gets the quiet RELEASE_REVERSED, never a REVERT (rule 2)', async () => {
    const { check } = await released({ eligibility: 'INTERNAL', apvNumbers: ['AP-1'] })
    const admin = await makeUser('FINANCE_ADMIN')
    const out = await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER, destination: 'SIGNED' })
    expect(out.status).toBe('SIGNED')
    expect(out.portalSyncStatus).toBe('NOT_APPLICABLE')
    const kinds = (await testDb.portalEvent.findMany({ where: { checkId: check.id }, orderBy: { createdAt: 'asc' } })).map((e) => e.kind)
    expect(kinds).toEqual(['RELEASED', 'RELEASE_REVERSED'])
  })

  it('refuses an unknown destination and writes nothing', async () => {
    const { check } = await released()
    const admin = await makeUser('FINANCE_ADMIN')
    await expect(reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER, destination: 'SIGNATURE_PENDING' as never }))
      .rejects.toMatchObject({ code: 'INVALID_DESTINATION' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).status).toBe('RELEASED')
    expect(await testDb.auditLog.count({ where: { checkId: check.id, action: 'release_reversed' } })).toBe(0)
  })
})

/**
 * A cheque the register delivered at RELEASED was never readied here, so it has
 * no availability to keep — and the portal refuses a RELEASE_REVERSED with no
 * pickup date (`6000353139`, 2026-11-03: parked, and the parked reversal then
 * locked REVERT TO SIGNED). The reversal must be given the day the cheque is
 * available again, and records the availability it creates.
 */
describe('reverseRelease — a check released outside the app has no availability to keep', () => {
  const NEW_PICKUP = new Date('2026-11-03')

  async function registerReleased() {
    const check = await makeCheck({ status: 'RELEASED', eligibility: 'SUPPLIER', availablePickupDate: null, apvNumbers: ['AP-ST043002'] })
    return check
  }

  it('refuses without a pickup date, and writes nothing', async () => {
    const check = await registerReleased()
    const admin = await makeUser('FINANCE_ADMIN')
    await expect(reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER }))
      .rejects.toMatchObject({ code: 'PICKUP_DATE_REQUIRED' })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('RELEASED')
    expect(after.availablePickupDate).toBeNull()
    expect(await testDb.auditLog.count({ where: { checkId: check.id, action: 'release_reversed' } })).toBe(0)
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
  })

  it('with a date, records the availability it creates; the portal, never told of the release, hears nothing', async () => {
    const check = await registerReleased()
    const admin = await makeUser('FINANCE_ADMIN')
    const out = await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'Check available as of 3 Nov', now: LATER, availablePickupDate: NEW_PICKUP })
    expect(out.status).toBe('READY_FOR_RELEASE')
    expect(out.availablePickupDate).toEqual(NEW_PICKUP)
    expect(out.readyById).toBe(admin.id)
    expect(out.readyAt).toEqual(LATER)
    expect(out.releasedAt).toBeNull()
    expect(out.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    const rows = await testDb.auditLog.findMany({ where: { checkId: check.id, action: 'release_reversed' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].details).toEqual({
      releasedAt: null, releasedById: null, destination: 'READY_FOR_RELEASE', portalTold: false, portalEvent: null,
      availablePickupDate: NEW_PICKUP.toISOString(),
    })
  })

  /**
   * The register-released cheque the portal DID hear about: `queueReleasedForStale`
   * (2026-10-07) reported every release since go-live, so such a cheque has a
   * delivered RELEASED event — and its reversal then needs the date to be
   * deliverable, which is the whole reason the date is asked for.
   */
  it('with a date and the release reported, queues a deliverable RELEASE_REVERSED', async () => {
    const check = await registerReleased()
    await testDb.portalEvent.create({
      data: { checkId: check.id, direction: 'OUT', kind: 'RELEASED', status: 'SYNCED', idempotencyKey: `${check.id}:RELEASED:stale`, payload: { action: 'RELEASED' } },
    })
    const admin = await makeUser('FINANCE_ADMIN')
    const out = await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER, availablePickupDate: NEW_PICKUP })
    expect(out.portalSyncStatus).toBe('PENDING')
    const events = await testDb.portalEvent.findMany({ where: { checkId: check.id, kind: 'RELEASE_REVERSED' } })
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('PENDING')
  })

  it('a check readied here keeps its own date; one supplied for it is ignored', async () => {
    const { user, check } = await released()
    const admin = await makeUser('FINANCE_ADMIN')
    const out = await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER, availablePickupDate: NEW_PICKUP })
    expect(out.availablePickupDate).toEqual(PICKUP)
    expect(out.readyById).toBe(user.id)
    expect(out.readyAt).toEqual(NOW)
    const rows = await testDb.auditLog.findMany({ where: { checkId: check.id, action: 'release_reversed' } })
    expect(rows[0].details).toEqual({ releasedAt: NOW.toISOString(), releasedById: user.id, ...REVERSED_TO_READY })
  })
})

describe('reverseRelease — the refusals, and that they write nothing', () => {
  async function expectUntouched(checkId: string) {
    const after = await testDb.check.findUniqueOrThrow({ where: { id: checkId } })
    expect(after.status).toBe('RELEASED')
    expect(after.releasedAt).toEqual(NOW)
    expect(await testDb.auditLog.count({ where: { checkId, action: 'release_reversed' } })).toBe(0)
    expect(await testDb.portalEvent.count({ where: { checkId, kind: 'RELEASE_REVERSED' } })).toBe(0)
  }

  it('refuses a blank reason', async () => {
    const { check } = await released()
    const admin = await makeUser('FINANCE_ADMIN')
    await expect(reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: '   ', now: LATER }))
      .rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    await expectUntouched(check.id)
  })

  /**
   * The client's own condition (2026-09-10): a recorded OR/CR is the supplier's
   * paper saying they took the cheque. It is settled with the supplier first.
   */
  it('refuses when a receipt is on record', async () => {
    const { check } = await released({ withReceipt: true })
    const admin = await makeUser('FINANCE_ADMIN')
    await expect(reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER }))
      .rejects.toMatchObject({ code: 'RECEIPT_ON_RECORD' })
    await expectUntouched(check.id)
  })

  it('refuses when the bank has cleared it', async () => {
    const { check } = await released()
    await testDb.check.update({ where: { id: check.id }, data: { clearingStatus: 'CLEARED', clearedDate: LATER } })
    const admin = await makeUser('FINANCE_ADMIN')
    await expect(reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER }))
      .rejects.toMatchObject({ code: 'CLEARED' })
    await expectUntouched(check.id)
  })

  it('refuses a check that is not RELEASED', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'SIGNED' })
    await expect(reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER }))
      .rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' })
    expect(await testDb.auditLog.count({ where: { checkId: check.id } })).toBe(0)
  })

  /**
   * An import-derived row, not one this app could have released itself:
   * `markReadyForRelease` refuses a non-cheque long before RELEASED, but
   * Acumatica can still hand the sync a DEBIT ADV or CASH payment that is
   * already RELEASED. Reversing it would land a non-cheque back at
   * READY_FOR_RELEASE — a state `markReadyForRelease` itself refuses for one —
   * so `reverseRelease` must apply the same `assertReleasable` guard every
   * other status-changing action does.
   */
  it('refuses a non-check, even one already RELEASED', async () => {
    const check = await makeCheck({ status: 'RELEASED', isCheque: false })
    await testDb.check.update({ where: { id: check.id }, data: { releasedAt: NOW } })
    const admin = await makeUser('FINANCE_ADMIN')
    await expect(reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER }))
      .rejects.toMatchObject({ code: 'NOT_A_CHEQUE' })
    await expectUntouched(check.id)
  })
})
