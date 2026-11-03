// tests/numbering/inventory-notes.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import { recordInventoryNote, loadInventoryNotes, INVENTORY_NOTE_ACTION, INVENTORY_REMARKS_MAX } from '@/lib/numbering/inventory-notes'

beforeEach(resetDb)

/** A check book holding one Acumatica check on `checkNumber`. */
async function book(checkNumber = '100', code = `BPI-S-${Math.random().toString(36).slice(2, 6)}`) {
  const c = await makeCheck({ checkNumber })
  const acc = await testDb.cashAccount.findUniqueOrThrow({ where: { id: c.cashAccountId! } })
  const b = await testDb.checkBook.create({ data: { code, bankId: acc.bankId, companyId: c.companyId } })
  await testDb.check.update({ where: { id: c.id }, data: { checkBookId: b.id, acumaticaPaymentId: `CV-${code}-${checkNumber}`, acumaticaTenant: 'GOLIVE' } })
  return b
}
const trail = () => testDb.auditLog.findMany({ where: { action: INVENTORY_NOTE_ACTION }, orderBy: { createdAt: 'asc' } })

describe('recordInventoryNote (spec §H)', () => {
  it('writes one row under the canonical number and one audit row with no checkId', async () => {
    const user = await makeUser()
    const b = await book()
    const out = await recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '0102', ticked: true, remarks: '  spoiled form ', userId: user.id })
    expect(out).toMatchObject({ checkNumber: '102', runTo: null, ticked: true, remarks: 'spoiled form', updatedBy: user.name })
    expect(out.updatedAt).toBeInstanceOf(Date)

    const rows = await testDb.checkInventoryNote.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ checkBookId: b.id, checkNumber: '102', ticked: true, remarks: 'spoiled form', updatedById: user.id })

    const audit = await trail()
    expect(audit).toHaveLength(1)
    expect(audit[0].checkId).toBeNull()
    expect(audit[0].actorType).toBe('USER')
    expect(audit[0].userId).toBe(user.id)
    expect(audit[0].remarks).toBe('spoiled form')
    expect(audit[0].details).toEqual({
      checkBook: b.code, checkBookId: b.id, checkNumber: '102', runTo: null, ticked: true, remarks: 'spoiled form', before: null,
    })
  })

  it('a second write on the same number updates the one row and records what it replaced', async () => {
    const ana = await makeUser()
    const ben = await makeUser()
    const b = await book()
    await recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '102', ticked: true, remarks: 'a', userId: ana.id })
    const out = await recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '102', ticked: false, remarks: '', userId: ben.id })
    expect(out).toMatchObject({ ticked: false, remarks: null, updatedBy: ben.name })
    expect(await testDb.checkInventoryNote.count()).toBe(1)
    const audit = await trail()
    expect(audit).toHaveLength(2)
    expect(audit[1].details).toMatchObject({ ticked: false, remarks: null, before: { ticked: true, remarks: 'a' } })
    expect(audit[1].remarks).toBeNull()
  })

  it('records the run a note is for, canonical, and refuses a run that does not end after it starts', async () => {
    const user = await makeUser()
    const b = await book()
    const out = await recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '0200', runTo: '0500', ticked: true, remarks: 'booklet in vault', userId: user.id })
    expect(out).toMatchObject({ checkNumber: '200', runTo: '500' })
    await expect(recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '600', runTo: '599', ticked: true, remarks: '', userId: user.id }))
      .rejects.toMatchObject({ code: 'INVENTORY_RUN_INVERTED' })
    await expect(recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '600', runTo: '600', ticked: true, remarks: '', userId: user.id }))
      .rejects.toMatchObject({ code: 'INVENTORY_RUN_INVERTED' })
    await expect(recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '600', runTo: 'MEMO', ticked: true, remarks: '', userId: user.id }))
      .rejects.toMatchObject({ code: 'INVENTORY_NOT_NUMERIC' })
  })

  it('ticks a number a check in that book holds, and its audit row names that check (third pass: held checks are inventoried too)', async () => {
    const user = await makeUser()
    const b = await book('100')
    const held = await testDb.check.findFirstOrThrow({ where: { checkBookId: b.id, checkNumber: '100' } })
    await expect(recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '100', ticked: true, remarks: 'in the vault', userId: user.id }))
      .resolves.toMatchObject({ checkNumber: '100', ticked: true })
    expect(await testDb.checkInventoryNote.count({ where: { checkBookId: b.id, checkNumber: '100', ticked: true } })).toBe(1)
    const audit = await trail()
    expect(audit).toHaveLength(1)
    expect(audit[0].checkId).toBe(held.id)
    const missing = await recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '102', ticked: true, remarks: '', userId: user.id })
    expect(missing.checkNumber).toBe('102')
    expect((await trail())[1].checkId).toBeNull()
  })

  it('refuses a number that is not all digits, an unknown book, and an over-long remark — writing nothing', async () => {
    const user = await makeUser()
    const b = await book()
    await expect(recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: 'PCF26-00001', ticked: true, remarks: '', userId: user.id }))
      .rejects.toMatchObject({ code: 'INVENTORY_NOT_NUMERIC' })
    await expect(recordInventoryNote(testDb, { checkBookId: 'no-such-book', checkNumber: '102', ticked: true, remarks: '', userId: user.id }))
      .rejects.toMatchObject({ code: 'INVENTORY_NO_SUCH_BOOK' })
    await expect(recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '102', ticked: true, remarks: 'x'.repeat(INVENTORY_REMARKS_MAX + 1), userId: user.id }))
      .rejects.toMatchObject({ code: 'INVENTORY_REMARKS_TOO_LONG' })
    expect(await testDb.checkInventoryNote.count()).toBe(0)
    expect(await trail()).toHaveLength(0)
  })
})

describe('recordInventoryNote — a run and its first number are two notes (second pass)', () => {
  it('keeps the whole-run note and the note on the run\'s first number as separate rows, each updated in place', async () => {
    const user = await makeUser()
    const b = await book()
    await recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '200', runTo: '500', ticked: true, remarks: 'the run', userId: user.id })
    await recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '200', ticked: false, remarks: 'just 200', userId: user.id })
    await recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '200', runTo: '500', ticked: false, remarks: 'the run, unticked', userId: user.id })
    const rows = await testDb.checkInventoryNote.findMany({ where: { checkBookId: b.id }, orderBy: { runTo: 'asc' }, select: { checkNumber: true, runTo: true, ticked: true, remarks: true } })
    expect(rows).toEqual([
      { checkNumber: '200', runTo: '', ticked: false, remarks: 'just 200' },
      { checkNumber: '200', runTo: '500', ticked: false, remarks: 'the run, unticked' },
    ])
    const loaded = (await loadInventoryNotes(testDb, [b.id])).get(b.id)!
    expect(loaded.map((n) => [n.checkNumber, n.runTo, n.remarks])).toEqual([['200', null, 'just 200'], ['200', '500', 'the run, unticked']])
    expect((await trail())[2].details).toMatchObject({ runTo: '500', before: { ticked: true, remarks: 'the run' } })
  })
})

describe('loadInventoryNotes', () => {
  it('groups by book and keys by canonical number; a book list narrows, undefined reads every book', async () => {
    const user = await makeUser()
    const a = await book('1', 'AAA')
    const b = await book('1', 'BBB')
    await recordInventoryNote(testDb, { checkBookId: a.id, checkNumber: '0005', ticked: true, remarks: 'r', userId: user.id })
    await recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '5', ticked: false, remarks: '', userId: user.id })
    const all = await loadInventoryNotes(testDb, undefined)
    expect([...all.keys()].sort()).toEqual([a.id, b.id].sort())
    expect(all.get(a.id)).toHaveLength(1)
    expect(all.get(a.id)?.[0]).toMatchObject({ checkNumber: '5', runTo: null, ticked: true, remarks: 'r', updatedBy: user.name })
    const onlyB = await loadInventoryNotes(testDb, [b.id])
    expect([...onlyB.keys()]).toEqual([b.id])
    expect(await loadInventoryNotes(testDb, [])).toEqual(new Map())
  })
})

describe('NO CHECK BOOK (spec §I)', () => {
  it('a note on the number of a check with no book carries that check\'s id; the book\'s own check wins when both hold it', async () => {
    const user = await makeUser()
    const b = await book('100')
    const payroll = await makeCheck({ checkNumber: '102' })
    await testDb.check.update({ where: { id: payroll.id }, data: { acumaticaPaymentId: 'CV-PAYROLL-102', acumaticaTenant: 'GOLIVE' } })
    await recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '102', ticked: true, remarks: 'payroll leaf', userId: user.id })
    expect((await trail())[0].checkId).toBe(payroll.id)
    // A register-only check with no book is not what the series shows, so it is not named.
    await makeCheck({ checkNumber: '103' })
    await recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '103', ticked: true, remarks: '', userId: user.id })
    expect((await trail())[1].checkId).toBeNull()
    // The book's own check on a shared number is the one named.
    const own = await testDb.check.findFirstOrThrow({ where: { checkBookId: b.id, checkNumber: '100' } })
    const twin = await makeCheck({ checkNumber: '100' })
    await testDb.check.update({ where: { id: twin.id }, data: { acumaticaPaymentId: 'CV-PAYROLL-100', acumaticaTenant: 'GOLIVE' } })
    await recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '100', ticked: true, remarks: '', userId: user.id })
    expect((await trail())[2].checkId).toBe(own.id)
  })
})
