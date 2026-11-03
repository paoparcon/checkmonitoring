// tests/admin/merge-check-book.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import {
  planCheckBookMerge, applyCheckBookMerge, snapshotOf, CHECK_BOOK_MERGE_ACTION, CHECK_BOOK_RETIRE_ACTION,
} from '@/lib/admin/merge-check-book'

beforeEach(resetDb)

/** The alias pair of lib/check-book-alias.ts, under one bank, plus a check on each. */
async function pair() {
  const a = await makeCheck({ checkNumber: '1791404689', status: 'RELEASED' })
  const b = await makeCheck({ checkNumber: '1791405000', status: 'SIGNED' })
  const acc = await testDb.cashAccount.findUniqueOrThrow({ where: { id: a.cashAccountId! } })
  const alias = await testDb.checkBook.create({ data: { code: 'MBT-S-9048', bankId: acc.bankId, companyId: a.companyId } })
  const canonical = await testDb.checkBook.create({ data: { code: 'MBT-A-9048', bankId: acc.bankId, companyId: a.companyId } })
  await testDb.check.update({ where: { id: a.id }, data: { checkBookId: alias.id, acumaticaPaymentId: 'CV-A1012623', acumaticaTenant: 'GOLIVE' } })
  await testDb.check.update({ where: { id: b.id }, data: { checkBookId: canonical.id } })
  return { a, b, alias, canonical }
}

describe('planCheckBookMerge', () => {
  it('lists the alias book\'s checks and notes, marking a note the canonical book already holds', async () => {
    const { a, alias, canonical } = await pair()
    const user = await makeUser()
    await testDb.checkInventoryNote.createMany({ data: [
      { checkBookId: alias.id, checkNumber: '1791404690', runTo: '', ticked: true, updatedById: user.id },
      { checkBookId: alias.id, checkNumber: '1791404700', runTo: '', ticked: true, remarks: 'alias copy', updatedById: user.id },
      { checkBookId: canonical.id, checkNumber: '1791404700', runTo: '', ticked: false, remarks: 'already here', updatedById: user.id },
    ] })
    const plan = await planCheckBookMerge(testDb, 'MBT-S-9048', 'MBT-A-9048')
    expect(plan.from.code).toBe('MBT-S-9048')
    expect(plan.to.code).toBe('MBT-A-9048')
    expect(plan.checks).toEqual([{ checkId: a.id, checkNumber: '1791404689', status: 'RELEASED', acumaticaPaymentId: 'CV-A1012623', company: expect.any(String) }])
    expect(plan.notes.map((n) => [n.checkNumber, n.clash])).toEqual([['1791404690', false], ['1791404700', true]])
    expect(snapshotOf(plan, new Date('2026-11-03T10:00:00Z'))).toMatchObject({ takenAt: '2026-11-03T10:00:00.000Z', checks: plan.checks, notes: plan.notes })
  })

  it('refuses a pair that is not in the alias table, and a book that is not on record', async () => {
    await pair()
    await expect(planCheckBookMerge(testDb, 'MBT-A-9048', 'MBT-S-9048')).rejects.toThrow(/not an alias/)
    await expect(planCheckBookMerge(testDb, 'BPI-S-4636', 'MBT-A-9048')).rejects.toThrow(/not an alias/)
    await testDb.checkBook.delete({ where: { code: 'MBT-A-9048' } })
    await expect(planCheckBookMerge(testDb, 'MBT-S-9048', 'MBT-A-9048')).rejects.toThrow(/not on record/)
  })
})

describe('applyCheckBookMerge', () => {
  it('moves the checks with one audit row each, status untouched; moves the notes; deletes the emptied book', async () => {
    const { a, b, alias, canonical } = await pair()
    const user = await makeUser()
    await testDb.checkInventoryNote.create({ data: { checkBookId: alias.id, checkNumber: '1791404690', runTo: '', ticked: true, updatedById: user.id } })
    const plan = await planCheckBookMerge(testDb, 'MBT-S-9048', 'MBT-A-9048')
    const r = await applyCheckBookMerge(testDb, plan)
    expect(r).toEqual({ moved: 1, notesMoved: 1, notesLeft: 0, bookDeleted: true })

    const moved = await testDb.check.findUniqueOrThrow({ where: { id: a.id } })
    expect(moved.checkBookId).toBe(canonical.id)
    expect(moved.status).toBe('RELEASED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: b.id } })).checkBookId).toBe(canonical.id)
    expect(await testDb.checkBook.findUnique({ where: { code: 'MBT-S-9048' } })).toBeNull()
    expect(await testDb.checkInventoryNote.count({ where: { checkBookId: canonical.id, checkNumber: '1791404690' } })).toBe(1)

    const audit = await testDb.auditLog.findMany({ where: { action: { in: [CHECK_BOOK_MERGE_ACTION, CHECK_BOOK_RETIRE_ACTION] } }, orderBy: { createdAt: 'asc' } })
    expect(audit.map((x) => [x.action, x.checkId, x.actorType])).toEqual([
      [CHECK_BOOK_MERGE_ACTION, a.id, 'SYSTEM'],
      [CHECK_BOOK_RETIRE_ACTION, null, 'SYSTEM'],
    ])
    expect(audit[0].details).toMatchObject({ from: { code: 'MBT-S-9048' }, to: { code: 'MBT-A-9048' }, acumaticaPaymentId: 'CV-A1012623', status: 'RELEASED' })
  })

  it('keeps a clashing note on the alias book and then keeps the book, because something still refers to it', async () => {
    const { alias, canonical } = await pair()
    const user = await makeUser()
    await testDb.checkInventoryNote.createMany({ data: [
      { checkBookId: alias.id, checkNumber: '1791404700', runTo: '', ticked: true, remarks: 'alias copy', updatedById: user.id },
      { checkBookId: canonical.id, checkNumber: '1791404700', runTo: '', ticked: false, remarks: 'already here', updatedById: user.id },
    ] })
    const plan = await planCheckBookMerge(testDb, 'MBT-S-9048', 'MBT-A-9048')
    const r = await applyCheckBookMerge(testDb, plan)
    expect(r).toEqual({ moved: 1, notesMoved: 0, notesLeft: 1, bookDeleted: false })
    expect(await testDb.checkBook.findUnique({ where: { code: 'MBT-S-9048' } })).not.toBeNull()
    expect(await testDb.checkInventoryNote.count({ where: { checkBookId: alias.id } })).toBe(1)
    expect(await testDb.auditLog.count({ where: { action: CHECK_BOOK_RETIRE_ACTION } })).toBe(0)
  })

  it('is idempotent: a second apply moves nothing', async () => {
    await pair()
    const first = await planCheckBookMerge(testDb, 'MBT-S-9048', 'MBT-A-9048')
    await applyCheckBookMerge(testDb, first)
    await expect(planCheckBookMerge(testDb, 'MBT-S-9048', 'MBT-A-9048')).rejects.toThrow(/not on record/)
    expect(await applyCheckBookMerge(testDb, first)).toEqual({ moved: 0, notesMoved: 0, notesLeft: 0, bookDeleted: false })
    expect(await testDb.auditLog.count({ where: { action: CHECK_BOOK_RETIRE_ACTION } })).toBe(1)
  })
})
