import { naiveDate } from './map'

/**
 * The purchase orders an AP bill names, read from Acumatica.
 *
 * `AP-Bills and Adjustments` carries one row per AP document; `VendorRef` is
 * the field the approval workbook's PO column comes from (lib/import/bills.ts,
 * VENDOR_REF). It is NOT always a PO — `26X06-0267A`, `SI#1659`, free text —
 * and the client chose "only real POs" (2026-10-05), so `extractPoNumbers`
 * keeps the PO shapes measured that day and nothing else.
 *
 * ONE column map for both tenants: measured 2026-10-05, MANUFACTURING names
 * this inquiry's columns exactly as Go-Live does (unlike AP-PAYMENTS-WITH-BILLS,
 * lib/integrations/acumatica/bills.ts).
 *
 * Only documents dated 2024 onward (`IN_SCOPE_FROM`, wider than the payment sync's scope). The incremental
 * filter is on `LastModifiedOn` alone, so the scope is enforced here, not in
 * OData. Pure.
 */

export const BILL_REFS_FEED = 'AP-Bills and Adjustments'

/** A Bill, or a Prepayment (the PPM a cheque can pay, lib/integrations/acumatica/bills.ts). */
export const BILL_REF_TYPES: readonly string[] = ['Bill', 'Prepayment']

export const BILL_REF_COLUMNS = {
  type: 'Type',
  ref: 'ReferenceNbr',
  date: 'Date',
  vendorRef: 'VendorRef',
  lastModified: 'LastModifiedOn',
  // AGING (2026-10-15): measured on both tenants with a read-only $top=5 probe.
  dueDate: 'DueDate',
  terms: 'Terms',
  // AGING, user ruling 2026-10-16: a Closed bill is paid and leaves AGING. The
  // Supplier Portal reads the same column of this inquiry on both tenants.
  status: 'Status',
} as const

/**
 * How far back a bill's Vendor Ref is mirrored: 2024, NOT the payment sync's
 * 2026 boundary. A 2026 cheque routinely pays an older bill (measured
 * 2026-10-06: AP-A1030212, dated 2025-10-29, had no stored Vendor Ref while
 * the cheque paying it sat on a transmittal; 40 of 1,332 open cheques). A bill
 * older than this that a live cheque still pays shows no PO until this moves
 * back and `scripts/sync.ts <TENANT> --bill-refs --full` is re-run.
 */
const IN_SCOPE_FROM = '2024-01-01T00:00:00'
const SCOPE_START = new Date(`${IN_SCOPE_FROM}Z`)

const literal = (d: Date) => `datetime'${d.toISOString().slice(0, 19)}'`

export function billRefsSelect(): string[] {
  return Object.values(BILL_REF_COLUMNS)
}

export function billRefsSinceFilter(since: Date): string {
  return `${BILL_REF_COLUMNS.lastModified} ge ${literal(since)}`
}

export function billRefsInScopeFilter(): string {
  return `${BILL_REF_COLUMNS.date} ge datetime'${IN_SCOPE_FROM}'`
}

/**
 * `PO-ST-031109`, `PO-A1-012345`, `PO-IND123456`, `PO-ST123456` (first form) and
 * `A1PP-PO-000123`, `STPP-PO-0001234` (second), never inside a longer
 * alphanumeric run. A trailing dot is outside the match by construction. The
 * first form's code starts with a letter, so `PO-0001234` / `PO-123456789`
 * (digits only) are not POs.
 */
const PO_PATTERN = /(?<![A-Z0-9])(?:PO-[A-Z][A-Z0-9]{1,3}-?\d{5,7}|[A-Z0-9]{2,5}-PO-\d{5,7})(?![A-Z0-9])/gi

export function extractPoNumbers(vendorRef: string | null | undefined): string[] {
  if (!vendorRef) return []
  const out: string[] = []
  for (const m of vendorRef.matchAll(PO_PATTERN)) {
    const po = m[0].toUpperCase()
    if (!out.includes(po)) out.push(po)
  }
  return out
}

export type BillRef = {
  /** `ReferenceNbr`, trimmed and upper-cased — the APV. */
  apvNumber: string
  /** `VendorRef`, trimmed; '' when absent. Kept for diagnosis. */
  vendorRef: string
  /** `extractPoNumbers(vendorRef)`; empty when the ref names no PO. */
  poNumbers: string[]
  lastModifiedOn: Date | null
  /** `DueDate` as a calendar day (UTC midnight); null when the feed states none. */
  dueDate: Date | null
  /** `Terms`, trimmed; null when blank. */
  termsCode: string | null
  /** `Status`, trimmed; null when blank. `Closed` = paid (AGING leaves it out). */
  status: string | null
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function mapBillRef(raw: unknown): BillRef | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!BILL_REF_TYPES.includes(text(r[BILL_REF_COLUMNS.type]))) return null
  const apvNumber = text(r[BILL_REF_COLUMNS.ref]).toUpperCase()
  if (!apvNumber) return null
  const date = naiveDate(r[BILL_REF_COLUMNS.date], { dayOnly: true })
  if (date === null || date < SCOPE_START) return null
  const vendorRef = text(r[BILL_REF_COLUMNS.vendorRef])
  return {
    apvNumber,
    vendorRef,
    poNumbers: extractPoNumbers(vendorRef),
    lastModifiedOn: naiveDate(r[BILL_REF_COLUMNS.lastModified], { dayOnly: false }),
    dueDate: naiveDate(r[BILL_REF_COLUMNS.dueDate], { dayOnly: true }),
    termsCode: text(r[BILL_REF_COLUMNS.terms]) || null,
    status: text(r[BILL_REF_COLUMNS.status]) || null,
  }
}
