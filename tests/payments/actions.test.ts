import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'
import { markPayments } from '@/lib/payments/actions'
import { listOtherPayments } from '@/lib/payments/query'
import { DomainError } from '@/lib/domain/errors'

const NOW = new Date('2026-11-20T12:00:00+08:00')

beforeEach(resetDb)

let n = 0
const makePayment = (o: Record<string, unknown> = {}) =>
  testDb.otherPayment.create({
    data: {
      tenant: 'GOLIVE', referenceNbr: `CV-ST02${String(++n).padStart(4, '0')}`, method: 'TT', docType: 'Payment',
      acumaticaStatus: 'Balanced', amount: '1000.10', currency: 'USD', payeeName: 'SHANGHAI PAPER CO', ...o,
    },
  })
const req = (o: Record<string, string> = {}) => ({ marking: 'PROCESSED' as const, date: '', bankReference: '', remarks: '', ...o })

describe('markPayments', () => {
  it('marks every selected payment, records who and when, one audit row each', async () => {
    const user = await makeUser()
    const [a, b] = [await makePayment(), await makePayment()]
    const r = await markPayments(testDb, { ids: [a.id, b.id, a.id], request: req({ date: '2026-11-18', bankReference: 'SWIFT-1' }), userId: user.id, now: NOW })
    expect(r).toMatchObject({ marked: 2, unchanged: 0, refused: 0 })
    const after = await testDb.otherPayment.findUniqueOrThrow({ where: { id: a.id } })
    expect(after).toMatchObject({ marking: 'PROCESSED', bankReference: 'SWIFT-1', markedById: user.id })
    expect(after.processedDate!.toISOString()).toBe('2026-11-18T00:00:00.000Z')
    expect(after.markedAt).toEqual(NOW)
    const audits = await testDb.auditLog.findMany({ where: { action: 'other_payment_marked' } })
    expect(audits).toHaveLength(2)
    expect(audits[0]).toMatchObject({ checkId: null, userId: user.id, actorType: 'USER' })
    expect(audits.map((x) => (x.details as { referenceNbr: string; from: string; to: string; amount: string })).find((d) => d.referenceNbr === a.referenceNbr))
      .toMatchObject({ from: 'ON_PROCESS', to: 'PROCESSED', amount: '1000.10', processedDate: '2026-11-18', bankReference: 'SWIFT-1' })
  })

  it('refuses a voided payment and a backward move with no remark, and still marks the rest', async () => {
    const user = await makeUser()
    const ok = await makePayment()
    const voided = await makePayment({ voided: true })
    const cleared = await makePayment({ marking: 'CLEARED', clearedDate: new Date('2026-11-01T00:00:00Z') })
    const r = await markPayments(testDb, { ids: [ok.id, voided.id, cleared.id, 'nope'], request: req(), userId: user.id, now: NOW })
    expect(r).toMatchObject({ marked: 1, refused: 3 })
    expect(r.outcomes.filter((o) => !o.ok).map((o) => o.referenceNbr)).toEqual([voided.referenceNbr, cleared.referenceNbr, null])
    expect((await testDb.otherPayment.findUniqueOrThrow({ where: { id: cleared.id } })).marking).toBe('CLEARED')
    expect((await testDb.otherPayment.findUniqueOrThrow({ where: { id: voided.id } })).markedById).toBeNull()
    expect(await testDb.auditLog.count()).toBe(1)
  })

  it('moves back with a remark and drops the cleared day', async () => {
    const user = await makeUser()
    const p = await makePayment({ marking: 'CLEARED', processedDate: new Date('2026-11-01T00:00:00Z'), clearedDate: new Date('2026-11-02T00:00:00Z') })
    await markPayments(testDb, { ids: [p.id], request: req({ remarks: 'bank reversed the debit' }), userId: user.id, now: NOW })
    const after = await testDb.otherPayment.findUniqueOrThrow({ where: { id: p.id } })
    expect(after).toMatchObject({ marking: 'PROCESSED', clearedDate: null, remarks: 'bank reversed the debit' })
    expect(after.processedDate!.toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect((await testDb.auditLog.findFirstOrThrow()).remarks).toBe('bank reversed the debit')
  })

  it('writes nothing when nothing would change', async () => {
    const user = await makeUser()
    const p = await makePayment({ marking: 'PROCESSED' })
    const r = await markPayments(testDb, { ids: [p.id], request: req(), userId: user.id, now: NOW })
    expect(r).toMatchObject({ marked: 0, unchanged: 1, refused: 0 })
    expect(await testDb.auditLog.count()).toBe(0)
    expect((await testDb.otherPayment.findUniqueOrThrow({ where: { id: p.id } })).markedById).toBeNull()
  })

  it.each([
    ['nothing ticked', [] as string[], req(), 'NOTHING_SELECTED'],
    ['CLEARED with no day', ['x'], req({ marking: 'CLEARED' }), 'CLEARED_DATE_REQUIRED'],
    ['a future day', ['x'], req({ date: '2026-11-21' }), 'FUTURE_DATE'],
  ])('refuses %s before reading anything', async (_n, ids, request, code) => {
    const user = await makeUser()
    const call = markPayments(testDb, { ids, request: request as ReturnType<typeof req>, userId: user.id, now: NOW })
    await expect(call).rejects.toBeInstanceOf(DomainError)
    await expect(call).rejects.toMatchObject({ code })
    expect(await testDb.auditLog.count()).toBe(0)
  })
})

describe('listOtherPayments', () => {
  it('lists newest payment first with plain values, CANCELLED for a void, and who marked it', async () => {
    const user = await makeUser()
    const old = await makePayment({ paymentDate: new Date('2026-01-05T00:00:00Z') })
    const recent = await makePayment({ paymentDate: new Date('2026-06-05T00:00:00Z'), voided: true, marking: 'PROCESSED' })
    await makePayment({ paymentDate: null, amount: null, currency: null })
    await markPayments(testDb, { ids: [old.id], request: req(), userId: user.id, now: NOW })
    const rows = await listOtherPayments(testDb)
    expect(rows.map((r) => r.paymentDate)).toEqual(['2026-06-05', '2026-01-05', null])
    expect(rows[0]).toMatchObject({ referenceNbr: recent.referenceNbr, display: 'CANCELLED', amount: '1000.10', methodLabel: 'TELEGRAPHIC TRANSFER', markedBy: null })
    expect(rows[1]).toMatchObject({ display: 'PROCESSED', markedBy: user.name })
    expect(rows[2]).toMatchObject({ amount: null, currency: null })
  })
})
