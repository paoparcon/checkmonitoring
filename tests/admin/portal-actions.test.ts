import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'

// `userId` starts as a placeholder and is set to a real, created User's id in
// the first test below - AuditLog.userId is a genuine FK (SetNull on delete,
// not unenforced), so a hardcoded id with no backing row would fail every
// write with a foreign-key violation. Same mutable-id pattern as
// tests/admin/actions.test.ts's `currentUser`.
const state = vi.hoisted(() => ({ role: 'FINANCE_ADMIN' as 'FINANCE_ADMIN' | 'FINANCE_USER', kicked: 0, userId: 'u1' }))
vi.mock('@/lib/db', async () => ({ prisma: (await import('../helpers/db')).testDb }))
vi.mock('@/lib/auth', () => ({ requireUser: async () => ({ id: state.userId, email: 'a@b', name: 'A', role: state.role }) }))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('@/lib/sync/portal-kick', () => ({ kickPortalDelivery: async () => { state.kicked += 1; return { skipped: 'PORTAL_BASE_URL is not set' } } }))

beforeEach(async () => { await resetDb(); state.role = 'FINANCE_ADMIN'; state.kicked = 0; state.userId = 'u1' })

describe('portal admin actions', () => {
  it('retry puts a PARKED event back to PENDING, due now, and audits it', async () => {
    const { retryPortalEventAction } = await import('@/app/admin/portal/actions')
    const user = await makeUser('FINANCE_ADMIN')
    state.userId = user.id
    const check = await makeCheck({ status: 'RELEASED' })
    const ev = await testDb.portalEvent.create({ data: { checkId: check.id, direction: 'OUT', kind: 'RELEASED', status: 'PARKED', idempotencyKey: 'k', payload: {}, attempts: 12, nextAttemptAt: new Date('2099-01-01') } })
    const f = new FormData(); f.set('eventId', ev.id)
    expect(await retryPortalEventAction(f)).toEqual({ ok: true })
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('PENDING'); expect(after.attempts).toBe(0); expect(after.nextAttemptAt.getTime()).toBeLessThan(Date.now() + 1000)
    expect(await testDb.auditLog.count({ where: { checkId: check.id, action: 'portal_event_retried' } })).toBe(1)
    expect(state.kicked).toBe(1)
  })

  it('a FINANCE_USER is refused RETRY by a returned result', async () => {
    const { retryPortalEventAction } = await import('@/app/admin/portal/actions')
    state.role = 'FINANCE_USER'
    const f = new FormData(); f.set('eventId', 'x')
    expect(await retryPortalEventAction(f)).toMatchObject({ ok: false, message: expect.stringContaining('Finance Admin') })
    expect(state.kicked).toBe(0)
  })

  it('a FINANCE_USER may DELIVER NOW (2026-10-15)', async () => {
    const { deliverPortalNowAction } = await import('@/app/admin/portal/actions')
    state.role = 'FINANCE_USER'
    expect(await deliverPortalNowAction()).toMatchObject({ ok: false, message: expect.stringContaining('PORTAL_BASE_URL') })
    expect(state.kicked).toBe(1)
  })

  it('deliver now kicks the worker', async () => {
    const { deliverPortalNowAction } = await import('@/app/admin/portal/actions')
    expect(await deliverPortalNowAction()).toMatchObject({ ok: false, message: expect.stringContaining('PORTAL_BASE_URL') })
    expect(state.kicked).toBe(1)
  })
})
