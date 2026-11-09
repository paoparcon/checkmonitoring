import { describe, it, expect } from 'vitest'
import { buildRecon, matchBooks, bookTail, bankOf, totalsOf, type ReconAccount, type ReconBook, type OutstandingByAccount } from '@/lib/bank-recon/recon'

const account = (o: Partial<ReconAccount> & { id: string }): ReconAccount => ({
  label: o.id, companyLabel: null, description: null, accountNumber: null, currency: 'PHP', position: 0,
  bankBalance: null, bankSource: null, bookBalance: null, depositsInTransit: null, note: null, ...o,
})
const oc = (accountId: string | null, account: string, count: number, total: string, currency = 'PHP'): OutstandingByAccount =>
  ({ accountId, account, count, totals: [{ currency, count, total }] })

const STK = account({ id: 'a-stk', label: 'BPI STARKSON (3373-1746-36)', accountNumber: '3373174636', position: 1 })
const A1 = account({ id: 'a-a1', label: 'MBTC A1+ (1797179604155)', accountNumber: '1797179604155', position: 2 })
const PP = account({ id: 'a-pp', label: 'A1+ PAPER AND PLASTIC 179-7-17963904-8', accountNumber: '1797179639048', position: 3 })
const BOOKS: ReconBook[] = [
  { id: 'b-4636', code: 'BPI-S-4636', bank: 'BPI' },
  { id: 'b-4155', code: 'MBT-A-4155', bank: 'MBTC' },
  { id: 'b-9048', code: 'MBT-A-9048', bank: 'MBTC' },
]

describe('matching a check book to its account', () => {
  it('reads the last four digits off a book code and the bank off a label', () => {
    expect(bookTail('BPI-S-4636')).toBe('4636')
    expect(bookTail('PAYROLL')).toBeNull()
    expect(bankOf('MBTC A1+ (1797179604155)')).toBe('MBTC')
    expect(bankOf('A1+ PAPER AND PLASTIC 179-7-17963904-8')).toBeNull()
  })

  it('matches each book to the one account ending in its four digits — a label naming no bank still matches', () => {
    const { byAccount, unmatchedBooks } = matchBooks([STK, A1, PP], BOOKS)
    expect(byAccount.get('a-stk')!.map((b) => b.code)).toEqual(['BPI-S-4636'])
    expect(byAccount.get('a-a1')!.map((b) => b.code)).toEqual(['MBT-A-4155'])
    expect(byAccount.get('a-pp')!.map((b) => b.code)).toEqual(['MBT-A-9048'])
    expect(unmatchedBooks).toEqual([])
  })

  it('gives two books to one account when both end in its digits', () => {
    const stpp = account({ id: 'a-stpp', label: 'BPI STARKSON PAPER AND PLASTIC (3371008879)', accountNumber: '3371008879' })
    const { byAccount } = matchBooks([stpp], [{ id: 'x', code: 'BPI-S-8879', bank: 'BPI' }, { id: 'y', code: 'BPI-A-8879', bank: 'BPI' }])
    expect(byAccount.get('a-stpp')!.map((b) => b.code)).toEqual(['BPI-S-8879', 'BPI-A-8879'])
  })

  it('matches nothing when two accounts end in the digits, when none does, or when the label names another bank', () => {
    const twin = account({ id: 'a-twin', label: 'BPI OTHER (9999-1746-36)', accountNumber: '9999174636' })
    expect(matchBooks([STK, twin], BOOKS.slice(0, 1)).unmatchedBooks.map((b) => b.code)).toEqual(['BPI-S-4636'])
    expect(matchBooks([A1], BOOKS.slice(0, 1)).unmatchedBooks.map((b) => b.code)).toEqual(['BPI-S-4636'])
    const bdo = account({ id: 'a-bdo', label: 'BDO STARKSON (0000004636)', accountNumber: '0000004636' })
    expect(matchBooks([bdo], BOOKS.slice(0, 1)).unmatchedBooks.map((b) => b.code)).toEqual(['BPI-S-4636'])
  })
})

describe('buildRecon — the arithmetic', () => {
  it('adjusted bank = bank + deposits in transit − outstanding checks; variance = adjusted − book', () => {
    const recon = buildRecon(
      [{ ...STK, bankBalance: '1200000.00', depositsInTransit: '50000.25', bookBalance: '1000000.00' }],
      BOOKS, [oc('b-4636', 'BPI-S-4636', 3, '250000.50')],
    )
    const [line] = recon.lines
    expect(line).toMatchObject({
      outstanding: { count: 3, total: '250000.50' }, adjustedBank: '999999.75', variance: '-0.25', ditAssumedNone: false,
    })
  })

  it('needs nothing typed for the adjusted balance: bank less the checks still out', () => {
    const recon = buildRecon([{ ...STK, bankBalance: '2350586.00' }], BOOKS, [oc('b-4636', 'BPI-S-4636', 55, '350586.00')])
    expect(recon.lines[0]).toMatchObject({ adjustedBank: '2000000.00', variance: null, ditAssumedNone: false })
  })

  it('goes negative when more is out than the bank holds — an overdraft waiting to happen is shown, not floored', () => {
    const recon = buildRecon([{ ...STK, bankBalance: '100.00' }], BOOKS, [oc('b-4636', 'BPI-S-4636', 2, '250.50')])
    expect(recon.lines[0]!.adjustedBank).toBe('-150.50')
  })

  it('is RECONCILED to the centavo — a variance of exactly 0.00', () => {
    const recon = buildRecon(
      [{ ...STK, bankBalance: '0.10', depositsInTransit: '0.30', bookBalance: '0.20' }],
      BOOKS, [oc('b-4636', 'BPI-S-4636', 1, '0.20')],
    )
    expect(recon.lines[0]!.variance).toBe('0.00')
    expect(recon.totals.reconciled).toBe(1)
  })

  it('what is not known is not a figure: no bank balance, no adjusted; no book balance, no variance', () => {
    const recon = buildRecon([{ ...STK, bookBalance: '5.00' }, { ...A1, bankBalance: '7.00' }], BOOKS, [])
    expect(recon.lines.map((l) => [l.adjustedBank, l.variance])).toEqual([[null, null], ['7.00', null]])
  })

  it('a deposit in transit nobody typed counts as none, and the line says so', () => {
    const recon = buildRecon([{ ...STK, bankBalance: '100.00', bookBalance: '110.00' }], BOOKS, [])
    expect(recon.lines[0]).toMatchObject({ adjustedBank: '100.00', variance: '-10.00', ditAssumedNone: true })
  })

  it('an account no check book draws on has no outstanding figure — not a zero', () => {
    const usd = account({ id: 'a-usd', label: 'BPI A1+ (3374044825)', accountNumber: '3374044825', currency: 'USD', bankBalance: '273489.44' })
    const recon = buildRecon([usd, { ...STK, bankBalance: '1.00' }], BOOKS, [])
    expect(recon.lines.find((l) => l.id === 'a-usd')).toMatchObject({ outstanding: null, adjustedBank: '273489.44' })
    expect(recon.lines.find((l) => l.id === 'a-stk')!.outstanding).toEqual({ count: 0, total: '0.00' })
  })

  it('lists outstanding checks whose account matches no line, and never adds them to a line', () => {
    const recon = buildRecon([{ ...STK, bankBalance: '1.00' }], BOOKS, [
      oc('b-4636', 'BPI-S-4636', 1, '10.00'), oc('payroll', 'PAYROLL', 4, '400.00'), oc(null, '(NO ACCOUNT)', 2, '20.00'), oc('b-4155', 'MBT-A-4155', 1, '5.00'),
    ])
    expect(recon.lines[0]!.outstanding).toEqual({ count: 1, total: '10.00' })
    expect(recon.unmatched).toEqual([
      { accountId: 'payroll', account: 'PAYROLL', count: 4, total: '400.00' },
      { accountId: null, account: '(NO ACCOUNT)', count: 2, total: '20.00' },
      { accountId: 'b-4155', account: 'MBT-A-4155', count: 1, total: '5.00' },
    ])
  })

  it('leaves a check that is not in pesos out of every figure and counts it', () => {
    const recon = buildRecon([{ ...STK, bankBalance: '1.00' }], BOOKS, [
      { accountId: 'b-4636', account: 'BPI-S-4636', count: 3, totals: [{ currency: 'PHP', count: 1, total: '10.00' }, { currency: 'USD', count: 2, total: '99.00' }] },
    ])
    expect(recon.lines[0]!.outstanding).toEqual({ count: 1, total: '10.00' })
    expect(recon.otherCurrencyChecks).toBe(2)
  })

  it('keeps the schedule order, and totals each column over what is known', () => {
    const recon = buildRecon([
      { ...A1, bankBalance: '300.00', bookBalance: '290.00', depositsInTransit: '5.00' },
      { ...STK, bankBalance: '100.00' },
    ], BOOKS, [oc('b-4636', 'BPI-S-4636', 2, '40.00'), oc('b-4155', 'MBT-A-4155', 1, '15.00')])
    expect(recon.lines.map((l) => l.id)).toEqual(['a-stk', 'a-a1'])
    expect(recon.totals).toEqual({
      accounts: 2, bankBalance: '400.00', depositsInTransit: '5.00', outstanding: '55.00', outstandingCount: 3,
      adjustedBank: '350.00', bookBalance: '290.00', bookTyped: 1, variance: '0.00', reconciled: 1,
    })
    expect(totalsOf(recon.lines.slice(0, 1)).bankBalance).toBe('100.00')
  })
})
