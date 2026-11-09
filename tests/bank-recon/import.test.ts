import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'
import { planCashImport, applyCashImport } from '@/lib/bank-recon/import'
import type { CashSheetAccount } from '@/lib/bank-recon/cash-sheet'

beforeEach(resetDb)

const line = (o: Partial<CashSheetAccount> & { key: string }): CashSheetAccount => ({
  label: o.key, companyLabel: 'A1', glAccount: '11120120', description: 'CIB', accountNumber: o.key.replace('ACCT:', ''),
  currency: 'PHP', row: 2, balances: [], ...o,
})
const read = (accounts: CashSheetAccount[]) => ({ sheet: 'CASH', days: ['2026-10-30', '2026-09-30'], accounts, problems: [], totals: [] })
const NOW = new Date('2026-11-09T06:00:00Z')

const MBTC = line({
  key: 'ACCT:1797179604155', label: 'MBTC A1+ (1797179604155)',
  balances: [{ day: '2026-10-30', amount: '19467.00', cell: 'G8' }, { day: '2026-09-30', amount: '3037757.64', cell: 'H8' }],
})

describe('planCashImport', () => {
  it('writes nothing, and calls every balance NEW on an empty store', async () => {
    const plan = await planCashImport(testDb, read([MBTC]), 'Cash OCT 2026.xlsx')
    expect(plan).toMatchObject({
      fileName: 'Cash OCT 2026.xlsx', sheet: 'CASH', accounts: 1, newAccounts: ['MBTC A1+ (1797179604155)'],
      created: 2, changed: [], same: 0,
      createdByDay: [{ day: '2026-10-30', count: 1 }, { day: '2026-09-30', count: 1 }],
    })
    expect(await testDb.cashLedgerAccount.count()).toBe(0)
    expect(await testDb.cashBalance.count()).toBe(0)
  })

  it('after an upload: the same file is all SAME, and a different figure is CHANGED with both shown', async () => {
    const user = await makeUser()
    await applyCashImport(testDb, read([MBTC]), { fileName: 'Cash OCT 2026.xlsx', userId: user.id, now: NOW })
    expect(await planCashImport(testDb, read([MBTC]), 'again.xlsx')).toMatchObject({ created: 0, changed: [], same: 2, newAccounts: [] })
    const edited = { ...MBTC, balances: [{ day: '2026-10-30', amount: '20000.00', cell: 'G8' }, { day: '2026-08-31', amount: '1.00', cell: 'I8' }] }
    const plan = await planCashImport(testDb, read([edited]), 'Cash NOV 2026.xlsx')
    expect(plan.created).toBe(1)
    expect(plan.changed).toEqual([{ key: 'ACCT:1797179604155', label: 'MBTC A1+ (1797179604155)', day: '2026-10-30', cell: 'G8', before: '19467.00', after: '20000.00' }])
  })
})

describe('applyCashImport', () => {
  it('creates the account and its balances with the cell each came from, and one audit row', async () => {
    const user = await makeUser()
    const summary = await applyCashImport(testDb, read([MBTC]), { fileName: 'Cash OCT 2026.xlsx', userId: user.id, now: NOW })
    expect(summary).toEqual({ accountsCreated: 1, created: 2, updated: 0, unchanged: 0 })
    const account = await testDb.cashLedgerAccount.findUniqueOrThrow({ where: { key: 'ACCT:1797179604155' }, include: { balances: { orderBy: { asOf: 'desc' } } } })
    expect(account).toMatchObject({ label: 'MBTC A1+ (1797179604155)', companyLabel: 'A1', accountNumber: '1797179604155', currency: 'PHP', position: 2 })
    expect(account.balances.map((b) => [b.asOf.toISOString().slice(0, 10), b.bankBalance!.toFixed(2), b.bankSource, b.bankRecordedById])).toEqual([
      ['2026-10-30', '19467.00', 'Cash OCT 2026.xlsx › CASH!G8', user.id],
      ['2026-09-30', '3037757.64', 'Cash OCT 2026.xlsx › CASH!H8', user.id],
    ])
    const audit = await testDb.auditLog.findMany({ where: { action: 'cash_balances_imported' } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ userId: user.id, actorType: 'USER', checkId: null })
    expect(audit[0]!.details).toMatchObject({ file: 'Cash OCT 2026.xlsx', created: 2, updated: 0, unchanged: 0, accountsCreated: 1, changes: [] })
  })

  it('is idempotent: the same file again writes no balance', async () => {
    const user = await makeUser()
    await applyCashImport(testDb, read([MBTC]), { fileName: 'a.xlsx', userId: user.id, now: NOW })
    const again = await applyCashImport(testDb, read([MBTC]), { fileName: 'a.xlsx', userId: user.id, now: NOW })
    expect(again).toEqual({ accountsCreated: 0, created: 0, updated: 0, unchanged: 2 })
    expect(await testDb.cashBalance.count()).toBe(2)
  })

  it('a changed figure replaces the bank balance, records before and after, and never touches the typed book figures', async () => {
    const user = await makeUser()
    await applyCashImport(testDb, read([MBTC]), { fileName: 'a.xlsx', userId: user.id, now: NOW })
    const account = await testDb.cashLedgerAccount.findFirstOrThrow()
    await testDb.cashBalance.update({
      where: { accountId_asOf: { accountId: account.id, asOf: new Date('2026-10-30T00:00:00Z') } },
      data: { bookBalance: '25000.00', depositsInTransit: '100.00', note: 'per ledger', bookRecordedById: user.id, bookRecordedAt: NOW },
    })
    const edited = { ...MBTC, label: 'MBTC A1 PLUS (1797179604155)', row: 9, balances: [{ day: '2026-10-30', amount: '20000.00', cell: 'G9' }] }
    const summary = await applyCashImport(testDb, read([edited]), { fileName: 'b.xlsx', userId: user.id, now: NOW })
    expect(summary).toEqual({ accountsCreated: 0, created: 0, updated: 1, unchanged: 0 })
    const row = await testDb.cashBalance.findUniqueOrThrow({ where: { accountId_asOf: { accountId: account.id, asOf: new Date('2026-10-30T00:00:00Z') } } })
    expect([row.bankBalance!.toFixed(2), row.bankSource, row.bookBalance!.toFixed(2), row.depositsInTransit!.toFixed(2), row.note, row.bookRecordedById])
      .toEqual(['20000.00', 'b.xlsx › CASH!G9', '25000.00', '100.00', 'per ledger', user.id])
    // The month absent from the newer file is still held; the wording follows the newer file.
    expect(await testDb.cashBalance.count()).toBe(2)
    expect(await testDb.cashLedgerAccount.findFirstOrThrow()).toMatchObject({ label: 'MBTC A1 PLUS (1797179604155)', position: 9 })
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'cash_balances_imported' }, orderBy: { createdAt: 'desc' } })
    expect((audit.details as { changes: unknown[] }).changes).toEqual([
      { key: 'ACCT:1797179604155', label: 'MBTC A1 PLUS (1797179604155)', day: '2026-10-30', cell: 'G9', before: '19467.00', after: '20000.00' },
    ])
  })

  it('a row holding only a typed book balance takes its bank balance as NEW, keeping what was typed', async () => {
    const user = await makeUser()
    const account = await testDb.cashLedgerAccount.create({ data: { key: MBTC.key, label: MBTC.label } })
    await testDb.cashBalance.create({ data: { accountId: account.id, asOf: new Date('2026-10-30T00:00:00Z'), bookBalance: '5.00' } })
    expect((await planCashImport(testDb, read([MBTC]), 'a.xlsx')).created).toBe(2)
    const summary = await applyCashImport(testDb, read([MBTC]), { fileName: 'a.xlsx', userId: user.id, now: NOW })
    expect(summary).toEqual({ accountsCreated: 0, created: 2, updated: 0, unchanged: 0 })
    const row = await testDb.cashBalance.findUniqueOrThrow({ where: { accountId_asOf: { accountId: account.id, asOf: new Date('2026-10-30T00:00:00Z') } } })
    expect([row.bankBalance!.toFixed(2), row.bookBalance!.toFixed(2)]).toEqual(['19467.00', '5.00'])
  })
})
