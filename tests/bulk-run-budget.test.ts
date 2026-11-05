import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/sync/portal-kick', () => ({ afterResponse: vi.fn(), kickPortalDelivery: vi.fn() }))

/**
 * `runEach`'s time budget (2026-11-05). With no selection cap a select-all can
 * be hundreds of checks; a run that would outlive the request stops and names
 * the checks it did not reach instead of being killed half way through.
 */
const fakeDb = {
  check: { findMany: async () => [{ id: 'a', checkNumber: '1001' }, { id: 'b', checkNumber: '1002' }, { id: 'c', checkNumber: '1003' }] },
} as unknown as PrismaClient

describe('runEach time budget', () => {
  it('acts on every check while the budget lasts', async () => {
    const { runEach } = await import('@/lib/bulk-run')
    const fn = vi.fn(async () => ({}))
    const r = await runEach(fakeDb, ['a', 'b', 'c'], fn)
    expect(fn).toHaveBeenCalledTimes(3)
    expect(r).toMatchObject({ ok: true, succeeded: 3, failed: 0 })
    expect(r.ok && r.notReached).toBeFalsy()
  })

  it('stops at the deadline and reports the rest as not reached, writing nothing for them', async () => {
    const { runEach, NOT_REACHED_MESSAGE } = await import('@/lib/bulk-run')
    let t = 0
    const fn = vi.fn(async () => { t += 10; return {} })
    const r = await runEach(fakeDb, ['a', 'b', 'c'], fn, { clock: () => t, deadline: 15 })
    expect(fn).toHaveBeenCalledTimes(2)
    expect(r).toMatchObject({ ok: true, succeeded: 2, failed: 1, notReached: 1 })
    if (!r.ok) return
    expect(r.outcomes[2]).toEqual({ ok: false, checkId: 'c', checkNumber: '1003', message: NOT_REACHED_MESSAGE, notReached: true })
  })

  it('defaults to a 45 s budget', async () => {
    const { BULK_TIME_BUDGET_MS } = await import('@/lib/bulk-run')
    expect(BULK_TIME_BUDGET_MS).toBe(45_000)
  })
})
