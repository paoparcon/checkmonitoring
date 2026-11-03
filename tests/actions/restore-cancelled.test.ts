import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import { restoreCancelled, cancelCheck } from '@/lib/domain/actions'
import { DomainError } from '@/lib/domain/errors'

const now = new Date('2026-10-06T04:00:00Z')
beforeEach(resetDb)

async function cancelled() {
  const actor = await makeUser()
  const c = await makeCheck({ status: 'CANCELLED' })
  await testDb.check.update({
    where: { id: c.id },
    data: { cancelledById: actor.id, cancelledAt: now, cancelReason: 'Wrong payee' },
  })
  return { actor, c }
}

describe('restoreCancelled', () => {
  it('returns a CANCELLED check to SIGNED, clears the cancel fields, writes one row', async () => {
    const { actor, c } = await cancelled()
    const after = await restoreCancelled(testDb, { checkId: c.id, userId: actor.id, reason: 'Cancelled in error', now })
    expect(after).toMatchObject({ status: 'SIGNED', cancelledById: null, cancelledAt: null, cancelReason: null })
    const rows = await testDb.auditLog.findMany({ where: { checkId: c.id, action: 'cancellation_restored' } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ userId: actor.id, remarks: 'Cancelled in error' })
    expect(rows[0].details).toMatchObject({ from: 'CANCELLED', to: 'SIGNED', previousCancelReason: 'Wrong payee' })
  })

  it('re-attaches the vouchers the cancellation detached, except one a live cheque has taken since', async () => {
    const actor = await makeUser()
    const c = await makeCheck({ status: 'SIGNED', apvNumbers: ['AP-A', 'AP-B'] })
    await cancelCheck(testDb, { checkId: c.id, userId: actor.id, reason: 'Wrong payee', now })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).apvNumbers).toEqual([])
    // A re-issue of the same company took AP-B in between.
    await testDb.check.create({
      data: {
        companyId: c.companyId, cashAccountId: c.cashAccountId, checkNumber: `${c.checkNumber}1`,
        apvNumbers: ['AP-B'], amount: '1.00', currency: 'PHP', status: 'SIGNED', eligibility: 'SUPPLIER', isCheque: true,
      },
    })

    const after = await restoreCancelled(testDb, { checkId: c.id, userId: actor.id, reason: 'Cancelled in error', now })
    expect(after.status).toBe('SIGNED')
    expect(after.apvNumbers).toEqual(['AP-A'])
    const row = await testDb.auditLog.findFirstOrThrow({ where: { checkId: c.id, action: 'cancellation_restored' } })
    expect(row.details).toMatchObject({ apvNumbersReattached: ['AP-A'] })
    expect(row.remarks).toBe('Cancelled in error Re-attached to AP-A.')
  })

  it('requires a reason', async () => {
    const { actor, c } = await cancelled()
    await expect(restoreCancelled(testDb, { checkId: c.id, userId: actor.id, reason: ' ', now })).rejects.toBeInstanceOf(DomainError)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('CANCELLED')
  })

  it('refuses every status but CANCELLED', async () => {
    const actor = await makeUser()
    for (const status of ['SIGNATURE_PENDING', 'SIGNED', 'RELEASED', 'VOIDED'] as const) {
      const c = await makeCheck({ status })
      await expect(restoreCancelled(testDb, { checkId: c.id, userId: actor.id, reason: 'x', now }), status).rejects.toBeInstanceOf(DomainError)
    }
  })

  it('refuses once the portal has been told, and changes nothing', async () => {
    const { actor, c } = await cancelled()
    await testDb.portalEvent.create({
      data: {
        checkId: c.id, direction: 'OUT', kind: 'CANCELLED', status: 'SYNCED',
        idempotencyKey: `restore-test-${c.id}`, payload: { action: 'CANCELLED' },
      },
    })
    await expect(restoreCancelled(testDb, { checkId: c.id, userId: actor.id, reason: 'x', now }))
      .rejects.toMatchObject({ code: 'PORTAL_ALREADY_NOTIFIED' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('CANCELLED')
  })
})
