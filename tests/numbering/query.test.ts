// tests/numbering/query.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { listNumberingAccounts, countChequesWithoutCheckBook, countRegisterOnlyCheques, listCheckBookOptions } from '@/lib/numbering/query'

beforeEach(resetDb)

/** A cheque Acumatica knows: NUMBERING shows only these (spec §G2). */
let cvSeq = 0
async function acuCheck(overrides: Parameters<typeof makeCheck>[0] = {}) {
  const c = await makeCheck(overrides)
  cvSeq += 1
  return testDb.check.update({ where: { id: c.id }, data: { acumaticaPaymentId: `CV-Q${String(cvSeq).padStart(6, '0')}`, acumaticaTenant: 'GOLIVE' } })
}

/** A cheque book under the cheque's own company and bank, and the cheque in it. */
async function bookFor(c: { id: string; companyId: string; cashAccountId: string | null }, code = `BPI-S-${Math.random().toString(36).slice(2, 6)}`) {
  const acc = await testDb.cashAccount.findUniqueOrThrow({ where: { id: c.cashAccountId! } })
  const book = await testDb.checkBook.create({ data: { code, bankId: acc.bankId, companyId: c.companyId } })
  await testDb.check.update({ where: { id: c.id }, data: { checkBookId: book.id } })
  return book
}
async function inBook(book: { id: string }, overrides: Parameters<typeof makeCheck>[0], register = false) {
  const c = register ? await makeCheck(overrides) : await acuCheck(overrides)
  return testDb.check.update({ where: { id: c.id }, data: { checkBookId: book.id } })
}

describe('listNumberingAccounts', () => {
  it('includes every status and checks with no amount; excludes non-checks', async () => {
    const first = await acuCheck({ checkNumber: '100', status: 'RELEASED' })
    const book = await bookFor(first)
    await inBook(book, { checkNumber: '101', status: 'VOIDED', amount: null })
    await inBook(book, { checkNumber: '102', status: 'CANCELLED' })
    await inBook(book, { checkNumber: '104', status: 'SIGNED', isCheque: false })
    const [acc, ...rest] = await listNumberingAccounts(testDb, {})
    expect(rest).toHaveLength(0)
    expect(acc.accountId).toBe(book.id)
    expect(acc.account).toBe(book.code)
    expect(acc.series.summary).toMatchObject({ first: '100', last: '102', held: 3, voided: 1, cancelled: 1, missingRuns: 0 })
    const voided = acc.series.entries.find((e) => e.kind === 'CHECK' && e.cheque.checkNumber === '101')
    expect(voided?.kind === 'CHECK' && voided.cheque.amount).toBeNull()
  })

  it('one entry per check book, sorted by book code, amounts as strings', async () => {
    const a = await acuCheck({ checkNumber: '1', amount: '197715.42' })
    const b = await acuCheck({ checkNumber: '2' })
    await bookFor(a, 'ZZZ')
    await bookFor(b, 'AAA')
    const out = await listNumberingAccounts(testDb, {})
    expect(out.map((x) => x.account)).toEqual(['AAA', 'ZZZ'])
    const e = out[1].series.entries[0]
    expect(e.kind === 'CHECK' && e.cheque.amount).toBe('197715.42')
  })

  it('returns amounts as two-decimal strings', async () => {
    const first = await acuCheck({ checkNumber: '1', amount: '1000.50' })
    const book = await bookFor(first)
    await inBook(book, { checkNumber: '2', amount: '500' })
    const [acc] = await listNumberingAccounts(testDb, {})
    const amountOf = (n: string) => {
      const e = acc.series.entries.find((x) => x.kind === 'CHECK' && x.cheque.checkNumber === n)
      return e?.kind === 'CHECK' ? e.cheque.amount : undefined
    }
    expect(amountOf('1')).toBe('1000.50')
    expect(amountOf('2')).toBe('500.00')
  })

  it('a named check book is shown whole: a companyId with no check in it does not empty it (spec §E)', async () => {
    const a = await acuCheck({ checkNumber: '1' })
    const b = await acuCheck({ checkNumber: '2' })
    const bookA = await bookFor(a)
    const bookB = await bookFor(b)
    const out = await listNumberingAccounts(testDb, { companyId: bookB.companyId, checkBookId: bookA.id })
    expect(out.map((x) => x.accountId)).toEqual([bookA.id])
    expect(out[0].series.summary.held).toBe(1)
  })

  it('narrows by the books the company\'s checks use, and by one check book', async () => {
    const a = await acuCheck({ checkNumber: '1' })
    const b = await acuCheck({ checkNumber: '2' })
    const bookA = await bookFor(a)
    const bookB = await bookFor(b)
    expect((await listNumberingAccounts(testDb, { companyId: a.companyId })).map((x) => x.accountId)).toEqual([bookA.id])
    expect((await listNumberingAccounts(testDb, { checkBookId: bookB.id })).map((x) => x.accountId)).toEqual([bookB.id])
  })

  it('a company with no check in any book gets no series', async () => {
    const a = await acuCheck({ checkNumber: '1' })
    await bookFor(a)
    const loose = await acuCheck({ checkNumber: '2' }) // its company's only cheque carries no book
    expect(await listNumberingAccounts(testDb, { companyId: loose.companyId })).toEqual([])
  })
})

describe('listNumberingAccounts — the inventory (spec §H)', () => {
  it('lists each MISSING number on its own line with the note recorded on it, and counts what is ticked', async () => {
    const user = await testDb.user.create({ data: { email: 'ana@rcl.test', name: 'Ana', passwordHash: 'x' } })
    const first = await acuCheck({ checkNumber: '100' })
    const book = await bookFor(first)
    await inBook(book, { checkNumber: '104' })
    await testDb.checkInventoryNote.create({ data: { checkBookId: book.id, checkNumber: '101', ticked: true, remarks: 'spoiled', updatedById: user.id } })
    await testDb.checkInventoryNote.create({ data: { checkBookId: book.id, checkNumber: '103', ticked: false, remarks: 'asked the bank', updatedById: user.id } })
    const [acc] = await listNumberingAccounts(testDb, {})
    expect(acc.lines.map((l) => (l.kind === 'MISSING_NUMBER' ? `N ${l.number}` : l.kind === 'CHECK' ? l.cheque.checkNumber : l.kind)))
      .toEqual(['100', 'N 101', 'N 102', 'N 103', '104'])
    const n101 = acc.lines[1]
    expect(n101.kind === 'MISSING_NUMBER' && n101.note).toMatchObject({ ticked: true, remarks: 'spoiled', updatedBy: 'Ana' })
    const n102 = acc.lines[2]
    expect(n102.kind === 'MISSING_NUMBER' && n102.note).toBeNull()
    expect(acc.inventory).toEqual({ ticked: '1', remarked: 2, lines: 3 })
    // The series itself is unchanged: one MISSING run of three.
    expect(acc.series.summary).toMatchObject({ missingNumbers: '3', missingRuns: 1 })
  })

  it("another book's note on the same number is not read into this one", async () => {
    const user = await testDb.user.create({ data: { email: 'ana@rcl.test', name: 'Ana', passwordHash: 'x' } })
    const a = await acuCheck({ checkNumber: '100' })
    const bookA = await bookFor(a, 'AAA')
    await inBook(bookA, { checkNumber: '102' })
    const b = await acuCheck({ checkNumber: '100' })
    const bookB = await bookFor(b, 'BBB')
    await inBook(bookB, { checkNumber: '102' })
    await testDb.checkInventoryNote.create({ data: { checkBookId: bookB.id, checkNumber: '101', ticked: true, updatedById: user.id } })
    const [accA, accB] = await listNumberingAccounts(testDb, {})
    expect(accA.inventory.ticked).toBe('0')
    expect(accB.inventory.ticked).toBe('1')
    expect((await listNumberingAccounts(testDb, { checkBookId: bookA.id }))[0].inventory.ticked).toBe('0')
  })
})

describe('listNumberingAccounts — a check book shared across companies (spec §E)', () => {
  /** Book 500-502: X holds 500 and 502, Y holds 501. A second book holds only X's 900. */
  async function sharedBook() {
    const x1 = await acuCheck({ checkNumber: '500' })
    const book = await bookFor(x1)
    const x2 = await inBook(book, { checkNumber: '502' })
    await testDb.check.update({ where: { id: x2.id }, data: { companyId: x1.companyId } })
    const y = await inBook(book, { checkNumber: '501' })
    const x3 = await acuCheck({ checkNumber: '900' })
    await testDb.check.update({ where: { id: x3.id }, data: { companyId: x1.companyId } })
    const xOnly = await bookFor({ ...x3, companyId: x1.companyId }, 'ZZZ-X-ONLY')
    const X = await testDb.company.findUniqueOrThrow({ where: { id: x1.companyId } })
    const Y = await testDb.company.findUniqueOrThrow({ where: { id: y.companyId } })
    return { book, xOnly, X, Y }
  }

  it('one series per book, its company listing every company in it, most checks first', async () => {
    const { book, X, Y } = await sharedBook()
    const out = await listNumberingAccounts(testDb, {})
    const shared = out.filter((x) => x.accountId === book.id)
    expect(shared).toHaveLength(1)
    expect(shared[0].company).toBe(`${X.code}, ${Y.code}`)
    expect(shared[0].series.summary).toMatchObject({ first: '500', last: '502', held: 3, missingRuns: 0 })
  })

  it('a company filter returns the whole shared book, with no MISSING where another company\'s check sits', async () => {
    const { book, X, Y } = await sharedBook()
    const out = await listNumberingAccounts(testDb, { companyId: Y.id })
    expect(out.map((x) => x.accountId)).toEqual([book.id])
    expect(out[0].series.summary).toMatchObject({ first: '500', last: '502', held: 3, missingRuns: 0 })
    expect(out[0].series.entries.some((e) => e.kind === 'MISSING')).toBe(false)
    expect(out[0].company).toBe(`${X.code}, ${Y.code}`)
  })

  it('a book holding none of the company\'s checks is left out', async () => {
    const { book, xOnly, X, Y } = await sharedBook()
    expect((await listNumberingAccounts(testDb, { companyId: Y.id })).map((x) => x.accountId)).not.toContain(xOnly.id)
    const forX = await listNumberingAccounts(testDb, { companyId: X.id })
    // Sorted by book code: BPI-S-… before ZZZ-X-ONLY.
    expect(forX.map((x) => x.accountId)).toEqual([book.id, xOnly.id])
    expect(forX.find((x) => x.accountId === xOnly.id)?.company).toBe(X.code)
  })

  it('a check with a cash account but no check book is in no series', async () => {
    const c = await acuCheck({ checkNumber: '500' })
    expect(c.cashAccountId).not.toBeNull()
    expect(c.checkBookId).toBeNull()
    expect(await listNumberingAccounts(testDb, {})).toEqual([])
    expect(await countChequesWithoutCheckBook(testDb, {})).toBe(1)
  })
})

async function stage(cashAccountCode: string | null, statedCheckRef: string, extra: Record<string, unknown> = {}) {
  const workbook = extra.source === 'WORKBOOK'
  return testDb.stagedCheck.create({
    data: {
      source: workbook ? 'WORKBOOK' : 'ACUMATICA',
      ...(workbook
        ? { sourceSheet: 'BPI RELEASED', sourceRow: Math.floor(Math.random() * 1e6) }
        : { acumaticaRef: `CV-T${Math.random().toString(36).slice(2, 9)}`, acumaticaTenant: 'GOLIVE' }),
      reason: 'NO_CHECK_NUMBER', impliedStatus: 'SIGNATURE_PENDING',
      statedCheckRef, cashAccountCode, amount: '500.00', currency: 'PHP', payeeName: 'HENKEL',
      apvNumbers: [], poNumbers: [], conflictingCompanies: [],
      ...(extra.promotedCheckId ? { promotedCheckId: extra.promotedCheckId as string } : {}),
    },
  })
}

describe('listNumberingAccounts — staged dotted re-uses', () => {
  it('joins a dotted staged payment to its check book as a STAGED line', async () => {
    const first = await acuCheck({ checkNumber: '1000' })
    const book = await bookFor(first)
    await inBook(book, { checkNumber: '1003' })
    await stage(book.code, '1001.')
    const [a] = await listNumberingAccounts(testDb, {})
    const kinds = a.series.entries.map((e) => (e.kind === 'MISSING' ? `M${e.from}` : e.kind === 'STAGED' ? `S${e.number}` : e.cheque.checkNumber))
    expect(kinds).toEqual(['1000', 'S1001', 'M1002', '1003'])
    expect(a.series.summary.staged).toBe(1)
    const s = a.series.entries.find((e) => e.kind === 'STAGED')
    expect(s?.kind === 'STAGED' && s.staged.amount).toBe('500.00')
  })

  it('ignores a promoted row, a row without a dot, a WORKBOOK row, an unknown check book and a cash-account code', async () => {
    const first = await acuCheck({ checkNumber: '2000' })
    const book = await bookFor(first)
    await inBook(book, { checkNumber: '2006' })
    const acc = await testDb.cashAccount.findUniqueOrThrow({ where: { id: first.cashAccountId! } })
    await stage(book.code, '2001.', { promotedCheckId: first.id })
    await stage(book.code, '2002')
    await stage(book.code, '2003.', { source: 'WORKBOOK' })
    await stage('NO SUCH BOOK', '2004.')
    await stage(acc.code, '2005.')
    const [a, ...rest] = await listNumberingAccounts(testDb, {})
    expect(rest).toHaveLength(0)
    expect(a.series.summary.staged).toBe(0)
    expect(a.series.summary.missingNumbers).toBe('5')
  })

  it('a check book with only staged numbers still appears', async () => {
    const other = await acuCheck({ checkNumber: '1' })
    await bookFor(other)
    const bank = await testDb.bank.create({ data: { code: `B${Math.random().toString(36).slice(2, 7)}`, name: 'BPI' } })
    const empty = await testDb.checkBook.create({ data: { code: 'EMPTY-BOOK', bankId: bank.id, companyId: other.companyId } })
    await stage('EMPTY-BOOK', '30.')
    const out = await listNumberingAccounts(testDb, {})
    const e = out.find((x) => x.accountId === empty.id)
    expect(e?.series.summary).toMatchObject({ first: '30', last: '30', held: 0, staged: 1 })
    // No cheques, so no company: the book's own reference company is not shown (spec §E).
    expect(e?.company).toBe('')
  })

  it('honours the company and check-book filters for staged rows', async () => {
    const a = await acuCheck({ checkNumber: '10' })
    const b = await acuCheck({ checkNumber: '20' })
    const bookA = await bookFor(a)
    const bookB = await bookFor(b)
    await stage(bookA.code, '11.')
    const onlyB = await listNumberingAccounts(testDb, { companyId: b.companyId })
    expect(onlyB.flatMap((x) => x.series.entries).some((e) => e.kind === 'STAGED')).toBe(false)
    const forA = await listNumberingAccounts(testDb, { companyId: a.companyId })
    expect(forA.flatMap((x) => x.series.entries).some((e) => e.kind === 'STAGED')).toBe(true)
    const forBookA = await listNumberingAccounts(testDb, { checkBookId: bookA.id })
    expect(forBookA.flatMap((x) => x.series.entries).some((e) => e.kind === 'STAGED')).toBe(true)
    const onlyBookB = await listNumberingAccounts(testDb, { checkBookId: bookB.id })
    expect(onlyBookB.flatMap((x) => x.series.entries).some((e) => e.kind === 'STAGED')).toBe(false)
  })
})

describe('countChequesWithoutCheckBook', () => {
  it('counts checks with no check book, narrowed by the check\'s company', async () => {
    const a = await acuCheck({ checkNumber: '1' })
    const b = await acuCheck({ checkNumber: '2' })
    await bookFor(b)
    expect(await countChequesWithoutCheckBook(testDb, {})).toBe(1)
    expect(await countChequesWithoutCheckBook(testDb, { companyId: a.companyId })).toBe(1)
    const other = await acuCheck({ checkNumber: '3' })
    await bookFor(other)
    expect(await countChequesWithoutCheckBook(testDb, { companyId: other.companyId })).toBe(0)
  })
})

describe('only Acumatica checks (spec §G2)', () => {
  it('a register-only check in a book is left out of the series; each check carries its CV', async () => {
    const first = await acuCheck({ checkNumber: '100' })
    const book = await bookFor(first)
    await inBook(book, { checkNumber: '101' }, true) // register-only: no Acumatica payment
    await inBook(book, { checkNumber: '102' })
    const [acc, ...rest] = await listNumberingAccounts(testDb, {})
    expect(rest).toHaveLength(0)
    expect(acc.series.summary).toMatchObject({ first: '100', last: '102', held: 2, missingNumbers: '1' })
    const e = acc.series.entries[0]
    expect(e.kind === 'CHECK' && e.cheque.cv).toBe(first.acumaticaPaymentId)
  })

  it('a book holding only register-only checks is not shown', async () => {
    const reg = await makeCheck({ checkNumber: '7' })
    await bookFor(reg)
    expect(await listNumberingAccounts(testDb, {})).toEqual([])
  })

  it('company book selection ignores register-only checks', async () => {
    const acu = await acuCheck({ checkNumber: '1' })
    const book = await bookFor(acu)
    const reg = await inBook(book, { checkNumber: '2' }, true) // its own company, register-only
    expect(await listNumberingAccounts(testDb, { companyId: reg.companyId })).toEqual([])
    expect((await listNumberingAccounts(testDb, { companyId: acu.companyId })).map((x) => x.accountId)).toEqual([book.id])
  })

  it('countRegisterOnlyCheques counts checks with no Acumatica payment, by company; non-checks are not counted', async () => {
    const reg = await makeCheck({ checkNumber: '1' })
    await bookFor(reg)
    await makeCheck({ checkNumber: '2' })
    await makeCheck({ checkNumber: '3', isCheque: false })
    const acu = await acuCheck({ checkNumber: '4' })
    expect(await countRegisterOnlyCheques(testDb, {})).toBe(2)
    expect(await countRegisterOnlyCheques(testDb, { companyId: reg.companyId })).toBe(1)
    expect(await countRegisterOnlyCheques(testDb, { companyId: acu.companyId })).toBe(0)
  })

  it('countChequesWithoutCheckBook counts only Acumatica checks', async () => {
    await makeCheck({ checkNumber: '1' }) // register-only, no book
    await acuCheck({ checkNumber: '2' })
    expect(await countChequesWithoutCheckBook(testDb, {})).toBe(1)
  })
})

describe('listCheckBookOptions', () => {
  it('lists every check book by code with its bank code', async () => {
    const a = await acuCheck({ checkNumber: '1' })
    const b = await acuCheck({ checkNumber: '2' })
    const bookA = await bookFor(a, 'ZZZ-BOOK')
    const bookB = await bookFor(b, 'AAA-BOOK')
    const bankA = await testDb.bank.findUniqueOrThrow({ where: { id: bookA.bankId } })
    const out = await listCheckBookOptions(testDb)
    expect(out.map((o) => o.id)).toEqual([bookB.id, bookA.id])
    expect(out[1]).toEqual({ id: bookA.id, code: 'ZZZ-BOOK', bankCode: bankA.code })
  })
})

describe('NO CHECK BOOK (spec §I): an Acumatica check with no book is shown where its number falls', () => {
  it('is placed in the book whose sequence spans its number, tagged with its cash account, and still counted as having no book', async () => {
    const first = await acuCheck({ checkNumber: '100' })
    const book = await bookFor(first)
    await inBook(book, { checkNumber: '104' })
    const payroll = await acuCheck({ checkNumber: '102', status: 'SIGNED' }) // a cash account, no book
    const code = (await testDb.cashAccount.findUniqueOrThrow({ where: { id: payroll.cashAccountId! } })).code
    const [acc, ...rest] = await listNumberingAccounts(testDb, {})
    expect(rest).toHaveLength(0)
    const shape = acc.series.entries.map((e) => (e.kind === 'CHECK' ? `${e.cheque.checkNumber}${e.noBook ? '*' : ''}` : e.kind === 'MISSING' ? `M${e.from}` : 'S'))
    expect(shape).toEqual(['100', 'M101', '102*', 'M103', '104'])
    expect(acc.series.entries[2]).toMatchObject({ kind: 'CHECK', noBook: true, cheque: { id: payroll.id, cashAccount: code, status: 'SIGNED' } })
    expect(acc.series.summary).toMatchObject({ held: 2, noBook: 1, missingNumbers: '2' })
    expect(acc.lines[2]).toMatchObject({ kind: 'CHECK', noBook: true })
    expect(await countChequesWithoutCheckBook(testDb, {})).toBe(1)
  })

  it('outside every book\'s sequence it is in no series; in two books\' sequences it is in both', async () => {
    const a = await acuCheck({ checkNumber: '100' })
    const bookA = await bookFor(a, 'AAA-A')
    await inBook(bookA, { checkNumber: '104' })
    const b = await acuCheck({ checkNumber: '101' })
    const bookB = await bookFor(b, 'BBB-B')
    await inBook(bookB, { checkNumber: '105' })
    const inside = await acuCheck({ checkNumber: '102' })
    await acuCheck({ checkNumber: '500' }) // outside both
    const out = await listNumberingAccounts(testDb, {})
    expect(out.map((x) => x.account)).toEqual(['AAA-A', 'BBB-B'])
    for (const acc of out) {
      const placed = acc.series.entries.filter((e) => e.kind === 'CHECK' && e.noBook)
      expect(placed.map((e) => e.kind === 'CHECK' && e.cheque.id)).toEqual([inside.id])
    }
    expect(await countChequesWithoutCheckBook(testDb, {})).toBe(2)
  })

  it('is placed whatever its company: the company filter selects books, and a book is shown whole', async () => {
    const a = await acuCheck({ checkNumber: '100' })
    const book = await bookFor(a)
    await inBook(book, { checkNumber: '104' })
    const otherCompany = await acuCheck({ checkNumber: '102' }) // its own company, no book
    const out = await listNumberingAccounts(testDb, { companyId: a.companyId })
    expect(out.map((x) => x.accountId)).toEqual([book.id])
    expect(out[0].series.entries.filter((e) => e.kind === 'CHECK' && e.noBook).map((e) => e.kind === 'CHECK' && e.cheque.id)).toEqual([otherCompany.id])
    // A register-only check with no book is never placed (spec §G2).
    await makeCheck({ checkNumber: '103' })
    expect((await listNumberingAccounts(testDb, {}))[0].series.summary).toMatchObject({ noBook: 1, missingNumbers: '2' })
  })
})
