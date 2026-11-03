import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import type { AcumaticaClient, AcumaticaRow, FetchAllOptions } from '@/lib/integrations/acumatica/client'
import { refreshOutOfScope } from '@/lib/sync/out-of-scope'

const NOW = new Date('2026-10-06T10:00:00+08:00')

beforeEach(resetDb)

const payment = (o: Record<string, unknown>): AcumaticaRow => ({
  Type: 'Payment', Vendor: 'V1', VendorName: 'HENKEL PHILIPPINES INC.', Status: 'Balanced',
  PaymentDate: '2026-08-11T00:00:00', PaymentAmount: '100.00', Currency: 'PHP', CashAccount: 'PCF-SITIO',
  PaymentMethod: 'CHK', Branch: 'ST', LastModifiedOn: '2026-10-05T09:00:00', ...o,
})

/** `inScope` answers the scoped read; `all` answers a read by reference. */
function fakeClient(inScope: AcumaticaRow[], all: AcumaticaRow[]): AcumaticaClient & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async fetchAll(_feed: string, opts?: FetchAllOptions) {
      calls.push(opts?.filter ?? '')
      const m = /^ReferenceNbr eq '(.+)'$/.exec(opts?.filter ?? '')
      return m ? all.filter((r) => r.ReferenceNbr === m[1]) : inScope
    },
    async fetchPage() { throw new Error('not used') },
  }
}

async function heldCheque(ref: string, checkNumber: string, status: 'SIGNATURE_PENDING' | 'CANCELLED' = 'SIGNATURE_PENDING') {
  const company = await testDb.company.upsert({
    where: { code: 'STK' }, update: {}, create: { code: 'STK', name: 'Starkson Packaging Inc.', legalNames: ['STARKSON PACKAGING INC.'] },
  })
  return testDb.check.create({
    data: {
      companyId: company.id, checkNumber, amount: '100.00', currency: 'PHP', payeeName: 'HENKEL PHILIPPINES INC.',
      status, eligibility: 'SUPPLIER', isCheque: true, acumaticaPaymentId: ref, acumaticaTenant: 'GOLIVE', checkDate: new Date('2026-08-11'),
    },
  })
}

describe('refreshOutOfScope', () => {
  it('lists LIVE checks whose payment left the scoped feed, and a dry run writes nothing', async () => {
    await heldCheque('CV-IN', '6000400100')
    await heldCheque('CV-OUT', 'PCF26-0244')
    await heldCheque('CV-DEAD', '6000400101', 'CANCELLED')
    const client = fakeClient([payment({ ReferenceNbr: 'CV-IN', PaymentRef: '6000400100' })], [])

    const res = await refreshOutOfScope(testDb, { client, tenant: 'GOLIVE', now: NOW, apply: false })
    expect(res.candidates).toEqual([{ checkNumber: 'PCF26-0244', ref: 'CV-OUT', status: 'SIGNATURE_PENDING' }])
    expect(client.calls).toHaveLength(1)
  })

  it('re-reads each by its reference and follows Acumatica: now a wire (TT), so no longer a check; status untouched', async () => {
    // Was CASH until 2026-10-23, when the user ruled a CASH payment is a check
    // payable to cash and the feed began reading CASH too. A payment leaves the
    // scoped feed now only by becoming a non-check method (TT, DEBIT ADV, BT).
    const c = await heldCheque('CV-OUT', 'PCF26-0244')
    const client = fakeClient([], [payment({ ReferenceNbr: 'CV-OUT', PaymentRef: 'PCF26-0244', PaymentMethod: 'TT' })])

    const res = await refreshOutOfScope(testDb, { client, tenant: 'GOLIVE', now: NOW, apply: true })
    expect(res.updated).toEqual(['CV-OUT'])
    const after = await testDb.check.findUniqueOrThrow({ where: { id: c.id } })
    expect(after.isCheque).toBe(false)
    expect(after.status).toBe('SIGNATURE_PENDING')
  })

  it('reports a payment Acumatica no longer returns, and changes nothing', async () => {
    const c = await heldCheque('CV-GONE', '6000400102')
    const res = await refreshOutOfScope(testDb, { client: fakeClient([], []), tenant: 'GOLIVE', now: NOW, apply: true })
    expect(res.gone).toEqual(['CV-GONE'])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).isCheque).toBe(true)
  })
})

describe('refreshOutOfScope outcomes', () => {
  it('reports a payment upsert stages (SHARED_NUMBER) as staged, not updated', async () => {
    await heldCheque('CV-HOLDER', '6000400200', 'CANCELLED')
    const c = await heldCheque('CV-LIVE', '6000400201')
    // Acumatica now states CV-LIVE under the number CV-HOLDER holds here.
    const client = fakeClient([], [payment({ ReferenceNbr: 'CV-LIVE', PaymentRef: '6000400200' })])
    const res = await refreshOutOfScope(testDb, { client, tenant: 'GOLIVE', now: NOW, apply: true })
    expect(res.updated).toEqual([])
    expect(res.staged).toEqual(['CV-LIVE (SHARED_NUMBER)'])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).checkNumber).toBe('6000400201')
  })
})
