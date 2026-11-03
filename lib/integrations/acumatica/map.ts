import { canonicalCheckNumber, isBareCheckNumber } from '@/lib/import/normalise'
import type { NormalisedRow } from '@/lib/normalised-row'
import { companyForBranch, type AcumaticaTenant } from './companies'

// One row of the `AP-Checks and Payments` generic inquiry -> the shared
// normalised row. Pure: no database, no network, no filesystem, no
// `process.env`, no `new Date()` of its own.
//
// Every rule here comes from the feed itself rather than from inference.
//
// The inquiry carries no payment category, so `category` is always null. Its
// CashAccount column is the cheque book (`BPI-S-4636`, spec §D), passed
// through as `checkBookCode`. Neither value is ever derived from Description
// or PaymentMethod: a derived cheque book files a cheque under a sibling
// company, and a derived category is simply made up.

const str = (v: unknown): string => (v == null ? '' : String(v)).trim()
const orNull = (v: unknown): string | null => str(v) || null

/**
 * PaymentRef is the CHEQUE number. ReferenceNbr is the CV (check voucher)
 * number. Reversing these two is the single most likely mapping error in this
 * file: both are short reference-looking strings, both are present on every
 * row, and swapping them produces data that looks entirely plausible while
 * keying 37,000 payments on the wrong identifier. The workbook's "CHECK NUMBER"
 * column is PaymentRef and its "VOUCHER NUMBER" column is ReferenceNbr, so the
 * mistake also silently breaks every match between the two ingestion paths.
 * `tests/integrations/acumatica-map.test.ts` pins it by name.
 */
const CHECK_NUMBER_FIELD = 'PaymentRef'
const CV_NUMBER_FIELD = 'ReferenceNbr'

// D2: only the first two are cheques Finance hands to a supplier. The feed also
// carries Prepayment, Debit Adj. and Refund; those are not imported. An
// unrecognised type is treated the same way — importing a document we have
// never seen is how a refund ends up on a cheque register.
const PAYMENT = 'Payment'
const VOIDED_PAYMENT = 'Voided Payment'
const IMPORTED_DOC_TYPES: ReadonlySet<string> = new Set([PAYMENT, VOIDED_PAYMENT])

// Acumatica's own word for a voided cheque, on the ORIGINAL row of the pair.
const VOIDED_STATUS = 'Voided'

// The Dongguan and Shanghai offices pay by transfer in CNY; their PaymentRef
// carries an AP document reference (`AP-DG001931`) rather than a cheque number,
// and there is no physical document to sign or hand over.
//
// Matched on the branch, which is a stated fact, and NOT on the shape of the
// PaymentRef. A shape rule looks tempting — these all start "AP-" — but cheque
// numbering is a bank's business and nothing guarantees a future bank's format
// stays numeric. A wrong answer here either blocks a real cheque from release
// or offers a release button for money that has already moved by wire.
const NON_CHEQUE_BRANCHES: ReadonlySet<string> = new Set(['DG', 'SH'])

/**
 * The feed's words for a payment made by check, and the second half of the
 * `isCheque` rule. Finance ruled on 2026-09-04 that only `CHK` is a check;
 * the user widened that on 2026-10-23: **every AP voucher is paid by a
 * physical check, and `CASH` is the method for a check payable to cash or to
 * be encashed** — still paper that is signed and handed over. Measured that
 * day over the 2026 feed (Go-Live):
 *
 *     13,496  CHK
 *      1,680  TT         wire — no document
 *        271  CASH       242 on PCF-SITIO (`PCF26-0226`), 29 on bank books
 *          3  BT
 *          1  DEBIT ADV
 *          1  MC
 *
 * Under `CHK` only, `CV-ST021234` (6000354949 on BPI-S-8879, 19 Oct) was never
 * fetched, so it never reached the app or the portal; 6000353877 the same.
 * While the register ran it carried such checks by hand, which is why 21 of
 * the 26 bank-book CASH checks were held — all from the register.
 *
 * A CASH check with the petty-cash fund's own numbering is still keyed like
 * any check: `PCF26-0226` is not a bare number, so it stages NO_CHECK_NUMBER
 * exactly as the 275 CHK payments numbered that way already do.
 *
 * The wires and debit advices still import and stay visible — they are real
 * money that moved — but they never had a physical document, so the
 * `NOT_A_CHEQUE` guard must block signing and releasing them. Offering Finance
 * a SIGN button for a debit advice is the failure this rule exists to prevent.
 *
 * This is IN ADDITION TO the branch rule above, never instead of it: the two
 * answer different questions, and a DG payment stays a non-cheque whatever its
 * PaymentMethod one day says. A method the feed does not state is treated as
 * not a cheque, which is the only safe direction — it withholds a button rather
 * than offering one over money with no document behind it.
 */
const CHEQUE_PAYMENT_METHODS: ReadonlySet<string> = new Set(['CHK', 'CASH'])

/**
 * A decimal string, or null. Never a JS number and never a round trip through
 * one: parsing 197715.42 into a float and formatting it back is how centavos
 * get lost, and the column is `Decimal(18,2)`.
 *
 * An exponent form is rejected rather than expanded — expanding 1e21 invents 21
 * digits nobody wrote down. Nothing in this feed renders that way, so a value
 * that does is a surprise and belongs in front of a human, not in a total.
 */
function decimalString(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const s = String(value)
    return /^-?\d+(\.\d+)?$/.test(s) ? s : null
  }
  if (typeof value !== 'string') return null
  const s = value.trim()
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null
}

/**
 * Acumatica's timestamps are naive: `2025-12-23T00:00:00`, no zone. Handing
 * that string to `new Date` parses it as LOCAL time, so on a UTC+8 host a
 * cheque dated the 23rd lands on the 22nd. Appending `Z` pins the wall clock
 * the feed stated, which is also what makes the sync watermark round-trip:
 * `toISOString().slice(0, 19)` gives back the exact string Acumatica sent.
 *
 * Deviation from the Supplier Portal, which keeps these as strings throughout
 * and never has to choose. We store `DateTime`, so the choice is unavoidable
 * and is made here, once, visibly.
 */
export function naiveDate(value: unknown, { dayOnly }: { dayOnly: boolean }): Date | null {
  const s = str(value)
  // The shape is checked BEFORE parsing, not after. `new Date('0Z')` is not an
  // Invalid Date — it is 2000-01-01 — so an `isNaN` check alone lets a stray 0
  // in the feed become a plausible-looking cheque date. Only a full ISO day
  // prefix is accepted.
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null
  const day = s.slice(0, 10)
  const time = dayOnly ? '00:00:00' : (/T(\d{2}:\d{2}:\d{2})/.exec(s)?.[1] ?? '00:00:00')
  const d = new Date(`${day}T${time}Z`)
  // A date we cannot read is not a date: an Invalid Date reaches Prisma as a
  // throw, and a null is what "the feed did not say" actually means.
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Returns null for a document type we do not import, and for anything that is
 * not a feed row at all. A null is "not our business", not an error: the sync
 * counts it as skipped and moves on.
 */
export function mapPayment(row: unknown, tenant: AcumaticaTenant): NormalisedRow | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null
  const r = row as Record<string, unknown>

  const docType = str(r.Type)
  if (!IMPORTED_DOC_TYPES.has(docType)) return null

  const status = str(r.Status)
  const branch = orNull(r.Branch)

  const method = orNull(r.PaymentMethod)?.toUpperCase()
  const isCheque =
    method != null && CHEQUE_PAYMENT_METHODS.has(method) &&
    !(branch !== null && NON_CHEQUE_BRANCHES.has(branch.toUpperCase()))

  // What the feed printed, and what it means as a key. They differ on 90.0% of
  // rows, where Acumatica writes `BPI 6000240287` for the cheque the register
  // writes `6000240287`; canonicalising is what stops one physical cheque being
  // stored twice, once per source. See `canonicalCheckNumber`.
  const statedCheckRef = orNull(r[CHECK_NUMBER_FIELD])
  const canonical = canonicalCheckNumber(statedCheckRef)

  // 80 live rows are CHK — genuinely cheques — but carry a memo here ("Oct
  // interest", "pay 12 25 2nd"). Nothing in them can key (company,
  // checkNumber), so the row is left unkeyable on purpose: `upsertCheck` stages
  // it as NO_CHECK_NUMBER, exactly as it already stages the register's 66
  // numberless rows, and a human supplies the real number from `statedCheckRef`
  // (Finance ruling of 2026-09-04). Inventing a number from the digits in a
  // memo would be inventing a fact about money.
  //
  // Applied only to CHEQUES. A non-cheque payment's reference is not a cheque
  // number and never was — the China rows' `AP-DG001931` is the only identifier
  // those payments have, and discarding it would make them unkeyable and lose
  // a payment that really happened. Do not "tidy" this into one rule for both.
  const checkNumber = isCheque && !isBareCheckNumber(canonical) ? null : canonical

  return {
    source: 'ACUMATICA',
    acumaticaPaymentId: orNull(r[CV_NUMBER_FIELD]),

    checkNumber,
    statedCheckRef,
    cvNumber: orNull(r[CV_NUMBER_FIELD]),

    checkDate: naiveDate(r.PaymentDate, { dayOnly: true }),
    // No sign manipulation. A Voided Payment reversal arrives negative and
    // stays negative; the portal's sign rule applies to bill adjustments, which
    // this feed does not carry.
    amount: decimalString(r.PaymentAmount),
    currency: orNull(r.Currency)?.toUpperCase() ?? null,

    payeeName: orNull(r.VendorName),
    vendorCode: orNull(r.Vendor),
    // null for an unrecognised branch, by `companyForBranch`'s own contract.
    companyCode: branch ? companyForBranch(tenant, branch) : null,
    cashAccountCode: orNull(r.CashAccount),
    // The inquiry's CashAccount IS the cheque book: Acumatica states the same
    // code the register wrote as the cheque book (`BPI-S-4636`). Measured
    // 2026-10-02, spec §D. Passed through; upsertCheck resolves it against
    // CheckBook.code and leaves it null for a code that is no cheque book
    // (`PAYROLL`, `PCF-SITIO`). cashAccountCode keeps the same value.
    checkBookCode: orNull(r.CashAccount),
    category: null,

    // Nor these. The payments inquiry is one row per payment and carries no
    // bill breakdown, so the APV and PO references a workbook row supplies
    // simply are not available here. Empty rather than absent: the upsert must
    // be able to tell "this source has no bill references" from "this source
    // forgot to set the field", and it must not clear references the workbook
    // already established for the same cheque.
    apvNumbers: [],
    poNumbers: [],
    receiptRef: null,

    isCheque,

    // A voided cheque is TWO rows under one reference: the original (Type
    // "Payment", positive, Status "Voided") and its reversal (Type "Voided
    // Payment", negative, Status "Closed"). Flagging only the reversal would
    // leave the original — the row that describes what actually happened, and
    // the one the Supplier Portal's dedupe deliberately keeps — unmarked. Both
    // conditions are needed; do not "simplify" this to the docType alone.
    voided: docType === VOIDED_PAYMENT || status === VOIDED_STATUS,

    acumaticaDocType: docType,
    acumaticaStatus: status || null,
    acumaticaBranch: branch,
    acumaticaTenant: tenant,
    lastModifiedOn: naiveDate(r.LastModifiedOn, { dayOnly: false }),

    // Sheet and row belong to the workbook path.
    sourceSheet: null,
    sourceRow: null,
  }
}

/**
 * Collapses each voided cheque's two feed rows into the one row that describes
 * what happened.
 *
 * A void is TWO rows under one `PaymentRef`: the original (`Type: Payment`,
 * positive, `Status: Voided`) and its reversal (`Type: Voided Payment`,
 * negative). Both map to the same `(company, checkNumber)`. Measured read-only
 * over 2,000 live rows on 2026-09-04: **67 such pairs among 1,836 keyable
 * cheques (3.6%), and 62 of the 67 carry an IDENTICAL `LastModifiedOn` on both
 * halves**. For those 62 there is nothing to order the two rows by at all —
 * whichever reached `upsertCheck` last won, arbitrarily — and for the other 5
 * the reversal is simply the later row. Either way a cheque could end up
 * storing its own negative reversal as its amount.
 *
 * The ORIGINAL survives, flagged voided. It is the row a human reads off a
 * cheque register, and it is the row the Supplier Portal's own `dedupePayments`
 * deliberately keeps against this same instance.
 *
 * **This is a PAIRING decision, not a sign flip.** Nothing here negates a value
 * or takes a magnitude, and `mapPayment` above still does no sign manipulation
 * of any kind. A reversal that arrives with no original in the batch is passed
 * through exactly as the feed sent it — inventing the cheque's amount from the
 * negation of its reversal would be inventing a fact about money. In practice
 * that cannot happen within a run, because the two rows share a timestamp and
 * so always fall in the same incremental window.
 *
 * Called BEFORE `upsertCheck`, the way `groupByCheckNumber` already collapses
 * the register's ambiguity groups before any row of one is written. Duplicate
 * PREVENTION stays solely the unique key inside `upsertCheck`; this is not a
 * second one, and must not grow into one.
 *
 * Pure, and stable: rows come back in the order the feed gave them.
 */
export function collapseVoidPairs(rows: readonly NormalisedRow[]): NormalisedRow[] {
  // The key `upsertCheck` actually writes on. Pairing on the cheque number
  // alone would collapse two companies' same-numbered cheques into one — a
  // cheque number is unique only per company. A row with no cheque number is in
  // no group at all: it cannot be keyed, so it cannot be paired, and grouping
  // the unkeyable rows together would silently discard payments.
  //
  // Joined on a character no company code or cheque number can contain, so no
  // pair of values can spell another pair's key. A space would do today —
  // `A1+`, `HAMFI(HO)`, `STINDUSTRY` — but a company code is reference data
  // somebody edits, and a key that is only safe by luck is not a key.
  //
  // AND the payment reference (full check 2026-10-06). The two halves of a void
  // share it; a RE-ISSUE on the same number does not — Acumatica voided
  // CV-A1009705 and re-issued 1791361374 as CV-A1009798, and pairing on the
  // number alone flagged the live re-issue voided, so the sync voided a cheque
  // Acumatica holds Closed. Five such numbers in Go-Live that day.
  const key = (row: NormalisedRow): string | null =>
    row.checkNumber === null
      ? null
      : `${row.companyCode ?? ''}\u0000${row.acumaticaPaymentId ?? ''}\u0000${row.checkNumber}`

  const reversed = new Set<string>()
  const originals = new Set<string>()
  for (const row of rows) {
    const k = key(row)
    if (k === null) continue
    if (row.acumaticaDocType === VOIDED_PAYMENT) reversed.add(k)
    else originals.add(k)
  }

  const out: NormalisedRow[] = []
  for (const row of rows) {
    const k = key(row)
    if (k === null || !reversed.has(k) || !originals.has(k)) {
      out.push(row)
      continue
    }
    // A complete pair. Drop the reversal; keep the original, stating the void
    // rather than relying on `Status` alone having been set on it.
    if (row.acumaticaDocType === VOIDED_PAYMENT) continue
    out.push(row.voided ? row : { ...row, voided: true })
  }
  return out
}
