// tests/admin/check-books.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import type { AcumaticaClient, AcumaticaRow } from '@/lib/integrations/acumatica/client'
import {
  planCheckBookBackfill, applyCheckBookBackfill, applyCheckBookRealign,
  CHECK_BOOK_BACKFILL_ACTION, CHECK_BOOK_REALIGN_ACTION,
} from '@/lib/admin/check-books'

beforeEach(resetDb)

const fake = (rows: AcumaticaRow[]): AcumaticaClient => ({ fetchPage: async () => rows, fetchAll: async () => rows })
const pay = (ref: string, cash: string, type = 'Payment'): AcumaticaRow => ({ Type: type, ReferenceNbr: ref, CashAccount: cash })

/** A cheque the sync created (tenant + payment id), and a cheque book under the same company and bank. */
async function acumaticaCheque(ref: string, checkNumber: string) {
  const c = await makeCheck({ checkNumber, status: 'SIGNED' })
  return testDb.check.update({ where: { id: c.id }, data: { acumaticaTenant: 'GOLIVE', acumaticaPaymentId: ref } })
}
async function bookFor(c: { companyId: string; cashAccountId: string | null }, code: string) {
  const acc = await testDb.cashAccount.findUniqueOrThrow({ where: { id: c.cashAccountId! } })
  return testDb.checkBook.create({ data: { code, bankId: acc.bankId, companyId: c.companyId } })
}

describe('planCheckBookBackfill', () => {
  it('matches each check to the book its payment states, and reports what it cannot set', async () => {
    const a = await acumaticaCheque('CV-1', '6000000001')
    const b = await acumaticaCheque('CV-2', '6000000002')
    const c = await acumaticaCheque('CV-3', '6000000003')
    const d = await acumaticaCheque('CV-4', '6000000004')
    const bookA = await bookFor(a, 'BPI-S-4636')
    const other = await makeCheck({ checkNumber: '1' })
    // A book on record under ANOTHER company: books are shared across companies, so it is still c's (spec §E).
    const shared = await bookFor(other, 'MBT-A-4155')
    const plan = await planCheckBookBackfill(testDb, fake([
      pay('CV-1', 'BPI-S-4636'), pay('CV-1', 'BPI-S-4636', 'Voided Payment'),
      pay('CV-2', 'PCF-SITIO'),
      pay('CV-3', 'MBT-A-4155'),
    ]), 'GOLIVE')
    expect(plan.scanned).toBe(4)
    expect(plan.candidates).toEqual([
      { checkId: a.id, checkNumber: '6000000001', acumaticaPaymentId: 'CV-1', checkBookId: bookA.id, checkBookCode: 'BPI-S-4636' },
      { checkId: c.id, checkNumber: '6000000003', acumaticaPaymentId: 'CV-3', checkBookId: shared.id, checkBookCode: 'MBT-A-4155' },
    ])
    expect(plan.notABook).toEqual({ 'PCF-SITIO': 1 })
    expect(plan).not.toHaveProperty('companyMismatch')
    expect(plan.notInFeed).toBe(1) // CV-4
    // A dry run writes nothing: the plan is a read.
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).checkBookId).toBeNull()
    expect(await testDb.auditLog.count({ where: { action: CHECK_BOOK_BACKFILL_ACTION } })).toBe(0)
    void b; void d
  })

  it('an alias code lands on the canonical book, and a cheque already there is not realigned (lib/check-book-alias.ts, 2026-11-03)', async () => {
    const a = await acumaticaCheque('CV-1', '1791404689')
    const b = await acumaticaCheque('CV-2', '1791405000')
    const canonical = await bookFor(a, 'MBT-A-9048')
    await testDb.check.update({ where: { id: b.id }, data: { checkBookId: canonical.id } })
    const plan = await planCheckBookBackfill(testDb, fake([pay('CV-1', 'MBT-S-9048'), pay('CV-2', 'MBT-S-9048')]), 'GOLIVE')
    expect(plan.candidates).toEqual([
      { checkId: a.id, checkNumber: '1791404689', acumaticaPaymentId: 'CV-1', checkBookId: canonical.id, checkBookCode: 'MBT-A-9048' },
    ])
    expect(plan.notABook).toEqual({})
    expect(plan.realign).toEqual([])
    expect(plan.clear).toEqual([])
  })

  it('applies a book on record under another company: the former mismatch gets its book (spec §E)', async () => {
    const c = await acumaticaCheque('CV-3', '6000000003')
    const other = await makeCheck({ checkNumber: '1' })
    const shared = await bookFor(other, 'MBT-A-4155')
    expect(shared.companyId).not.toBe(c.companyId)
    const plan = await planCheckBookBackfill(testDb, fake([pay('CV-3', 'MBT-A-4155')]), 'GOLIVE')
    expect(await applyCheckBookBackfill(testDb, plan.candidates)).toBe(1)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: c.id } })
    expect(after.checkBookId).toBe(shared.id)
    expect(after.companyId).toBe(c.companyId)
    expect(after.status).toBe('SIGNED')
  })

  it('ignores checks that already have a book, have no payment id, or belong to the other tenant', async () => {
    const a = await acumaticaCheque('CV-1', '6000000001')
    const book = await bookFor(a, 'BPI-S-4636')
    await testDb.check.update({ where: { id: a.id }, data: { checkBookId: book.id } })
    await makeCheck({ checkNumber: '6000000002' }) // register-only: no payment id
    const m = await acumaticaCheque('CV-9', '6000000009')
    await testDb.check.update({ where: { id: m.id }, data: { acumaticaTenant: 'MANUFACTURING' } })
    const plan = await planCheckBookBackfill(testDb, fake([pay('CV-1', 'BPI-S-4636'), pay('CV-9', 'BPI-S-4636')]), 'GOLIVE')
    expect(plan.scanned).toBe(0)
    expect(plan.candidates).toEqual([])
    // a agrees with Acumatica: in neither repair list.
    expect(plan.realign).toEqual([])
    expect(plan.clear).toEqual([])
  })
})

describe('applyCheckBookBackfill', () => {
  it('sets the book and writes one audit row each; status untouched; a second run is a no-op', async () => {
    const a = await acumaticaCheque('CV-1', '6000000001')
    await bookFor(a, 'BPI-S-4636')
    const plan = await planCheckBookBackfill(testDb, fake([pay('CV-1', 'BPI-S-4636')]), 'GOLIVE')
    expect(await applyCheckBookBackfill(testDb, plan.candidates)).toBe(1)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: a.id } })
    expect(after.checkBookId).toBe(plan.candidates[0].checkBookId)
    expect(after.status).toBe('SIGNED')
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: a.id, action: CHECK_BOOK_BACKFILL_ACTION } })
    expect(audit.actorType).toBe('SYSTEM')
    expect(audit.details).toMatchObject({ checkBookCode: 'BPI-S-4636', acumaticaPaymentId: 'CV-1' })
    expect(await applyCheckBookBackfill(testDb, plan.candidates)).toBe(0)
    expect(await testDb.auditLog.count({ where: { action: CHECK_BOOK_BACKFILL_ACTION } })).toBe(1)
  })

  it('leaves a check that gained a book after planning', async () => {
    const a = await acumaticaCheque('CV-1', '6000000001')
    const book = await bookFor(a, 'BPI-S-4636')
    const plan = await planCheckBookBackfill(testDb, fake([pay('CV-1', 'BPI-S-4636')]), 'GOLIVE')
    const other = await testDb.checkBook.create({ data: { code: 'BPI-S-0000', bankId: book.bankId, companyId: book.companyId } })
    await testDb.check.update({ where: { id: a.id }, data: { checkBookId: other.id } })
    expect(await applyCheckBookBackfill(testDb, plan.candidates)).toBe(0)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).checkBookId).toBe(other.id)
  })
})

/** An Acumatica cheque already filed under `code` (a leftover of the register). */
async function bookedCheque(ref: string, checkNumber: string, code: string) {
  const c = await acumaticaCheque(ref, checkNumber)
  const book = await bookFor(c, code)
  const after = await testDb.check.update({ where: { id: c.id }, data: { checkBookId: book.id } })
  return { check: after, book }
}

describe('planCheckBookBackfill — realign to Acumatica (spec §G1)', () => {
  it('plans a realign when the book differs and a clear when Acumatica names no book; leaves agreeing, blank and absent alone', async () => {
    const { check: a, book: oldA } = await bookedCheque('CV-1', '6000000001', 'BPI-S-0001')
    const target = await bookFor(a, 'BPI-S-4636')
    const { check: b, book: oldB } = await bookedCheque('CV-2', '6000000002', 'MBT-A-0002')
    await bookedCheque('CV-3', '6000000003', 'BDO-A-3838') // agrees
    await bookedCheque('CV-4', '6000000004', 'BDO-A-0004') // blank CashAccount
    await bookedCheque('CV-5', '6000000005', 'BDO-A-0005') // not in the feed
    const plan = await planCheckBookBackfill(testDb, fake([
      pay('CV-1', 'BPI-S-4636'),
      pay('CV-2', 'PAYROLL'),
      pay('CV-3', 'BDO-A-3838'),
      pay('CV-4', ''),
    ]), 'GOLIVE')
    expect(plan.realign).toEqual([
      { checkId: a.id, checkNumber: '6000000001', acumaticaPaymentId: 'CV-1', fromCheckBookId: oldA.id, fromCode: 'BPI-S-0001', toCheckBookId: target.id, code: 'BPI-S-4636' },
    ])
    expect(plan.clear).toEqual([
      { checkId: b.id, checkNumber: '6000000002', acumaticaPaymentId: 'CV-2', fromCheckBookId: oldB.id, fromCode: 'MBT-A-0002', toCheckBookId: null, code: 'PAYROLL' },
    ])
    // The fill is unaffected: booked cheques are not scanned, not-a-book or not-in-feed.
    expect(plan.scanned).toBe(0)
    expect(plan.candidates).toEqual([])
    expect(plan.notABook).toEqual({})
    expect(plan.notInFeed).toBe(0)
    // A dry run writes nothing.
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).checkBookId).toBe(oldA.id)
  })
})

describe('applyCheckBookRealign', () => {
  it('moves the book, writes one SYSTEM audit row with from/to, keeps status; a second run is a no-op', async () => {
    const { check: a } = await bookedCheque('CV-1', '6000000001', 'BPI-S-0001')
    const target = await bookFor(a, 'BPI-S-4636')
    const plan = await planCheckBookBackfill(testDb, fake([pay('CV-1', 'BPI-S-4636')]), 'GOLIVE')
    expect(await applyCheckBookRealign(testDb, plan.realign)).toBe(1)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: a.id } })
    expect(after.checkBookId).toBe(target.id)
    expect(after.status).toBe('SIGNED')
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: a.id, action: CHECK_BOOK_REALIGN_ACTION } })
    expect(audit.actorType).toBe('SYSTEM')
    expect(audit.details).toMatchObject({ from: 'BPI-S-0001', to: 'BPI-S-4636', code: 'BPI-S-4636', acumaticaPaymentId: 'CV-1' })
    expect(await applyCheckBookRealign(testDb, plan.realign)).toBe(0)
    expect(await testDb.auditLog.count({ where: { action: CHECK_BOOK_REALIGN_ACTION } })).toBe(1)
  })

  it('clears the book when Acumatica names a non-book account; the audit row says to: null', async () => {
    const { check: b } = await bookedCheque('CV-2', '6000000002', 'MBT-A-0002')
    const plan = await planCheckBookBackfill(testDb, fake([pay('CV-2', 'PAYROLL')]), 'GOLIVE')
    expect(await applyCheckBookRealign(testDb, plan.clear)).toBe(1)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: b.id } })
    expect(after.checkBookId).toBeNull()
    expect(after.status).toBe('SIGNED')
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: b.id, action: CHECK_BOOK_REALIGN_ACTION } })
    expect(audit.details).toMatchObject({ from: 'MBT-A-0002', to: null, code: 'PAYROLL', acumaticaPaymentId: 'CV-2' })
  })

  it('leaves a check whose book changed after planning', async () => {
    const { check: a, book: oldA } = await bookedCheque('CV-1', '6000000001', 'BPI-S-0001')
    await bookFor(a, 'BPI-S-4636')
    const plan = await planCheckBookBackfill(testDb, fake([pay('CV-1', 'BPI-S-4636')]), 'GOLIVE')
    const moved = await testDb.checkBook.create({ data: { code: 'BPI-S-9999', bankId: oldA.bankId, companyId: oldA.companyId } })
    await testDb.check.update({ where: { id: a.id }, data: { checkBookId: moved.id } })
    expect(await applyCheckBookRealign(testDb, plan.realign)).toBe(0)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).checkBookId).toBe(moved.id)
    expect(await testDb.auditLog.count({ where: { action: CHECK_BOOK_REALIGN_ACTION } })).toBe(0)
  })
})
