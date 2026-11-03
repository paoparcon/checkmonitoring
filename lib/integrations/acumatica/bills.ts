import type { AcumaticaTenant } from './companies'
import { naiveDate } from './map'

/**
 * Which AP vouchers a cheque pays, read from Acumatica.
 *
 * `AP-Checks and Payments` — the feed every cheque comes from — publishes no
 * bill reference, so since the register was retired (2026-09-10) no cheque
 * generated here carried an APV. `AP-PAYMENTS-WITH-BILLS` joins a payment to
 * the documents it settles, one row per application.
 *
 * THE JOIN IS THE PAYMENT'S OWN REFERENCE (the CV number), which is
 * `Check.acumaticaPaymentId`. Exact, unique, and blind to cheque numbers, which
 * repeat across companies. A voucher paid by two cheques appears on both.
 *
 * Only `CHK` applied to a `Bill`. Measured 2026-10-01: the payment side also
 * carries VCK (the reversal of a voided cheque), PPM, ADR, REF; the bill side
 * `Debit Adj.` and `PPM`. None of those is "the voucher this cheque pays".
 * `CHK` here is the DOCUMENT type (a Payment), not the payment method: a
 * Payment whose method is CASH — a check payable to cash, read by the payment
 * sync since 2026-10-23 — is `AdjgDocType = CHK` all the same (measured on
 * CV-ST021234, 2026-10-23), so its voucher links with no change here.
 *
 * The two tenants name the columns differently; filtering MANUFACTURING on a
 * Go-Live name is a 500. Pure.
 */

export const BILLS_FEED = 'AP-PAYMENTS-WITH-BILLS'

/**
 * The documents a cheque can pay: a Bill, or a PPM (prepayment request — what a
 * cargo, customs or brokerage cheque is drawn against). User ruling 2026-10-06:
 * link the PPM too (the 15 STK cheques `6000354281`… showed no APV and no PO).
 * `Debit Adj.` and the other payment types stay out.
 */
export const BILL_SIDE_TYPES: readonly string[] = ['Bill', 'PPM']

export const BILL_FEED_COLUMNS = {
  GOLIVE: { date: 'LastModifiedOn', paymentRef: 'AdjgRefNbr', paymentType: 'AdjgDocType', billRef: 'AdjdRefNbr', billType: 'AdjdDocType' },
  MANUFACTURING: { date: 'APAdjust_lastModifiedDateTime', paymentRef: 'ReferenceNbr', paymentType: 'AdjgDocType', billRef: 'ReferenceNbr_2', billType: 'DocumentType' },
} as const satisfies Record<AcumaticaTenant, Record<string, string>>

/** The same scope boundary as the payment sync (`SYNC_FROM_DATE` in lib/sync/run.ts). */
const IN_SCOPE_FROM = '2026-01-01T00:00:00'

const literal = (d: Date) => `datetime'${d.toISOString().slice(0, 19)}'`

export function billsSinceFilter(tenant: AcumaticaTenant, since: Date): string {
  return `${BILL_FEED_COLUMNS[tenant].date} ge ${literal(since)}`
}

export function billsInScopeFilter(tenant: AcumaticaTenant): string {
  return `${BILL_FEED_COLUMNS[tenant].date} ge datetime'${IN_SCOPE_FROM}'`
}

/**
 * The applications of ONE payment, by its own reference — the direct lookup the
 * BILLS run makes for a held check that still has no APV (2026-10-26; see
 * `lookUpApvLess` in `lib/sync/bills.ts`). The tenant's own column name: a
 * filter on the Go-Live name is a 500 on MANUFACTURING. An `eq` on this column
 * works on both (measured on CV-HF000161, Go-Live, 2026-10-26). A quote in the
 * reference is doubled, the OData literal escape.
 */
export function billsForPaymentFilter(tenant: AcumaticaTenant, paymentRef: string): string {
  return `${BILL_FEED_COLUMNS[tenant].paymentRef} eq '${paymentRef.replace(/'/g, "''")}'`
}

export function billFeedSelect(tenant: AcumaticaTenant): string[] {
  return Object.values(BILL_FEED_COLUMNS[tenant])
}

export type BillApplication = { paymentRef: string; voucher: string; lastModifiedOn: Date | null }

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function mapBillApplication(raw: unknown, tenant: AcumaticaTenant): BillApplication | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const c = BILL_FEED_COLUMNS[tenant]
  if (text(r[c.paymentType]) !== 'CHK' || !BILL_SIDE_TYPES.includes(text(r[c.billType]))) return null
  const paymentRef = text(r[c.paymentRef])
  const voucher = text(r[c.billRef]).toUpperCase()
  if (!paymentRef || !voucher) return null
  return { paymentRef, voucher, lastModifiedOn: naiveDate(r[c.date], { dayOnly: false }) }
}
