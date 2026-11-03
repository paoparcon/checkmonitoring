import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'

const currentUser = { id: '', email: 'f@rcl.test', name: 'Finance User', role: 'FINANCE_USER' as const }

vi.mock('@/lib/auth', () => ({ requireUser: async () => currentUser }))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`) },
}))

beforeEach(async () => {
  await resetDb()
  currentUser.id = (await makeUser()).id
})

const form = (id: string) => { const f = new FormData(); f.append('id', id); return f }

describe('openNotificationAction', () => {
  it('marks the row read and goes to its link', async () => {
    const { openNotificationAction } = await import('@/app/notifications/actions')
    const n = await testDb.notification.create({ data: { userId: currentUser.id, kind: 'SYNC_FAILED', message: 'm', link: '/admin/sync' } })
    await expect(openNotificationAction(form(n.id))).rejects.toThrow('REDIRECT:/admin/sync')
    expect((await testDb.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt).not.toBeNull()
  })

  it('refuses another user\'s row: untouched, back to the list', async () => {
    const { openNotificationAction } = await import('@/app/notifications/actions')
    const other = await makeUser()
    const n = await testDb.notification.create({ data: { userId: other.id, kind: 'SYNC_FAILED', message: 'm', link: '/admin/sync' } })
    await expect(openNotificationAction(form(n.id))).rejects.toThrow('REDIRECT:/notifications')
    expect((await testDb.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt).toBeNull()
  })

  it('never follows a stored off-site link', async () => {
    const { openNotificationAction } = await import('@/app/notifications/actions')
    const n = await testDb.notification.create({ data: { userId: currentUser.id, kind: 'SYNC_FAILED', message: 'm', link: '//evil.test' } })
    await expect(openNotificationAction(form(n.id))).rejects.toThrow('REDIRECT:/notifications')
  })
})

describe('markAllReadAction', () => {
  it('marks every unread row of the user read', async () => {
    const { markAllReadAction } = await import('@/app/notifications/actions')
    await testDb.notification.create({ data: { userId: currentUser.id, kind: 'SYNC_FAILED', message: 'a' } })
    await testDb.notification.create({ data: { userId: currentUser.id, kind: 'SYNC_FAILED', message: 'b' } })
    await expect(markAllReadAction()).rejects.toThrow('REDIRECT:/notifications')
    expect(await testDb.notification.count({ where: { readAt: null } })).toBe(0)
  })
})
