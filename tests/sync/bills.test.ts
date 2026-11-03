import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import {
  runBillsSync, lastBillsWatermark, runScheduledBillsSync,
  BILLS_MODE, VOUCHER_LINKED_ACTION, NO_BILLS_WATERMARK_MESSAGE, DIRECT_LOOKUP_LIMIT,
} from '@/lib/sync/bills'
import { SyncInProgressError, SYNC_OVERLAP_MINUTES } from '@/lib/sync/run'
import {
  BILLS_FEED, billsSinceFilter, billsInScopeFilter, billsForPaymentFilter,
} from '@/lib/integrations/acumatica/bills'
import type {
  AcumaticaClient, AcumaticaRow, FetchAllOptions, PageOptions,
} from '@/lib/integrations/acumatica/client'

const NOW = new Date('2026-10-01T18:00:00+08:00')

beforeEach(resetDb)

// The voucher read changes a cheque's data, never tells a supplier anything.
afterEach(async () => {
  expect(await testDb.portalEvent.count()).toBe(0)
})

type FeedCall = { feed: string; opts: FetchAllOptions | undefined }

/** Records what it was asked for and returns the given rows for BILLS_FEED. */
function fakeBillsFeed(rows: readonly AcumaticaRow[], failWith?: Error) {
  const calls: FeedCall[] = []
  const client: AcumaticaClient = {
    async fetchAll(feed: string, opts?: FetchAllOptions): Promise<AcumaticaRow[]> {
      calls.push({ feed, opts })
      if (failWith) throw failWith
      if (feed !== BILLS_FEED) throw new Error(`unexpected feed ${feed}`)
      return [...rows]
    },
    async fetchPage(_feed: string, _opts?: PageOptions): Promise<AcumaticaRow[]> {
      throw new Error('runBillsSync must page through fetchAll, not fetchPage')
    },
  }
  return { client, calls }
}

/** One Go-Live row of AP-PAYMENTS-WITH-BILLS. */
const billRow = (o: Record<string, unknown> = {}): AcumaticaRow => ({
  AdjgDocType: 'CHK',
  AdjgRefNbr: 'CV-ST012345',
  AdjdDocType: 'Bill',
  AdjdRefNbr: 'AP-ST000001',
  LastModifiedOn: '2026-09-29T08:15:00',
  ...o,
})

const bills = (
  rows: readonly AcumaticaRow[],
  opts: { since?: Date | null; failWith?: Error } = {},
) => {
  const { client, calls } = fakeBillsFeed(rows, opts.failWith)
  return {
    calls,
    result: runBillsSync(testDb, {
      client,
      tenant: 'GOLIVE',
      since: opts.since ?? null,
      now: NOW,
      trigger: 'MANUAL',
    }),
  }
}

async function heldCheque(paymentRef: string, extra: Parameters<typeof makeCheck>[0] = {}) {
  const c = await makeCheck(extra)
  return testDb.check.update({ where: { id: c.id }, data: { acumaticaPaymentId: paymentRef } })
}

describe('runBillsSync — linking vouchers', () => {
  it('links two vouchers to the check whose acumaticaPaymentId matches, sorted, with one audit row', async () => {
    const c = await heldCheque('CV-ST012345')
    const other = await heldCheque('CV-ST099999')
    const result = await bills([
      billRow({ AdjdRefNbr: 'AP-ST000002' }),
      billRow({ AdjdRefNbr: 'AP-ST000001' }),
    ]).result

    const after = await testDb.check.findUniqueOrThrow({ where: { id: c.id } })
    expect(after.apvNumbers).toEqual(['AP-ST000001', 'AP-ST000002'])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: other.id } })).apvNumbers).toEqual([])

    const audits = await testDb.auditLog.findMany({ where: { action: VOUCHER_LINKED_ACTION } })
    expect(audits).toHaveLength(1)
    expect(audits[0].checkId).toBe(c.id)
    expect(audits[0].actorType).toBe('SYSTEM')
    expect((audits[0].details as { vouchers: string[] }).vouchers).toEqual(['AP-ST000001', 'AP-ST000002'])
    expect(result.vouchersAdded).toBe(2)
    expect(result.chequesChanged).toBe(1)
  })

  it('never links a CANCELLED or VOIDED cheque, counts it, and says so in the run message (ruling 2026-10-29)', async () => {
    const voided = await heldCheque('CV-ST012345', { status: 'VOIDED', apvNumbers: [] })
    const cancelled = await heldCheque('CV-ST012346', { status: 'CANCELLED', apvNumbers: [] })
    const live = await heldCheque('CV-ST012347', { status: 'SIGNED', apvNumbers: [] })
    const result = await bills([
      billRow({ AdjgRefNbr: 'CV-ST012345', AdjdRefNbr: 'AP-ST000001' }),
      billRow({ AdjgRefNbr: 'CV-ST012346', AdjdRefNbr: 'AP-ST000002' }),
      billRow({ AdjgRefNbr: 'CV-ST012347', AdjdRefNbr: 'AP-ST000001' }),
    ], { since: new Date('2026-09-29T00:00:00Z') }).result

    expect((await testDb.check.findUniqueOrThrow({ where: { id: voided.id } })).apvNumbers).toEqual([])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: cancelled.id } })).apvNumbers).toEqual([])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: live.id } })).apvNumbers).toEqual(['AP-ST000001'])
    expect(result.cancelledHere).toBe(2)
    expect(result.vouchersAdded).toBe(1)
    expect(result.errors).toBe(0)
    expect(result.watermark).not.toBeNull()
    expect(await testDb.auditLog.count({ where: { action: VOUCHER_LINKED_ACTION } })).toBe(1)
    const run = await testDb.syncRun.findFirstOrThrow({ where: { id: result.syncRunId } })
    expect(run.message).toContain('2 payment(s) whose check is cancelled or voided here were not linked')
  })

  it('keeps vouchers already present and never removes one; a second identical run writes nothing', async () => {
    const c = await heldCheque('CV-ST012345', { apvNumbers: ['AP-OLD'] })
    await bills([billRow({ AdjdRefNbr: 'AP-NEW' })]).result
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).apvNumbers).toEqual(['AP-OLD', 'AP-NEW'])
    expect(await testDb.auditLog.count({ where: { action: VOUCHER_LINKED_ACTION } })).toBe(1)

    const second = await bills([billRow({ AdjdRefNbr: 'AP-NEW' })]).result
    expect(second.vouchersAdded).toBe(0)
    expect(second.chequesChanged).toBe(0)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).apvNumbers).toEqual(['AP-OLD', 'AP-NEW'])
    expect(await testDb.auditLog.count({ where: { action: VOUCHER_LINKED_ACTION } })).toBe(1)
  })

  it('never writes status and creates no PortalEvent', async () => {
    const c = await heldCheque('CV-ST012345', { status: 'SIGNATURE_PENDING' })
    await bills([billRow()]).result
    const after = await testDb.check.findUniqueOrThrow({ where: { id: c.id } })
    expect(after.status).toBe('SIGNATURE_PENDING')
    expect(after.apvNumbers).toEqual(['AP-ST000001'])
    expect(await testDb.portalEvent.count()).toBe(0)
  })

  it('ignores VCK and Debit Adj. rows, links nothing from them, but their date still advances the watermark', async () => {
    const c = await heldCheque('CV-ST012345')
    const result = await bills([
      billRow({ AdjgDocType: 'VCK', LastModifiedOn: '2026-09-30T10:00:00' }),
      billRow({ AdjdDocType: 'Debit Adj.', LastModifiedOn: '2026-09-30T12:00:00' }),
    ]).result
    expect(result.fetched).toBe(2)
    expect(result.ignored).toBe(2)
    expect(result.vouchersAdded).toBe(0)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).apvNumbers).toEqual([])
    expect(result.watermark).toEqual(
      new Date(new Date('2026-09-30T12:00:00Z').getTime() - SYNC_OVERLAP_MINUTES * 60_000),
    )
  })

  it('counts a payment ref this system does not hold as notHeld and writes nothing', async () => {
    const result = await bills([
      billRow({ AdjgRefNbr: 'CV-NOTHERE', AdjdRefNbr: 'AP-1' }),
      billRow({ AdjgRefNbr: 'CV-NOTHERE', AdjdRefNbr: 'AP-2' }),
    ]).result
    expect(result.notHeld).toBe(1)
    expect(result.chequesChanged).toBe(0)
    expect(await testDb.auditLog.count()).toBe(0)
  })
})

describe('runBillsSync — the run record', () => {
  it('records mode BILLS, the counts, watermark = max − 120 min and finishedAt', async () => {
    await heldCheque('CV-ST012345')
    const result = await bills([
      billRow({ AdjdRefNbr: 'AP-ST000001', LastModifiedOn: '2026-09-29T08:15:00' }),
      billRow({ AdjdRefNbr: 'AP-ST000002', LastModifiedOn: '2026-09-29T09:00:00' }),
      billRow({ AdjgRefNbr: 'CV-NOTHERE', LastModifiedOn: '2026-09-29T07:00:00' }),
    ]).result

    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.mode).toBe(BILLS_MODE)
    expect(run.mode).toBe('BILLS')
    expect(run.tenant).toBe('GOLIVE')
    expect(run.trigger).toBe('MANUAL')
    expect(run.startedAt).toEqual(NOW)
    expect(run.finishedAt).not.toBeNull()
    expect(run.imported).toBe(2)
    expect(run.updated).toBe(1)
    expect(run.staged).toBe(1)
    expect(run.errors).toBe(0)
    // The one payment not held here is named, so a later full re-read can link it.
    expect(run.message).toContain('CV-NOTHERE')
    expect(run.watermark).toEqual(new Date('2026-09-29T07:00:00Z'))
  })

  it('names every payment ref not held here in the message', async () => {
    const result = await bills([
      billRow({ AdjgRefNbr: 'CV-GONE001', AdjdRefNbr: 'AP-1' }),
      billRow({ AdjgRefNbr: 'CV-GONE002', AdjdRefNbr: 'AP-2' }),
    ]).result
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.message).toContain('2 payment(s)')
    expect(run.message).toContain('CV-GONE001')
    expect(run.message).toContain('CV-GONE002')
    expect(run.message).toContain('--bills --full')
  })

  it('names only the first 10 not-held refs and counts the rest', async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      billRow({ AdjgRefNbr: `CV-GONE${String(i).padStart(3, '0')}`, AdjdRefNbr: `AP-${i}` }))
    const result = await bills(rows).result
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.message).toContain('12 payment(s)')
    expect(run.message).toContain('CV-GONE009')
    expect(run.message).not.toContain('CV-GONE010')
    expect(run.message).toContain('and 2 more')
  })

  it('leaves message null when every payment is held and nothing failed', async () => {
    await heldCheque('CV-ST012345')
    const result = await bills([billRow()]).result
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.message).toBeNull()
  })

  it('one check whose write fails is an error; the next check is still linked', async () => {
    const first = await heldCheque('CV-FIRST001')
    const second = await heldCheque('CV-SECOND01')
    let calls = 0
    // The first per-cheque transaction throws; every other call is the real one.
    const flaky = new Proxy(testDb, {
      get(target, prop, receiver) {
        if (prop === '$transaction') {
          return (...a: unknown[]) => {
            calls++
            if (calls === 1) return Promise.reject(new Error('write refused for the first check'))
            return (target.$transaction as (...x: unknown[]) => unknown).apply(target, a)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const { client } = fakeBillsFeed([
      billRow({ AdjgRefNbr: 'CV-FIRST001', AdjdRefNbr: 'AP-F' }),
      billRow({ AdjgRefNbr: 'CV-SECOND01', AdjdRefNbr: 'AP-S' }),
    ])
    const result = await runBillsSync(flaky, { client, tenant: 'GOLIVE', since: null, now: NOW, trigger: 'MANUAL' })
    expect(result.errors).toBe(1)
    expect(result.chequesChanged).toBe(1)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: first.id } })).apvNumbers).toEqual([])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: second.id } })).apvNumbers).toEqual(['AP-S'])
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.errors).toBe(1)
    expect(run.message).toContain('write refused for the first check')
    // The failing cheque is named by its payment reference.
    expect(run.message).toContain('CV-FIRST001')
    // The watermark is held, so the failed cheque's vouchers are re-read next run.
    expect(result.watermark).toBeNull()
    expect(run.watermark).toBeNull()
  })

  it('a re-read of an already fully-linked set opens no transaction, writes no audit row, and still advances the watermark', async () => {
    await heldCheque('CV-FIRST001', { apvNumbers: ['AP-F'] })
    await heldCheque('CV-SECOND01', { apvNumbers: ['AP-S2', 'AP-S1'] })
    let transactions = 0
    const counting = new Proxy(testDb, {
      get(target, prop, receiver) {
        if (prop === '$transaction') {
          return (...a: unknown[]) => {
            transactions++
            return (target.$transaction as (...x: unknown[]) => unknown).apply(target, a)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const { client } = fakeBillsFeed([
      billRow({ AdjgRefNbr: 'CV-FIRST001', AdjdRefNbr: 'AP-F' }),
      billRow({ AdjgRefNbr: 'CV-SECOND01', AdjdRefNbr: 'AP-S1' }),
      billRow({ AdjgRefNbr: 'CV-SECOND01', AdjdRefNbr: 'AP-S2' }),
    ])
    const result = await runBillsSync(counting, { client, tenant: 'GOLIVE', since: null, now: NOW, trigger: 'MANUAL' })
    expect(transactions).toBe(0)
    expect(await testDb.auditLog.count({ where: { action: VOUCHER_LINKED_ACTION } })).toBe(0)
    expect(result.errors).toBe(0)
    expect(result.chequesChanged).toBe(0)
    // billRow's LastModifiedOn 08:15 (read as UTC) less the 120-minute overlap.
    expect(result.watermark).toEqual(new Date('2026-09-29T06:15:00Z'))
  })

  it('incremental: passes billsSinceFilter with since, billsInScopeFilter without', async () => {
    const since = new Date('2026-09-28T00:00:00Z')
    const a = bills([], { since })
    await a.result
    expect(a.calls).toHaveLength(1)
    expect(a.calls[0].feed).toBe(BILLS_FEED)
    expect(a.calls[0].opts?.filter).toBe(billsSinceFilter('GOLIVE', since))
    expect(a.calls[0].opts?.orderby).toBe('LastModifiedOn asc')

    const b = bills([])
    await b.result
    expect(b.calls[0].opts?.filter).toBe(billsInScopeFilter('GOLIVE'))
  })

  it('a fetch failure leaves the run finished with errors 1, watermark null, and rethrows', async () => {
    const boom = new Error('feed down')
    await expect(bills([], { failWith: boom }).result).rejects.toBe(boom)
    const run = await testDb.syncRun.findFirstOrThrow({ where: { mode: 'BILLS' } })
    expect(run.finishedAt).not.toBeNull()
    expect(run.errors).toBe(1)
    expect(run.watermark).toBeNull()
    expect(run.message).toContain('feed down')
  })
})

describe('runBillsSync — one run at a time', () => {
  const unfinished = (mode: string, minutesAgo: number) =>
    testDb.syncRun.create({
      data: { mode, tenant: 'GOLIVE', startedAt: new Date(NOW.getTime() - minutesAgo * 60_000), finishedAt: null },
    })

  it('refuses while a BILLS run younger than the setting is unfinished', async () => {
    await unfinished('BILLS', 5)
    await expect(bills([billRow()]).result).rejects.toBeInstanceOf(SyncInProgressError)
    expect(await testDb.syncRun.count()).toBe(1)
  })

  it('is not blocked by an unfinished payment run', async () => {
    await unfinished('INCREMENTAL', 5)
    const result = await bills([]).result
    expect(result.errors).toBe(0)
  })

  it('is not blocked by an unfinished BILL_REFS run', async () => {
    await unfinished('BILL_REFS', 5)
    const result = await bills([]).result
    expect(result.errors).toBe(0)
  })
})

describe('lastBillsWatermark', () => {
  it('returns the newest BILLS watermark and ignores payment runs', async () => {
    await testDb.syncRun.create({
      data: { mode: 'BILLS', tenant: 'GOLIVE', startedAt: new Date('2026-09-29T10:00:00Z'), finishedAt: new Date('2026-09-29T10:00:01Z'), watermark: new Date('2026-09-29T08:00:00Z') },
    })
    await testDb.syncRun.create({
      data: { mode: 'BILLS', tenant: 'GOLIVE', startedAt: new Date('2026-09-30T10:00:00Z'), finishedAt: new Date('2026-09-30T10:00:01Z'), watermark: new Date('2026-09-30T08:00:00Z') },
    })
    await testDb.syncRun.create({
      data: { mode: 'INCREMENTAL', tenant: 'GOLIVE', startedAt: new Date('2026-10-01T10:00:00Z'), finishedAt: new Date('2026-10-01T10:00:01Z'), watermark: new Date('2026-10-01T08:00:00Z') },
    })
    expect(await lastBillsWatermark(testDb, 'GOLIVE')).toEqual(new Date('2026-09-30T08:00:00Z'))
    expect(await lastBillsWatermark(testDb, 'MANUFACTURING')).toBeNull()
  })
})

describe('lastBillsWatermark — other feeds', () => {
  it('ignores a newer BILL_REFS watermark', async () => {
    await testDb.syncRun.create({
      data: { mode: 'BILLS', tenant: 'GOLIVE', startedAt: new Date('2026-09-29T10:00:00Z'), finishedAt: new Date('2026-09-29T10:00:01Z'), watermark: new Date('2026-09-29T08:00:00Z') },
    })
    await testDb.syncRun.create({
      data: { mode: 'BILL_REFS', tenant: 'GOLIVE', startedAt: new Date('2026-09-30T10:00:00Z'), finishedAt: new Date('2026-09-30T10:00:01Z'), watermark: new Date('2026-09-30T08:00:00Z') },
    })
    expect(await lastBillsWatermark(testDb, 'GOLIVE')).toEqual(new Date('2026-09-29T08:00:00Z'))
  })
})

describe('runScheduledBillsSync', () => {
  const billsWatermark = (tenant: 'GOLIVE' | 'MANUFACTURING') =>
    testDb.syncRun.create({
      data: {
        mode: 'BILLS', tenant, trigger: 'MANUAL',
        startedAt: new Date('2026-09-29T10:00:00Z'), finishedAt: new Date('2026-09-29T10:00:01Z'),
        watermark: new Date('2026-09-29T08:00:00Z'),
      },
    })

  it('refuses without a BILLS watermark and records a finished BILLS row saying so', async () => {
    // A payment watermark is not a BILLS watermark.
    await testDb.syncRun.create({
      data: { mode: 'INCREMENTAL', tenant: 'GOLIVE', startedAt: NOW, finishedAt: NOW, watermark: NOW },
    })
    let built = 0
    const outcome = await runScheduledBillsSync(testDb, {
      tenant: 'GOLIVE', now: NOW, client: () => { built++; return fakeBillsFeed([]).client },
    })
    expect(built).toBe(0)
    const run = await testDb.syncRun.findFirstOrThrow({ where: { mode: 'BILLS' } })
    expect(outcome).toEqual({ tenant: 'GOLIVE', outcome: 'REFUSED_NO_WATERMARK', syncRunId: run.id })
    expect(run.trigger).toBe('SCHEDULED')
    expect(run.finishedAt).not.toBeNull()
    expect(run.errors).toBe(1)
    expect(run.watermark).toBeNull()
    expect(run.message).toBe(NO_BILLS_WATERMARK_MESSAGE)
  })

  it('a client factory that throws is FAILED, never a throw', async () => {
    await billsWatermark('GOLIVE')
    const outcome = await runScheduledBillsSync(testDb, {
      tenant: 'GOLIVE', now: NOW, client: () => { throw new Error('x'.repeat(400)) },
    })
    expect(outcome.outcome).toBe('FAILED')
    if (outcome.outcome !== 'FAILED') throw new Error('unreachable')
    expect(outcome.message.length).toBe(300)
  })

  it('with a watermark, RAN with the counts, as SCHEDULED, from that watermark', async () => {
    await billsWatermark('GOLIVE')
    await heldCheque('CV-ST012345')
    const feed = fakeBillsFeed([billRow(), billRow({ AdjgRefNbr: 'CV-NOTHERE' })])
    const outcome = await runScheduledBillsSync(testDb, { tenant: 'GOLIVE', now: NOW, client: () => feed.client })
    expect(outcome).toMatchObject({
      tenant: 'GOLIVE', outcome: 'RAN',
      fetched: 2, ignored: 0, vouchersAdded: 1, chequesChanged: 1, notHeld: 1, errors: 0,
    })
    expect(feed.calls[0].opts?.filter).toBe(billsSinceFilter('GOLIVE', new Date('2026-09-29T08:00:00Z')))
    if (outcome.outcome !== 'RAN') throw new Error('unreachable')
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: outcome.syncRunId } })
    expect(run.trigger).toBe('SCHEDULED')
  })

  it('a BILLS run already in progress is IN_PROGRESS, not FAILED', async () => {
    await billsWatermark('GOLIVE')
    await testDb.syncRun.create({
      data: { mode: 'BILLS', tenant: 'GOLIVE', startedAt: new Date(NOW.getTime() - 60_000), finishedAt: null },
    })
    const outcome = await runScheduledBillsSync(testDb, {
      tenant: 'GOLIVE', now: NOW, client: () => fakeBillsFeed([]).client,
    })
    expect(outcome.outcome).toBe('IN_PROGRESS')
  })
})

// ---------------------------------------------------------------------------
// A held check with no APV is looked up DIRECTLY, by its payment reference.
//
// Why (2026-10-26): CV-HF000161 (6000354602, HAMFI) was released on 23 October
// and its RELEASED event parked — "no APV numbers". Acumatica had applied it to
// AP-HF002206 on 5 October 23:08; a manual full BILLS read at 01:23 on the 6th
// saw that application and moved the watermark to 23:14, and the payment sync
// only created the check at 04:00. Every incremental read since started after
// the application, so the link was never written. The user's ruling: "this
// should not happen again". The watermark cannot know which not-held payments
// will be held later, so the run no longer depends on it for this: every
// scheduled run also asks the inquiry, one request per check, about each held
// Acumatica check that still has no APV. Bounded, add-only, self-healing
// whatever the cause.
// ---------------------------------------------------------------------------

/**
 * A fake that honours the one filter the lookup uses — `<paymentRef> eq '…'` —
 * and answers the feed read with `feedRows` otherwise.
 */
function fakeFeedWithLookups(
  feedRows: readonly AcumaticaRow[],
  lookups: Record<string, readonly AcumaticaRow[]>,
  opts: { failLookups?: boolean } = {},
) {
  const calls: FeedCall[] = []
  const client: AcumaticaClient = {
    async fetchAll(feed: string, o?: FetchAllOptions): Promise<AcumaticaRow[]> {
      calls.push({ feed, opts: o })
      if (feed !== BILLS_FEED) throw new Error(`unexpected feed ${feed}`)
      const m = /^(\w+) eq '([^']+)'$/.exec(o?.filter ?? '')
      if (m && (m[1] === 'AdjgRefNbr' || m[1] === 'ReferenceNbr')) {
        if (opts.failLookups) throw new Error('inquiry answered 500')
        return [...(lookups[m[2]] ?? [])]
      }
      return [...feedRows]
    },
    async fetchPage(): Promise<AcumaticaRow[]> {
      throw new Error('runBillsSync must page through fetchAll, not fetchPage')
    },
  }
  return { client, calls }
}

/** A check this system holds from Acumatica, with no APV yet. */
async function apvless(
  paymentRef: string,
  extra: Parameters<typeof makeCheck>[0] & { tenant?: 'GOLIVE' | 'MANUFACTURING' } = {},
) {
  const { tenant = 'GOLIVE', ...rest } = extra
  const c = await makeCheck(rest)
  return testDb.check.update({
    where: { id: c.id },
    data: { acumaticaPaymentId: paymentRef, acumaticaTenant: tenant },
  })
}

const lookupFilters = (calls: readonly FeedCall[]) =>
  calls.slice(1).map((c) => c.opts?.filter)

describe('runBillsSync — a held check with no APV is looked up directly', () => {
  const SINCE = new Date('2026-10-06T01:14:00Z') // past the application, as on 6 October

  it('asks the inquiry about the check by its payment reference and links what it answers', async () => {
    const c = await apvless('CV-HF000161', { checkNumber: '6000354602' })
    const { client, calls } = fakeFeedWithLookups([], {
      'CV-HF000161': [billRow({ AdjgRefNbr: 'CV-HF000161', AdjdRefNbr: 'AP-HF002206', LastModifiedOn: '2026-10-05T23:08:19' })],
    })
    const result = await runBillsSync(testDb, { client, tenant: 'GOLIVE', since: SINCE, now: NOW, trigger: 'SCHEDULED' })

    expect(lookupFilters(calls)).toEqual([billsForPaymentFilter('GOLIVE', 'CV-HF000161')])
    expect(billsForPaymentFilter('GOLIVE', 'CV-HF000161')).toBe("AdjgRefNbr eq 'CV-HF000161'")
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).apvNumbers).toEqual(['AP-HF002206'])
    expect(result.lookedUp).toBe(1)
    expect(result.linkedByLookup).toBe(1)
    expect(result.vouchersAdded).toBe(1)
    expect(result.chequesChanged).toBe(1)
    expect(result.errors).toBe(0)

    const audits = await testDb.auditLog.findMany({ where: { action: VOUCHER_LINKED_ACTION } })
    expect(audits).toHaveLength(1)
    expect(audits[0].checkId).toBe(c.id)
    expect((audits[0].details as { lookup?: boolean }).lookup).toBe(true)
  })

  it('uses the tenant’s own column name — a Go-Live name is a 500 on MANUFACTURING', async () => {
    const c = await apvless('CV-MF000123', { tenant: 'MANUFACTURING', checkNumber: '1791400001' })
    const { client, calls } = fakeFeedWithLookups([], {
      'CV-MF000123': [{
        AdjgDocType: 'CHK', ReferenceNbr: 'CV-MF000123', DocumentType: 'Bill',
        ReferenceNbr_2: 'A1PP-AP-000014', APAdjust_lastModifiedDateTime: '2026-10-05T23:08:19',
      }],
    })
    await runBillsSync(testDb, { client, tenant: 'MANUFACTURING', since: SINCE, now: NOW, trigger: 'SCHEDULED' })
    expect(lookupFilters(calls)).toEqual(["ReferenceNbr eq 'CV-MF000123'"])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).apvNumbers).toEqual(['A1PP-AP-000014'])
  })

  it('looks up only what needs it: not a linked check, a non-check, a voided or cancelled one, another tenant’s, or one the feed just linked', async () => {
    await apvless('CV-LINKED', { checkNumber: '6000400001', apvNumbers: ['AP-ST000009'] })
    await apvless('CV-NOTCHEQUE', { checkNumber: 'Oct interest', isCheque: false })
    await apvless('CV-VOIDED', { checkNumber: '6000400003', status: 'VOIDED' })
    await apvless('CV-CANCELLED', { checkNumber: '6000400004', status: 'CANCELLED' })
    await apvless('CV-OTHER', { checkNumber: '6000400005', tenant: 'MANUFACTURING' })
    const fed = await apvless('CV-ST012345', { checkNumber: '6000400006' })
    const needs = await apvless('CV-NEEDS', { checkNumber: '6000400007', status: 'RELEASED' })

    const { client, calls } = fakeFeedWithLookups([billRow()], { 'CV-NEEDS': [billRow({ AdjgRefNbr: 'CV-NEEDS', AdjdRefNbr: 'AP-ST000777' })] })
    const result = await runBillsSync(testDb, { client, tenant: 'GOLIVE', since: SINCE, now: NOW, trigger: 'SCHEDULED' })

    expect(lookupFilters(calls)).toEqual([billsForPaymentFilter('GOLIVE', 'CV-NEEDS')])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: fed.id } })).apvNumbers).toEqual(['AP-ST000001'])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: needs.id } })).apvNumbers).toEqual(['AP-ST000777'])
    expect(result.lookedUp).toBe(1)
    expect(result.linkedByLookup).toBe(1)
  })

  it('a lookup the inquiry answers with no application links nothing and is not an error', async () => {
    const c = await apvless('CV-UNAPPLIED', { checkNumber: '6000400010' })
    const { client } = fakeFeedWithLookups([billRow()], { 'CV-UNAPPLIED': [] })
    const result = await runBillsSync(testDb, { client, tenant: 'GOLIVE', since: SINCE, now: NOW, trigger: 'SCHEDULED' })
    expect(result.lookedUp).toBe(1)
    expect(result.linkedByLookup).toBe(0)
    expect(result.errors).toBe(0)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).apvNumbers).toEqual([])
    expect(await testDb.auditLog.count({ where: { action: VOUCHER_LINKED_ACTION } })).toBe(0)
  })

  it('only the application of THAT payment is taken from the answer, whatever else the inquiry returns', async () => {
    const c = await apvless('CV-MINE', { checkNumber: '6000400011' })
    const { client } = fakeFeedWithLookups([], {
      'CV-MINE': [
        billRow({ AdjgRefNbr: 'CV-SOMEONE-ELSE', AdjdRefNbr: 'AP-ST000888' }),
        billRow({ AdjgRefNbr: 'CV-MINE', AdjdRefNbr: 'AP-ST000999' }),
        billRow({ AdjgRefNbr: 'CV-MINE', AdjdRefNbr: 'DM-ST000001', AdjdDocType: 'Debit Adj.' }),
      ],
    })
    await runBillsSync(testDb, { client, tenant: 'GOLIVE', since: SINCE, now: NOW, trigger: 'SCHEDULED' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).apvNumbers).toEqual(['AP-ST000999'])
  })

  it('a failed lookup is counted and named, and the feed watermark still moves', async () => {
    await apvless('CV-FAILS', { checkNumber: '6000400012' })
    const { client } = fakeFeedWithLookups([billRow({ LastModifiedOn: '2026-10-06T03:00:00' })], {}, { failLookups: true })
    const result = await runBillsSync(testDb, { client, tenant: 'GOLIVE', since: SINCE, now: NOW, trigger: 'SCHEDULED' })
    expect(result.lookedUp).toBe(1)
    expect(result.linkedByLookup).toBe(0)
    expect(result.errors).toBe(1)
    // The feed read itself succeeded; a lookup failure must not hold it back,
    // because the next run looks the check up again anyway.
    expect(result.watermark).toEqual(new Date(new Date('2026-10-06T03:00:00Z').getTime() - SYNC_OVERLAP_MINUTES * 60_000))
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.message).toContain('CV-FAILS')
    expect(run.errors).toBe(1)
  })

  it('looks up at most DIRECT_LOOKUP_LIMIT checks per run, oldest first, so the cron’s budget holds', async () => {
    const refs: string[] = []
    for (let i = 0; i < DIRECT_LOOKUP_LIMIT + 2; i++) {
      const ref = `CV-MANY${String(i).padStart(3, '0')}`
      refs.push(ref)
      await apvless(ref, { checkNumber: String(6000500000 + i) })
    }
    const { client, calls } = fakeFeedWithLookups([], {})
    const result = await runBillsSync(testDb, { client, tenant: 'GOLIVE', since: SINCE, now: NOW, trigger: 'SCHEDULED' })
    expect(result.lookedUp).toBe(DIRECT_LOOKUP_LIMIT)
    expect(lookupFilters(calls)).toHaveLength(DIRECT_LOOKUP_LIMIT)
    expect(lookupFilters(calls)[0]).toBe(billsForPaymentFilter('GOLIVE', refs[0]))
  })

  it('a first read (no watermark) looks nothing up — the whole year’s applications were just read', async () => {
    await apvless('CV-FIRST', { checkNumber: '6000400013' })
    const { client, calls } = fakeFeedWithLookups([], { 'CV-FIRST': [billRow({ AdjgRefNbr: 'CV-FIRST' })] })
    const result = await runBillsSync(testDb, { client, tenant: 'GOLIVE', since: null, now: NOW, trigger: 'MANUAL' })
    expect(calls).toHaveLength(1)
    expect(result.lookedUp).toBe(0)
  })
})
