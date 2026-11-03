import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import { buildPortalCheckRow, PORTAL_CHECK_BATCH, type PortalCheckSource } from '@/lib/integrations/portal/check-feed'

const source = (over: Partial<PortalCheckSource> = {}): PortalCheckSource => ({
  id: 'chk1', checkNumber: '6000353106', cvNumber: 'CV-ST012345', apvNumbers: ['AP-ST043926'],
  checkDate: new Date('2026-09-01T00:00:00Z'), amount: new Prisma.Decimal('197715.42'), currency: 'PHP', isCheque: true,
  payeeName: 'ACME SUPPLY', eligibility: 'SUPPLIER', status: 'SIGNED', isStale: false,
  signedAt: new Date('2026-09-02T01:00:00Z'), readyAt: null, availablePickupDate: null,
  releasedAt: null, statedReleaseDate: null, orNumber: null, orDate: null, receiptType: null,
  cancelledAt: null, cancelReason: null, voidedAt: null, acumaticaStatus: 'Balanced', acumaticaTenant: 'GOLIVE',
  updatedAt: new Date('2026-11-03T02:00:00Z'),
  company: { code: 'STK' }, cashAccount: { code: 'BPI STK', bank: { code: 'BPI' } }, checkBook: { code: 'BPI-S-4636', bank: { code: 'BPI' } },
  releasedBy: null, bills: [{ apvNumber: 'AP-ST043926', poNumber: 'PO-77' }, { apvNumber: 'AP-ST043927', poNumber: null }],
  ...over,
})

describe('buildPortalCheckRow', () => {
  it('carries the identity, the amount as a two-decimal string and the status', () => {
    const row = buildPortalCheckRow(source(), { detachedApvs: [], poNumbers: ['PO-77'] })
    expect(row).toMatchObject({
      id: 'chk1', checkNumber: '6000353106', cvNumber: 'CV-ST012345', company: 'STK', bank: 'BPI', checkBook: 'BPI-S-4636', cashAccount: 'BPI STK',
      payee: 'ACME SUPPLY', amount: '197715.42', currency: 'PHP', checkDate: '2026-09-01', isCheque: true,
      status: 'SIGNED', eligibility: 'SUPPLIER', apvs: ['AP-ST043926', 'AP-ST043927'], detachedApvs: [], poNumbers: ['PO-77'],
      acumaticaStatus: 'Balanced', acumaticaTenant: 'GOLIVE', signedAt: '2026-09-02T01:00:00.000Z', releaseDate: null, updatedAt: '2026-11-03T02:00:00.000Z',
    })
    expect(typeof row.amount).toBe('string')
  })

  it('a cheque with no recorded amount sends null, never 0', () => {
    expect(buildPortalCheckRow(source({ amount: null }), { detachedApvs: [], poNumbers: [] }).amount).toBeNull()
  })

  it('a voided cheque says what it was detached from, and its APVs are empty', () => {
    const row = buildPortalCheckRow(source({ status: 'VOIDED', apvNumbers: [], bills: [], voidedAt: new Date('2026-10-06T00:00:00Z') }), { detachedApvs: ['AP-ST044626', 'AP-ST044626'], poNumbers: [] })
    expect(row).toMatchObject({ status: 'VOIDED', apvs: [], detachedApvs: ['AP-ST044626'], voidedAt: '2026-10-06T00:00:00.000Z' })
  })

  it('the release day is the app record, else the register day, as a Manila day', () => {
    expect(buildPortalCheckRow(source({ status: 'RELEASED', releasedAt: new Date('2026-10-02T20:00:00Z'), releasedBy: { name: 'Ana' } }), { detachedApvs: [], poNumbers: [] }))
      .toMatchObject({ releasedAt: '2026-10-02T20:00:00.000Z', releaseDate: '2026-10-03', releasedBy: 'Ana' })
    expect(buildPortalCheckRow(source({ status: 'RELEASED', statedReleaseDate: new Date('2026-09-25T00:00:00Z') }), { detachedApvs: [], poNumbers: [] }))
      .toMatchObject({ releasedAt: null, releaseDate: '2026-09-25' })
  })

  it('takes the bank from the check book when there is no cash account, and blank when neither', () => {
    expect(buildPortalCheckRow(source({ cashAccount: null, checkBook: { code: 'MBT-A-4155', bank: { code: 'MBTC' } } }), { detachedApvs: [], poNumbers: [] })).toMatchObject({ bank: 'MBTC', cashAccount: null })
    expect(buildPortalCheckRow(source({ cashAccount: null, checkBook: null }), { detachedApvs: [], poNumbers: [] }).bank).toBe('')
  })

  it('an INTERNAL cheque is sent with its eligibility stated, so the portal keeps it off every payee screen', () => {
    expect(buildPortalCheckRow(source({ eligibility: 'INTERNAL' }), { detachedApvs: [], poNumbers: [] }).eligibility).toBe('INTERNAL')
  })

  it('the batch size is what the portal accepts', () => {
    expect(PORTAL_CHECK_BATCH).toBe(500)
  })
})
