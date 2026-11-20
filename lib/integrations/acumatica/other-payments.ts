import { companyForBranch, type AcumaticaTenant } from './companies'
import { naiveDate } from './map'

/**
 * OTHER PAYMENTS: the payment methods that are not a check (user, 2026-11-20:
 * "we will also include payments on foreign suppliers in the monitoring and
 * other forms" - DP at sight, Letter of Credit, Manager's check, Telegraphic).
 *
 * Read from the same inquiry as the checks (`AP-Checks and Payments`) and
 * mapped HERE, not through `mapPayment`: that mapper feeds `upsertCheck`,
 * which keys on a check number, and none of these has one - a telegraphic
 * transfer's PaymentRef holds the bill numbers it pays. These are keyed by the
 * payment document's own reference (`ReferenceNbr`, the CV number).
 *
 * Measured read-only on 2026-11-20 over the 2026 feed:
 *
 *     Go-Live        TT 1,681 (CNY 985, USD 690, PHP 6)   MC 1   LC 0   DP 0
 *     Manufacturing  none of the four
 *
 * LC (3) and DP (37) exist only on 2024-2025 payments. DEBIT ADV and BT are
 * not on the user's list and are not read.
 *
 * Pure: no database, no network, no clock.
 */

/** Acumatica's PaymentMethod codes, in the order the screen and the file list them. */
export const OTHER_PAYMENT_METHODS = ['TT', 'LC', 'DP', 'MC'] as const
export type OtherPaymentMethod = (typeof OTHER_PAYMENT_METHODS)[number]

export const OTHER_PAYMENT_METHOD_LABELS: Readonly<Record<OtherPaymentMethod, string>> = {
  TT: 'TELEGRAPHIC TRANSFER',
  LC: 'LETTER OF CREDIT',
  DP: 'DP AT SIGHT',
  MC: "MANAGER'S CHECK",
}

export function methodLabel(method: string): string {
  return (OTHER_PAYMENT_METHOD_LABELS as Record<string, string>)[method] ?? method
}

/** The same scope boundary the check sync keeps (`SYNC_FROM_DATE`, lib/sync/run.ts). */
export const OTHER_PAYMENTS_FROM = '2026-01-01T00:00:00'

/**
 * Every in-scope payment of the four methods. The payments inquiry accepts a
 * parenthesised `or` of `eq` filters (measured 2026-10-23, lib/sync/run.ts).
 * No watermark: the whole set is about 1,700 rows, read in one request, so
 * every run is a full read and nothing can be skipped past.
 */
export function otherPaymentsFilter(): string {
  const methods = OTHER_PAYMENT_METHODS.map((m) => `PaymentMethod eq '${m}'`).join(' or ')
  return `PaymentDate ge datetime'${OTHER_PAYMENTS_FROM}' and (${methods})`
}

const PAYMENT_TYPES: ReadonlySet<string> = new Set(['Payment', 'Prepayment'])
const VOIDED_PAYMENT = 'Voided Payment'
const VOIDED_STATUS = 'Voided'
/** Acumatica's word for a payment that is released and fully applied. */
export const CLOSED_STATUS = 'Closed'

export type OtherPaymentRow = {
  tenant: AcumaticaTenant
  referenceNbr: string
  method: OtherPaymentMethod
  docType: string
  acumaticaStatus: string | null
  voided: boolean
  paymentDate: Date | null
  paymentRef: string | null
  /** A decimal string, never a JS number (rule 8). */
  amount: string | null
  currency: string | null
  vendorCode: string | null
  payeeName: string | null
  description: string | null
  cashAccount: string | null
  branch: string | null
  companyCode: string | null
  lastModifiedOn: Date | null
}

const str = (v: unknown): string => (v == null ? '' : String(v)).trim()
const orNull = (v: unknown): string | null => str(v) || null

function decimalString(value: unknown): string | null {
  if (value == null) return null
  const s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : typeof value === 'string' ? value.trim() : ''
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null
}

/**
 * One feed row, or null for a row that is not one of the four methods, has no
 * reference, or is a document type that is not a payment (a Refund). A null is
 * "not ours", never an error.
 */
export function mapOtherPayment(row: unknown, tenant: AcumaticaTenant): OtherPaymentRow | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null
  const r = row as Record<string, unknown>

  const method = str(r.PaymentMethod).toUpperCase()
  if (!(OTHER_PAYMENT_METHODS as readonly string[]).includes(method)) return null
  const docType = str(r.Type)
  if (!PAYMENT_TYPES.has(docType) && docType !== VOIDED_PAYMENT) return null
  const referenceNbr = str(r.ReferenceNbr)
  if (referenceNbr === '') return null

  const status = orNull(r.Status)
  const branch = orNull(r.Branch)
  return {
    tenant,
    referenceNbr,
    method: method as OtherPaymentMethod,
    docType,
    acumaticaStatus: status,
    voided: docType === VOIDED_PAYMENT || status === VOIDED_STATUS,
    paymentDate: naiveDate(r.PaymentDate, { dayOnly: true }),
    paymentRef: orNull(r.PaymentRef),
    amount: decimalString(r.PaymentAmount),
    currency: orNull(r.Currency)?.toUpperCase() ?? null,
    vendorCode: orNull(r.Vendor),
    payeeName: orNull(r.VendorName),
    description: orNull(r.Description),
    cashAccount: orNull(r.CashAccount),
    branch,
    companyCode: branch ? companyForBranch(tenant, branch) : null,
    lastModifiedOn: naiveDate(r.LastModifiedOn, { dayOnly: false }),
  }
}

/**
 * One row per payment document. A void is two feed rows under one reference:
 * the original (positive, Status Voided) and its reversal (Type Voided
 * Payment, negative). The ORIGINAL is kept and flagged voided, as
 * `collapseVoidPairs` does for checks - its amount is the payment's own.
 *
 * A reversal with no original beside it is dropped and counted: its negative
 * amount is not the payment's, and this read is always the full set, so the
 * original is missing only if Acumatica itself no longer lists it.
 */
export function collapseOtherPayments(rows: readonly OtherPaymentRow[]): { payments: OtherPaymentRow[]; orphanReversals: number } {
  const originals = new Map<string, OtherPaymentRow>()
  const reversed = new Set<string>()
  for (const row of rows) {
    if (row.docType === VOIDED_PAYMENT) reversed.add(row.referenceNbr)
    // Two non-reversal rows under one reference is not expected; the later row wins.
    else originals.set(row.referenceNbr, row)
  }
  const payments = [...originals.values()].map((p) => (reversed.has(p.referenceNbr) && !p.voided ? { ...p, voided: true } : p))
  const orphanReversals = [...reversed].filter((ref) => !originals.has(ref)).length
  return { payments, orphanReversals }
}
