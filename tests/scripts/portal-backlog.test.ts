import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { summariseBacklog, queueCancelledForStale, queueReleasedForStale } from '@/lib/admin/portal-backlog'

beforeEach(resetDb)

type Kind = 'MARK_AVAILABLE' | 'RELEASED' | 'CANCELLED'
const mkEvent = (checkId: string, kind: Kind, at: Date, status: 'PENDING' | 'FAILED' | 'IN_FLIGHT' | 'SYNCED' | 'PARKED' = 'PENDING') =>
  testDb.portalEvent.create({ data: { checkId, direction: 'OUT', kind, status, idempotencyKey: `${checkId}${kind}${at.toISOString()}`, payload: {}, createdAt: at } })

describe('summariseBacklog', () => {
  it('applies latest-wins as a dry run and never carries an amount', async () => {
    const check = await makeCheck({ status: 'RELEASED', payeeName: 'HENKEL' })
    await mkEvent(check.id, 'MARK_AVAILABLE', new Date('2026-09-05')); await mkEvent(check.id, 'RELEASED', new Date('2026-09-06'))
    const s = await summariseBacklog(testDb)
    expect(s.total).toBe(2); expect(s.superseded).toBe(1); expect(s.stale).toBe(0)
    expect(s.winners).toEqual([expect.objectContaining({ kind: 'RELEASED', checkNumber: check.checkNumber, payeeName: 'HENKEL', checkStatus: 'RELEASED', eligibility: 'SUPPLIER', stale: false })])
    expect(s.byKind).toEqual({ MARK_AVAILABLE: 1, RELEASED: 1 })
    expect(JSON.stringify(s)).not.toMatch(/197715/)
  })

  it('flags a winner whose kind no longer matches the check as stale (final review 2026-09-26)', async () => {
    const cancelled = await makeCheck({ status: 'CANCELLED' })
    const ready = await makeCheck({ status: 'READY_FOR_RELEASE' })
    await mkEvent(cancelled.id, 'MARK_AVAILABLE', new Date('2026-09-05'))
    await mkEvent(ready.id, 'MARK_AVAILABLE', new Date('2026-09-06'))
    const s = await summariseBacklog(testDb)
    expect(s.stale).toBe(1)
    const byCheque = Object.fromEntries(s.winners.map((w) => [w.checkNumber, w.stale]))
    expect(byCheque).toEqual({ [cancelled.checkNumber]: true, [ready.checkNumber]: false })
  })
})

describe('queueCancelledForStale', () => {
  const NOW = new Date('2026-09-26T10:00:00+08:00')

  async function scenario() {
    const cancelled = await makeCheck({ status: 'CANCELLED', payeeName: 'HENKEL', apvNumbers: ['AP-ST000101'] })
    const voided = await makeCheck({ status: 'VOIDED', apvNumbers: ['AP-ST000102'] })
    await mkEvent(cancelled.id, 'MARK_AVAILABLE', new Date('2026-09-05'))
    await mkEvent(voided.id, 'MARK_AVAILABLE', new Date('2026-09-05'), 'FAILED')
    // Not candidates: already has a CANCELLED event; MARK_AVAILABLE already
    // closed; still ready (not cancelled); INTERNAL.
    const hasCancel = await makeCheck({ status: 'CANCELLED' })
    await mkEvent(hasCancel.id, 'MARK_AVAILABLE', new Date('2026-09-05'))
    await mkEvent(hasCancel.id, 'CANCELLED', new Date('2026-09-07'))
    const closed = await makeCheck({ status: 'CANCELLED' })
    await mkEvent(closed.id, 'MARK_AVAILABLE', new Date('2026-09-05'), 'SYNCED')
    const ready = await makeCheck({ status: 'READY_FOR_RELEASE' })
    await mkEvent(ready.id, 'MARK_AVAILABLE', new Date('2026-09-05'))
    const internal = await makeCheck({ status: 'CANCELLED', eligibility: 'INTERNAL' })
    await mkEvent(internal.id, 'MARK_AVAILABLE', new Date('2026-09-05'))
    return { cancelled, voided }
  }

  it('a cancelled routed check with an open MARK_AVAILABLE and no APV is not found and gets no CANCELLED event', async () => {
    const noApv = await makeCheck({ status: 'CANCELLED', eligibility: 'SUPPLIER', apvNumbers: [] })
    await mkEvent(noApv.id, 'MARK_AVAILABLE', new Date('2026-09-05'))
    const dry = await queueCancelledForStale(testDb, { now: NOW, apply: false })
    expect(dry.found).toBe(0)
    expect(dry.cheques.map((c) => c.id)).not.toContain(noApv.id)
    const r = await queueCancelledForStale(testDb, { now: NOW, apply: true })
    expect(r).toMatchObject({ found: 0, queued: 0 })
    expect(await testDb.portalEvent.count({ where: { checkId: noApv.id, kind: 'CANCELLED' } })).toBe(0)
  })

  it('dry run counts the checks and writes nothing', async () => {
    const { cancelled, voided } = await scenario()
    const before = await testDb.portalEvent.count()
    const r = await queueCancelledForStale(testDb, { now: NOW, apply: false })
    expect(r.found).toBe(2); expect(r.queued).toBe(0)
    expect(r.cheques.map((c) => c.id).sort()).toEqual([cancelled.id, voided.id].sort())
    expect(await testDb.portalEvent.count()).toBe(before)
    expect(await testDb.auditLog.count({ where: { action: 'portal_event_backfilled' } })).toBe(0)
  })

  it('apply queues one CANCELLED event per check with an audit row; a second apply queues nothing', async () => {
    const { cancelled, voided } = await scenario()
    const r = await queueCancelledForStale(testDb, { now: NOW, apply: true })
    expect(r).toMatchObject({ found: 2, queued: 2 })
    for (const c of [cancelled, voided]) {
      const evs = await testDb.portalEvent.findMany({ where: { checkId: c.id, kind: 'CANCELLED' } })
      expect(evs).toHaveLength(1)
      expect(evs[0]).toMatchObject({
        status: 'PENDING', direction: 'OUT',
        idempotencyKey: `${c.id}:CANCELLED:backfill-${NOW.toISOString()}`,
        payload: { action: 'CANCELLED', checkNumber: c.checkNumber },
      })
      const chk = await testDb.check.findUniqueOrThrow({ where: { id: c.id } })
      expect(chk.portalSyncStatus).toBe('PENDING')
      const audits = await testDb.auditLog.findMany({ where: { checkId: c.id, action: 'portal_event_backfilled' } })
      expect(audits).toHaveLength(1)
      expect(audits[0].actorType).toBe('SYSTEM')
      expect((audits[0].details as { eventId?: string }).eventId).toBe(evs[0].id)
    }

    const again = await queueCancelledForStale(testDb, { now: new Date(NOW.getTime() + 60_000), apply: true })
    expect(again).toMatchObject({ found: 0, queued: 0 })
    expect(await testDb.portalEvent.count({ where: { kind: 'CANCELLED' } })).toBe(3)
    expect(await testDb.auditLog.count({ where: { action: 'portal_event_backfilled' } })).toBe(2)
  })
})

// User report 2026-10-06: the register catch-up (lib/admin/register-releases.ts)
// moved cheques the portal had been told were available to RELEASED and queued
// nothing, so the portal kept them on its Checks Available list.
describe('queueReleasedForStale', () => {
  const NOW = new Date('2026-10-06T10:00:00+08:00')

  async function scenario() {
    const register = await makeCheck({ status: 'RELEASED', payeeName: 'FILMEX', apvNumbers: ['AP-A1034346'], statedReleaseDate: new Date('2026-09-30T00:00:00Z') })
    await mkEvent(register.id, 'MARK_AVAILABLE', new Date('2026-09-26'), 'SYNCED')
    // Not candidates: already told RELEASED; never told available; no APV;
    // still ready; released with no day to send.
    const told = await makeCheck({ status: 'RELEASED', releasedAt: new Date('2026-10-01T02:00:00Z') })
    await mkEvent(told.id, 'MARK_AVAILABLE', new Date('2026-09-26'), 'SYNCED')
    await mkEvent(told.id, 'RELEASED', new Date('2026-10-01'), 'SYNCED')
    await makeCheck({ status: 'RELEASED', statedReleaseDate: new Date('2026-09-30T00:00:00Z') })
    const noApv = await makeCheck({ status: 'RELEASED', apvNumbers: [], statedReleaseDate: new Date('2026-09-30T00:00:00Z') })
    await mkEvent(noApv.id, 'MARK_AVAILABLE', new Date('2026-09-26'), 'SYNCED')
    const ready = await makeCheck({ status: 'READY_FOR_RELEASE' })
    await mkEvent(ready.id, 'MARK_AVAILABLE', new Date('2026-09-26'), 'SYNCED')
    const noDay = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-ST000201'] })
    await mkEvent(noDay.id, 'MARK_AVAILABLE', new Date('2026-09-26'), 'SYNCED')
    return { register, noDay }
  }

  it('dry run lists the check, sets aside one with no day, and writes nothing', async () => {
    const { register, noDay } = await scenario()
    const before = await testDb.portalEvent.count()
    const r = await queueReleasedForStale(testDb, { now: NOW, apply: false })
    expect(r).toMatchObject({ found: 1, queued: 0 })
    expect(r.cheques.map((c) => c.id)).toEqual([register.id])
    expect(r.noDate.map((c) => c.id)).toEqual([noDay.id])
    expect(await testDb.portalEvent.count()).toBe(before)
  })

  it('apply queues one RELEASED event with an audit row; a second apply queues nothing', async () => {
    const { register } = await scenario()
    const r = await queueReleasedForStale(testDb, { now: NOW, apply: true })
    expect(r).toMatchObject({ found: 1, queued: 1 })
    const evs = await testDb.portalEvent.findMany({ where: { checkId: register.id, kind: 'RELEASED' } })
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({
      status: 'PENDING', direction: 'OUT',
      idempotencyKey: `${register.id}:RELEASED:backfill-${NOW.toISOString()}`,
      payload: { action: 'RELEASED', checkNumber: register.checkNumber },
    })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: register.id } })).portalSyncStatus).toBe('PENDING')
    const audits = await testDb.auditLog.findMany({ where: { checkId: register.id, action: 'portal_event_backfilled' } })
    expect(audits).toHaveLength(1)
    expect(audits[0].details).toMatchObject({ kind: 'RELEASED', eventId: evs[0].id })

    const again = await queueReleasedForStale(testDb, { now: new Date(NOW.getTime() + 60_000), apply: true })
    expect(again).toMatchObject({ found: 0, queued: 0 })
  })
  it('also reports a check the portal was never told about, released since the app went live (2026-10-07)', async () => {
    // 6000330355 and three others: released 1 Oct by the register catch-up,
    // availability withdrawn before the portal heard of it, so no event at all.
    const never = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-ST040725'], statedReleaseDate: new Date('2026-10-01T00:00:00Z') })
    // Released before the app went live: not sent.
    await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-ST000301'], statedReleaseDate: new Date('2026-08-15T00:00:00Z') })
    // Not a cheque: not sent.
    await makeCheck({ status: 'RELEASED', isCheque: false, apvNumbers: ['AP-ST000302'], statedReleaseDate: new Date('2026-10-01T00:00:00Z') })
    const r = await queueReleasedForStale(testDb, { now: NOW, apply: true })
    expect(r).toMatchObject({ found: 1, queued: 1 })
    expect(r.cheques.map((c) => c.id)).toEqual([never.id])
    expect(await testDb.portalEvent.count({ where: { checkId: never.id, kind: 'RELEASED', status: 'PENDING' } })).toBe(1)
  })

  it('queues an INTERNAL release with an APV (ruling 2026-10-19) and writes no portal state on the check', async () => {
    const internal = await makeCheck({ status: 'RELEASED', eligibility: 'INTERNAL', apvNumbers: ['AP-ST044602'], statedReleaseDate: new Date('2026-10-05T00:00:00Z') })
    const oldInternal = await makeCheck({ status: 'RELEASED', eligibility: 'INTERNAL', apvNumbers: ['AP-ST040001'], statedReleaseDate: new Date('2026-08-20T00:00:00Z') })
    const r = await queueReleasedForStale(testDb, { now: NOW, apply: true })
    expect(r.cheques.map((c) => c.id)).toContain(internal.id)
    expect(r.cheques.map((c) => c.id)).not.toContain(oldInternal.id)
    expect((await testDb.portalEvent.findFirstOrThrow({ where: { checkId: internal.id } })).kind).toBe('RELEASED')
    const after = await testDb.check.findUniqueOrThrow({ where: { id: internal.id } })
    expect(after.portalSyncStatus).toBe('NOT_APPLICABLE'); expect(after.portalDomain).toBeNull()
  })

  it('queues at most `limit` per run, newest release first, and the next run takes the rest', async () => {
    const older = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-ST000401'], statedReleaseDate: new Date('2026-09-10T00:00:00Z') })
    const newer = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-ST000402'], statedReleaseDate: new Date('2026-10-01T00:00:00Z') })
    const first = await queueReleasedForStale(testDb, { now: NOW, apply: true, limit: 1 })
    expect(first).toMatchObject({ found: 2, queued: 1 })
    expect(await testDb.portalEvent.count({ where: { checkId: newer.id, kind: 'RELEASED' } })).toBe(1)
    expect(await testDb.portalEvent.count({ where: { checkId: older.id, kind: 'RELEASED' } })).toBe(0)
    const second = await queueReleasedForStale(testDb, { now: new Date(NOW.getTime() + 60_000), apply: true, limit: 1 })
    expect(second).toMatchObject({ found: 1, queued: 1 })
  })
})
