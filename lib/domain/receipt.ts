import type { GuardResult } from './check-status'

/**
 * The supplier's receipt — the paper handed over when the cheque is collected.
 *
 * Pure: no database, network, filesystem or clock, like the rest of
 * `lib/domain/` apart from `actions.ts`.
 *
 * **This is NOT `Check.crNumber`.** That column sits beside `clearingStatus`
 * (NONE/DEPOSITED/ENCASHED/CLEARED) and `clearedDate` and holds the BANK's
 * clearing reference, recorded weeks after release when the cheque comes back
 * through the account. A supplier's Collection Receipt is a piece of paper
 * handed across a counter on the day. The two abbreviate to the same two
 * letters and mean nothing like each other: a receipt number written into the
 * column that tracks whether a cheque cleared the bank would read, to every
 * report and every reconciliation, as evidence the money had cleared. The
 * receipt lives in `orNumber` / `orDate` / `receiptType`, and nothing here ever
 * writes `crNumber`.
 *
 * **The type is stored, not inferred.** "OR-000123" and "4471" and "CR 88" are
 * all references a supplier writes, and parsing the kind back out of the string
 * would be a guess dressed as a fact — the register already taught this project
 * what positional and prefix guesses cost. Finance says which kind it is, once,
 * and the answer is a column.
 */

export const RECEIPT_TYPES = ['OR', 'CR', 'AR', 'PR', 'SI', 'OTHERS'] as const
export type ReceiptType = (typeof RECEIPT_TYPES)[number]

/** What the letters stand for, spelled out wherever a user has to choose. */
export const RECEIPT_TYPE_LABELS: Record<ReceiptType, string> = {
  OR: 'OFFICIAL RECEIPT',
  CR: 'COLLECTION RECEIPT',
  AR: 'ACKNOWLEDGEMENT RECEIPT',
  PR: 'PROVISIONAL RECEIPT',
  SI: 'SALES INVOICE',
  OTHERS: 'OTHERS',
}

/**
 * The kinds the Supplier Portal accepts: its RECEIPT endpoint rejects anything
 * but OR or CR ("receiptType must be OR or CR"). An AR, PR, SI or OTHERS is recorded
 * here and queues no RECEIPT event — it could only park on /admin/portal — until
 * the portal learns it; then widening this list is the whole change.
 */
export const PORTAL_RECEIPT_TYPES: readonly ReceiptType[] = ['OR', 'CR']
export function portalAcceptsReceiptType(value: string | null | undefined): boolean {
  return (PORTAL_RECEIPT_TYPES as readonly (string | null | undefined)[]).includes(value)
}

export function isReceiptType(value: unknown): value is ReceiptType {
  return typeof value === 'string' && (RECEIPT_TYPES as readonly string[]).includes(value)
}

export type ReceiptInput = {
  orNumber?: string | null
  orDate?: Date | null
  receiptType?: ReceiptType | null
}

export type Receipt = {
  orNumber: string | null
  orDate: Date | null
  receiptType: ReceiptType | null
}

const reference = (input: ReceiptInput): string | null => {
  const raw = (input.orNumber ?? '').trim()
  return raw === '' ? null : raw
}

/**
 * The one combination that is refused: a reference with no type.
 *
 * Everything else is permitted, because the client made the receipt optional —
 * "A cheque can be released with the box empty and the receipt added later" —
 * and RELEASE ALL at the counter releases 81 cheques without one.
 *
 * A reference with no type is refused rather than defaulted to OR. Defaulting
 * would turn "the person releasing did not say" into "the person releasing said
 * OR", which is the difference between a gap somebody can fill and a fact
 * nobody can distinguish from a real one. The message names both kinds so the
 * answer is in the question.
 */
export function checkReceipt(input: ReceiptInput): GuardResult {
  if (reference(input) !== null && !isReceiptType(input.receiptType ?? null)) {
    return {
      ok: false,
      code: 'RECEIPT_TYPE_REQUIRED',
      message:
        'Choose which kind of receipt this reference is: Official Receipt (OR), Collection Receipt (CR), ' +
        'Acknowledgement Receipt (AR), Provisional Receipt (PR) or Sales Invoice (SI). ' +
        'A receipt reference cannot be recorded without saying which kind of receipt it is.',
    }
  }
  return { ok: true }
}

/**
 * What is actually stored, once the guard has passed.
 *
 * A type or a date with no reference is dropped rather than written: both are
 * attributes OF a reference, and a receipt with no number is a receipt nobody
 * can look up. Storing them would leave a cheque reading as "an OR dated the
 * 8th" with nothing to find, and would inflate any later count of the receipts
 * Finance actually holds.
 */
export function normaliseReceipt(input: ReceiptInput): Receipt {
  const orNumber = reference(input)
  if (orNumber === null) return { orNumber: null, orDate: null, receiptType: null }
  return {
    orNumber,
    orDate: input.orDate ?? null,
    receiptType: isReceiptType(input.receiptType) ? input.receiptType : null,
  }
}

/** True when a receipt was actually recorded, which is what gets an audit row. */
export function hasReceipt(receipt: Receipt): boolean {
  return receipt.orNumber !== null
}

/**
 * The receipt's amount and scanned file (user request 2026-10-01). Pure, like
 * the rest of this module. The file is capped at 3 MB (spec 2026-10-02): the
 * portal receives it base64 inside one request and Vercel caps a request at
 * ~4.5 MB. The leading bytes must agree with the stated type, so a renamed
 * file is refused rather than stored under a type it is not.
 */
export const MAX_RECEIPT_FILE_BYTES = 3 * 1024 * 1024
export const RECEIPT_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
export type ReceiptFileInput = { fileName: string; contentType: string; bytes: Uint8Array }

const SIGNATURES: Record<(typeof RECEIPT_FILE_TYPES)[number], number[]> = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
}

/**
 * A decimal string with two places, or null for a blank box. Never a JS
 * number (rule 8): `Number` loses precision past 2^53, inside the sixteen
 * integer digits `Decimal(18,2)` holds, so leading zeros are stripped as text.
 */
export function checkReceiptAmount(raw: string | null | undefined): GuardResult & { amount?: string | null } {
  const s = String(raw ?? '').replace(/,/g, '').trim()
  if (s === '') return { ok: true, amount: null }
  if (!/^\d{1,16}(\.\d{1,2})?$/.test(s)) {
    return { ok: false, code: 'RECEIPT_AMOUNT_INVALID', message: 'Enter the receipt amount as a number, for example 12,500.00.' }
  }
  const [whole, frac = ''] = s.split('.')
  return { ok: true, amount: `${whole.replace(/^0+(?=\d)/, '')}.${frac.padEnd(2, '0')}` }
}

export function checkReceiptFile(file: ReceiptFileInput | null | undefined): GuardResult {
  if (!file) return { ok: true }
  if (file.bytes.length === 0) return { ok: false, code: 'RECEIPT_FILE_EMPTY', message: 'The receipt file is empty.' }
  if (file.bytes.length > MAX_RECEIPT_FILE_BYTES) {
    return { ok: false, code: 'RECEIPT_FILE_TOO_LARGE', message: 'The receipt file is larger than 3 MB. Scan it at a lower resolution or save it as a smaller PDF.' }
  }
  const sig = SIGNATURES[file.contentType as keyof typeof SIGNATURES]
  if (!sig || !sig.every((b, i) => file.bytes[i] === b)) {
    return { ok: false, code: 'RECEIPT_FILE_TYPE', message: 'The receipt file must be a PDF, JPG or PNG.' }
  }
  return { ok: true }
}
