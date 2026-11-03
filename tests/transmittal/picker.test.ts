import { describe, it, expect } from 'vitest'
import { applyKit } from '@/lib/table-kit/match'
import { byStatus, pickColumns, pickValue, PICK_COLUMNS, type TransmittalCandidate } from '@/lib/transmittal-picker'

const row = (o: Partial<TransmittalCandidate>): TransmittalCandidate => ({
  id: o.checkNumber ?? 'x', checkNumber: '1', cashAccount: 'BPI-S-4636', poNumber: '', voucher: '', payee: 'ACME',
  amount: '100.00', currency: 'PHP', status: 'SIGNED', company: 'STK', ...o,
})
const ROWS = [
  row({ checkNumber: '1791406000', payee: 'Save Plus', amount: '180521.15', voucher: 'AP-A1015281', poNumber: '23X09-0341' }),
  row({ checkNumber: '600033188', payee: 'PLDT, Inc.', amount: '8960.00', company: 'HAMFI', status: 'SIGNATURE_PENDING' }),
  row({ checkNumber: '1790405938', payee: 'Garisons Enterprise', amount: '3928.57' }),
  row({ checkNumber: '1791259540', payee: 'Starkson Packaging', amount: null }),
  row({ checkNumber: '1700000001', payee: 'Old Release', amount: '10.00', status: 'RELEASED' }),
]
const ids = (rs: readonly TransmittalCandidate[]) => rs.map((r) => r.checkNumber)
const cols = pickColumns(['HAMFI', 'STK'])

describe('byStatus', () => {
  it('ALL is pending + signed; RELEASED only on its own choice', () => {
    expect(ids(byStatus(ROWS, 'ALL'))).toEqual(['1791406000', '600033188', '1790405938', '1791259540'])
    expect(ids(byStatus(ROWS, 'RELEASED'))).toEqual(['1700000001'])
    expect(ids(byStatus(ROWS, 'SIGNATURE_PENDING'))).toEqual(['600033188'])
  })
})

describe('pickColumns', () => {
  it('describes every column; company is a dropdown, amount a range, status filtered above the table', () => {
    expect(cols.map((c) => c.key)).toEqual(['checkNumber', 'cashAccount', 'poNumber', 'voucher', 'payee', 'amount', 'company', 'status'])
    expect(new Set(cols.map((c) => c.key))).toEqual(new Set(PICK_COLUMNS))
    expect(cols.find((c) => c.key === 'company')!.options).toEqual([{ value: 'HAMFI', label: 'HAMFI' }, { value: 'STK', label: 'STK' }])
    expect(cols.find((c) => c.key === 'amount')!.kind).toBe('amount')
    expect(cols.find((c) => c.key === 'status')!.noFilter).toBe(true)
  })
})

describe('the picker through the kit', () => {
  const pick = (filters: Record<string, string>, sort: { key: string; dir: 'asc' | 'desc' } | null = null) =>
    ids(applyKit(byStatus(ROWS, 'ALL'), cols, pickValue, filters, sort))

  it('text is contains, company exact, amount a centavo range excluding no-amount rows', () => {
    expect(pick({ payee: 'save' })).toEqual(['1791406000'])
    expect(pick({ company: '=HAMFI' })).toEqual(['600033188'])
    expect(pick({ amount: '~between:3,000:10000' })).toEqual(['600033188', '1790405938'])
  })

  it('an unreadable amount matches nothing', () => {
    expect(pick({ amount: '~ge:12x' })).toEqual([])
  })

  it('orders check numbers numerically and amounts by value, a missing amount last', () => {
    expect(pick({}, { key: 'checkNumber', dir: 'asc' })).toEqual(['600033188', '1790405938', '1791259540', '1791406000'])
    expect(pick({}, { key: 'amount', dir: 'desc' })).toEqual(['1791406000', '600033188', '1790405938', '1791259540'])
  })
})
