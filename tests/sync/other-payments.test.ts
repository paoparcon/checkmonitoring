import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { runOtherPaymentsSync, runScheduledOtherPaymentsSync, OTHER_PAYMENTS_MODE } from '@/lib/sync/other-payments'
import { SyncInProgressError } from '@/lib/sync/run'
import { otherPaymentsFilter } from '@/lib/integrations/acumatica/other-payments'
import { PAYMENTS_FEED } from '@/lib/integrations/acumatica/client'
import type { AcumaticaClient, AcumaticaRow, FetchAllOptions, PageOptions } from '@/lib/integrations/acumatica/client'
import { makeCheck } from '../helpers/factory'

const NOW = new Date('2026-11-20T12:00:00+08:00')

beforeEach(resetDb)

// Reference data in: no audit row, nothing for a supplier, and never a check.
afterEach(async () => {
  expect(await testDb.auditLog.count()).toBe(0)
  expect(await testDb.portalEvent.count()).toBe(0)
})

function fakeFeed(rows: readonly AcumaticaRow[], failWith?: Error) {
  const calls: { feed: string; opts: FetchAllOptions | undefined }[] = []
  const client: AcumaticaClient = {
    async fetchAll(feed: string, opts?: FetchAllOptions): Promise<AcumaticaRow[]> {
      calls.push({ feed, opts })
      if (failWith) throw failWith
      return [...rows]
    },
    async fetchPage(_feed: string, _opts?: PageOptions): Promise<AcumaticaRow[]> {
      throw new Error('must page through fetchAll')
    },
  }
  return { client, calls }
}

const feedRow = (o: Record<string, unknown> = {}): AcumaticaRow => ({
  Type: 'Payment', ReferenceNbr: 'CV-ST020001', Vendor: 'V0001', VendorName: 'SHANGHAI PAPER CO', Status: 'Balanced',
  PaymentDate: '2026-05-12T00:00:00', Description: 'TT payment', PaymentRef: 'AP-ST040001',
  PaymentAmount: 12345.67, Balance: 0, Currency: 'USD', CashAccount: 'BPI-S-4833', PaymentMethod: 'TT',
  Branch: 'ST', LastModifiedOn: '2026-05-12T09:30:15', ...o,
})

const read = (rows: readonly AcumaticaRow[], o: { tenant?: 'GOLIVE' | 'MANUFACTURING'; dryRun?: boolean; failWith?: Error } = {}) => {
  const { client, calls } = fakeFeed(rows, o.failWith)
  return { calls, result: runOtherPaymentsSync(testDb, { client, tenant: o.tenant ?? 'GOLIVE', now: NOW, trigger: 'MANUAL', dryRun: o.dryRun }) }
}

describe('runOtherPaymentsSync', () => {
  it('reads the payments inquiry with the four-method filter, in full', async () => {
    const { calls, result } = read([feedRow()])
    await result
    expect(calls).toHaveLength(1)
    expect(calls[0].feed).toBe(PAYMENTS_FEED)
    expect(calls[0].opts?.filter).toBe(otherPaymentsFilter())
  })

  it('creates a payment keyed by its reference, amount exact, ON PROCESS while Acumatica has it open', async () => {
    const r = await read([feedRow()]).result
    expect(r).toMatchObject({ fetched: 1, ignored: 0, payments: 1, created: 1, updated: 0, errors: 0 })
    const p = await testDb.otherPayment.findUniqueOrThrow({ where: { tenant_referenceNbr: { tenant: 'GOLIVE', referenceNbr: 'CV-ST020001' } } })
    expect(p.amount!.toFixed(2)).toBe('12345.67')
    expect(p).toMatchObject({ method: 'TT', currency: 'USD', companyCode: 'STK', marking: 'ON_PROCESS', voided: false, markedById: null, payeeName: 'SHANGHAI PAPER CO' })
    expect(p.paymentDate!.toISOString()).toBe('2026-05-12T00:00:00.000Z')
    expect(await testDb.check.count()).toBe(0)
  })

  it('a payment that arrives Closed starts PROCESSED; a voided one does not', async () => {
    await read([
      feedRow({ ReferenceNbr: 'CV-1', Status: 'Closed' }),
      feedRow({ ReferenceNbr: 'CV-2', Status: 'Voided' }),
      feedRow({ ReferenceNbr: 'CV-2', Type: 'Voided Payment', Status: 'Closed', PaymentAmount: -12345.67 }),
    ]).result
    const all = await testDb.otherPayment.findMany({ orderBy: { referenceNbr: 'asc' } })
    expect(all.map((p) => [p.referenceNbr, p.marking, p.voided, p.amount!.toFixed(2)])).toEqual([
      ['CV-1', 'PROCESSED', false, '12345.67'],
      ['CV-2', 'ON_PROCESS', true, '12345.67'],
    ])
  })

  it('never changes a marking on a re-read, even when Acumatica closes the payment', async () => {
    await read([feedRow()]).result
    await testDb.otherPayment.updateMany({ data: { marking: 'CLEARED', bankReference: 'SWIFT-9', remarks: 'typed' } })
    const r = await read([feedRow({ Status: 'Closed', PaymentAmount: 999.5 })]).result
    expect(r).toMatchObject({ created: 0, updated: 1 })
    const p = await testDb.otherPayment.findFirstOrThrow()
    expect(p).toMatchObject({ marking: 'CLEARED', bankReference: 'SWIFT-9', remarks: 'typed', acumaticaStatus: 'Closed' })
    expect(p.amount!.toFixed(2)).toBe('999.50')
  })

  it('writes nothing for an unchanged set', async () => {
    await read([feedRow()]).result
    const before = await testDb.otherPayment.findFirstOrThrow()
    const r = await read([feedRow()]).result
    expect(r).toMatchObject({ created: 0, updated: 0 })
    expect((await testDb.otherPayment.findFirstOrThrow()).updatedAt).toEqual(before.updatedAt)
  })

  it('follows Acumatica on a later void and keeps the payment', async () => {
    await read([feedRow()]).result
    await read([feedRow({ Status: 'Voided' }), feedRow({ Type: 'Voided Payment', PaymentAmount: -12345.67 })]).result
    const p = await testDb.otherPayment.findFirstOrThrow()
    expect(p.voided).toBe(true)
    expect(p.amount!.toFixed(2)).toBe('12345.67')
    expect(await testDb.otherPayment.count()).toBe(1)
  })

  it('keeps the two tenants apart under one reference', async () => {
    await read([feedRow()]).result
    await read([feedRow({ PaymentAmount: 1 })], { tenant: 'MANUFACTURING' }).result
    const all = await testDb.otherPayment.findMany({ orderBy: { tenant: 'asc' } })
    expect(all.map((p) => [p.tenant, p.amount!.toFixed(2), p.companyCode])).toEqual([['GOLIVE', '12345.67', 'STK'], ['MANUFACTURING', '1.00', 'STPP']])
  })

  it('ignores a row that is not one of the four methods, and leaves a check alone', async () => {
    const check = await makeCheck({})
    const r = await read([feedRow({ PaymentMethod: 'CHK' }), feedRow({ Type: 'Refund' })]).result
    expect(r).toMatchObject({ fetched: 2, ignored: 2, payments: 0, created: 0 })
    expect(await testDb.otherPayment.count()).toBe(0)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).updatedAt).toEqual(check.updatedAt)
  })

  it('records the run, and a dry run records and writes nothing', async () => {
    const dry = await read([feedRow()], { dryRun: true }).result
    expect(dry).toMatchObject({ syncRunId: null, payments: 1, created: 0 })
    expect(await testDb.otherPayment.count()).toBe(0)
    expect(await testDb.syncRun.count()).toBe(0)

    const r = await read([feedRow()]).result
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: r.syncRunId! } })
    expect(run).toMatchObject({ mode: OTHER_PAYMENTS_MODE, tenant: 'GOLIVE', trigger: 'MANUAL', imported: 1, updated: 0, errors: 0, watermark: null })
    expect(run.finishedAt).not.toBeNull()
  })

  it('records a failed fetch on the run and throws', async () => {
    await expect(read([], { failWith: new Error('OData AP-Checks and Payments returned 500') }).result).rejects.toThrow('500')
    const run = await testDb.syncRun.findFirstOrThrow()
    expect(run).toMatchObject({ mode: OTHER_PAYMENTS_MODE, errors: 1 })
    expect(run.finishedAt).not.toBeNull()
  })

  it('refuses to overlap another other-payments run, and is not blocked by a payment run', async () => {
    await testDb.syncRun.create({ data: { mode: 'INCREMENTAL', tenant: 'GOLIVE', startedAt: new Date(NOW.getTime() - 60_000) } })
    await read([feedRow()]).result
    await testDb.syncRun.create({ data: { mode: OTHER_PAYMENTS_MODE, tenant: 'GOLIVE', startedAt: new Date(NOW.getTime() - 60_000) } })
    await expect(read([feedRow()]).result).rejects.toBeInstanceOf(SyncInProgressError)
  })
})

describe('runScheduledOtherPaymentsSync', () => {
  it('reports RAN, and a failure as FAILED without throwing', async () => {
    const ok = await runScheduledOtherPaymentsSync(testDb, { tenant: 'GOLIVE', now: NOW, client: () => fakeFeed([feedRow()]).client })
    expect(ok).toMatchObject({ outcome: 'RAN', payments: 1, created: 1 })
    expect((await testDb.syncRun.findFirstOrThrow()).trigger).toBe('SCHEDULED')
    const bad = await runScheduledOtherPaymentsSync(testDb, { tenant: 'MANUFACTURING', now: NOW, client: () => { throw new Error('ACUMATICA_ODATA_URL_MFG is not set') } })
    expect(bad).toMatchObject({ outcome: 'FAILED' })
  })
})
