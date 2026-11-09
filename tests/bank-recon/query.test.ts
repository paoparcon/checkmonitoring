import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { listBalanceDays, loadBankRecon } from '@/lib/bank-recon/query'

beforeEach(resetDb)

const day = (d: string) => new Date(`${d}T00:00:00Z`)

/** A released check on a check book named for the account ending 4636. */
async function releasedOnBook(checkNumber: string, amount: string, checkDate: string, code = 'BPI-S-4636') {
  const c = await makeCheck({ status: 'RELEASED', checkNumber, amount, checkDate: day(checkDate) })
  const bank = await testDb.bank.upsert({ where: { code: 'BPI' }, update: {}, create: { code: 'BPI', name: 'BPI' } })
  const book = await testDb.checkBook.upsert({ where: { code }, update: {}, create: { code, bankId: bank.id, companyId: c.companyId } })
  await testDb.check.update({ where: { id: c.id }, data: { cashAccountId: null, checkBookId: book.id } })
  return { check: c, book }
}

describe('listBalanceDays', () => {
  it('lists the days a bank balance is held for, newest first, with the count and peso total', async () => {
    const a = await testDb.cashLedgerAccount.create({ data: { key: 'ACCT:1', label: 'A' } })
    const b = await testDb.cashLedgerAccount.create({ data: { key: 'ACCT:2', label: 'B' } })
    await testDb.cashBalance.createMany({ data: [
      { accountId: a.id, asOf: day('2026-10-30'), bankBalance: '100.10' },
      { accountId: b.id, asOf: day('2026-10-30'), bankBalance: '200.20' },
      { accountId: a.id, asOf: day('2026-09-30'), bankBalance: '5.00' },
      // A typed book balance alone is not a bank balance day.
      { accountId: b.id, asOf: day('2026-11-05'), bookBalance: '9.00' },
    ] })
    expect(await listBalanceDays(testDb)).toEqual([
      { day: '2026-10-30', accounts: 2, total: '300.30' },
      { day: '2026-09-30', accounts: 1, total: '5.00' },
    ])
  })
})

describe('loadBankRecon', () => {
  it('adjusts the bank balance by the outstanding checks of the book named for the account, as of the day', async () => {
    const stk = await testDb.cashLedgerAccount.create({ data: { key: 'ACCT:3373174636', label: 'BPI STARKSON (3373-1746-36)', accountNumber: '3373174636', position: 1 } })
    await testDb.cashBalance.create({ data: { accountId: stk.id, asOf: day('2026-10-30'), bankBalance: '1350.00', bookBalance: '1000.00', depositsInTransit: '50.00' } })
    await releasedOnBook('1', '300.00', '2026-10-01')
    await releasedOnBook('2', '100.00', '2026-10-15')
    // Dated after the day: not yet presentable, not outstanding on it.
    await releasedOnBook('3', '999.00', '2026-11-03')
    // Cleared before the day: not outstanding.
    const { check } = await releasedOnBook('4', '77.00', '2026-10-02')
    await testDb.check.update({ where: { id: check.id }, data: { clearingStatus: 'CLEARED', clearedDate: day('2026-10-20') } })

    const { recon, silent } = await loadBankRecon(testDb, '2026-10-30')
    expect(silent).toBe(0)
    expect(recon.lines).toHaveLength(1)
    expect(recon.lines[0]).toMatchObject({
      label: 'BPI STARKSON (3373-1746-36)', bankBalance: '1350.00', depositsInTransit: '50.00',
      outstanding: { count: 2, total: '400.00' },
      adjustedBank: '1000.00', bookBalance: '1000.00', variance: '0.00',
    })
    expect(recon.lines[0]!.books.map((b) => b.code)).toEqual(['BPI-S-4636'])
    expect(recon.unmatched).toEqual([])
  })

  it('a clearing recorded later corrects an earlier day: cleared after the day is still outstanding on it', async () => {
    const stk = await testDb.cashLedgerAccount.create({ data: { key: 'ACCT:3373174636', label: 'BPI STARKSON (3373-1746-36)', accountNumber: '3373174636' } })
    await testDb.cashBalance.create({ data: { accountId: stk.id, asOf: day('2026-09-30'), bankBalance: '10.00' } })
    const { check } = await releasedOnBook('1', '300.00', '2026-09-10')
    await testDb.check.update({ where: { id: check.id }, data: { clearingStatus: 'CLEARED', clearedDate: day('2026-10-05') } })
    expect((await loadBankRecon(testDb, '2026-09-30')).recon.lines[0]!.outstanding).toEqual({ count: 1, total: '300.00' })
    expect((await loadBankRecon(testDb, '2026-10-30')).recon.lines).toEqual([])
  })

  it('shows an account with no figure on the day only when checks are outstanding on it, counts the silent ones, and lists checks in no account', async () => {
    await testDb.cashLedgerAccount.create({ data: { key: 'ACCT:3373174636', label: 'BPI STARKSON (3373-1746-36)', accountNumber: '3373174636', position: 1 } })
    const quiet = await testDb.cashLedgerAccount.create({ data: { key: 'ACCT:3374044825', label: 'BPI A1+ (3374044825)', accountNumber: '3374044825', position: 2 } })
    await testDb.cashBalance.create({ data: { accountId: quiet.id, asOf: day('2026-09-30'), bankBalance: '5.00' } })
    await releasedOnBook('1', '300.00', '2026-10-01')
    // On a register label, not a book: matches no line of the schedule.
    const loose = await makeCheck({ status: 'RELEASED', checkNumber: '9', amount: '40.00', checkDate: day('2026-10-01') })
    const { recon, silent } = await loadBankRecon(testDb, '2026-10-30')
    expect(recon.lines.map((l) => [l.label, l.bankBalance, l.outstanding])).toEqual([
      ['BPI STARKSON (3373-1746-36)', null, { count: 1, total: '300.00' }],
    ])
    expect(silent).toBe(1)
    expect(recon.unmatched).toEqual([{ accountId: loose.cashAccountId, account: expect.stringMatching(/^BPI STK /), count: 1, total: '40.00' }])
    expect(recon.totals).toMatchObject({ accounts: 1, bankBalance: '0.00', outstanding: '300.00', adjustedBank: '0.00', bookTyped: 0 })
  })
})
