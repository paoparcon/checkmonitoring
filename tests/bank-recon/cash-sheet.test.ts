import { describe, it, expect } from 'vitest'
import { readCashSheet, accountNumberOf, cleanLabel, numberToMoney, columnLetter, type SheetGrid } from '@/lib/bank-recon/cash-sheet'

const d = (day: string) => new Date(`${day}T00:00:00.000Z`)
const HEADER = ['Company', 'Bank Account', 'Account', 'Type', 'Description', 'FS Classification', d('2026-10-30'), d('2026-09-30')]

function grid(rows: unknown[][], name = 'CASH'): SheetGrid[] {
  return [{ name: 'PCF OCT 2026', rows: [['x']] }, { name, rows: [HEADER, ...rows] }]
}

describe('the pieces', () => {
  it('reads an account number out of a label, hyphens or not, and none out of a fund', () => {
    expect(accountNumberOf('BDO A1+ (104260161914)')).toBe('104260161914')
    expect(accountNumberOf('BPI STARKSON (3373-1746-36)')).toBe('3373174636')
    expect(accountNumberOf('A1+ PAPER AND PLASTIC 179-7-17963904-8')).toBe('1797179639048')
    expect(accountNumberOf('Gcash 09452905923')).toBe('09452905923')
    expect(accountNumberOf('Petty Cash Fund')).toBeNull()
    expect(accountNumberOf('A1+ 2026')).toBeNull()
  })

  it('flattens a label: Excel carriage returns and line breaks become one space', () => {
    expect(cleanLabel('MBTC STARKSON _x000D_\n(179-7-17960112-1)')).toBe('MBTC STARKSON (179-7-17960112-1)')
    expect(cleanLabel({ richText: [{ text: 'BPI ' }, { text: 'A1+' }] })).toBe('BPI A1+')
    expect(cleanLabel(null)).toBe('')
  })

  it('turns a cell double into two-decimal money text, and refuses what is not an amount', () => {
    expect(numberToMoney(2350586.0000004675)).toBe('2350586.00')
    expect(numberToMoney(169996.55999999537)).toBe('169996.56')
    expect(numberToMoney(1.163513729807164e-12)).toBe('0.00')
    expect(numberToMoney(-0.001)).toBe('0.00')
    expect(numberToMoney(-12.345)).toBe('-12.35')
    expect(numberToMoney(Number.NaN)).toBeNull()
    expect(numberToMoney(1e17)).toBeNull()
  })

  it('names columns as Excel does', () => {
    expect([0, 6, 25, 26, 33].map(columnLetter)).toEqual(['A', 'G', 'Z', 'AA', 'AH'])
  })
})

describe('readCashSheet', () => {
  it('reads one line per account and one balance per dated column, with the cell each came from', () => {
    const read = readCashSheet(grid([
      ['A1', 'MBTC A1+ \n(1797179604155)', 11120120, 'Asset', 'CIB MBTC - 179-7-179604155 - PHP', 'Cash and cash equivalents', 19467.00000019226, 3037757.6400001906],
      ['STARKSON', 'BPI STARKSON \n(3374044833)', 11120070, 'Asset', 'CIB BPI - 3374-0448-33 - USD', 'Cash and cash equivalents', 6304752.71999996, null],
    ]))
    if (!read.ok) throw new Error(read.message)
    expect(read.sheet).toBe('CASH')
    expect(read.days).toEqual(['2026-10-30', '2026-09-30'])
    expect(read.accounts).toEqual([
      {
        key: 'ACCT:1797179604155', label: 'MBTC A1+ (1797179604155)', companyLabel: 'A1', glAccount: '11120120',
        description: 'CIB MBTC - 179-7-179604155 - PHP', accountNumber: '1797179604155', currency: 'PHP', row: 2,
        balances: [{ day: '2026-10-30', amount: '19467.00', cell: 'G2' }, { day: '2026-09-30', amount: '3037757.64', cell: 'H2' }],
      },
      {
        key: 'ACCT:3374044833', label: 'BPI STARKSON (3374044833)', companyLabel: 'STARKSON', glAccount: '11120070',
        description: 'CIB BPI - 3374-0448-33 - USD', accountNumber: '3374044833', currency: 'USD', row: 3,
        balances: [{ day: '2026-10-30', amount: '6304752.72', cell: 'G3' }],
      },
    ])
    expect(read.problems).toEqual([])
  })

  it('a blank cell is no balance; a zero is a balance of zero', () => {
    const read = readCashSheet(grid([['A1', 'BPI A1+ \n(33731790-18)', 1, 'Asset', 'CIB BPI', 'x', 0, null]]))
    if (!read.ok) throw new Error(read.message)
    expect(read.accounts[0]!.balances).toEqual([{ day: '2026-10-30', amount: '0.00', cell: 'G2' }])
  })

  it('keys a fund with no account number by its company and name, so two petty cash funds stay two', () => {
    const read = readCashSheet(grid([
      ['A1', null, 11110020, 'Asset', 'Petty Cash Fund', 'x', 1, 2],
      ['STARKSON', null, 11110020, 'Asset', 'Petty Cash Fund', 'x', 3, 4],
    ]))
    if (!read.ok) throw new Error(read.message)
    expect(read.accounts.map((a) => a.key)).toEqual(['FUND:A1:PETTY CASH FUND', 'FUND:STARKSON:PETTY CASH FUND'])
    expect(read.accounts.map((a) => a.accountNumber)).toEqual([null, null])
  })

  it('takes the account number from the BANK ACCOUNT cell even when the description writes another', () => {
    const read = readCashSheet(grid([['A1', 'MBTC A1+ \n(1793179351588)', 11120230, 'Asset', 'CIB MBTC - 3179-3151588 PHP', 'x', 5, 6]]))
    if (!read.ok) throw new Error(read.message)
    expect(read.accounts[0]!.accountNumber).toBe('1793179351588')
  })

  it('leaves out BOTH of two lines that name the same account, and says which rows', () => {
    const read = readCashSheet(grid([
      ['A1', 'BDO A1+ (010-718003838)', 1, 'Asset', 'a', 'x', 10, 10],
      ['A1', 'BDO A1 PLUS (010718003838)', 1, 'Asset', 'b', 'x', 20, 20],
      ['A1', 'BPI A1+ (3374044825)', 1, 'Asset', 'c', 'x', 30, 30],
    ]))
    if (!read.ok) throw new Error(read.message)
    expect(read.accounts.map((a) => a.key)).toEqual(['ACCT:3374044825'])
    expect(read.problems).toEqual(['Rows 2 and 3 name the same account (BDO A1+ (010-718003838)) — neither was read.'])
  })

  it('names a cell that is not a number and skips only that cell', () => {
    const read = readCashSheet(grid([['A1', 'BPI A1+ (3374044825)', 1, 'Asset', 'c', 'x', 'closed', 12.5]]))
    if (!read.ok) throw new Error(read.message)
    expect(read.accounts[0]!.balances).toEqual([{ day: '2026-09-30', amount: '12.50', cell: 'H2' }])
    expect(read.problems).toEqual(['CASH!G2 (BPI A1+ (3374044825), 2026-10-30) does not hold a number — skipped.'])
  })

  it('reads a formula cell by its result', () => {
    const read = readCashSheet(grid([['A1', 'BPI A1+ (3374044825)', 1, 'Asset', 'c', 'x', { formula: 'A1*2', result: 99.999 }, null]]))
    if (!read.ok) throw new Error(read.message)
    expect(read.accounts[0]!.balances).toEqual([{ day: '2026-10-30', amount: '100.00', cell: 'G2' }])
  })

  it("compares the sheet's own total row with the lines read, per day", () => {
    const read = readCashSheet(grid([
      ['A1', 'BPI A1+ (3374044825)', 1, 'Asset', 'c', 'x', 100.25, 50],
      ['A1', 'BDO A1+ (010-718003838)', 1, 'Asset', 'c', 'x', 200.5, 60],
      [],
      [null, null, null, null, null, null, { formula: 'SUM(G2:G4)', result: 300.75 }, 999],
    ]))
    if (!read.ok) throw new Error(read.message)
    expect(read.totals).toEqual([
      { day: '2026-10-30', sheetTotal: '300.75', linesTotal: '300.75', agrees: true },
      { day: '2026-09-30', sheetTotal: '999.00', linesTotal: '110.00', agrees: false },
    ])
    // The total row is not an account.
    expect(read.accounts).toHaveLength(2)
  })

  it('refuses a workbook with no CASH sheet, naming the sheets it has', () => {
    const read = readCashSheet([{ name: 'LOCAL', rows: [] }, { name: 'BROKERS', rows: [] }])
    expect(read).toEqual({ ok: false, message: 'This workbook has no sheet named CASH (its sheets: LOCAL, BROKERS). Upload the monthly Cash workbook.' })
  })

  it('finds the CASH sheet whatever its case or padding', () => {
    expect(readCashSheet(grid([['A1', 'BPI A1+ (3374044825)', 1, 'Asset', 'c', 'x', 1, 2]], ' Cash ')).ok).toBe(true)
  })

  it('refuses a CASH sheet with no header, and one with two columns for the same day', () => {
    expect(readCashSheet([{ name: 'CASH', rows: [['a', 'b'], ['c', 'd']] }]).ok).toBe(false)
    const twice = readCashSheet([{ name: 'CASH', rows: [['Company', 'Bank Account', 'Account', 'Type', 'Description', 'x', d('2026-10-30'), d('2026-10-30')]] }])
    expect(twice).toEqual({ ok: false, message: 'The CASH sheet has two columns dated 2026-10-30. Nothing was read — one day cannot have two balances.' })
  })
})
