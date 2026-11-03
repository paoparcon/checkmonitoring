import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import { deliverPortalEvents, kindMatchesStatus, RETRY_DELAYS_MS, MAX_ATTEMPTS, UNMATCHED_MAX_ATTEMPTS } from '@/lib/sync/portal-outbox'
import type { PortalClient, PortalDeliveryResult, PortalEventBody } from '@/lib/integrations/portal/client'

const NOW = new Date('2026-09-26T10:00:00+08:00')
const LATER = new Date(NOW.getTime() + 60_000)

function fakeClient(reply: (body: PortalEventBody) => PortalDeliveryResult | Error): PortalClient & { sent: PortalEventBody[] } {
  const sent: PortalEventBody[] = []
  return {
    sent,
    async deliver(body) {
      sent.push(body)
      const r = reply(body)
      if (r instanceof Error) throw r
      return r
    },
  }
}

const ok = (over: Partial<NonNullable<PortalDeliveryResult['body']>> = {}): PortalDeliveryResult => ({
  status: 200,
  body: { eventId: 'x', replay: false, results: [{ ref: 'AP-1', domain: 'local', releaseId: 41, outcome: 'applied' }], unmatched: [], ...over },
})

async function queue(checkId: string, kind: 'MARK_AVAILABLE' | 'RELEASED' | 'REVERT' | 'RELEASE_REVERSED' | 'CANCELLED' | 'RECEIPT', createdAt: Date, extra: Record<string, unknown> = {}) {
  return testDb.portalEvent.create({
    data: {
      checkId, direction: 'OUT', kind, status: 'PENDING', createdAt, nextAttemptAt: createdAt,
      idempotencyKey: `${checkId}:${kind}:${createdAt.toISOString()}`, payload: { action: kind },
      ...extra,
    },
  })
}

/**
 * A released cheque as the portal payload needs it: RELEASED requires a
 * releaseDate, and the factory leaves `releasedAt` null (a RELEASED event for
 * such a cheque parks as a payload defect - see the MISSING_DATE test).
 */
async function releasedCheck(apv: string) {
  const check = await makeCheck({ status: 'RELEASED', apvNumbers: [apv] })
  return testDb.check.update({ where: { id: check.id }, data: { releasedAt: NOW } })
}

beforeEach(resetDb)

describe('deliverPortalEvents', () => {
  it('delivers a pending event and marks it SYNCED, learning the portal id', async () => {
    const check = await makeCheck({ status: 'READY_FOR_RELEASE', apvNumbers: ['AP-1'], availablePickupDate: new Date('2026-09-30') })
    const ev = await queue(check.id, 'MARK_AVAILABLE', NOW)
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(out).toMatchObject({ delivered: 1, synced: 1, failed: 0, parked: 0, superseded: 0, stoppedAtDeadline: false })
    expect(client.sent[0]).toMatchObject({ eventId: ev.id, kind: 'MARK_AVAILABLE', apvs: ['AP-1'], availablePickupDate: '2026-09-30' })
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('SYNCED'); expect(after.attempts).toBe(1); expect(after.claimedBy).toBeTruthy()
    const chk = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(chk.portalSyncStatus).toBe('SYNCED'); expect(chk.portalTradeId).toBe(41)
    expect(await testDb.auditLog.count({ where: { checkId: check.id, action: 'portal_event_synced' } })).toBe(1)
  })

  it('latest wins per check: older non-terminal events are superseded, not sent', async () => {
    const check = await releasedCheck('AP-1')
    const old = await queue(check.id, 'MARK_AVAILABLE', new Date('2026-08-01T00:00:00Z'))
    const mid = await queue(check.id, 'REVERT', new Date('2026-08-02T00:00:00Z'), { status: 'FAILED', nextAttemptAt: new Date('2099-01-01') })
    const newest = await queue(check.id, 'RELEASED', new Date('2026-08-03T00:00:00Z'))
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(out).toMatchObject({ delivered: 1, superseded: 2 })
    expect(client.sent.map((b) => b.eventId)).toEqual([newest.id])
    for (const id of [old.id, mid.id]) {
      const e = await testDb.portalEvent.findUniqueOrThrow({ where: { id } })
      expect(e.status).toBe('SYNCED'); expect(e.lastError).toBe(`superseded by ${newest.id}`)
    }
  })

  it('a newest event not yet due is neither sent nor superseded; the check waits', async () => {
    const check = await releasedCheck('AP-1')
    await queue(check.id, 'RELEASED', new Date('2026-08-03T00:00:00Z'), { status: 'FAILED', nextAttemptAt: new Date('2099-01-01') })
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(out).toMatchObject({ delivered: 0, superseded: 0 })
    expect(client.sent).toHaveLength(0)
  })

  it('a refused result parks the event and flags the check', async () => {
    const check = await releasedCheck('AP-1')
    const ev = await queue(check.id, 'RELEASED', NOW)
    const client = fakeClient(() => ok({ results: [{ ref: 'AP-1', domain: 'local', releaseId: 41, outcome: 'refused', reason: 'cancelled in the portal' }] }))
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(out).toMatchObject({ parked: 1 })
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('PARKED'); expect(after.lastError).toMatch(/cancelled in the portal/)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).portalSyncStatus).toBe('FAILED')
  })

  it('nothing matched retries daily and parks after UNMATCHED_MAX_ATTEMPTS', async () => {
    const check = await makeCheck({ status: 'READY_FOR_RELEASE', apvNumbers: ['AP-9'], availablePickupDate: new Date('2026-09-30') })
    const ev = await queue(check.id, 'MARK_AVAILABLE', NOW, { attempts: UNMATCHED_MAX_ATTEMPTS - 2 })
    const client = fakeClient(() => ok({ results: [], unmatched: ['AP-9'] }))
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    let after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('FAILED'); expect(after.lastError).toMatch(/unmatched: AP-9/)
    expect(after.nextAttemptAt.getTime()).toBe(LATER.getTime() + 24 * 3_600_000)

    await testDb.portalEvent.update({ where: { id: ev.id }, data: { nextAttemptAt: LATER } })
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('PARKED'); expect(after.attempts).toBe(UNMATCHED_MAX_ATTEMPTS)
  })

  it('a network error backs off along RETRY_DELAYS_MS and parks at MAX_ATTEMPTS', async () => {
    const check = await releasedCheck('AP-1')
    const ev = await queue(check.id, 'RELEASED', NOW)
    const client = fakeClient(() => new Error('ECONNRESET'))
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    let after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('FAILED'); expect(after.attempts).toBe(1); expect(after.lastError).toMatch(/ECONNRESET/)
    expect(after.nextAttemptAt.getTime()).toBe(LATER.getTime() + RETRY_DELAYS_MS[0])

    await testDb.portalEvent.update({ where: { id: ev.id }, data: { attempts: MAX_ATTEMPTS - 1, nextAttemptAt: LATER } })
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('PARKED')
  })

  it('401 and 400 park immediately; 503 retries', async () => {
    for (const [status, expected] of [[401, 'PARKED'], [400, 'PARKED'], [503, 'FAILED']] as const) {
      await resetDb()
      const check = await releasedCheck('AP-1')
      const ev = await queue(check.id, 'RELEASED', NOW)
      const client = fakeClient(() => ({ status, body: null }))
      await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
      expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe(expected)
    }
  })

  it('sends an INTERNAL RELEASED flagged internal and leaves the check with no portal state (spec 2026-10-19)', async () => {
    const check = await makeCheck({ status: 'RELEASED', eligibility: 'INTERNAL', apvNumbers: ['AP-1'], releasedAt: NOW })
    const ev = await queue(check.id, 'RELEASED', NOW)
    const client = fakeClient(() => ok())
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(client.sent).toHaveLength(1)
    expect(client.sent[0]).toMatchObject({ kind: 'RELEASED', internal: true })
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('SYNCED')
    // check_internal_never_routes_to_portal: delivery state lives on the event only.
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.portalSyncStatus).toBe('NOT_APPLICABLE'); expect(after.portalDomain).toBeNull()
  })

  it('still parks an INTERNAL MARK_AVAILABLE without a request', async () => {
    const check = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'INTERNAL', apvNumbers: ['AP-1'], availablePickupDate: NOW })
    const ev = await queue(check.id, 'MARK_AVAILABLE', NOW)
    const client = fakeClient(() => ok())
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(client.sent).toHaveLength(0)
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('PARKED')
  })

  it('a payload missing its required date parks without a request (never retried)', async () => {
    // The factory leaves releasedAt null: the portal requires releaseDate on RELEASED.
    const check = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-1'] })
    const ev = await queue(check.id, 'RELEASED', NOW)
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(client.sent).toHaveLength(0)
    expect(out).toMatchObject({ delivered: 0, parked: 1, failed: 0 })
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('PARKED'); expect(after.lastError).toMatch(/releasedAt/)
  })

  it('stops at the deadline and leaves the rest PENDING', async () => {
    const a = await releasedCheck('AP-1')
    const b = await releasedCheck('AP-2')
    await queue(a.id, 'RELEASED', NOW); await queue(b.id, 'RELEASED', NOW)
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() - 1), client })
    expect(out.stoppedAtDeadline).toBe(true); expect(out.delivered).toBe(0)
    expect(await testDb.portalEvent.count({ where: { status: 'PENDING' } })).toBe(2)
  })

  it('a stale IN_FLIGHT claim is retried, a fresh one is left alone', async () => {
    const check = await releasedCheck('AP-1')
    const stale = await queue(check.id, 'RELEASED', NOW, { status: 'IN_FLIGHT', claimedAt: new Date(LATER.getTime() - 3_600_000), claimedBy: 'dead-run' })
    const client = fakeClient(() => ok())
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('SYNCED')

    const other = await releasedCheck('AP-2')
    const fresh = await queue(other.id, 'RELEASED', NOW, { status: 'IN_FLIGHT', claimedAt: LATER, claimedBy: 'live-run' })
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('IN_FLIGHT')
  })

  // Review fixes 2026-09-26.

  it('a live claim freezes its check: a newer PENDING event is neither sent nor supersedes it', async () => {
    const check = await releasedCheck('AP-1')
    const older = await queue(check.id, 'MARK_AVAILABLE', new Date('2026-08-01T00:00:00Z'), { status: 'IN_FLIGHT', claimedAt: LATER, claimedBy: 'live-run' })
    const newer = await queue(check.id, 'RELEASED', new Date('2026-08-02T00:00:00Z'))
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(client.sent).toHaveLength(0)
    expect(out.superseded).toBe(0)
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: newer.id } })).status).toBe('PENDING')
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: older.id } })).status).toBe('IN_FLIGHT')
  })

  it('settle is conditional on still holding the claim: a row settled by another run is left alone', async () => {
    const check = await releasedCheck('AP-1')
    const ev = await queue(check.id, 'RELEASED', NOW)
    const client = fakeClient(() => ok())
    const stealing: PortalClient = {
      async deliver(body) {
        // Another run reclaimed the row as stale and settled it while this
        // run's request was in flight.
        await testDb.portalEvent.update({ where: { id: body.eventId }, data: { status: 'SYNCED', claimedBy: 'other-run' } })
        return client.deliver(body)
      },
    }
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client: stealing })
    expect(out).toMatchObject({ delivered: 1, synced: 0, failed: 0, parked: 0 })
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('SYNCED'); expect(after.claimedBy).toBe('other-run'); expect(after.attempts).toBe(0)
    expect(await testDb.auditLog.count({ where: { checkId: check.id, action: 'portal_event_synced' } })).toBe(0)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).portalTradeId).toBeNull()
  })

  it('a deliver that throws synchronously is a normal FAILED, and the run carries on', async () => {
    const a = await releasedCheck('AP-1')
    const b = await releasedCheck('AP-2')
    const evA = await queue(a.id, 'RELEASED', NOW)
    const evB = await queue(b.id, 'RELEASED', new Date(NOW.getTime() + 1))
    let calls = 0
    const client: PortalClient = {
      // Not async: the throw escapes synchronously from the call itself.
      deliver() {
        calls += 1
        if (calls === 1) throw new Error('socket exploded')
        return Promise.resolve(ok())
      },
    }
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(out.error).toBeUndefined()
    expect(out).toMatchObject({ delivered: 2, synced: 1, failed: 1 })
    const afterA = await testDb.portalEvent.findUniqueOrThrow({ where: { id: evA.id } })
    expect(afterA.status).toBe('FAILED'); expect(afterA.nextAttemptAt.getTime()).toBe(LATER.getTime() + RETRY_DELAYS_MS[0])
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: evB.id } })).status).toBe('SYNCED')
  })

  it('an unexpected DB error on one row is recorded and the run carries on', async () => {
    const a = await releasedCheck('AP-1')
    const b = await releasedCheck('AP-2')
    const evA = await queue(a.id, 'RELEASED', NOW)
    const evB = await queue(b.id, 'RELEASED', new Date(NOW.getTime() + 1))
    // testDb with check.findUnique failing for cheque A only.
    const bind = (t: object, p: string | symbol) => {
      const v: unknown = Reflect.get(t, p)
      return typeof v === 'function' ? v.bind(t) : v
    }
    const checkDelegate = new Proxy(testDb.check, {
      get(t, p) {
        if (p === 'findUnique') {
          return (q: { where: { id: string } }) => {
            if (q.where.id === a.id) return Promise.reject(new Error('connection reset by Neon'))
            return (t.findUnique as (x: unknown) => unknown)(q)
          }
        }
        return bind(t, p)
      },
    })
    const db = new Proxy(testDb, { get: (t, p) => (p === 'check' ? checkDelegate : bind(t, p)) }) as typeof testDb
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const client = fakeClient(() => ok())
      const out = await deliverPortalEvents(db, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
      expect(out.error).toMatch(/connection reset by Neon/)
      expect(out).toMatchObject({ synced: 1 })
      expect(errors).toHaveBeenCalled()
      expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: evA.id } })).status).toBe('IN_FLIGHT')
      expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: evB.id } })).status).toBe('SYNCED')
    } finally {
      errors.mockRestore()
    }
  })

  it('a not-due newest event still supersedes its older due sibling; nothing is sent', async () => {
    const check = await releasedCheck('AP-1')
    const older = await queue(check.id, 'MARK_AVAILABLE', new Date('2026-08-01T00:00:00Z'))
    const newest = await queue(check.id, 'RELEASED', new Date('2026-08-02T00:00:00Z'), { status: 'FAILED', nextAttemptAt: new Date('2099-01-01') })
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(client.sent).toHaveLength(0)
    expect(out).toMatchObject({ delivered: 0, superseded: 1 })
    const o = await testDb.portalEvent.findUniqueOrThrow({ where: { id: older.id } })
    expect(o.status).toBe('SYNCED'); expect(o.lastError).toBe(`superseded by ${newest.id}`)
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: newest.id } })).status).toBe('FAILED')
  })

  it('each superseded row carries exactly one synced audit marked superseded; the delivered one is not marked', async () => {
    const check = await releasedCheck('AP-1')
    const old = await queue(check.id, 'MARK_AVAILABLE', new Date('2026-08-01T00:00:00Z'))
    const mid = await queue(check.id, 'REVERT', new Date('2026-08-02T00:00:00Z'))
    const newest = await queue(check.id, 'RELEASED', new Date('2026-08-03T00:00:00Z'))
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client: fakeClient(() => ok()) })
    const rows = await testDb.auditLog.findMany({ where: { checkId: check.id, action: 'portal_event_synced' } })
    const forEvent = (id: string) => rows.filter((r) => (r.details as { eventId?: string } | null)?.eventId === id)
    for (const id of [old.id, mid.id]) {
      const mine = forEvent(id)
      expect(mine).toHaveLength(1)
      expect((mine[0].details as { superseded?: boolean }).superseded).toBe(true)
    }
    const delivered = forEvent(newest.id)
    expect(delivered).toHaveLength(1)
    expect((delivered[0].details as { superseded?: boolean }).superseded).toBeUndefined()
  })

  it('once RETRY_DELAYS_MS is exhausted (attempt 5) the backoff is daily', async () => {
    const check = await releasedCheck('AP-1')
    const ev = await queue(check.id, 'RELEASED', NOW, { attempts: RETRY_DELAYS_MS.length })
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client: fakeClient(() => ({ status: 503, body: null })) })
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('FAILED'); expect(after.attempts).toBe(RETRY_DELAYS_MS.length + 1)
    expect(after.nextAttemptAt.getTime()).toBe(LATER.getTime() + 24 * 3_600_000)
  })

  it('the deadline is honoured inside the supersede pass too', async () => {
    const check = await releasedCheck('AP-1')
    await queue(check.id, 'MARK_AVAILABLE', new Date('2026-08-01T00:00:00Z'))
    await queue(check.id, 'RELEASED', new Date('2026-08-02T00:00:00Z'))
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() - 1), client })
    expect(out).toMatchObject({ stoppedAtDeadline: true, superseded: 0, delivered: 0 })
    expect(await testDb.portalEvent.count({ where: { status: 'PENDING' } })).toBe(2)
  })

  it('RELEASED then RECEIPT for one check: both delivered, status first, neither superseded', async () => {
    const check = await releasedCheck('AP-1')
    await testDb.check.update({ where: { id: check.id }, data: { orNumber: 'OR-1', receiptType: 'OR' } })
    await queue(check.id, 'RELEASED', NOW)
    await queue(check.id, 'RECEIPT', new Date(NOW.getTime() + 1))
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 60_000), client })
    expect(client.sent.map(b => b.kind)).toEqual(['RELEASED', 'RECEIPT'])
    expect(out).toMatchObject({ synced: 2, superseded: 0 })
  })
  it('a newer RECEIPT supersedes an older RECEIPT only', async () => {
    const check = await releasedCheck('AP-2')
    await testDb.check.update({ where: { id: check.id }, data: { orNumber: 'OR-2', receiptType: 'OR' } })
    await queue(check.id, 'RECEIPT', NOW)
    await queue(check.id, 'RECEIPT', new Date(NOW.getTime() + 1))
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 60_000), client })
    expect(out).toMatchObject({ synced: 1, superseded: 1 })
  })
  it('RECEIPT waits while its check has a status event that failed this run', async () => {
    const check = await releasedCheck('AP-3')
    await testDb.check.update({ where: { id: check.id }, data: { orNumber: 'OR-3', receiptType: 'OR' } })
    await queue(check.id, 'RELEASED', NOW)
    await queue(check.id, 'RECEIPT', new Date(NOW.getTime() + 1))
    const client = fakeClient((b) => (b.kind === 'RELEASED' ? new Error('network down') : ok()))
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 60_000), client })
    expect(client.sent.map(b => b.kind)).toEqual(['RELEASED'])
    expect((await testDb.portalEvent.findFirst({ where: { checkId: check.id, kind: 'RECEIPT' } }))?.status).toBe('PENDING')
  })
  // Cross-run hold (review 2026-10-02): a RECEIPT waits while its cheque's
  // newest status-lane event is not SYNCED, PARKED included.
  it('RECEIPT stays held on a later run while the check\'s newest status event is PARKED', async () => {
    const check = await releasedCheck('AP-4')
    await testDb.check.update({ where: { id: check.id }, data: { orNumber: 'OR-4', receiptType: 'OR' } })
    await queue(check.id, 'RELEASED', NOW, { status: 'PARKED', lastError: 'refused' })
    const receipt = await queue(check.id, 'RECEIPT', new Date(NOW.getTime() + 1))
    const client = fakeClient(() => ok())
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 60_000), client })
    expect(client.sent).toHaveLength(0)
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: receipt.id } })
    expect(after.status).toBe('PENDING'); expect(after.attempts).toBe(0)
  })
  it('RECEIPT goes out when the check\'s RELEASED was SYNCED on an earlier run', async () => {
    const check = await releasedCheck('AP-5')
    await testDb.check.update({ where: { id: check.id }, data: { orNumber: 'OR-5', receiptType: 'OR' } })
    await queue(check.id, 'RELEASED', NOW, { status: 'SYNCED' })
    await queue(check.id, 'RECEIPT', new Date(NOW.getTime() + 1))
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 60_000), client })
    expect(client.sent.map(b => b.kind)).toEqual(['RECEIPT'])
    expect(out).toMatchObject({ synced: 1 })
  })
  it('RECEIPT stays held while the check\'s status event is FAILED and not yet due', async () => {
    const check = await releasedCheck('AP-6')
    await testDb.check.update({ where: { id: check.id }, data: { orNumber: 'OR-6', receiptType: 'OR' } })
    await queue(check.id, 'RELEASED', NOW, { status: 'FAILED', nextAttemptAt: new Date('2099-01-01') })
    const receipt = await queue(check.id, 'RECEIPT', new Date(NOW.getTime() + 1))
    const client = fakeClient(() => ok())
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 60_000), client })
    expect(client.sent).toHaveLength(0)
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: receipt.id } })).status).toBe('PENDING')
  })
  it('a RECEIPT settle leaves the check-level portal state to the status lane (review 2026-10-02)', async () => {
    const check = await releasedCheck('AP-7')
    await testDb.check.update({ where: { id: check.id }, data: { orNumber: 'OR-7', receiptType: 'OR' } })
    const before = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    const receipt = await queue(check.id, 'RECEIPT', NOW)
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 60_000), client })
    expect(out).toMatchObject({ synced: 1 })
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: receipt.id } })).status).toBe('SYNCED')
    const chk = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(chk.portalSyncStatus).toBe(before.portalSyncStatus)
    expect(chk.portalTradeId).toBe(before.portalTradeId)
    expect(await testDb.auditLog.count({ where: { checkId: check.id, action: 'portal_event_synced' } })).toBe(1)
  })
  it('an ordinary 8 s after-action kick still sends a RECEIPT (review 2026-10-02, second pass)', async () => {
    const check = await releasedCheck('AP-9')
    await testDb.check.update({ where: { id: check.id }, data: { orNumber: 'OR-9', receiptType: 'OR' } })
    await queue(check.id, 'RECEIPT', NOW)
    const client = fakeClient(() => ok())
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 8_000), client })
    expect(client.sent.map((b) => b.kind)).toEqual(['RECEIPT'])
  })
  it('a RECEIPT is left untouched when the run has under 6 s left (review 2026-10-02)', async () => {
    const check = await releasedCheck('AP-8')
    await testDb.check.update({ where: { id: check.id }, data: { orNumber: 'OR-8', receiptType: 'OR' } })
    const receipt = await queue(check.id, 'RECEIPT', NOW)
    const client = fakeClient(() => ok())
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 5_000), client })
    expect(client.sent).toHaveLength(0)
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: receipt.id } })
    expect(after.status).toBe('PENDING'); expect(after.attempts).toBe(0); expect(after.claimedBy).toBeNull()
  })
  it('kindMatchesStatus: RECEIPT only for a RELEASED check', () => {
    expect(kindMatchesStatus('RECEIPT', 'RELEASED')).toBe(true)
    expect(kindMatchesStatus('RECEIPT', 'READY_FOR_RELEASE')).toBe(false)
  })
})

// Final review 2026-09-26.
describe('deliverPortalEvents - final review fixes', () => {
  const run = (client: PortalClient, db: typeof testDb = testDb) =>
    deliverPortalEvents(db, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })

  it('C1: MARK_AVAILABLE for a since-CANCELLED check is closed unsent as stale', async () => {
    const check = await makeCheck({ status: 'CANCELLED', apvNumbers: ['AP-1'], availablePickupDate: new Date('2026-09-30') })
    const ev = await queue(check.id, 'MARK_AVAILABLE', NOW)
    const client = fakeClient(() => ok())
    const out = await run(client)
    expect(client.sent).toHaveLength(0)
    expect(out).toMatchObject({ stale: 1, delivered: 0, synced: 0, superseded: 0 })
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('SYNCED'); expect(after.lastError).toBe('stale: check is now CANCELLED')
    const audits = await testDb.auditLog.findMany({ where: { checkId: check.id, action: 'portal_event_synced' } })
    expect(audits).toHaveLength(1)
    const d = audits[0].details as { stale?: boolean; superseded?: boolean }
    expect(d.stale).toBe(true); expect(d.superseded).toBeUndefined()
    // Nothing was said to the portal: the cheque's portal state is untouched.
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).portalTradeId).toBeNull()
  })

  it('C1: MARK_AVAILABLE for a since-VOIDED check is closed unsent as stale', async () => {
    const check = await makeCheck({ status: 'VOIDED', apvNumbers: ['AP-1'], availablePickupDate: new Date('2026-09-30') })
    const ev = await queue(check.id, 'MARK_AVAILABLE', NOW)
    const client = fakeClient(() => ok())
    const out = await run(client)
    expect(client.sent).toHaveLength(0); expect(out.stale).toBe(1)
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })).lastError).toBe('stale: check is now VOIDED')
  })

  it('C1: a retried (PENDING) MARK_AVAILABLE for a check now RELEASED is stale, not sent', async () => {
    const check = await releasedCheck('AP-1')
    // The newer RELEASED already went out; RETRY put the old row back to PENDING.
    await queue(check.id, 'RELEASED', new Date('2026-08-01T00:00:00Z'), { status: 'SYNCED' })
    const old = await queue(check.id, 'MARK_AVAILABLE', new Date('2026-07-01T00:00:00Z'))
    const client = fakeClient(() => ok())
    const out = await run(client)
    expect(client.sent).toHaveLength(0)
    expect(out).toMatchObject({ stale: 1, delivered: 0 })
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: old.id } })).lastError).toBe('stale: check is now RELEASED')
  })

  it('C1 regression: RELEASED for a RELEASED check still delivers', async () => {
    const check = await releasedCheck('AP-1')
    const ev = await queue(check.id, 'RELEASED', NOW)
    const client = fakeClient(() => ok())
    const out = await run(client)
    expect(client.sent.map((b) => b.eventId)).toEqual([ev.id])
    expect(out).toMatchObject({ delivered: 1, synced: 1, stale: 0 })
  })

  it('I1: a lost supersede freezes the check - the winner is not sent this run', async () => {
    const check = await releasedCheck('AP-1')
    const older = await queue(check.id, 'MARK_AVAILABLE', new Date('2026-08-01T00:00:00Z'))
    const newer = await queue(check.id, 'RELEASED', new Date('2026-08-02T00:00:00Z'))
    const bind = (t: object, p: string | symbol) => {
      const v: unknown = Reflect.get(t, p)
      return typeof v === 'function' ? v.bind(t) : v
    }
    // portalEvent.updateMany answers { count: 0 } for the supersede only, as if
    // another run had claimed the older row between the read and the close.
    const wrapEvents = <T extends object>(delegate: T): T => new Proxy(delegate, {
      get(t, p) {
        if (p === 'updateMany') {
          return (q: { data?: { lastError?: unknown } }) => {
            if (typeof q.data?.lastError === 'string' && q.data.lastError.startsWith('superseded')) return Promise.resolve({ count: 0 })
            return (Reflect.get(t, p) as (x: unknown) => unknown).call(t, q)
          }
        }
        return bind(t, p)
      },
    })
    const wrapDb = <T extends object>(inner: T): T => new Proxy(inner, {
      get(t, p) {
        if (p === 'portalEvent') return wrapEvents(Reflect.get(t, p) as object)
        if (p === '$transaction') {
          return (fn: (tx: object) => Promise<unknown>) =>
            (t as unknown as typeof testDb).$transaction((tx) => fn(wrapDb(tx)))
        }
        return bind(t, p)
      },
    })
    const client = fakeClient(() => ok())
    const out = await run(client, wrapDb(testDb))
    expect(client.sent).toHaveLength(0)
    expect(out).toMatchObject({ superseded: 0, delivered: 0 })
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: newer.id } })).status).toBe('PENDING')
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: older.id } })).status).toBe('PENDING')
  })

  it('I4: a 401 parks that one event and stops the run', async () => {
    const a = await releasedCheck('AP-1')
    const b = await releasedCheck('AP-2')
    const evA = await queue(a.id, 'RELEASED', NOW)
    const evB = await queue(b.id, 'RELEASED', new Date(NOW.getTime() + 1))
    const client = fakeClient(() => ({ status: 401, body: null }))
    const out = await run(client)
    expect(out).toMatchObject({ stoppedOnAuth: true, parked: 1, delivered: 1 })
    expect(client.sent).toHaveLength(1)
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: evA.id } })).status).toBe('PARKED')
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: evB.id } })).status).toBe('PENDING')
  })

  it('I2: each request carries a timeout within the budget; an abort is a normal FAILED with backoff', async () => {
    const check = await releasedCheck('AP-1')
    const ev = await queue(check.id, 'RELEASED', NOW)
    const seen: (number | undefined)[] = []
    const client: PortalClient = {
      async deliver(_body, opts) {
        seen.push(opts?.timeoutMs)
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      },
    }
    await run(client)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeGreaterThanOrEqual(1_000); expect(seen[0]).toBeLessThanOrEqual(10_000)
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('FAILED'); expect(after.nextAttemptAt.getTime()).toBe(LATER.getTime() + RETRY_DELAYS_MS[0])
  })

  it('a 400 keeps the portal error text in lastError', async () => {
    const check = await releasedCheck('AP-1')
    const ev = await queue(check.id, 'RELEASED', NOW)
    await run(fakeClient(() => ({ status: 400, body: null, error: 'releaseDate must be YYYY-MM-DD' })))
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('PARKED'); expect(after.lastError).toBe('portal rejected the payload (400): releaseDate must be YYYY-MM-DD')
  })

  it('the default claimedBy is unique per run', async () => {
    const check = await releasedCheck('AP-1')
    const ev = await queue(check.id, 'RELEASED', NOW)
    await run(fakeClient(() => ({ status: 503, body: null })))
    const first = (await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })).claimedBy
    await testDb.portalEvent.update({ where: { id: ev.id }, data: { nextAttemptAt: LATER } })
    await run(fakeClient(() => ({ status: 503, body: null })))
    const second = (await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })).claimedBy
    expect(first).toMatch(/^run-2026-09-26T02:01:00\.000Z-[0-9a-f-]{36}$/)
    expect(second).not.toBe(first)
  })
})

describe('kindMatchesStatus', () => {
  it('pins the kind-vs-status rule', () => {
    const all = ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED', 'RELEASED', 'CANCELLED', 'VOIDED'] as const
    const allowed = (kind: Parameters<typeof kindMatchesStatus>[0]) => all.filter((s) => kindMatchesStatus(kind, s))
    expect(allowed('MARK_AVAILABLE')).toEqual(['READY_FOR_RELEASE', 'SCHEDULED'])
    expect(allowed('RELEASE_REVERSED')).toEqual(['READY_FOR_RELEASE', 'SCHEDULED'])
    expect(allowed('RELEASED')).toEqual(['RELEASED'])
    expect(allowed('REVERT')).toEqual(['GENERATED', 'SIGNATURE_PENDING', 'SIGNED'])
    expect(allowed('CANCELLED')).toEqual(['CANCELLED', 'VOIDED'])
  })
})

describe('deliverPortalEvents: a parked event notifies the admins', () => {
  it('writes one PORTAL_PARKED per active admin, once per event', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    await makeUser('FINANCE_USER')
    const check = await releasedCheck('AP-1')
    const ev = await queue(check.id, 'RELEASED', NOW)
    const client = fakeClient(() => ({ status: 400, body: null }))
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })

    const rows = await testDb.notification.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      userId: admin.id, kind: 'PORTAL_PARKED', link: '/admin/portal', checkId: check.id, dedupeKey: `parked:${ev.id}`,
    })
    expect(rows[0].message).toContain(`check ${check.checkNumber}`)

    // Re-queued by RETRY and parked again: no second notification for the same event.
    await testDb.portalEvent.update({ where: { id: ev.id }, data: { status: 'PENDING', nextAttemptAt: LATER } })
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(await testDb.notification.count()).toBe(1)
  })

  it('a FAILED delivery that will retry notifies nobody', async () => {
    await makeUser('FINANCE_ADMIN')
    const check = await releasedCheck('AP-1')
    await queue(check.id, 'RELEASED', NOW)
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client: fakeClient(() => ({ status: 503, body: null })) })
    expect(await testDb.notification.count()).toBe(0)
  })
})

describe('deliverPortalEvents: an unmatched INTERNAL event (ruling 2026-10-19)', () => {
  it('retries while attempts remain, then closes SYNCED quietly on the last one: no parked notice', async () => {
    await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'RELEASED', eligibility: 'INTERNAL', apvNumbers: ['AP-1'], releasedAt: NOW })
    const early = await queue(check.id, 'RELEASED', NOW, { attempts: UNMATCHED_MAX_ATTEMPTS - 2 })
    const client = fakeClient(() => ok({ results: [], unmatched: ['AP-1'] }))
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    let after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: early.id } })
    expect(after.status).toBe('FAILED')   // a bill that arrives late is still matched

    await testDb.portalEvent.update({ where: { id: early.id }, data: { nextAttemptAt: LATER } })
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: early.id } })
    expect(after.status).toBe('SYNCED'); expect(after.attempts).toBe(UNMATCHED_MAX_ATTEMPTS)
    expect(after.lastError).toBe('unmatched (internal): AP-1')
    expect(await testDb.notification.count()).toBe(0)
    const c = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(c.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(await testDb.auditLog.count({ where: { checkId: check.id, action: 'portal_event_synced' } })).toBe(1)
  })

  it('a SUPPLIER check unmatched on its last attempt still parks and notifies', async () => {
    await makeUser('FINANCE_ADMIN')
    const check = await releasedCheck('AP-1')
    const ev = await queue(check.id, 'RELEASED', NOW, { attempts: UNMATCHED_MAX_ATTEMPTS - 1 })
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client: fakeClient(() => ok({ results: [], unmatched: ['AP-1'] })) })
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('PARKED')
    expect(await testDb.notification.count()).toBe(1)
  })
})
