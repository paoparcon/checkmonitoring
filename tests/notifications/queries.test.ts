import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'
import { countUnread, listNotifications, markRead, markAllRead } from '@/lib/notifications/queries'

const NOW = new Date('2026-10-16T04:00:00Z')

beforeEach(resetDb)

async function seed(userId: string, message: string, createdAt: Date, readAt: Date | null = null) {
  return testDb.notification.create({ data: { userId, kind: 'SYNC_FAILED', message, link: '/admin/sync', createdAt, readAt } })
}

describe('notification queries', () => {
  it('counts and lists only the user\'s own, newest first', async () => {
    const me = await makeUser(); const other = await makeUser()
    await seed(me.id, 'old', new Date('2026-10-15T00:00:00Z'))
    await seed(me.id, 'new', new Date('2026-10-16T00:00:00Z'))
    await seed(me.id, 'read', new Date('2026-10-14T00:00:00Z'), NOW)
    await seed(other.id, 'theirs', NOW)
    expect(await countUnread(testDb, me.id)).toBe(2)
    expect((await listNotifications(testDb, me.id)).map((n) => n.message)).toEqual(['new', 'old', 'read'])
    expect((await listNotifications(testDb, me.id, 1)).map((n) => n.message)).toEqual(['new'])
  })

  it('markRead marks the owner\'s row and returns its link; another user\'s row is refused untouched', async () => {
    const me = await makeUser(); const other = await makeUser()
    const mine = await seed(me.id, 'm', NOW)
    const theirs = await seed(other.id, 't', NOW)
    expect(await markRead(testDb, me.id, mine.id, NOW)).toEqual({ link: '/admin/sync' })
    expect((await testDb.notification.findUniqueOrThrow({ where: { id: mine.id } })).readAt).toEqual(NOW)
    expect(await markRead(testDb, me.id, theirs.id, NOW)).toBeNull()
    expect((await testDb.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt).toBeNull()
  })

  it('markAllRead marks only the user\'s unread rows', async () => {
    const me = await makeUser(); const other = await makeUser()
    await seed(me.id, 'a', NOW); await seed(me.id, 'b', NOW)
    await seed(other.id, 'c', NOW)
    expect(await markAllRead(testDb, me.id, NOW)).toBe(2)
    expect(await countUnread(testDb, me.id)).toBe(0)
    expect(await countUnread(testDb, other.id)).toBe(1)
  })
})
