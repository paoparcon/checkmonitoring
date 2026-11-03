import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'
import { notify, safeNotify } from '@/lib/notifications/notify'
import type { Notice } from '@/lib/notifications/messages'

const adminNotice: Notice = { kind: 'SYNC_FAILED', audience: 'ADMINS', message: 'm', link: '/admin/sync' }
const everyone: Notice = { kind: 'READY_FOR_RELEASE', audience: 'FINANCE', message: 'r', link: '/?status=READY_FOR_RELEASE' }

beforeEach(resetDb)

describe('notify', () => {
  it('ADMINS reaches active admins only; FINANCE reaches every active user', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    const user = await makeUser('FINANCE_USER')
    const gone = await makeUser('FINANCE_ADMIN')
    await testDb.user.update({ where: { id: gone.id }, data: { active: false } })
    const pending = await makeUser('FINANCE_USER')
    await testDb.user.update({ where: { id: pending.id }, data: { active: false, pendingSince: new Date() } })

    expect(await notify(testDb, adminNotice)).toBe(1)
    expect(await notify(testDb, everyone)).toBe(2)

    const rows = await testDb.notification.findMany({ orderBy: { kind: 'asc' } })
    expect(rows.filter((r) => r.kind === 'SYNC_FAILED').map((r) => r.userId)).toEqual([admin.id])
    expect(rows.filter((r) => r.kind === 'READY_FOR_RELEASE').map((r) => r.userId).sort()).toEqual([admin.id, user.id].sort())
    expect(rows.every((r) => r.readAt === null && r.link !== null)).toBe(true)
  })

  it('leaves out the actor', async () => {
    const actor = await makeUser('FINANCE_USER')
    const other = await makeUser('FINANCE_USER')
    expect(await notify(testDb, everyone, { excludeUserId: actor.id })).toBe(1)
    expect((await testDb.notification.findMany()).map((r) => r.userId)).toEqual([other.id])
  })

  it('a repeated dedupeKey writes nothing more; no key never dedupes', async () => {
    await makeUser('FINANCE_ADMIN')
    expect(await notify(testDb, { ...adminNotice, dedupeKey: 'k' })).toBe(1)
    expect(await notify(testDb, { ...adminNotice, dedupeKey: 'k' })).toBe(0)
    expect(await notify(testDb, adminNotice)).toBe(1)
    expect(await notify(testDb, adminNotice)).toBe(1)
    expect(await testDb.notification.count()).toBe(3)
  })
})

describe('safeNotify', () => {
  it('never throws, and writes each notice it can', async () => {
    await makeUser('FINANCE_ADMIN')
    const broken = { ...adminNotice, checkId: 'no-such-check' } // FK violation
    await expect(safeNotify(testDb, [broken, adminNotice])).resolves.toBeUndefined()
    expect(await testDb.notification.count()).toBe(1)
    await expect(safeNotify(testDb, null)).resolves.toBeUndefined()
  })
})
