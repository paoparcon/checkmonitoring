// tests/numbering/inventory-notes.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import { recordInventoryNote, loadInventoryNotes, INVENTORY_NOTE_ACTION, INVENTORY_REMARKS_MAX } from '@/lib/numbering/inventory-notes'
import { DomainError } from '@/lib/domain/errors'

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
    expect(audit[1].details).toMatchObject({ ticked: false, remarks: null, before: { ticked: true, remarks: 'a', runTo: null } })
    expect(audit[1].remarks).toBeNull()
  })

  it('records the run a note is for, canonical, and refuses a run that ends before it starts', async () => {
    const user = await makeUser()
    const b = await book()
    const out = await recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '0200', runTo: '0500', ticked: true, remarks: 'booklet in vault', userId: user.id })
    expect(out).toMatchObject({ checkNumber: '200', runTo: '500' })
    await expect(recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '600', runTo: '599', ticked: true, remarks: '', userId: user.id }))
      .rejects.toMatchObject({ code: 'INVENTORY_RUN_INVERTED' })
    await expect(recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '600', runTo: 'MEMO', ticked: true, remarks: '', userId: user.id }))
      .rejects.toMatchObject({ code: 'INVENTORY_NOT_NUMERIC' })
  })

  it('refuses a number a check in that book holds, naming the check, but allows it in another book', async () => {
    const user = await makeUser()
    const b = await book('100')
    const other = await book('7')
    const err = await recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '100', ticked: true, remarks: '', userId: user.id }).catch((e) => e)
    expect(err).toBeInstanceOf(DomainError)
    expect(err.code).toBe('INVENTORY_NUMBER_HELD')
    expect(err.message).toContain('Check 100 is on record in')
    expect(err.message).toContain(b.code)
    expect(await testDb.checkInventoryNote.count()).toBe(0)
    expect(await trail()).toHaveLength(0)
    await expect(recordInventoryNote(testDb, { checkBookId: other.id, checkNumber: '100', ticked: true, remarks: '', userId: user.id })).resolves.toMatchObject({ checkNumber: '100' })
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

describe('loadInventoryNotes', () => {
  it('groups by book and keys by canonical number; a book list narrows, undefined reads every book', async () => {
    const user = await makeUser()
    const a = await book('1', 'AAA')
    const b = await book('1', 'BBB')
    await recordInventoryNote(testDb, { checkBookId: a.id, checkNumber: '0005', ticked: true, remarks: 'r', userId: user.id })
    await recordInventoryNote(testDb, { checkBookId: b.id, checkNumber: '5', ticked: false, remarks: '', userId: user.id })
    const all = await loadInventoryNotes(testDb, undefined)
    expect([...all.keys()].sort()).toEqual([a.id, b.id].sort())
    expect(all.get(a.id)?.get('5')).toMatchObject({ checkNumber: '5', ticked: true, remarks: 'r', updatedBy: user.name })
    expect(all.get(a.id)?.get('0005')).toBeUndefined()
    const onlyB = await loadInventoryNotes(testDb, [b.id])
    expect([...onlyB.keys()]).toEqual([b.id])
    expect(await loadInventoryNotes(testDb, [])).toEqual(new Map())
  })
})
