// tests/admin/clearing-accounts.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import type { AcumaticaClient, AcumaticaRow } from '@/lib/integrations/acumatica/client'
import { planCashAccountLink, applyCashAccountLink, CASH_ACCOUNT_LINK_ACTION } from '@/lib/admin/clearing-accounts'

beforeEach(resetDb)

const fake = (rows: AcumaticaRow[]): AcumaticaClient => ({ fetchPage: async () => rows, fetchAll: async () => rows })
const pay = (ref: string, cash: string, type = 'Payment'): AcumaticaRow => ({ Type: type, ReferenceNbr: ref, CashAccount: cash })

/** An Acumatica check with no account and no book, as the sync leaves a PAYROLL payment. */
async function unlinked(ref: string, checkNumber: string) {
  const c = await makeCheck({ checkNumber, status: 'SIGNED' })
  return testDb.check.update({
    where: { id: c.id },
    data: { acumaticaTenant: 'GOLIVE', acumaticaPaymentId: ref, cashAccountId: null, checkBookId: null },
  })
}

describe('PAYROLL clearing account link', () => {
  it('links only unlinked checks whose payment names the account, once, with an audit row and no status change', async () => {
    const a = await unlinked('CV-1', '1791000001')
    const b = await unlinked('CV-2', '1791000002')
    const linked = await makeCheck({ checkNumber: '1791000003' }) // already has the factory's account
    await testDb.check.update({ where: { id: linked.id }, data: { acumaticaTenant: 'GOLIVE', acumaticaPaymentId: 'CV-3' } })
    const other = await testDb.cashAccount.findUniqueOrThrow({ where: { id: linked.cashAccountId! } })
    await testDb.cashAccount.create({ data: { code: 'PAYROLL', bankId: other.bankId, companyId: other.companyId } })

    const plan = await planCashAccountLink(testDb, fake([
      pay('CV-1', 'PAYROLL'), pay('CV-1', 'PAYROLL', 'Voided Payment'), pay('CV-2', 'PCF-SITIO'), pay('CV-3', 'PAYROLL'),
    ]), 'GOLIVE', 'PAYROLL')
    expect(plan.map((p) => p.checkId)).toEqual([a.id])

    expect(await applyCashAccountLink(testDb, 'PAYROLL', plan)).toBe(1)
    expect(await applyCashAccountLink(testDb, 'PAYROLL', plan)).toBe(0) // idempotent
    const after = await testDb.check.findUniqueOrThrow({ where: { id: a.id }, include: { cashAccount: true } })
    expect(after.cashAccount?.code).toBe('PAYROLL')
    expect(after.status).toBe('SIGNED')
    expect(await testDb.auditLog.count({ where: { checkId: a.id, action: CASH_ACCOUNT_LINK_ACTION } })).toBe(1)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: b.id } })).cashAccountId).toBeNull()
  })
})
