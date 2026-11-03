import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import { findRecentSigned, manilaDayStart, revertRecentSigned } from '@/lib/admin/revert-recent-signed'
import { SIGNATURE_REVERTED_ACTION } from '@/lib/domain/auto-sign'

const now = new Date('2026-10-22T04:00:00Z')
beforeEach(resetDb)

async function checkAt(status: 'SIGNED' | 'SIGNATURE_PENDING' | 'READY_FOR_RELEASE', createdAt: string, checkNumber: string) {
  const c = await makeCheck({ status, checkNumber })
  await testDb.check.update({ where: { id: c.id }, data: { createdAt: new Date(createdAt) } })
  return c
}

describe('revert recent SIGNED checks', () => {
  it('starts at 00:00 Manila on the day', () => {
    expect(manilaDayStart('2026-10-19').toISOString()).toBe('2026-10-18T16:00:00.000Z')
    expect(() => manilaDayStart('19/10/2026')).toThrow()
  })

  it('lists only SIGNED checks first read on or after the day', async () => {
    await checkAt('SIGNED', '2026-10-18T15:59:59Z', '1001') // 23:59 Manila on the 18th
    await checkAt('SIGNED', '2026-10-18T16:00:00Z', '1002') // 00:00 Manila on the 19th
    await checkAt('SIGNED', '2026-10-21T02:00:00Z', '1003')
    await checkAt('SIGNATURE_PENDING', '2026-10-20T02:00:00Z', '1004')
    await checkAt('READY_FOR_RELEASE', '2026-10-20T02:00:00Z', '1005')
    const rows = await findRecentSigned(testDb, manilaDayStart('2026-10-19'))
    expect(rows.map((r) => r.checkNumber)).toEqual(['1002', '1003'])
  })

  it('reverts each through revertSignature, one audit row each, and refuses one that changed', async () => {
    const actor = await makeUser()
    await checkAt('SIGNED', '2026-10-19T02:00:00Z', '2001')
    const moved = await checkAt('SIGNED', '2026-10-19T03:00:00Z', '2002')
    const rows = await findRecentSigned(testDb, manilaDayStart('2026-10-19'))
    await testDb.check.update({ where: { id: moved.id }, data: { status: 'READY_FOR_RELEASE' } })

    const out = await revertRecentSigned(testDb, rows, { userId: actor.id, reason: 'manual signing', now })
    expect(out.reverted).toEqual(['2001'])
    expect(out.refused.map((r) => r.checkNumber)).toEqual(['2002'])

    const statuses = await testDb.check.findMany({ select: { checkNumber: true, status: true }, orderBy: { checkNumber: 'asc' } })
    expect(statuses).toEqual([
      { checkNumber: '2001', status: 'SIGNATURE_PENDING' },
      { checkNumber: '2002', status: 'READY_FOR_RELEASE' },
    ])
    const audit = await testDb.auditLog.findMany({ where: { action: SIGNATURE_REVERTED_ACTION } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ userId: actor.id, remarks: 'manual signing' })
    expect(await testDb.portalEvent.count()).toBe(0)
  })
})
