import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import { runAutoSign, listAutoSignCandidates, getLastAutoSign } from '@/lib/sync/auto-sign'
import { AUTO_SIGN_RUN_ACTION } from '@/lib/domain/auto-sign'
import { markSigned, revertSignature } from '@/lib/domain/actions'

// Monday 12 Oct 2026 and Tuesday 13 Oct 2026, Manila (UTC+8).
const mondayNoon = new Date('2026-10-12T04:00:00Z')
const mondayEvening = new Date('2026-10-12T10:00:00Z')   // 18:00 Manila, the day's last run
const tuesdayNoon = new Date('2026-10-13T04:00:00Z')
const tuesdayEvening = new Date('2026-10-13T10:00:00Z')
const wednesdayNoon = new Date('2026-10-14T04:00:00Z')

const backlog = new Date('2026-09-29T02:00:00Z')         // Tue 29 Sep, the old backlog
const lastThursday = new Date('2026-10-08T02:00:00Z')    // Thu 8 Oct
const sundayLast = new Date('2026-10-11T15:59:59Z')      // Sun 23:59:59 Manila
const mondayFirst = new Date('2026-10-11T16:00:00Z')     // Mon 00:00 Manila
const mondayLate = new Date('2026-10-12T15:59:59Z')      // Mon 23:59:59 Manila
const tuesdayFirst = new Date('2026-10-12T16:00:00Z')    // Tue 00:00 Manila

async function pendingAt(createdAt: Date, o: { acumatica?: boolean; acumaticaStatus?: string | null } = {}) {
  const c = await makeCheck({ status: 'SIGNATURE_PENDING' })
  return testDb.check.update({
    where: { id: c.id },
    data: {
      acumaticaPaymentId: o.acumatica === false ? null : `PAY-${c.id}`,
      acumaticaStatus: o.acumaticaStatus === undefined ? 'Balanced' : o.acumaticaStatus,
      createdAt,
    },
  })
}

beforeEach(resetDb)

describe('listAutoSignCandidates', () => {
  it('on a Monday lists every Acumatica check first read before that Monday, oldest first', async () => {
    const old = await pendingAt(backlog)
    const thu = await pendingAt(lastThursday)
    const sun = await pendingAt(sundayLast, { acumaticaStatus: null })
    await pendingAt(mondayFirst)                                   // Monday's own: waits for Tuesday
    await pendingAt(lastThursday, { acumaticaStatus: 'Voided' })
    await pendingAt(lastThursday, { acumatica: false })
    const ids = (await listAutoSignCandidates(testDb, mondayNoon)).map((c) => c.id)
    expect(ids).toEqual([old.id, thu.id, sun.id])
  })

  it('on a Tuesday lists Monday’s checks and any leftover, not Tuesday’s', async () => {
    const leftover = await pendingAt(lastThursday)
    const mon = await pendingAt(mondayFirst)
    const monLate = await pendingAt(mondayLate)
    await pendingAt(tuesdayFirst)
    const ids = (await listAutoSignCandidates(testDb, tuesdayNoon)).map((c) => c.id)
    expect(ids).toEqual([leftover.id, mon.id, monLate.id])
  })

  it('leaves out a reverted check', async () => {
    const u = await makeUser()
    const c = await pendingAt(lastThursday)
    await markSigned(testDb, { checkId: c.id, userId: u.id, now: new Date('2026-10-08T03:00:00Z') })
    await revertSignature(testDb, { checkId: c.id, userId: u.id, now: new Date('2026-10-08T04:00:00Z') })
    expect(await listAutoSignCandidates(testDb, mondayNoon)).toEqual([])
  })

  it('lists nothing Wednesday to Sunday', async () => {
    await pendingAt(lastThursday)
    expect(await listAutoSignCandidates(testDb, wednesdayNoon)).toEqual([])
  })
})

describe('runAutoSign — retired (user ruling 2026-10-27)', () => {
  it('records DISABLED and signs nothing on a Tuesday with Monday’s checks due', async () => {
    const mon = await pendingAt(mondayFirst)
    const old = await pendingAt(lastThursday)
    const run = await runAutoSign(testDb, { now: tuesdayNoon })
    expect(run).toEqual({ outcome: 'DISABLED', signed: 0, skipped: 0, enabled: false })
    const after = await testDb.check.findMany({ where: { id: { in: [mon.id, old.id] } }, select: { status: true } })
    expect(after.map((r) => r.status)).toEqual(['SIGNATURE_PENDING', 'SIGNATURE_PENDING'])
    const rows = await testDb.auditLog.findMany({ where: { action: AUTO_SIGN_RUN_ACTION } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ checkId: null, actorType: 'SYSTEM' })
    expect(rows[0].details).toMatchObject({ outcome: 'DISABLED', signed: 0, enabled: false })
  })

  it('ignores a stored autoSign.mondayEnabled = 1 row: no setting brings the rule back', async () => {
    await testDb.setting.create({ data: { key: 'autoSign.mondayEnabled', value: '1' } })
    const c = await pendingAt(lastThursday)
    expect(await runAutoSign(testDb, { now: mondayNoon })).toEqual({ outcome: 'DISABLED', signed: 0, skipped: 0, enabled: false })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
    expect((await getLastAutoSign(testDb))?.outcome).toBe('DISABLED')
  })

  it('getLastAutoSign is null before any run', async () => {
    expect(await getLastAutoSign(testDb)).toBeNull()
  })
})

describe('getLastAutoSign', () => {
  it('reads back the newest run, with enabled', async () => {
    await runAutoSign(testDb, { now: wednesdayNoon })
    expect(await getLastAutoSign(testDb)).toMatchObject({ outcome: 'DISABLED', enabled: false, legacyDays: null })
  })

  it('reads a run recorded under the old days rule as legacy', async () => {
    await testDb.auditLog.create({
      data: { actorType: 'SYSTEM', action: AUTO_SIGN_RUN_ACTION, details: { outcome: 'OK', signed: 2, skipped: 0, days: 3 } },
    })
    expect(await getLastAutoSign(testDb)).toMatchObject({ outcome: 'OK', signed: 2, enabled: null, legacyDays: 3 })
  })
})
