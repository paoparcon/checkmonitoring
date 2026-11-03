import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { findAttachedCancelled, detachAttachedCancelled, DETACHED_EVENT_ERROR } from '@/lib/admin/detach-cancelled-apvs'
import { APV_DETACHED_ACTION } from '@/lib/domain/actions'
import { getPortalOverview } from '@/lib/admin/portal-overview'

const NOW = new Date('2026-10-29T10:00:00+08:00')
beforeEach(resetDb)

async function event(checkId: string, status: 'PENDING' | 'FAILED' | 'PARKED' | 'SYNCED') {
  return testDb.portalEvent.create({
    data: {
      checkId, direction: 'OUT', kind: 'CANCELLED', status, payload: { action: 'CANCELLED' },
      idempotencyKey: `detach-test-${checkId}-${status}`, attempts: status === 'PARKED' ? 1 : 0,
    },
  })
}

describe('detach-cancelled-apvs', () => {
  it('finds CANCELLED and VOIDED cheques connected through apvNumbers or a bill, with their open CANCELLED events', async () => {
    const byApv = await makeCheck({ status: 'VOIDED', apvNumbers: ['AP-1'], checkNumber: '1' })
    const byBill = await makeCheck({ status: 'CANCELLED', apvNumbers: [], checkNumber: '2' })
    await testDb.checkBill.create({ data: { checkId: byBill.id, apvNumber: 'AP-2', amount: '1.00' } })
    const parked = await event(byApv.id, 'PARKED')
    await event(byApv.id, 'SYNCED')
    await makeCheck({ status: 'VOIDED', apvNumbers: [] })            // nothing to detach
    await makeCheck({ status: 'SIGNED', apvNumbers: ['AP-9'] })      // live: never listed

    const rows = await findAttachedCancelled(testDb)
    expect(rows.map((r) => r.checkNumber)).toEqual(['2', '1'])
    expect(rows[1]).toMatchObject({ status: 'VOIDED', apvNumbers: ['AP-1'], billApvs: [], openEventIds: [parked.id] })
    expect(rows[0]).toMatchObject({ status: 'CANCELLED', apvNumbers: [], billApvs: ['AP-2'], openEventIds: [] })
  })

  it('detaches each, closes its open CANCELLED events unsent as unmatchable, and writes one audit row', async () => {
    const c = await makeCheck({ status: 'VOIDED', apvNumbers: ['AP-1'] })
    await testDb.check.update({ where: { id: c.id }, data: { portalSyncStatus: 'FAILED', portalDomain: 'LOCAL' } })
    await testDb.checkBill.create({ data: { checkId: c.id, apvNumber: 'AP-1', amount: '5.00' } })
    const parked = await event(c.id, 'PARKED')
    const synced = await event(c.id, 'SYNCED')

    const r = await detachAttachedCancelled(testDb, await findAttachedCancelled(testDb), NOW)
    expect(r).toEqual({ detached: 1, eventsClosed: 1 })

    const after = await testDb.check.findUniqueOrThrow({ where: { id: c.id } })
    expect(after).toMatchObject({ status: 'VOIDED', apvNumbers: [], portalSyncStatus: 'NOT_APPLICABLE' })
    expect(await testDb.checkBill.count({ where: { checkId: c.id } })).toBe(0)
    expect(await testDb.portalEvent.findUniqueOrThrow({ where: { id: parked.id } })).toMatchObject({ status: 'SYNCED', lastError: DETACHED_EVENT_ERROR })
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: synced.id } })).lastError).toBeNull()
    expect((await getPortalOverview(testDb)).closed.unmatchable).toBe(1)

    const audits = await testDb.auditLog.findMany({ where: { checkId: c.id, action: APV_DETACHED_ACTION } })
    expect(audits).toHaveLength(1)
    expect(audits[0].actorType).toBe('SYSTEM')
    expect(audits[0].details).toMatchObject({
      apvNumbersDetached: ['AP-1'], billsDetached: [expect.objectContaining({ apvNumber: 'AP-1', amount: '5.00' })],
      status: 'VOIDED', eventsClosed: 1,
    })
    expect(audits[0].remarks).toContain('Detached from AP-1')
    expect(await findAttachedCancelled(testDb)).toEqual([])
  })

  it('leaves a cheque alone that is no longer cancelled when its turn comes', async () => {
    const c = await makeCheck({ status: 'CANCELLED', apvNumbers: ['AP-1'] })
    const rows = await findAttachedCancelled(testDb)
    await testDb.check.update({ where: { id: c.id }, data: { status: 'SIGNED' } })
    expect(await detachAttachedCancelled(testDb, rows, NOW)).toEqual({ detached: 0, eventsClosed: 0 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).apvNumbers).toEqual(['AP-1'])
    expect(await testDb.auditLog.count({ where: { action: APV_DETACHED_ACTION } })).toBe(0)
  })
})
