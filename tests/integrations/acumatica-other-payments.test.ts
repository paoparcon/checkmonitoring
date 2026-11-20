import { describe, it, expect } from 'vitest'
import {
  OTHER_PAYMENT_METHODS, collapseOtherPayments, mapOtherPayment, methodLabel, otherPaymentsFilter,
} from '@/lib/integrations/acumatica/other-payments'

const feedRow = (o: Record<string, unknown> = {}) => ({
  Type: 'Payment', ReferenceNbr: 'CV-ST020001', Vendor: 'V0001', VendorName: 'SHANGHAI PAPER CO', Status: 'Closed',
  PaymentDate: '2026-05-12T00:00:00', Description: 'TT payment', PaymentRef: 'AP-ST040001 AP-ST040002',
  PaymentAmount: 12345.6, Balance: 0, Currency: 'usd', CashAccount: 'BPI-S-4833', PaymentMethod: 'TT',
  Branch: 'ST        ', LastModifiedOn: '2026-05-12T09:30:15', ...o,
})

describe('otherPaymentsFilter', () => {
  it('asks for the four methods dated 2026 onward, and no check method', () => {
    const f = otherPaymentsFilter()
    expect(f).toBe("PaymentDate ge datetime'2026-01-01T00:00:00' and (PaymentMethod eq 'TT' or PaymentMethod eq 'LC' or PaymentMethod eq 'DP' or PaymentMethod eq 'MC')")
    expect(f).not.toContain("'CHK'")
    expect(f).not.toContain("'CASH'")
    expect([...OTHER_PAYMENT_METHODS]).toEqual(['TT', 'LC', 'DP', 'MC'])
  })
})

describe('mapOtherPayment', () => {
  it('keys on the payment document reference and keeps PaymentRef as stated', () => {
    const p = mapOtherPayment(feedRow(), 'GOLIVE')!
    expect(p.referenceNbr).toBe('CV-ST020001')
    expect(p.paymentRef).toBe('AP-ST040001 AP-ST040002')
    expect(p.method).toBe('TT')
    expect(p.tenant).toBe('GOLIVE')
  })

  it('keeps the amount a decimal string and upper-cases the currency', () => {
    const p = mapOtherPayment(feedRow({ PaymentAmount: '27980663.98' }), 'GOLIVE')!
    expect(p.amount).toBe('27980663.98')
    expect(p.currency).toBe('USD')
    expect(mapOtherPayment(feedRow({ PaymentAmount: 'n/a' }), 'GOLIVE')!.amount).toBeNull()
  })

  it('trims the padded branch and resolves the company per tenant', () => {
    expect(mapOtherPayment(feedRow(), 'GOLIVE')!.companyCode).toBe('STK')
    expect(mapOtherPayment(feedRow({ Branch: 'SH' }), 'GOLIVE')!.companyCode).toBe('SH')
    expect(mapOtherPayment(feedRow({ Branch: 'NOPE' }), 'GOLIVE')!.companyCode).toBeNull()
    expect(mapOtherPayment(feedRow({ Branch: 'NOPE' }), 'GOLIVE')!.branch).toBe('NOPE')
  })

  it('pins the stated wall-clock day', () => {
    const p = mapOtherPayment(feedRow(), 'GOLIVE')!
    expect(p.paymentDate!.toISOString()).toBe('2026-05-12T00:00:00.000Z')
    expect(p.lastModifiedOn!.toISOString()).toBe('2026-05-12T09:30:15.000Z')
  })

  it('flags a void from either the document type or the status', () => {
    expect(mapOtherPayment(feedRow({ Status: 'Voided' }), 'GOLIVE')!.voided).toBe(true)
    expect(mapOtherPayment(feedRow({ Type: 'Voided Payment' }), 'GOLIVE')!.voided).toBe(true)
    expect(mapOtherPayment(feedRow(), 'GOLIVE')!.voided).toBe(false)
  })

  it.each([
    ['a check', { PaymentMethod: 'CHK' }],
    ['a cash check', { PaymentMethod: 'CASH' }],
    ['a debit advice', { PaymentMethod: 'DEBIT ADV' }],
    ['no method', { PaymentMethod: null }],
    ['a refund', { Type: 'Refund' }],
    ['a debit adjustment', { Type: 'Debit Adj.' }],
    ['no reference', { ReferenceNbr: '  ' }],
  ])('returns null for %s', (_name, o) => {
    expect(mapOtherPayment(feedRow(o), 'GOLIVE')).toBeNull()
  })

  it('returns null for something that is not a row', () => {
    expect(mapOtherPayment(null, 'GOLIVE')).toBeNull()
    expect(mapOtherPayment([], 'GOLIVE')).toBeNull()
  })

  it.each(OTHER_PAYMENT_METHODS.map((m) => [m]))('maps method %s', (m) => {
    expect(mapOtherPayment(feedRow({ PaymentMethod: m.toLowerCase() }), 'GOLIVE')!.method).toBe(m)
  })
})

describe('collapseOtherPayments', () => {
  it('keeps the original of a void pair, flagged voided, with its own positive amount', () => {
    const original = mapOtherPayment(feedRow({ Status: 'Voided', PaymentAmount: '500.00' }), 'GOLIVE')!
    const reversal = mapOtherPayment(feedRow({ Type: 'Voided Payment', Status: 'Closed', PaymentAmount: '-500.00' }), 'GOLIVE')!
    const other = mapOtherPayment(feedRow({ ReferenceNbr: 'CV-ST020002' }), 'GOLIVE')!
    for (const order of [[original, reversal, other], [reversal, other, original]]) {
      const { payments, orphanReversals } = collapseOtherPayments(order)
      expect(orphanReversals).toBe(0)
      expect(payments).toHaveLength(2)
      const voided = payments.find((p) => p.referenceNbr === 'CV-ST020001')!
      expect(voided.voided).toBe(true)
      expect(voided.amount).toBe('500.00')
      expect(payments.find((p) => p.referenceNbr === 'CV-ST020002')!.voided).toBe(false)
    }
  })

  it('flags an original whose own status does not say voided when a reversal exists', () => {
    const original = mapOtherPayment(feedRow({ Status: 'Closed' }), 'GOLIVE')!
    const reversal = mapOtherPayment(feedRow({ Type: 'Voided Payment' }), 'GOLIVE')!
    expect(collapseOtherPayments([original, reversal]).payments[0].voided).toBe(true)
  })

  it('drops and counts a reversal with no original', () => {
    const reversal = mapOtherPayment(feedRow({ Type: 'Voided Payment', PaymentAmount: '-500.00' }), 'GOLIVE')!
    expect(collapseOtherPayments([reversal])).toEqual({ payments: [], orphanReversals: 1 })
  })
})

describe('methodLabel', () => {
  it('names the four and passes an unknown code through', () => {
    expect(methodLabel('TT')).toBe('TELEGRAPHIC TRANSFER')
    expect(methodLabel('LC')).toBe('LETTER OF CREDIT')
    expect(methodLabel('DP')).toBe('DP AT SIGHT')
    expect(methodLabel('MC')).toBe("MANAGER'S CHECK")
    expect(methodLabel('XYZ')).toBe('XYZ')
  })
})
