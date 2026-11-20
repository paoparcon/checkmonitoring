import type { PaymentRow } from '@/lib/payments/query'

/** One OTHER PAYMENTS row as the screen and the extract read it. */
export const paymentRow = (o: Partial<PaymentRow> = {}): PaymentRow => ({
  id: 'p1', tenant: 'GOLIVE', referenceNbr: 'CV-ST020001', method: 'TT', methodLabel: 'TELEGRAPHIC TRANSFER',
  marking: 'ON_PROCESS', voided: false, display: 'ON PROCESS', payee: 'SHANGHAI PAPER CO', vendorCode: 'V1',
  company: 'STK', branch: 'ST', currency: 'USD', amount: '1000.10', paymentDate: '2026-05-12', paymentRef: 'AP-ST040001',
  cashAccount: 'BPI-S-4833', acumaticaStatus: 'Balanced', description: null, processedDate: null, clearedDate: null,
  bankReference: null, remarks: null, markedBy: null, markedAt: null, ...o,
})
