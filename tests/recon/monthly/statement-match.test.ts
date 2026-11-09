import { describe, it, expect } from 'vitest'
import { parseStatement, readAmount, readDate, csvRows } from '@/lib/recon/monthly/statement'
import { proposeMatches, type MatchCheck } from '@/lib/recon/monthly/match'

const d = (day: string) => new Date(`${day}T00:00:00.000Z`)

describe('readAmount / readDate', () => {
  it('reads the shapes banks write amounts in', () => {
    expect(readAmount(1234.5)).toBe('1234.50')
    expect(readAmount('1,234.56')).toBe('1234.56')
    expect(readAmount('(1,234.56)')).toBe('-1234.56')
    expect(readAmount('1,234.56 DR')).toBe('-1234.56')
    expect(readAmount('PHP 99.00 CR')).toBe('99.00')
    expect(readAmount('')).toBeNull()
    expect(readAmount('abc')).toBeNull()
  })

  it('reads a numeric date in the order that lands inside the month, and refuses one that cannot be settled', () => {
    expect(readDate('11/03/2026', '2026-11')).toEqual({ day: '2026-11-03' })
    expect(readDate('03/11/2026', '2026-11')).toEqual({ day: '2026-11-03' })
    expect(readDate('11/11/2026', '2026-11')).toEqual({ day: '2026-11-11' })
    expect(readDate('2026-11-07', '2026-11')).toEqual({ day: '2026-11-07' })
    expect(readDate('07-Nov-2026', '2026-11')).toEqual({ day: '2026-11-07' })
    expect(readDate('Nov 7, 2026', '2026-11')).toEqual({ day: '2026-11-07' })
    expect(readDate(d('2026-11-09'), '2026-11')).toEqual({ day: '2026-11-09' })
    expect(readDate('13/13/2026', '2026-11')).toMatchObject({ error: expect.any(String) })
  })
})

describe('parseStatement', () => {
  const sheet = {
    name: 'Sheet1',
    rows: [
      ['BPI STATEMENT OF ACCOUNT'],
      [],
      ['Date', 'Description', 'Check No.', 'Debit', 'Credit', 'Balance'],
      ['11/01/2026', 'BEGINNING BALANCE', '', '', '', '10,000.00'],
      ['11/03/2026', 'CHECK ENCASHMENT', '6000354602', '1,500.00', '', '8,500.00'],
      ['11/04/2026', 'DEPOSIT', '', '', '2,000.00', '10,500.00'],
      ['11/30/2026', 'SERVICE CHARGE', '', 50, '', '10,450.00'],
      ['10/31/2026', 'LAST MONTH', '', '5.00', '', ''],
      ['11/30/2026', 'ENDING BALANCE', '', '', '', '10,450.00'],
    ],
  }

  it('finds the header, reads lines, the balance rows, and reports what it left out', () => {
    const s = parseStatement([sheet], '2026-11')
    expect(s.sheetsRead).toEqual(['Sheet1'])
    expect(s.statementBeginning).toBe('10000.00')
    expect(s.statementEnding).toBe('10450.00')
    expect(s.lines.map((l) => [l.lineDay, l.debit, l.credit, l.checkNumber])).toEqual([
      ['2026-11-03', '1500.00', null, '6000354602'],
      ['2026-11-04', null, '2000.00', null],
      ['2026-11-30', '50.00', null, null],
    ])
    expect(s.skipped).toEqual([{ place: 'row 8', reason: 'dated 2026-10-31, outside this month' }])
  })

  it('gives identical lines distinct fingerprints and the same file the same ones', () => {
    const twice = { name: 'S', rows: [['Date', 'Particulars', 'Amount'], ['2026-11-05', 'SC', '-10.00'], ['2026-11-05', 'SC', '-10.00']] }
    const a = parseStatement([twice], '2026-11')
    const b = parseStatement([twice], '2026-11')
    expect(a.lines).toHaveLength(2)
    expect(a.lines[0].debit).toBe('10.00')
    expect(a.lines[0].fingerprint).not.toBe(a.lines[1].fingerprint)
    expect(a.lines.map((l) => l.fingerprint)).toEqual(b.lines.map((l) => l.fingerprint))
  })

  it('skips a sheet with no statement header, by name', () => {
    expect(parseStatement([{ name: 'Notes', rows: [['hello']] }], '2026-11').sheetsSkipped).toEqual(['Notes'])
  })

  it('reads quoted CSV', () => {
    const rows = csvRows('Date,Description,Debit,Credit\n2026-11-02,"CHECK 123456, PAID","1,000.00",\n')
    expect(rows[1]).toEqual(['2026-11-02', 'CHECK 123456, PAID', '1,000.00', ''])
    const s = parseStatement([{ name: 'csv', rows }], '2026-11')
    expect(s.lines[0]).toMatchObject({ debit: '1000.00', description: 'CHECK 123456, PAID' })
  })
})

describe('proposeMatches', () => {
  const chk = (over: Partial<MatchCheck>): MatchCheck => ({
    id: 'c1', checkNumber: '6000354602', payee: 'HENKEL PHILIPPINES INC.', amount: '1500.00', currency: 'PHP',
    checkDate: d('2026-10-28'), releasedAt: null, clearingStatus: 'NONE', clearedDate: null, status: 'RELEASED',
    inAccount: true, accountCode: 'BPI-S-4636', ...over,
  })
  const l = (over: object) => ({ lineDay: '2026-11-03', description: 'CHECK ENCASHMENT', reference: null, checkNumber: '6000354602', debit: '1500.00', credit: null, ...over })

  it('auto-matches a check by number, amount and date, once', () => {
    const [a, b] = proposeMatches([l({}), l({})], [chk({})], [], 'PHP')
    expect(a).toMatchObject({ kind: 'CHECK', method: 'AUTO', checkId: 'c1', alreadyCleared: false })
    expect(b).toMatchObject({ kind: 'UNIDENTIFIED_DEBIT', method: null, suggestedCheckId: 'c1' })
  })

  it('finds the number in the description and ignores leading zeros', () => {
    const [a] = proposeMatches([l({ checkNumber: null, description: 'CHK NO 006000354602 CLEARING' })], [chk({})], [], 'PHP')
    expect(a.kind).toBe('CHECK')
  })

  it('suggests but does not match on a different amount, a check of another account, a not-released check or a line before the check date', () => {
    expect(proposeMatches([l({ debit: '1500.01' })], [chk({})], [], 'PHP')[0]).toMatchObject({ kind: 'UNIDENTIFIED_DEBIT', suggestedCheckId: 'c1' })
    expect(proposeMatches([l({})], [chk({ inAccount: false })], [], 'PHP')[0].note).toMatch(/BPI-S-4636/)
    expect(proposeMatches([l({})], [chk({ status: 'SIGNED' })], [], 'PHP')[0].method).toBeNull()
    expect(proposeMatches([l({ lineDay: '2026-10-01' })], [chk({})], [], 'PHP')[0].method).toBeNull()
    expect(proposeMatches([l({})], [chk({ clearingStatus: 'CLEARED', clearedDate: d('2026-10-30') })], [], 'PHP')[0].method).toBeNull()
  })

  it('links a check already cleared on the same day without clearing it again', () => {
    expect(proposeMatches([l({})], [chk({ clearingStatus: 'CLEARED', clearedDate: d('2026-11-03') })], [], 'PHP')[0])
      .toMatchObject({ kind: 'CHECK', alreadyCleared: true })
  })

  it('matches a book entry by direction, amount and a 10-day window; classifies charges and interest', () => {
    const entries = [{ id: 'e1', kind: 'DEPOSIT' as const, entryDay: '2026-11-01', amount: '2000.00', reference: 'OR-1' }]
    const [dep, late, sc, int, unk] = proposeMatches([
      { lineDay: '2026-11-04', description: 'DEPOSIT', reference: null, checkNumber: null, debit: null, credit: '2000.00' },
      { lineDay: '2026-11-25', description: 'DEPOSIT', reference: null, checkNumber: null, debit: null, credit: '2000.00' },
      { lineDay: '2026-11-30', description: 'SERVICE CHARGE', reference: null, checkNumber: null, debit: '50.00', credit: null },
      { lineDay: '2026-11-30', description: 'INTEREST EARNED', reference: null, checkNumber: null, debit: null, credit: '1.23' },
      { lineDay: '2026-11-30', description: 'FUND TRANSFER', reference: null, checkNumber: null, debit: '9.00', credit: null },
    ], [], entries, 'PHP')
    expect(dep).toMatchObject({ kind: 'BOOK_ENTRY', bookEntryId: 'e1' })
    expect(late.kind).toBe('UNIDENTIFIED_CREDIT')
    expect(sc.kind).toBe('BANK_CHARGE')
    expect(int.kind).toBe('BANK_CREDIT')
    expect(unk.kind).toBe('UNIDENTIFIED_DEBIT')
  })
})
