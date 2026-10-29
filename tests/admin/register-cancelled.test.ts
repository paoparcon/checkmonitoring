import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { findRegisterCancelled, reinstateRegisterCancelled, REINSTATED_ACTION } from '@/lib/admin/register-cancelled'

beforeEach(resetDb)

const NOW = new Date('2026-10-30T01:00:00.000Z')

async function registerCancelled(o: { checkNumber: string; acumaticaStatus?: string | null; cancelledById?: string | null; voidedAt?: Date | null; paymentId?: string | null }) {
  const c = await makeCheck({ status: 'CANCELLED', checkNumber: o.checkNumber, apvNumbers: [] })
  return testDb.check.update({
    where: { id: c.id },
    data: {
      sourceSheet: 'CANCELLED', sourceRow: 751, acumaticaPaymentId: o.paymentId === undefined ? `CV-${o.checkNumber}` : o.paymentId,
      acumaticaStatus: o.acumaticaStatus === undefined ? 'Closed' : o.acumaticaStatus, voidedAt: o.voidedAt ?? null,
    },
  })
}

async function detached(checkId: string, vouchers: string[], bills = 0) {
  return testDb.auditLog.create({ data: {
    checkId, actorType: 'SYSTEM', action: 'apv_detached_on_cancel',
    details: { status: 'CANCELLED', apvNumbersDetached: vouchers, billsDetached: Array(bills).fill('AP-X'), eventsClosed: 0 },
  } })
}

describe('findRegisterCancelled', () => {
  it('selects cheques the register alone cancelled that Acumatica holds live, with the bills the detach removed', async () => {
    const closed = await registerCancelled({ checkNumber: '1791363258' })
    await detached(closed.id, ['AP-A1033419'], 1)
    const balanced = await registerCancelled({ checkNumber: '1791363259', acumaticaStatus: 'Balanced' })
    await registerCancelled({ checkNumber: '1791363260', acumaticaStatus: 'Voided' })
    await registerCancelled({ checkNumber: '1791363261', acumaticaStatus: null, paymentId: null })   // register-only cheque
    await registerCancelled({ checkNumber: '1791363262', voidedAt: new Date() })
    const byUser = await makeCheck({ status: 'CANCELLED', checkNumber: '1791363263' })             // cancelled in the app
    await testDb.check.update({ where: { id: byUser.id }, data: { sourceSheet: 'CANCELLED', acumaticaPaymentId: 'CV-X', acumaticaStatus: 'Closed', cancelledAt: new Date() } })
    const liveSheet = await makeCheck({ status: 'CANCELLED', checkNumber: '1791363264' })           // not from the CANCELLED sheet
    await testDb.check.update({ where: { id: liveSheet.id }, data: { sourceSheet: 'BPI STK', acumaticaPaymentId: 'CV-Y', acumaticaStatus: 'Closed' } })

    const rows = await findRegisterCancelled(testDb)
    expect(rows.map((r) => [r.checkNumber, r.acumaticaStatus, r.detachedVouchers, r.detachedBills])).toEqual([
      ['1791363258', 'Closed', ['AP-A1033419'], 1],
      ['1791363259', 'Balanced', [], 0],
    ])
    expect(rows[0]).toMatchObject({ id: closed.id, registerRow: 751, acumaticaPaymentId: 'CV-1791363258', vouchersNow: [], ruling: null })
    expect(rows[1].id).toBe(balanced.id)
  })

  it('names the ruling already on record — STALED by Finance, reverted by the user, or INTERNAL', async () => {
    const staled = await registerCancelled({ checkNumber: '179011' })
    await testDb.check.update({ where: { id: staled.id }, data: { isStale: true } })
    const reverted = await registerCancelled({ checkNumber: '179174' })
    await testDb.auditLog.create({ data: { checkId: reverted.id, actorType: 'SYSTEM', action: 'reconcile_available_reverted', details: {} } })
    const payroll = await registerCancelled({ checkNumber: '1791363720' })
    await testDb.check.update({ where: { id: payroll.id }, data: { eligibility: 'INTERNAL' } })
    await registerCancelled({ checkNumber: '1791362864' })
    const rows = await findRegisterCancelled(testDb)
    expect(rows.map((r) => [r.checkNumber, r.ruling])).toEqual([
      ['179011', 'Finance: STALED (2026-10-07) — stays CANCELLED'],
      ['1791362864', null],
      ['1791363720', 'INTERNAL — never goes to the portal'],
      ['179174', 'user ruling 2026-10-07 — stays CANCELLED'],
    ])
  })
})

describe('reinstateRegisterCancelled', () => {
  it('puts the named cheque back to SIGNED with its detached bills, one audit row, and nothing else', async () => {
    const closed = await registerCancelled({ checkNumber: '1791363258' })
    await detached(closed.id, ['AP-A1033419'])
    const other = await registerCancelled({ checkNumber: '1791363259' })
    const rows = await findRegisterCancelled(testDb)

    const out = await reinstateRegisterCancelled(testDb, rows.filter((r) => r.checkNumber === '1791363258'), { now: NOW, instruction: 'User said yes, this one.' })
    expect(out).toEqual([{ checkNumber: '1791363258', ok: true }])

    const after = await testDb.check.findUniqueOrThrow({ where: { id: closed.id } })
    expect(after).toMatchObject({ status: 'SIGNED', apvNumbers: ['AP-A1033419'], availablePickupDate: null, readyAt: null })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('CANCELLED')
    const audit = await testDb.auditLog.findMany({ where: { action: REINSTATED_ACTION } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ checkId: closed.id, actorType: 'SYSTEM', details: { from: 'CANCELLED', to: 'SIGNED', apvNumbersReattached: ['AP-A1033419'], registerRow: 751 } })
    expect(audit[0].remarks).toMatch(/User said yes, this one\./)
    expect(await testDb.portalEvent.count()).toBe(0)
    expect((await findRegisterCancelled(testDb)).map((r) => r.checkNumber)).toEqual(['1791363259'])
  })

  it('refuses a cheque that moved or that Acumatica voided since the list was read', async () => {
    const moved = await registerCancelled({ checkNumber: '1791363258' })
    const voided = await registerCancelled({ checkNumber: '1791363259' })
    const rows = await findRegisterCancelled(testDb)
    await testDb.check.update({ where: { id: moved.id }, data: { status: 'RELEASED' } })
    await testDb.check.update({ where: { id: voided.id }, data: { acumaticaStatus: 'Voided' } })

    const out = await reinstateRegisterCancelled(testDb, rows, { now: NOW, instruction: 'x' })
    expect(out).toEqual([
      { checkNumber: '1791363258', ok: false, reason: 'it is RELEASED now' },
      { checkNumber: '1791363259', ok: false, reason: 'Acumatica now says Voided' },
    ])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: voided.id } })).status).toBe('CANCELLED')
    expect(await testDb.auditLog.count({ where: { action: REINSTATED_ACTION } })).toBe(0)
  })
})
