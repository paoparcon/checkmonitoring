import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import {
  requestAvailabilityChange, applyOrRequest, approveAvailabilityRequest, rejectAvailabilityRequest,
  REQUESTED_ACTION, APPROVED_ACTION, REJECTED_ACTION, PENDING_KEY,
} from '@/lib/domain/availability-approval'
import { markReadyForRelease } from '@/lib/domain/actions'
import { loadApprover, canDecide, APPROVER_SETTING } from '@/lib/approvals/approver'
import { loadSettings } from '@/lib/settings/read'

const NOW = new Date('2026-11-05T09:00:00.000Z')
const LATER = new Date('2026-11-05T10:00:00.000Z')
const PICKUP = new Date('2026-11-06T00:00:00.000Z')

const setApprover = (id: string) =>
  testDb.setting.upsert({ where: { key: APPROVER_SETTING }, create: { key: APPROVER_SETTING, value: id }, update: { value: id } })
const decider = (u: { id: string; role: 'FINANCE_USER' | 'FINANCE_ADMIN' }) => ({ id: u.id, role: u.role })

beforeEach(resetDb)

describe('requestAvailabilityChange', () => {
  it('records a MAKE_AVAILABLE request and leaves the check, the portal and readyAt alone', async () => {
    const requester = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })
    const request = await requestAvailabilityChange(testDb, {
      kind: 'MAKE_AVAILABLE', checkId: check.id, requesterId: requester.id, now: NOW, availablePickupDate: PICKUP,
    })
    expect(request).toMatchObject({ status: 'PENDING', pendingKey: PENDING_KEY, kind: 'MAKE_AVAILABLE', requestedById: requester.id, availablePickupDate: PICKUP, reason: null })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after).toMatchObject({ status: 'SIGNED', readyAt: null, readyById: null, availablePickupDate: null })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    const audit = await testDb.auditLog.findMany({ where: { checkId: check.id } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: REQUESTED_ACTION, userId: requester.id, actorType: 'USER' })
    expect(audit[0].details).toMatchObject({ requestId: request.id, kind: 'MAKE_AVAILABLE', availablePickupDate: PICKUP.toISOString() })
  })

  it('runs the same refusals as applying would, so the requester hears them now', async () => {
    const requester = await makeUser()
    const signed = await makeCheck({ status: 'SIGNED' })
    await expect(requestAvailabilityChange(testDb, { kind: 'MAKE_AVAILABLE', checkId: signed.id, requesterId: requester.id, now: NOW, availablePickupDate: null }))
      .rejects.toMatchObject({ code: 'MISSING_FIELDS' })
    const pending = await makeCheck({ status: 'SIGNATURE_PENDING' })
    await expect(requestAvailabilityChange(testDb, { kind: 'MAKE_AVAILABLE', checkId: pending.id, requesterId: requester.id, now: NOW, availablePickupDate: PICKUP }))
      .rejects.toMatchObject({ code: 'NOT_SIGNED' })
    const notCheque = await makeCheck({ status: 'SIGNED', isCheque: false })
    await expect(requestAvailabilityChange(testDb, { kind: 'MAKE_AVAILABLE', checkId: notCheque.id, requesterId: requester.id, now: NOW, availablePickupDate: PICKUP }))
      .rejects.toMatchObject({ code: 'NOT_A_CHEQUE' })
    // WITHDRAW: a reason, and a check that is actually available.
    const ready = await makeCheck({ status: 'READY_FOR_RELEASE', availablePickupDate: PICKUP })
    await expect(requestAvailabilityChange(testDb, { kind: 'WITHDRAW', checkId: ready.id, requesterId: requester.id, now: NOW, reason: '  ' }))
      .rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    await expect(requestAvailabilityChange(testDb, { kind: 'WITHDRAW', checkId: signed.id, requesterId: requester.id, now: NOW, reason: 'pulled' }))
      .rejects.toMatchObject({ code: 'NOT_AVAILABLE' })
    const released = await makeCheck({ status: 'RELEASED' })
    await expect(requestAvailabilityChange(testDb, { kind: 'WITHDRAW', checkId: released.id, requesterId: requester.id, now: NOW, reason: 'pulled' }))
      .rejects.toMatchObject({ code: 'NOT_AVAILABLE' })
    expect(await testDb.availabilityRequest.count()).toBe(0)
    expect(await testDb.auditLog.count()).toBe(0)
  })

  it('allows one pending request per check', async () => {
    const requester = await makeUser()
    const other = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await requestAvailabilityChange(testDb, { kind: 'MAKE_AVAILABLE', checkId: check.id, requesterId: requester.id, now: NOW, availablePickupDate: PICKUP })
    await expect(requestAvailabilityChange(testDb, { kind: 'MAKE_AVAILABLE', checkId: check.id, requesterId: other.id, now: LATER, availablePickupDate: PICKUP }))
      .rejects.toMatchObject({ code: 'APPROVAL_PENDING' })
    // The index behind the read-then-write: a second PENDING row cannot exist.
    await expect(testDb.availabilityRequest.create({
      data: { checkId: check.id, kind: 'MAKE_AVAILABLE', status: 'PENDING', pendingKey: PENDING_KEY, requestedById: other.id, requestedAt: LATER },
    })).rejects.toMatchObject({ code: 'P2002' })
    expect(await testDb.availabilityRequest.count()).toBe(1)
  })
})

describe('applyOrRequest — the gate', () => {
  it('applies at once when nobody is set', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    const out = await applyOrRequest(testDb, { kind: 'MAKE_AVAILABLE', checkId: check.id, actor: user, approver: null, now: NOW, availablePickupDate: PICKUP })
    expect(out.applied).toBe(true)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).status).toBe('READY_FOR_RELEASE')
    expect(await testDb.availabilityRequest.count()).toBe(0)
  })

  it("applies at once for the approver's own action, and requests for anybody else", async () => {
    const approver = await makeUser('FINANCE_ADMIN')
    const other = await makeUser()
    const inForce = { id: approver.id, name: approver.name, email: approver.email }
    const a = await makeCheck({ status: 'SIGNED' })
    const b = await makeCheck({ status: 'SIGNED' })
    const own = await applyOrRequest(testDb, { kind: 'MAKE_AVAILABLE', checkId: a.id, actor: approver, approver: inForce, now: NOW, availablePickupDate: PICKUP })
    expect(own.applied).toBe(true)
    const theirs = await applyOrRequest(testDb, { kind: 'MAKE_AVAILABLE', checkId: b.id, actor: other, approver: inForce, now: NOW, availablePickupDate: PICKUP })
    expect(theirs.applied).toBe(false)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('READY_FOR_RELEASE')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('SIGNED')
    expect(await testDb.availabilityRequest.count({ where: { checkId: b.id, status: 'PENDING' } })).toBe(1)
  })

  it('gates a withdrawal the same way', async () => {
    const approver = await makeUser('FINANCE_ADMIN')
    const other = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: approver.id, availablePickupDate: PICKUP, now: NOW })
    const out = await applyOrRequest(testDb, { kind: 'WITHDRAW', checkId: check.id, actor: other, approver: { id: approver.id, name: approver.name, email: approver.email }, now: LATER, reason: 'Pulled from the list' })
    expect(out.applied).toBe(false)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after).toMatchObject({ status: 'READY_FOR_RELEASE', availablePickupDate: PICKUP })
    // Still only the MARK_AVAILABLE event: the portal has not been told of any withdrawal.
    expect((await testDb.portalEvent.findMany({ where: { checkId: check.id } })).map((e) => e.kind)).toEqual(['MARK_AVAILABLE'])
  })
})

describe('approveAvailabilityRequest', () => {
  it('applies the change AS THE APPROVER, queues the portal event, and closes the request', async () => {
    const approver = await makeUser('FINANCE_USER')
    await setApprover(approver.id)
    const requester = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })
    const request = await requestAvailabilityChange(testDb, { kind: 'MAKE_AVAILABLE', checkId: check.id, requesterId: requester.id, now: NOW, availablePickupDate: PICKUP })

    const out = await approveAvailabilityRequest(testDb, { requestId: request.id, actor: decider(approver), now: LATER, note: 'ok' })
    expect(out.check).toMatchObject({ status: 'READY_FOR_RELEASE', readyById: approver.id, readyAt: LATER, availablePickupDate: PICKUP })
    expect(out.request).toMatchObject({ status: 'APPROVED', pendingKey: null, decidedById: approver.id, decidedAt: LATER, decisionNote: 'ok' })

    const events = await testDb.portalEvent.findMany({ where: { checkId: check.id } })
    expect(events.map((e) => [e.kind, e.status])).toEqual([['MARK_AVAILABLE', 'PENDING']])

    const rows = await testDb.auditLog.findMany({ where: { checkId: check.id }, orderBy: { createdAt: 'asc' } })
    expect(rows.map((r) => r.action)).toEqual([REQUESTED_ACTION, 'ready_for_release', APPROVED_ACTION])
    const ready = rows[1]
    expect(ready.userId).toBe(approver.id)
    expect(ready.details).toMatchObject({ approval: { requestId: request.id, requestedById: requester.id, requestedAt: NOW.toISOString() } })
    expect(rows[2]).toMatchObject({ userId: approver.id, remarks: 'ok' })
    expect(rows[2].details).toMatchObject({ requestId: request.id, requestedById: requester.id })
  })

  it('applies a WITHDRAW: back to SIGNED, pickup cleared, REVERT queued, the approval on the audit row', async () => {
    const approver = await makeUser('FINANCE_USER')
    await setApprover(approver.id)
    const requester = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: approver.id, availablePickupDate: PICKUP, now: NOW })
    const request = await requestAvailabilityChange(testDb, { kind: 'WITHDRAW', checkId: check.id, requesterId: requester.id, now: NOW, reason: 'Pulled from the list' })

    const out = await approveAvailabilityRequest(testDb, { requestId: request.id, actor: decider(approver), now: LATER })
    expect(out.check).toMatchObject({ status: 'SIGNED', availablePickupDate: null, readyById: null })
    expect((await testDb.portalEvent.findMany({ where: { checkId: check.id }, orderBy: { createdAt: 'asc' } })).map((e) => e.kind)).toEqual(['MARK_AVAILABLE', 'REVERT'])
    const reverted = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'reverted_availability' } })
    expect(reverted).toMatchObject({ userId: approver.id, remarks: 'Pulled from the list' })
    expect(reverted.details).toMatchObject({ approval: { requestId: request.id, requestedById: requester.id } })
  })

  it('refuses anybody but the approver in force, and writes nothing', async () => {
    const approver = await makeUser('FINANCE_USER')
    await setApprover(approver.id)
    const admin = await makeUser('FINANCE_ADMIN')
    const requester = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    const request = await requestAvailabilityChange(testDb, { kind: 'MAKE_AVAILABLE', checkId: check.id, requesterId: requester.id, now: NOW, availablePickupDate: PICKUP })
    await expect(approveAvailabilityRequest(testDb, { requestId: request.id, actor: decider(admin), now: LATER }))
      .rejects.toMatchObject({ code: 'NOT_APPROVER' })
    await expect(approveAvailabilityRequest(testDb, { requestId: request.id, actor: decider(requester), now: LATER }))
      .rejects.toMatchObject({ code: 'NOT_APPROVER' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).status).toBe('SIGNED')
    expect((await testDb.availabilityRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('PENDING')
  })

  it('lets a Finance Admin close what is left when nobody is set, and nobody else', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    const request = await requestAvailabilityChange(testDb, { kind: 'MAKE_AVAILABLE', checkId: check.id, requesterId: user.id, now: NOW, availablePickupDate: PICKUP })
    await expect(approveAvailabilityRequest(testDb, { requestId: request.id, actor: decider(user), now: LATER }))
      .rejects.toMatchObject({ code: 'NOT_APPROVER' })
    const out = await approveAvailabilityRequest(testDb, { requestId: request.id, actor: decider(admin), now: LATER })
    expect(out.check.status).toBe('READY_FOR_RELEASE')
  })

  it('refuses a request whose check moved since, naming the status, and leaves it pending', async () => {
    const approver = await makeUser('FINANCE_ADMIN')
    await setApprover(approver.id)
    const requester = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    const request = await requestAvailabilityChange(testDb, { kind: 'MAKE_AVAILABLE', checkId: check.id, requesterId: requester.id, now: NOW, availablePickupDate: PICKUP })
    await testDb.check.update({ where: { id: check.id }, data: { status: 'RELEASED' } })
    await expect(approveAvailabilityRequest(testDb, { requestId: request.id, actor: decider(approver), now: LATER }))
      .rejects.toMatchObject({ code: 'REQUEST_STALE', message: expect.stringContaining('RELEASED') })
    expect((await testDb.availabilityRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('PENDING')
    expect(await testDb.auditLog.count({ where: { checkId: check.id } })).toBe(1)
  })

  it('refuses a request already decided', async () => {
    const approver = await makeUser('FINANCE_ADMIN')
    await setApprover(approver.id)
    const requester = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    const request = await requestAvailabilityChange(testDb, { kind: 'MAKE_AVAILABLE', checkId: check.id, requesterId: requester.id, now: NOW, availablePickupDate: PICKUP })
    await approveAvailabilityRequest(testDb, { requestId: request.id, actor: decider(approver), now: LATER })
    await expect(approveAvailabilityRequest(testDb, { requestId: request.id, actor: decider(approver), now: LATER }))
      .rejects.toMatchObject({ code: 'REQUEST_DECIDED' })
    await expect(approveAvailabilityRequest(testDb, { requestId: 'nope', actor: decider(approver), now: LATER }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('rejectAvailabilityRequest', () => {
  it('needs a note, closes the request, touches no check, and frees the check for a new request', async () => {
    const approver = await makeUser('FINANCE_ADMIN')
    await setApprover(approver.id)
    const requester = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    const request = await requestAvailabilityChange(testDb, { kind: 'MAKE_AVAILABLE', checkId: check.id, requesterId: requester.id, now: NOW, availablePickupDate: PICKUP })
    await expect(rejectAvailabilityRequest(testDb, { requestId: request.id, actor: decider(approver), now: LATER, note: ' ' }))
      .rejects.toMatchObject({ code: 'NOTE_REQUIRED' })
    await expect(rejectAvailabilityRequest(testDb, { requestId: request.id, actor: decider(requester), now: LATER, note: 'no' }))
      .rejects.toMatchObject({ code: 'NOT_APPROVER' })

    const out = await rejectAvailabilityRequest(testDb, { requestId: request.id, actor: decider(approver), now: LATER, note: 'Not on the list' })
    expect(out).toMatchObject({ status: 'REJECTED', pendingKey: null, decidedById: approver.id, decisionNote: 'Not on the list' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).status).toBe('SIGNED')
    expect(await testDb.portalEvent.count()).toBe(0)
    const rows = await testDb.auditLog.findMany({ where: { checkId: check.id }, orderBy: { createdAt: 'asc' } })
    expect(rows.map((r) => r.action)).toEqual([REQUESTED_ACTION, REJECTED_ACTION])
    expect(rows[1]).toMatchObject({ userId: approver.id, remarks: 'Not on the list' })

    // A decided request no longer holds the one-pending slot.
    const again = await requestAvailabilityChange(testDb, { kind: 'MAKE_AVAILABLE', checkId: check.id, requesterId: requester.id, now: LATER, availablePickupDate: PICKUP })
    expect(again.status).toBe('PENDING')
  })
})

describe('loadApprover and canDecide', () => {
  it('is nobody when unset, invalid when the id names no active user, and the person otherwise', async () => {
    expect(await loadApprover(testDb, await loadSettings(testDb))).toEqual({ approver: null, configured: false, invalid: false })
    const gone = await makeUser('FINANCE_ADMIN')
    await testDb.user.update({ where: { id: gone.id }, data: { active: false } })
    await setApprover(gone.id)
    expect(await loadApprover(testDb, await loadSettings(testDb))).toEqual({ approver: null, configured: true, invalid: true })
    await setApprover('no-such-user')
    expect((await loadApprover(testDb, await loadSettings(testDb))).invalid).toBe(true)
    const paolo = await makeUser('FINANCE_ADMIN')
    await setApprover(paolo.id)
    expect(await loadApprover(testDb, await loadSettings(testDb))).toEqual({
      approver: { id: paolo.id, name: paolo.name, email: paolo.email }, configured: true, invalid: false,
    })
  })

  it('canDecide: the approver only; a Finance Admin only while nobody is set', () => {
    const approver = { id: 'a', name: 'A', email: 'a@x' }
    expect(canDecide({ id: 'a', role: 'FINANCE_USER' }, approver)).toBe(true)
    expect(canDecide({ id: 'b', role: 'FINANCE_ADMIN' }, approver)).toBe(false)
    expect(canDecide({ id: 'b', role: 'FINANCE_ADMIN' }, null)).toBe(true)
    expect(canDecide({ id: 'b', role: 'FINANCE_USER' }, null)).toBe(false)
  })
})
