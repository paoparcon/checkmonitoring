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

/** A cheque released through the app, the way every future release will be. */
async function released(opts: { eligibility?: 'SUPPLIER' | 'INTERNAL'; withReceipt?: boolean; apvNumbers?: string[] } = {}) {
  const user = await makeUser()
  const check = await makeCheck({ status: 'SIGNED', eligibility: opts.eligibility ?? 'SUPPLIER', ...(opts.apvNumbers ? { apvNumbers: opts.apvNumbers } : {}) })
  await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
  await markReleased(testDb, {
    checkId: check.id, userId: user.id, now: NOW, remarks: 'Handed to the courier',
    ...(opts.withReceipt ? { orNumber: 'OR-000123', receiptType: 'OR' as const } : {}),
  })
  return { user, check }
}

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
    expect(rows[0].details).toEqual({ releasedAt: NOW.toISOString(), releasedById: user.id })
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
