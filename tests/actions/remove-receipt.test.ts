import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import {
  markReadyForRelease, markReleased, reverseRelease, removeReceipt, revertAvailability, RECEIPT_REMOVED_ACTION,
} from '@/lib/domain/actions'
import { DomainError } from '@/lib/domain/errors'

// 2026-10-23: 6000354897 was released by mistake with AR 4852 typed; the
// receipt blocked REVERSE RELEASE and nothing could remove it.
const NOW = new Date('2026-10-16T13:00:00+08:00')
const LATER = new Date('2026-10-23T09:00:00+08:00')

beforeEach(resetDb)

async function releasedWithReceipt() {
  const user = await makeUser()
  const check = await makeCheck({ status: 'SIGNED', apvNumbers: ['AP-ST045048'] })
  await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: new Date('2026-10-16'), now: NOW })
  await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW, orNumber: '4852', receiptType: 'AR' as const })
  return check
}

describe('removeReceipt', () => {
  it('clears the receipt, its amount and file, writes one audit row, and unblocks REVERSE RELEASE', async () => {
    const check = await releasedWithReceipt()
    await testDb.check.update({ where: { id: check.id }, data: { receiptAmount: '9910.71' } })
    const admin = await makeUser('FINANCE_ADMIN')
    await testDb.checkReceiptFile.create({
      data: { checkId: check.id, fileName: 'ar.pdf', contentType: 'application/pdf', sizeBytes: 3, sha256: 'abc', bytes: Buffer.from('pdf'), uploadedById: admin.id },
    })

    await expect(reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER })).rejects.toBeInstanceOf(DomainError)

    const out = await removeReceipt(testDb, { checkId: check.id, userId: admin.id, reason: 'Released by mistake', now: LATER })
    expect(out).toMatchObject({ status: 'RELEASED', orNumber: null, orDate: null, receiptType: null, receiptAmount: null })
    expect(await testDb.checkReceiptFile.count({ where: { checkId: check.id } })).toBe(0)

    const audit = await testDb.auditLog.findMany({ where: { checkId: check.id, action: RECEIPT_REMOVED_ACTION } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ userId: admin.id, remarks: 'Released by mistake' })
    expect(audit[0].details).toMatchObject({ orNumber: '4852', receiptType: 'AR', receiptAmount: '9910.71', file: { fileName: 'ar.pdf', sha256: 'abc' } })

    const reversed = await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'Released by mistake', now: LATER })
    expect(reversed.status).toBe('READY_FOR_RELEASE')
  })

  it('requires a reason and writes nothing without one', async () => {
    const check = await releasedWithReceipt()
    const admin = await makeUser('FINANCE_ADMIN')
    await expect(removeReceipt(testDb, { checkId: check.id, userId: admin.id, reason: '  ', now: LATER })).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).orNumber).toBe('4852')
  })

  it('refuses a check with no receipt, one not RELEASED, and one the bank cleared', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    const none = await makeCheck({ status: 'RELEASED' })
    await expect(removeReceipt(testDb, { checkId: none.id, userId: admin.id, reason: 'r', now: LATER })).rejects.toMatchObject({ code: 'RECEIPT_REQUIRED' })

    const ready = await makeCheck({ status: 'READY_FOR_RELEASE' })
    await testDb.check.update({ where: { id: ready.id }, data: { orNumber: '1', receiptType: 'OR' } })
    await expect(removeReceipt(testDb, { checkId: ready.id, userId: admin.id, reason: 'r', now: LATER })).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' })

    const cleared = await releasedWithReceipt()
    await testDb.check.update({ where: { id: cleared.id }, data: { clearedDate: new Date('2026-10-20') } })
    await expect(removeReceipt(testDb, { checkId: cleared.id, userId: admin.id, reason: 'r', now: LATER })).rejects.toMatchObject({ code: 'CLEARED' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: cleared.id } })).orNumber).toBe('4852')
  })

  it('refuses a receipt the portal already received, but closes one still waiting', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    const sent = await releasedWithReceipt()
    await testDb.portalEvent.create({ data: { checkId: sent.id, direction: 'OUT', kind: 'RECEIPT', status: 'SYNCED', idempotencyKey: 'r-sent', payload: {} } })
    await expect(removeReceipt(testDb, { checkId: sent.id, userId: admin.id, reason: 'r', now: LATER })).rejects.toMatchObject({ code: 'RECEIPT_DELIVERED' })

    const waiting = await releasedWithReceipt()
    await testDb.portalEvent.create({ data: { checkId: waiting.id, direction: 'OUT', kind: 'RECEIPT', status: 'SYNCED', lastError: 'superseded by x', idempotencyKey: 'r-old', payload: {} } })
    const ev = await testDb.portalEvent.create({ data: { checkId: waiting.id, direction: 'OUT', kind: 'RECEIPT', status: 'PENDING', idempotencyKey: 'r-new', payload: {} } })
    await removeReceipt(testDb, { checkId: waiting.id, userId: admin.id, reason: 'r', now: LATER })
    expect(await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ status: 'SYNCED', lastError: 'closed: receipt removed' })
  })
})

// The user, 2026-10-23: a reverted release must reopen the AP in the portal.
// The portal derives "paid" from its RELEASED row, so RELEASE_REVERSED has to
// land; a REVERT queued first would supersede it unsent.
describe('revertAvailability after a reversed release', () => {
  it('refuses while RELEASE_REVERSED is undelivered, and goes through once it is', async () => {
    const check = await releasedWithReceipt()
    const admin = await makeUser('FINANCE_ADMIN')
    await removeReceipt(testDb, { checkId: check.id, userId: admin.id, reason: 'mistake', now: LATER })
    await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'mistake', now: LATER })
    const ev = await testDb.portalEvent.findFirstOrThrow({ where: { checkId: check.id, kind: 'RELEASE_REVERSED' } })
    expect(ev.status).toBe('PENDING')

    await expect(revertAvailability(testDb, { checkId: check.id, userId: admin.id, reason: 'mistake', now: LATER }))
      .rejects.toMatchObject({ code: 'PORTAL_REVERSAL_PENDING' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).status).toBe('READY_FOR_RELEASE')
    expect(await testDb.portalEvent.count({ where: { checkId: check.id, kind: 'REVERT' } })).toBe(0)

    await testDb.portalEvent.update({ where: { id: ev.id }, data: { status: 'SYNCED' } })
    const out = await revertAvailability(testDb, { checkId: check.id, userId: admin.id, reason: 'mistake', now: LATER })
    expect(out.status).toBe('SIGNED')
    expect(await testDb.portalEvent.count({ where: { checkId: check.id, kind: 'REVERT', status: 'PENDING' } })).toBe(1)
  })
})
