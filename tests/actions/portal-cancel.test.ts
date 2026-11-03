import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import { cancelCheck, voidCheck, DETACHED_SKIP_REASON } from '@/lib/domain/actions'

const NOW = new Date('2026-10-29T10:00:00+08:00')

beforeEach(resetDb)

// USER RULING 2026-10-29: "Once the check is cancelled, it should not be
// connected to the AP it was applied to." A cancel or void detaches the cheque
// from its bills and queues NOTHING for the portal — the portal keeps one row
// per BILL, and the voided cheque's CANCELLED cancelled the bill's row under
// a re-issue (6000354974..77 on AP-ST039900/07/10/12, 26 October).
describe('a cancelled or voided cheque is detached from its AP bills, and the portal is not told', () => {
  it('cancelCheck empties apvNumbers, deletes its bills, queues nothing, and records what it detached', async () => {
    const user = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'SUPPLIER', apvNumbers: ['AP-ST000002', 'AP-ST000001'] })
    await testDb.checkBill.create({ data: { checkId: check.id, apvNumber: 'AP-ST000001', poNumber: 'PO-1', amount: '1.50' } })
    await cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'duplicate', now: NOW })

    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('CANCELLED')
    expect(after.apvNumbers).toEqual([])
    expect(after.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(after.portalDomain).toBe('LOCAL')
    expect(await testDb.checkBill.count({ where: { checkId: check.id } })).toBe(0)

    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'cancelled' } })
    expect(audit.details).toEqual({
      portalNotified: false, portalSkipReason: DETACHED_SKIP_REASON,
      apvNumbersDetached: ['AP-ST000002', 'AP-ST000001'],
      billsDetached: [expect.objectContaining({ apvNumber: 'AP-ST000001', poNumber: 'PO-1', amount: '1.50' })],
    })
    expect(audit.remarks).toBe('duplicate Detached from AP-ST000001, AP-ST000002 (user ruling 2026-10-29).')
  })

  it('voidCheck does the same for a BROKER check, even after release', async () => {
    const check = await makeCheck({ status: 'RELEASED', eligibility: 'BROKER', apvNumbers: ['AP-ST000002'] })
    await voidCheck(testDb, { checkId: check.id, reason: 'Voided in Acumatica', now: NOW })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after).toMatchObject({ status: 'VOIDED', apvNumbers: [], portalSyncStatus: 'NOT_APPLICABLE', portalDomain: 'BROKER' })
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'voided_after_release' } })
    expect(audit.details).toMatchObject({ portalNotified: false, portalSkipReason: DETACHED_SKIP_REASON, apvNumbersDetached: ['AP-ST000002'] })
    expect(audit.remarks).toContain('Detached from AP-ST000002')
  })

  it('an INTERNAL check is detached too, queues nothing, and writes no portal state (ruling 2026-10-19 kept)', async () => {
    const user = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL', apvNumbers: ['AP-ST000009'] })
    await cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'x', now: NOW })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after).toMatchObject({ apvNumbers: [], portalSyncStatus: 'NOT_APPLICABLE', portalDomain: null })
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'cancelled' } })
    // No portal keys for an unrouted cheque; the detachment is still recorded.
    expect(audit.details).toEqual({ apvNumbersDetached: ['AP-ST000009'], billsDetached: [] })
  })

  it('voidCheck on an INTERNAL check queues nothing either', async () => {
    const check = await makeCheck({ status: 'RELEASED', eligibility: 'INTERNAL', apvNumbers: ['AP-ST000010'] })
    await voidCheck(testDb, { checkId: check.id, reason: 'Voided in Acumatica', now: NOW })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } }))).toMatchObject({ apvNumbers: [], portalSyncStatus: 'NOT_APPLICABLE' })
  })

  it('a routed check with nothing to detach still says the portal was not told, and nothing else', async () => {
    const user = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER', apvNumbers: [] })
    await cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'spoiled', now: NOW })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'cancelled' } })
    expect(audit.details).toEqual({ portalNotified: false, portalSkipReason: DETACHED_SKIP_REASON })
    expect(audit.remarks).toBe('spoiled')
  })

  it('voidCheck on a routed check with nothing to detach records the same on its voided row', async () => {
    const check = await makeCheck({ status: 'SIGNATURE_PENDING', eligibility: 'SUPPLIER', apvNumbers: [] })
    await voidCheck(testDb, { checkId: check.id, reason: 'Voided in Acumatica', now: NOW })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'voided' } })
    expect(audit.details).toMatchObject({ portalNotified: false, portalSkipReason: DETACHED_SKIP_REASON })
    expect(audit.details).not.toHaveProperty('apvNumbersDetached')
  })

  it('a check carrying only a bill is detached from it too', async () => {
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER', apvNumbers: [] })
    await testDb.checkBill.create({ data: { checkId: check.id, apvNumber: 'AP-ST000004', amount: '1.00' } })
    await voidCheck(testDb, { checkId: check.id, reason: 'Voided in Acumatica', now: NOW })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    expect(await testDb.checkBill.count({ where: { checkId: check.id } })).toBe(0)
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'voided' } })
    expect(audit.details).toMatchObject({ apvNumbersDetached: [], billsDetached: [expect.objectContaining({ apvNumber: 'AP-ST000004' })] })
  })

  it('an INTERNAL check with nothing to detach records no details at all', async () => {
    const user = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL' })
    await cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'x', now: NOW })
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'cancelled' } })
    expect(audit.details).toBeNull()
  })

  it('the re-issue keeps the bill: voiding the old cheque leaves the live one on the same APV untouched', async () => {
    const old = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'SUPPLIER', apvNumbers: ['AP-ST039907'], checkNumber: '6000354900' })
    const reissue = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER', apvNumbers: ['AP-ST039907'], checkNumber: '6000354974' })
    await voidCheck(testDb, { checkId: old.id, reason: 'Voided in Acumatica', now: NOW })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: old.id } })).apvNumbers).toEqual([])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: reissue.id } })).apvNumbers).toEqual(['AP-ST039907'])
    expect(await testDb.portalEvent.count()).toBe(0)
  })
})
