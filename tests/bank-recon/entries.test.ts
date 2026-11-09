import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'
import { recordBookFigures, parseTypedMoney } from '@/lib/bank-recon/entries'

beforeEach(resetDb)

const NOW = new Date('2026-11-09T06:00:00Z')
const DAY = '2026-10-30'
const asOf = new Date(`${DAY}T00:00:00Z`)

describe('parseTypedMoney', () => {
  it('reads money as typed into two decimals, a blank as not known, and refuses the rest', () => {
    expect(parseTypedMoney('1,234,567.5', { allowNegative: false })).toBe('1234567.50')
    expect(parseTypedMoney(' 0 ', { allowNegative: false })).toBe('0.00')
    expect(parseTypedMoney('', { allowNegative: false })).toBeNull()
    expect(parseTypedMoney('-250.75', { allowNegative: true })).toBe('-250.75')
    expect(parseTypedMoney('-250.75', { allowNegative: false })).toBe('INVALID')
    expect(parseTypedMoney('1,5', { allowNegative: true })).toBe('INVALID')
    expect(parseTypedMoney('12.345', { allowNegative: true })).toBe('INVALID')
    expect(parseTypedMoney('abc', { allowNegative: true })).toBe('INVALID')
  })
})

describe('recordBookFigures', () => {
  const setup = async () => {
    const user = await makeUser()
    const account = await testDb.cashLedgerAccount.create({ data: { key: 'ACCT:1', label: 'BPI STARKSON (3373-1746-36)' } })
    return { user, account }
  }
  const save = (userId: string, entries: { accountId: string; bookBalance: string; depositsInTransit: string; note: string }[], asOfDay = DAY) =>
    recordBookFigures(testDb, { userId, asOfDay, todayDay: '2026-11-09', entries, now: NOW })

  it('saves the book balance, deposits in transit and note, with one audit row carrying before and after', async () => {
    const { user, account } = await setup()
    const done = await save(user.id, [{ accountId: account.id, bookBalance: '1,200,000.00', depositsInTransit: '50000.25', note: ' per general ledger ' }])
    expect(done).toEqual({ ok: true, results: [{ accountId: account.id, outcome: 'SAVED' }] })
    const row = await testDb.cashBalance.findUniqueOrThrow({ where: { accountId_asOf: { accountId: account.id, asOf } } })
    expect([row.bookBalance!.toFixed(2), row.depositsInTransit!.toFixed(2), row.note, row.bookRecordedById, row.bankBalance, row.bankRecordedById]).toEqual(['1200000.00', '50000.25', 'per general ledger', user.id, null, null])
    const audit = await testDb.auditLog.findMany({ where: { action: 'bank_recon_recorded' } })
    expect(audit).toHaveLength(1)
    expect(audit[0]!.details).toEqual({
      accountId: account.id, account: 'BPI STARKSON (3373-1746-36)', asOf: DAY,
      before: { bookBalance: null, depositsInTransit: null, note: null },
      after: { bookBalance: '1200000.00', depositsInTransit: '50000.25', note: 'per general ledger' },
    })
  })

  it('writes nothing for a row that is unchanged, and never touches the bank balance', async () => {
    const { user, account } = await setup()
    await testDb.cashBalance.create({ data: { accountId: account.id, asOf, bankBalance: '999.99', bankSource: 'f › CASH!G2' } })
    await save(user.id, [{ accountId: account.id, bookBalance: '10', depositsInTransit: '', note: '' }])
    const again = await save(user.id, [{ accountId: account.id, bookBalance: '10.00', depositsInTransit: '', note: '' }])
    expect(again).toEqual({ ok: true, results: [{ accountId: account.id, outcome: 'UNCHANGED' }] })
    expect(await testDb.auditLog.count({ where: { action: 'bank_recon_recorded' } })).toBe(1)
    const row = await testDb.cashBalance.findUniqueOrThrow({ where: { accountId_asOf: { accountId: account.id, asOf } } })
    expect([row.bankBalance!.toFixed(2), row.bankSource, row.bookBalance!.toFixed(2), row.depositsInTransit]).toEqual(['999.99', 'f › CASH!G2', '10.00', null])
  })

  it('a cleared box clears the figure — blank is not known, never zero', async () => {
    const { user, account } = await setup()
    await save(user.id, [{ accountId: account.id, bookBalance: '10', depositsInTransit: '5', note: 'x' }])
    await save(user.id, [{ accountId: account.id, bookBalance: '', depositsInTransit: '0', note: '' }])
    const row = await testDb.cashBalance.findUniqueOrThrow({ where: { accountId_asOf: { accountId: account.id, asOf } } })
    expect([row.bookBalance, row.depositsInTransit!.toFixed(2), row.note]).toEqual([null, '0.00', null])
  })

  it('refuses a row that is not an amount and still saves the others', async () => {
    const { user, account } = await setup()
    const other = await testDb.cashLedgerAccount.create({ data: { key: 'ACCT:2', label: 'MBTC A1+' } })
    const done = await save(user.id, [
      { accountId: account.id, bookBalance: '12,34', depositsInTransit: '', note: '' },
      { accountId: other.id, bookBalance: '7', depositsInTransit: '-1', note: '' },
      { accountId: 'no-such-account', bookBalance: '7', depositsInTransit: '', note: '' },
      { accountId: other.id, bookBalance: '-7.5', depositsInTransit: '', note: '' },
    ])
    if (!done.ok) throw new Error(done.message)
    expect(done.results.map((r) => r.outcome)).toEqual(['REFUSED', 'REFUSED', 'REFUSED', 'SAVED'])
    expect(await testDb.cashBalance.count()).toBe(1)
    expect((await testDb.cashBalance.findFirstOrThrow()).bookBalance!.toFixed(2)).toBe('-7.50')
  })

  it('refuses a day that is not real, and a day after today', async () => {
    const { user, account } = await setup()
    const entry = [{ accountId: account.id, bookBalance: '1', depositsInTransit: '', note: '' }]
    expect((await save(user.id, entry, '2026-02-30')).ok).toBe(false)
    expect(await save(user.id, entry, '2026-11-10')).toEqual({ ok: false, message: '2026-11-10 has not happened yet — there is nothing to reconcile.' })
    expect(await testDb.cashBalance.count()).toBe(0)
  })
})
