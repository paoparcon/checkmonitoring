import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { kickPortalDelivery, afterResponse } from '@/lib/sync/portal-kick'

beforeEach(async () => { await resetDb(); delete process.env.PORTAL_BASE_URL; delete process.env.PORTAL_TOKEN })

describe('kickPortalDelivery', () => {
  it('skips, naming the setting, when the portal is not configured', async () => {
    expect(await kickPortalDelivery(testDb, { budgetMs: 1000 })).toEqual({ skipped: 'PORTAL_BASE_URL is not set' })
  })

  it('delivers with an injected client and never throws', async () => {
    const check = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-1'] })
    // The factory leaves releasedAt null; a RELEASED event with no releasedAt
    // is parked, not delivered (tests/sync/portal-outbox.test.ts:40-45). Set
    // it so this test actually reaches the injected client.
    await testDb.check.update({ where: { id: check.id }, data: { releasedAt: new Date() } })
    await testDb.portalEvent.create({ data: { checkId: check.id, direction: 'OUT', kind: 'RELEASED', status: 'PENDING', idempotencyKey: 'k', payload: {} } })
    const out = await kickPortalDelivery(testDb, {
      budgetMs: 1000,
      client: { deliver: async () => { throw new Error('boom') } },
    })
    expect(out).toMatchObject({ delivered: 1, failed: 1 })
  })
})

// User demand 2026-10-06 ("this should be always the trigger", "make sure it
// will always work"): every delivery first queues RELEASED for any cheque the
// portal was told was available and was released by a path that queued
// nothing (register catch-up, Acumatica reconcile, the older backfills).
describe('kickPortalDelivery: released checks the portal was never told', () => {
  it('queues and delivers RELEASED in the same kick', async () => {
    const check = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-A1034346'], statedReleaseDate: new Date('2026-09-30T00:00:00Z') })
    await testDb.portalEvent.create({ data: { checkId: check.id, direction: 'OUT', kind: 'MARK_AVAILABLE', status: 'SYNCED', idempotencyKey: 'avail', payload: {} } })
    const sent: { kind: string; releaseDate?: string }[] = []
    const out = await kickPortalDelivery(testDb, {
      budgetMs: 5000,
      client: { deliver: async (body: { kind: string; releaseDate?: string }) => { sent.push(body); return { status: 200, body: { eventId: 'e', replay: false, results: [{ ref: 'AP-A1034346', domain: 'local', releaseId: 1, outcome: 'applied' }], unmatched: [] } } } } as never,
    })
    expect(out).toMatchObject({ delivered: 1 })
    expect(sent).toEqual([expect.objectContaining({ kind: 'RELEASED', releaseDate: '2026-09-30' })])
    const ev = await testDb.portalEvent.findFirstOrThrow({ where: { checkId: check.id, kind: 'RELEASED' } })
    expect(ev.status).toBe('SYNCED')
  })

  it('queues even when the portal is not configured, so the next configured run sends it', async () => {
    const check = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-1'], statedReleaseDate: new Date('2026-09-30T00:00:00Z') })
    await testDb.portalEvent.create({ data: { checkId: check.id, direction: 'OUT', kind: 'MARK_AVAILABLE', status: 'SYNCED', idempotencyKey: 'avail', payload: {} } })
    expect(await kickPortalDelivery(testDb, { budgetMs: 1000 })).toEqual({ skipped: 'PORTAL_BASE_URL is not set' })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id, kind: 'RELEASED', status: 'PENDING' } })).toBe(1)
  })
})

// User ruling 2026-11-03: every cheque is mirrored to the portal's check list,
// and the kick that delivers the outbox pushes the changed cheques after it.
describe('kickPortalDelivery: the check list', () => {
  it('pushes the changed cheques after the outbox, with the budget that is left', async () => {
    await makeCheck({ status: 'SIGNED' })
    const pushed: unknown[][] = []
    const out = await kickPortalDelivery(testDb, {
      budgetMs: 5000,
      client: { deliver: async () => { throw new Error('unused') }, pushChecks: async (rows: unknown[]) => { pushed.push(rows); return { status: 200, body: { received: rows.length, upserted: rows.length } } } } as never,
    })
    expect(out).toMatchObject({ delivered: 0, checks: { pushed: 1, errors: 0 } })
    expect(pushed).toHaveLength(1)
  })

  it('a client that implements only deliver skips the list and says so', async () => {
    const out = await kickPortalDelivery(testDb, { budgetMs: 5000, client: { deliver: async () => { throw new Error('unused') } } })
    expect(out).toMatchObject({ checks: { skipped: 'the portal client cannot push the check list' } })
  })
})

describe('afterResponse', () => {
  it('forwards fn to afterImpl - inside a "request" the scheduled fn runs and delivers', async () => {
    let captured: (() => Promise<unknown>) | undefined
    afterResponse(
      () => kickPortalDelivery(testDb, { budgetMs: 1000 }),
      (fn) => { captured = fn },
    )
    expect(captured).toBeInstanceOf(Function)
    // The fake afterImpl only recorded fn - a real `after` would run it once
    // the response is sent. Invoking it here stands in for that and proves
    // kickPortalDelivery actually ran (skip result, since unconfigured).
    await expect(captured!()).resolves.toEqual({ skipped: 'PORTAL_BASE_URL is not set' })
  })

  it('swallows "called outside a request scope" and never invokes fn', () => {
    let called = false
    const fn = async () => { called = true }
    const afterImpl = () => {
      throw new Error('`after` was called outside a request scope. Read more: https://nextjs.org/docs/messages/next-dynamic-api-wrong-context')
    }
    expect(() => afterResponse(fn, afterImpl)).not.toThrow()
    expect(called).toBe(false)
  })

  it('rethrows any other error from afterImpl', () => {
    const afterImpl = () => { throw new Error('boom') }
    expect(() => afterResponse(() => Promise.resolve(), afterImpl)).toThrow('boom')
  })
})
