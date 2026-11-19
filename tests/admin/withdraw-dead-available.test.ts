import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { findDeadAvailable, withdrawDeadAvailable, WITHDRAWN_AFTER_CANCEL_ACTION } from '@/lib/admin/withdraw-dead-available'
import { writeAudit } from '@/lib/audit'

const NOW = new Date('2026-11-19T13:00:00+08:00')

beforeEach(resetDb)

const told = (checkId: string, kind: 'MARK_AVAILABLE' | 'REVERT' | 'RELEASED', at: string, extra: Record<string, unknown> = {}) =>
  testDb.portalEvent.create({
    data: {
      checkId, direction: 'OUT', kind, status: 'SYNCED', createdAt: new Date(at), nextAttemptAt: new Date(at),
      idempotencyKey: `${checkId}:${kind}:${at}`, payload: { action: kind }, ...extra,
    },
  })

/** A cheque voided under the 2026-10-29 rule: detached, the vouchers kept on its `voided` row. */
async function voidedAfterAnnounce(checkNumber: string, apvs: string[], eligibility: 'SUPPLIER' | 'INTERNAL' = 'SUPPLIER') {
  const check = await makeCheck({ status: 'VOIDED', eligibility, apvNumbers: [], checkNumber })
  await writeAudit(testDb, { checkId: check.id, actorType: 'SYSTEM', action: 'voided', details: { apvNumbersDetached: apvs, billsDetached: [] } })
  return check
}

describe('withdraw-dead-available (ruling 2026-11-19)', () => {
  it('finds a voided cheque the portal still lists, and only that', async () => {
    const dead = await voidedAfterAnnounce('1791406353', ['AP-A1035183'])
    await told(dead.id, 'MARK_AVAILABLE', '2026-11-05T08:54:51Z')
    const withdrawn = await voidedAfterAnnounce('6000000001', ['AP-ST000001'])
    await told(withdrawn.id, 'MARK_AVAILABLE', '2026-11-05T00:00:00Z'); await told(withdrawn.id, 'REVERT', '2026-11-06T00:00:00Z')
    const unsent = await voidedAfterAnnounce('6000000002', ['AP-ST000002'])
    await told(unsent.id, 'MARK_AVAILABLE', '2026-11-05T00:00:00Z', { lastError: 'stale: check is now VOIDED' })
    const live = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'SUPPLIER', apvNumbers: ['AP-ST000003'] })
    await told(live.id, 'MARK_AVAILABLE', '2026-11-05T00:00:00Z')

    const rows = await findDeadAvailable(testDb)
    expect(rows.map((r) => r.checkNumber)).toEqual(['1791406353'])
    expect(rows[0]).toMatchObject({ status: 'VOIDED', lastTold: 'MARK_AVAILABLE', detached: { apvNumbersDetached: ['AP-A1035183'] } })
  })

  it('queues one REVERT carrying the detached vouchers, audits it, and finds nothing on a second look', async () => {
    const dead = await voidedAfterAnnounce('6000318593', ['AP-ST028422'])
    await told(dead.id, 'MARK_AVAILABLE', '2026-11-05T07:50:42Z')
    const results = await withdrawDeadAvailable(testDb, await findDeadAvailable(testDb), NOW)
    expect(results).toEqual([{ checkNumber: '6000318593', withdrawn: ['AP-ST028422'], heldByAnother: [] }])
    const ev = await testDb.portalEvent.findFirstOrThrow({ where: { checkId: dead.id, kind: 'REVERT' } })
    expect(ev).toMatchObject({ status: 'PENDING', payload: { withdrawnOnCancel: true, apvs: ['AP-ST028422'], checkNumber: '6000318593' } })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: dead.id } }))).toMatchObject({ status: 'VOIDED', portalSyncStatus: 'PENDING' })
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: dead.id, action: WITHDRAWN_AFTER_CANCEL_ACTION } })
    expect(audit.details).toMatchObject({ portalEvent: 'REVERT', portalWithdrawn: ['AP-ST028422'], lastTold: 'MARK_AVAILABLE' })
    expect(await findDeadAvailable(testDb)).toEqual([])
  })

  it('leaves a bill another cheque already holds at the portal, and writes nothing for it', async () => {
    const dead = await voidedAfterAnnounce('6000000010', ['AP-ST000010'])
    await told(dead.id, 'MARK_AVAILABLE', '2026-11-05T00:00:00Z')
    await makeCheck({ status: 'RELEASED', eligibility: 'SUPPLIER', apvNumbers: ['AP-ST000010'], checkNumber: '6000000011' })
    const results = await withdrawDeadAvailable(testDb, await findDeadAvailable(testDb), NOW)
    expect(results[0]).toMatchObject({ withdrawn: [], heldByAnother: ['AP-ST000010'], skipped: 'every voucher is held by another cheque' })
    expect(await testDb.portalEvent.count({ where: { kind: 'REVERT' } })).toBe(0)
    expect(await testDb.auditLog.count({ where: { action: WITHDRAWN_AFTER_CANCEL_ACTION } })).toBe(0)
  })
})
