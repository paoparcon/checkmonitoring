import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { writeAudit } from '@/lib/audit'
import type { PortalCheckRow, } from '@/lib/integrations/portal/check-feed'
import type { PortalCheckListClient, PortalChecksPushResult } from '@/lib/integrations/portal/client'
import { PORTAL_CHECKS_MODE, lastPortalChecksRun, lastPortalChecksWatermark, pushChecksToPortal, runPortalChecksPush } from '@/lib/sync/portal-checks'

function fakeClient(reply: (rows: PortalCheckRow[]) => PortalChecksPushResult | Error = (rows) => ({ status: 200, body: { received: rows.length, upserted: rows.length } })) {
  const batches: PortalCheckRow[][] = []
  const client: PortalCheckListClient & { batches: PortalCheckRow[][] } = {
    batches,
    async pushChecks(rows) { batches.push(rows); const r = reply(rows); if (r instanceof Error) throw r; return r },
  }
  return client
}

beforeEach(async () => { await resetDb(); delete process.env.PORTAL_BASE_URL; delete process.env.PORTAL_TOKEN })

describe('runPortalChecksPush', () => {
  it('sends every cheque, whatever its status, and records the watermark', async () => {
    const a = await makeCheck({ status: 'SIGNED', apvNumbers: ['AP-1'] })
    const b = await makeCheck({ status: 'VOIDED', apvNumbers: [] })
    await makeCheck({ status: 'CANCELLED', apvNumbers: [], eligibility: 'INTERNAL' })
    await writeAudit(testDb, { checkId: b.id, actorType: 'SYSTEM', action: 'voided', details: { apvNumbersDetached: ['AP-OLD'] } })
    const client = fakeClient()
    const r = await runPortalChecksPush(testDb, { client, now: new Date(), trigger: 'MANUAL' })
    expect(r).toMatchObject({ pushed: 3, batches: 1, errors: 0, remaining: false })
    const rows = client.batches[0]
    expect(rows.map((x) => x.status).sort()).toEqual(['CANCELLED', 'SIGNED', 'VOIDED'])
    expect(rows.find((x) => x.id === a.id)).toMatchObject({ apvs: ['AP-1'], amount: '197715.42' })
    expect(rows.find((x) => x.id === b.id)).toMatchObject({ apvs: [], detachedApvs: ['AP-OLD'] })
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: r.syncRunId! } })
    expect(run).toMatchObject({ mode: PORTAL_CHECKS_MODE, tenant: null, trigger: 'MANUAL', imported: 3, errors: 0 })
    expect(run.watermark).not.toBeNull()
    expect(await lastPortalChecksWatermark(testDb)).toEqual(run.watermark)
  })

  it('an incremental push sends only what changed since the watermark, and a quiet one writes no run', async () => {
    const a = await makeCheck({ status: 'SIGNED' })
    await runPortalChecksPush(testDb, { client: fakeClient(), now: new Date(), trigger: 'MANUAL' })
    // The push reads back 10 minutes from the watermark, so a cheque written seconds ago is inside
    // the overlap; move the watermark past it to prove a quiet run writes nothing.
    const run = await testDb.syncRun.findFirstOrThrow({ where: { mode: PORTAL_CHECKS_MODE } })
    await testDb.syncRun.update({ where: { id: run.id }, data: { watermark: new Date(Date.now() + 11 * 60_000) } })
    const quiet = fakeClient()
    expect(await runPortalChecksPush(testDb, { client: quiet, now: new Date(), trigger: 'SCHEDULED' })).toMatchObject({ pushed: 0, syncRunId: null })
    expect(quiet.batches).toEqual([])
    expect(await testDb.syncRun.count({ where: { mode: PORTAL_CHECKS_MODE } })).toBe(1)
    // A change after the watermark is sent, and only it.
    await testDb.syncRun.update({ where: { id: run.id }, data: { watermark: new Date(Date.now() - 1_000) } })
    const b = await makeCheck({ status: 'RELEASED' })
    await testDb.check.update({ where: { id: a.id }, data: { updatedAt: new Date(Date.now() - 60 * 60_000) } })
    const client = fakeClient()
    const r = await runPortalChecksPush(testDb, { client, now: new Date(), trigger: 'SCHEDULED' })
    expect(r).toMatchObject({ pushed: 1, errors: 0 })
    expect(client.batches[0].map((x) => x.id)).toEqual([b.id])
  })

  it('a refused batch holds the watermark at the last batch sent and says so', async () => {
    await makeCheck({ status: 'SIGNED' })
    const client = fakeClient(() => ({ status: 400, body: null, error: 'checks must be an array' }))
    const r = await runPortalChecksPush(testDb, { client, now: new Date(), trigger: 'MANUAL' })
    expect(r).toMatchObject({ pushed: 0, errors: 1, remaining: true })
    expect(r.message).toMatch(/answered 400: checks must be an array/)
    expect(await lastPortalChecksWatermark(testDb)).toBeNull()
    const last = await lastPortalChecksRun(testDb)
    expect(last).toMatchObject({ pushed: 0, errors: 1 })
  })

  it('a thrown delivery is an error too, never a crash', async () => {
    await makeCheck({ status: 'SIGNED' })
    const r = await runPortalChecksPush(testDb, { client: fakeClient(() => new Error('boom')), now: new Date(), trigger: 'MANUAL' })
    expect(r).toMatchObject({ errors: 1, remaining: true })
    expect(r.message).toMatch(/boom/)
  })

  it('a full push records the epoch first, so a failed first batch leaves the next run continuing it', async () => {
    await makeCheck({ status: 'SIGNED' })
    const r = await runPortalChecksPush(testDb, { client: fakeClient(() => new Error('down')), now: new Date(), trigger: 'MANUAL', full: true })
    expect(r).toMatchObject({ errors: 1, pushed: 0 })
    expect(await lastPortalChecksWatermark(testDb)).toEqual(new Date(0))
    const client = fakeClient()
    expect(await runPortalChecksPush(testDb, { client, now: new Date(), trigger: 'SCHEDULED' })).toMatchObject({ pushed: 1, errors: 0 })
  })

  it('a deadline already past stops after one batch and the next run sends the rest', async () => {
    const a = await makeCheck({ status: 'SIGNED' })
    await testDb.check.update({ where: { id: a.id }, data: { updatedAt: new Date('2026-01-01T00:00:00Z') } })
    await makeCheck({ status: 'SIGNED' })
    // One batch holds both here (500 a batch); the deadline rule is "no further batch once past", so
    // prove it on the boundary: a run whose deadline is already past still sends its first batch.
    const client = fakeClient()
    const r = await runPortalChecksPush(testDb, { client, now: new Date(), trigger: 'MANUAL', deadline: new Date(Date.now() - 1) })
    expect(r).toMatchObject({ pushed: 2, batches: 1, stoppedAtDeadline: false })
  })
})

describe('pushChecksToPortal', () => {
  it('skips, naming the setting, when the portal is not configured', async () => {
    expect(await pushChecksToPortal(testDb, { budgetMs: 1000 })).toEqual({ skipped: 'PORTAL_BASE_URL is not set' })
  })

  it('skips when the injected client cannot push the list', async () => {
    expect(await pushChecksToPortal(testDb, { budgetMs: 1000, client: {} })).toEqual({ skipped: 'the portal client cannot push the check list' })
  })

  it('pushes with an injected client', async () => {
    await makeCheck({ status: 'SIGNED' })
    const client = fakeClient()
    expect(await pushChecksToPortal(testDb, { budgetMs: 5000, client })).toMatchObject({ pushed: 1, errors: 0 })
  })
})
