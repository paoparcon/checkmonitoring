import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import { autoSign, revertSignature, markSigned } from '@/lib/domain/actions'
import { AUTO_SIGNED_ACTION } from '@/lib/domain/auto-sign'

const tuesdayNoon = new Date('2026-09-29T04:00:00Z')
const mondayMorning = new Date('2026-09-28T01:00:00Z') // 09:00 Manila Monday

async function acumaticaPending(createdAt: Date, o: { isCheque?: boolean; acumaticaStatus?: string | null } = {}) {
  const c = await makeCheck({ status: 'SIGNATURE_PENDING', isCheque: o.isCheque ?? true })
  return testDb.check.update({
    where: { id: c.id },
    data: {
      acumaticaPaymentId: `PAY-${c.id}`,
      acumaticaStatus: o.acumaticaStatus === undefined ? 'Balanced' : o.acumaticaStatus,
      createdAt,
    },
  })
}

beforeEach(resetDb)

describe('autoSign', () => {
  it('signs a Monday check at Tuesday’s run, no signing user, one SYSTEM row', async () => {
    const c = await acumaticaPending(mondayMorning)
    const signed = await autoSign(testDb, { checkId: c.id, now: tuesdayNoon })
    expect(signed).toMatchObject({ status: 'SIGNED', signedById: null })
    expect(signed!.signedAt!.toISOString()).toBe(tuesdayNoon.toISOString())
    const audit = await testDb.auditLog.findMany({ where: { checkId: c.id, action: AUTO_SIGNED_ACTION } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actorType: 'SYSTEM', userId: null })
    expect(audit[0].details).toMatchObject({
      from: 'SIGNATURE_PENDING', to: 'SIGNED', rule: 'WEEKLY', runDay: 'TUESDAY', inAppSince: c.createdAt.toISOString(),
    })
    expect(audit[0].remarks).toBe(
      `Signed automatically at Tuesday's run: this Acumatica check first reached the app on ` +
      `${c.createdAt.toISOString()}, before that Tuesday. No one signed it here, so no signing user is recorded.`,
    )
  })

  it('signs last Thursday’s check at the next Monday’s run', async () => {
    const c = await acumaticaPending(new Date('2026-09-24T02:00:00Z'))   // Thu 24 Sep
    const mondayNoon = new Date('2026-09-28T04:00:00Z')                 // Mon 28 Sep 12:00 Manila
    expect(await autoSign(testDb, { checkId: c.id, now: mondayNoon })).toMatchObject({ status: 'SIGNED' })
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: c.id, action: AUTO_SIGNED_ACTION } })
    expect(audit.details).toMatchObject({ rule: 'WEEKLY', runDay: 'MONDAY' })
    expect(audit.remarks).toContain("Signed automatically at Monday's run")
    expect(audit.remarks).toContain('before that Monday.')
  })

  it('queues no portal event', async () => {
    const c = await acumaticaPending(mondayMorning)
    await autoSign(testDb, { checkId: c.id, now: tuesdayNoon })
    expect(await testDb.portalEvent.count({ where: { checkId: c.id } })).toBe(0)
  })

  it('skips (null) a check someone reverted', async () => {
    const u = await makeUser()
    const c = await acumaticaPending(mondayMorning)
    await markSigned(testDb, { checkId: c.id, userId: u.id, now: mondayMorning })
    await revertSignature(testDb, { checkId: c.id, userId: u.id, now: mondayMorning })
    expect(await autoSign(testDb, { checkId: c.id, now: tuesdayNoon })).toBeNull()
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
  })

  it('skips (null) a Tuesday check and any run on another day', async () => {
    const tue = await acumaticaPending(new Date('2026-09-29T01:00:00Z'))
    expect(await autoSign(testDb, { checkId: tue.id, now: tuesdayNoon })).toBeNull()
    const mon = await acumaticaPending(mondayMorning)
    expect(await autoSign(testDb, { checkId: mon.id, now: new Date('2026-09-30T04:00:00Z') })).toBeNull()
  })
})
