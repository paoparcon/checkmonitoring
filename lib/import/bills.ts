import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { sniff } from './field-sniffer'
import { canonicalCheckNumber, cleanCell, excelSerialToDate, isBareCheckNumber } from './normalise'
import { readAmount } from './parse'
import type { RawRow } from './workbook'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * Bill detail from the approval-for-release workbook, which is NOT the cheque
 * register.
 *
 * Two things about it govern everything below.
 *
 * **Its grain is one row per bill**, where the register's is one row per cheque.
 * The register puts every APV a cheque settles on that cheque's single row and
 * publishes no per-bill amount; this workbook publishes the amount, due date,
 * terms, GL account and creator of each bill separately. That is why the two
 * feed different tables — `Check.apvNumbers` is a reference list, `CheckBill` is
 * a ledger — and why this parser produces neither a `ParsedRow` nor a
 * `NormalisedRow`. Do not route it through `upsertCheck`: it has no cheque to
 * create, only detail to hang on one that already exists.
 *
 * **It is a current snapshot, not history** — the approval-for-release working
 * list as of the day it was exported. It says nothing whatsoever about cheques
 * outside it, so nothing here deletes or deactivates a cheque or a bill this
 * file does not mention. An absence in this file is not evidence.
 *
 * **Its sheets are not stable and its shape is.** 4 September: `LIST` and
 * `PIVOT`. 7 September: `Sheet3` (the pivot, renamed), `local supplier` and
 * `BROKERAGE`. 10 September: `PIVOT` again, plus the same two data sheets. The
 * parser reads every sheet carrying the 24-column Acumatica header and no
 * others; see `isBillSheet`. It does not know the name `LIST` and must not
 * learn it again.
 *
 * **A voucher can appear on two data sheets.** Measured on the 7 September
 * workbook: `local supplier` and `BROKERAGE` share exactly two vouchers, and
 * both pairs name the SAME cheque — one by an identical cheque number on both
 * rows, one by an unusable `check No.` cell on both, which resolves through the
 * same voucher to the same cheque. So both fold onto one `CheckBill` through
 * the `(checkId, apvNumber)` unique index: the second row updates the first
 * rather than duplicating it, and both rows are recorded in the audit trail
 * with their own sheet. Nothing here needs to arbitrate. If a voucher ever
 * names DIFFERENT cheques on two sheets that is a real conflict rather than a
 * duplicate, and it would have to be staged rather than written twice — it does
 * not occur in any workbook measured so far, and this is not the place to guess
 * at how it should be settled.
 */

// A bill sheet's columns, 0-indexed exactly as `readWorkbook` yields a row's
// cells. Positional, unlike the register's parser, and legitimately so: this is
// one machine-generated Acumatica export with one header row per sheet, not
// fifteen hand-maintained sheets whose columns drift. The header row measured
// 2026-09-04 and again 2026-09-07 reads, in order: Date, Post Period, Reference
// Nbr., Vendor Ref., Vendor Name, Balance Amount, Description, Due Date, Type,
// Detail Total, Terms Code, Created By, NO. OF DAYS, four ageing buckets, OVER
// 90 DAYS, GL Account, FINANCE REMARKS, Payment Ref. #, check No., bank.
//
// Reading positionally is only safe because the header is CHECKED before a
// sheet is read — see `isBillSheet`. A shifted or renamed column makes the
// sheet unreadable and reported, rather than read as the wrong field silently.
const COL = {
  REFERENCE_NBR: 2,   // -> CheckBill.apvNumber
  VENDOR_REF: 3,      // -> CheckBill.poNumber
  DESCRIPTION: 6,     // -> CheckBill.description
  DUE_DATE: 7,        // -> CheckBill.dueDate
  DETAIL_TOTAL: 9,    // -> CheckBill.amount
  TERMS_CODE: 10,     // -> CheckBill.termsCode
  CREATED_BY: 11,     // -> CheckBill.createdByName
  GL_ACCOUNT: 17,     // -> CheckBill.glAccount
  FINANCE_REMARKS: 18,
  CHECK_NO: 20,       // links to Check.checkNumber
  BANK: 21,           // a cash-account label, not a bank name
} as const

/**
 * The label that must sit above each column this parser reads.
 *
 * Keyed on `COL`, so moving a column without restating the label it is now
 * under is a compile error rather than a sheet that quietly stops being read.
 */
const HEADER_LABEL: Readonly<Record<keyof typeof COL, string>> = {
  REFERENCE_NBR: 'REFERENCE NBR.',
  VENDOR_REF: 'VENDOR REF.',
  DESCRIPTION: 'DESCRIPTION',
  DUE_DATE: 'DUE DATE',
  DETAIL_TOTAL: 'DETAIL TOTAL',
  TERMS_CODE: 'TERMS CODE',
  CREATED_BY: 'CREATED BY',
  GL_ACCOUNT: 'GL ACCOUNT',
  FINANCE_REMARKS: 'FINANCE REMARKS',
  CHECK_NO: 'CHECK NO.',
  BANK: 'BANK',
}

/**
 * Which sheets hold bills, as a property of the SHEET rather than of its name.
 *
 * This is the whole lesson of 7 September. The 4 September workbook was `LIST`
 * and `PIVOT`; the 7 September one is `Sheet3`, `local supplier` and
 * `BROKERAGE`, and a parser that skipped everything but `LIST` read zero rows
 * out of it and reported success — the failure this codebase least wants, since
 * a bill that is never read is a supplier never told.
 *
 * What did NOT change is the header. Every data sheet of both workbooks carries
 * the same 24-column Acumatica header on row 1; every pivot sheet carries an
 * empty row 1. So the header is the evidence, and the eleven columns this
 * parser reads must ALL be where they say they are before a single row of the
 * sheet is read positionally.
 *
 * Deliberately strict in both directions:
 *
 *   * a sheet with no header, or a header missing one of these labels, is not
 *     read — it is reported. `Sheet3`'s column 3 holds pivot subtotals, and
 *     reading it positionally would file an AMOUNT as a voucher reference.
 *   * a sheet is not required to be *named* anything. `local supplier` and
 *     `BROKERAGE` are both read, and `sourceSheet` on every parsed row keeps
 *     them apart — the supplier portal exposes broker cheques on a different
 *     endpoint, and that routing is Plan 3's to build on this evidence.
 */
export function isBillSheet(header: readonly unknown[] | undefined): boolean {
  if (header === undefined || header.length === 0) return false
  return (Object.keys(COL) as (keyof typeof COL)[]).every(
    (key) => cleanCell(header[COL[key]])?.toUpperCase() === HEADER_LABEL[key],
  )
}

/**
 * What a run read, and from where, per sheet.
 *
 * A workbook that grew a sheet must not be summarised as one number. This is
 * how an operator sees that `BROKERAGE` contributed 11 rows and that the pivot
 * sheet was skipped rather than silently empty.
 */
export type BillSheetReport = {
  sheet: string
  /** Data rows the sheet carries, whether or not they were read. */
  rows: number
  /** False when the sheet carries no bill header. Its rows are not bills. */
  read: boolean
  bills: number
  review: number
}

export type ParsedBill = {
  // Provenance, so a reconciliation report can point a human at the cell.
  sheet: string
  row: number

  /**
   * Canonical, through `canonicalCheckNumber` — the single place that rule
   * lives. **Null when the `check No.` cell does not hold a cheque number.**
   *
   * It used to be non-nullable, and such a row went to review at parse time.
   * That was correct and it lost a cheque: row 81 of the 4 September LIST sheet
   * holds a date, `2026-08-13`, where the cheque number belongs — the only one
   * of the 85 — and its voucher `AP-ST042652` therefore never reached the
   * supplier portal. The client's instruction of 2026-09-07 is verbatim: *"In
   * CHECK MONITORING 9.4.2026 please use acumatica as reference for check
   * numbers."* So a row whose cheque cell is unusable is resolved by its
   * VOUCHER against the cheques already here, and only staged if that finds
   * none — or more than one, which is not a tie to break. See `matchBills`.
   *
   * The nullability stops at the parser. `CheckBill` still requires a cheque,
   * and a bill that resolves to none is never written.
   */
  checkNumber: string | null
  /**
   * What the `check No.` cell actually held, legibly, for the human who has to
   * correct it — a date rendered `2026-08-13`, a memo, or null where the cell
   * was empty. Never normalised and never promoted into a cheque number.
   */
  statedCheckRef: string | null

  // `CheckBill.apvNumber` and `.amount` are both NOT NULL, so both are
  // non-nullable here for the same reason `checkNumber` is: a bill missing
  // either cannot be written without inventing it.
  apvNumber: string
  /** A decimal string, never a JS number. `Decimal(18,2)`; a float round-trip
   * is how centavos go missing. */
  amount: string

  poNumber: string | null
  description: string | null
  glAccount: string | null
  dueDate: Date | null
  termsCode: string | null
  createdByName: string | null

  /**
   * The `bank` column, which holds a cash-account label (`MBTC P&P`, `BPI STK`)
   * rather than a bank name. All 85 rows carry one, and it is a company signal
   * the register lacks for some cheques.
   *
   * Carried, deliberately NOT used. Feeding it to `resolveCompany` to promote a
   * `NO_COMPANY` staged row is the sync's job and out of this task's scope; it
   * is here so that work has the signal without re-reading the workbook.
   */
  cashAccountLabel: string | null

  /**
   * `FINANCE REMARKS`, which is `AVAILABLE` on all 85 rows.
   *
   * It corroborates READY_FOR_RELEASE and it is NOT an instruction. Import
   * never changes release status (decision D4, enforced by
   * `IMMUTABLE_ON_UPDATE`): Acumatica does not know whether Finance has signed
   * a cheque, and this workbook does not either. The remark is evidence for a
   * human. Nothing in this module may turn it into a status.
   */
  financeRemark: string | null
}

/**
 * Why the PARSER refused a row, as opposed to why the database could not place
 * it. Both are only ever the two NOT NULL columns of `CheckBill`, and neither
 * is ever satisfied by inventing a value: `NO_AMOUNT` in particular is a bill
 * whose `Detail Total` is missing or states its own currency, and the register's
 * cheque amount is NOT that bill's amount.
 *
 * `NO_CHECK_NUMBER` is deliberately absent. Whether an unusable cheque cell is
 * fatal is a question about the DATABASE — the row's voucher may name exactly
 * one cheque — and a pure parser cannot answer it. It is decided in `matchBills`.
 */
export type BillReviewReason = 'NO_APV' | 'NO_AMOUNT'

export type BillReviewItem = {
  sheet: string
  row: number
  reason: BillReviewReason
  /**
   * The whole row, for an operator reading a report in the terminal.
   *
   * **Never persisted.** It carries the vendor name and the balance amount, and
   * `StagedBill` deliberately holds neither — a bill's figure sitting in a
   * cheque-shaped queue is read as a cheque's figure sooner or later.
   */
  cells: unknown[]
  /** What the row did say where it could be read, so a staged row is legible. */
  apvNumber: string | null
  poNumber: string | null
  checkNumber: string | null
  statedCheckRef: string | null
}

// The due date is a real date cell on all 85 rows, but ExcelJS yields a bare
// serial when a date cell carries no date format, so both are read. Same
// Invalid-Date guard the register's parser needs: ExcelJS produces one for a
// malformed cell, it passes `instanceof Date`, and Prisma throws on write.
function readDate(cell: unknown): Date | null {
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : cell
  if (typeof cell === 'number' && sniff(cell) === 'DATE_SERIAL') return excelSerialToDate(cell)
  return null
}

/**
 * Pure: a grid in, bills, a review queue and a per-sheet account out. No
 * database, no clock.
 *
 * Nothing is dropped and nothing is silent. Every sheet in the file appears in
 * `sheets`, read or not; for the sheets that were read,
 * `bills.length + review.length` equals their combined row count. A sheet whose
 * header does not match is reported with `read: false` rather than passed over,
 * because "read zero rows" and "there were no rows" are the two things this
 * importer must never confuse.
 */
export function parseBillRows(rows: readonly RawRow[]): {
  bills: ParsedBill[]
  review: BillReviewItem[]
  sheets: BillSheetReport[]
} {
  const bills: ParsedBill[] = []
  const review: BillReviewItem[] = []
  // Insertion-ordered, so the report lists sheets in the order the workbook
  // carries them.
  const sheets = new Map<string, BillSheetReport>()

  for (const raw of rows) {
    let report = sheets.get(raw.sheet)
    if (report === undefined) {
      // Decided once per sheet, from the first row of it we see — every row of
      // a sheet carries the same header by construction.
      report = { sheet: raw.sheet, rows: 0, read: isBillSheet(raw.header), bills: 0, review: 0 }
      sheets.set(raw.sheet, report)
    }
    report.rows++
    if (!report.read) continue

    // Deliberately NOT filtered on `Type = Bill`. 84 of the 85 rows say Bill and
    // the 85th (row 41) has an empty Type cell along with an empty Created By,
    // while carrying a perfectly good APV, amount and cheque number. Filtering
    // on the column would silently drop a genuine bill to enforce a property of
    // the file rather than a fact about the row.

    // The cheque cell is a numeric cell on all 84 usable rows, so the number has
    // to survive the trip back to a string. `String(6000338925)` is exact —
    // these are integers well inside the safe range — and `cleanCell` handles
    // the text form. The 85th row (row 81) holds a *date* here.
    //
    // That row is NOT refused. It is a bill with no cheque number, which is a
    // question for `matchBills` and not for a parser: its voucher may name
    // exactly one cheque, and 2026-09-07 it does. What the cell held is kept
    // verbatim — a date rendered as `2026-08-13`, which is legible where
    // `String(new Date(...))` is not — because that is what a human replaces
    // with the real number.
    const checkCell = raw.cells[COL.CHECK_NO]
    const stated = checkCell instanceof Date
      ? (Number.isNaN(checkCell.getTime()) ? null : checkCell.toISOString().slice(0, 10))
      : cleanCell(checkCell)
    // The single cheque-number rule, shared with the register importer and the
    // Acumatica mapper. Acumatica prefixes 90.0% of its refs with a bank code
    // (`BPI 6000240287`) while the register writes them bare, so matching a bill
    // on a raw string would silently match nothing. Do not normalise here.
    //
    // A date, a memo or an empty cell yields null, and the row travels on with
    // `checkNumber: null` rather than being dropped.
    const canonical = checkCell instanceof Date ? null : canonicalCheckNumber(stated)
    const checkNumber = canonical !== null && isBareCheckNumber(canonical) ? canonical : null

    const apvNumber = cleanCell(raw.cells[COL.REFERENCE_NBR])?.toUpperCase() ?? null
    const poNumber = cleanCell(raw.cells[COL.VENDOR_REF])?.toUpperCase() ?? null
    const sheetReport = report
    const flag = (reason: BillReviewReason) => {
      sheetReport.review++
      review.push({
        sheet: raw.sheet, row: raw.row, reason, cells: raw.cells,
        apvNumber, poNumber, checkNumber, statedCheckRef: stated,
      })
    }

    if (apvNumber === null) {
      flag('NO_APV')
      continue
    }

    // One money reader for both workbooks, including its refusal to expand an
    // exponent form. Measured on this file: all 85 Detail Totals are numeric
    // cells, none in exponent form, none with more than two decimal places, so
    // nothing here is silently reshaped.
    //
    // A total that states its own currency — the register's "USD 300000" form —
    // is sent to review rather than stored: `CheckBill` has no currency column,
    // because a bill's currency is its cheque's, and writing the bare number
    // would relabel it as whatever the cheque says. It does not occur in this
    // file; it is refused rather than guessed if it ever does.
    const money = readAmount(raw.cells[COL.DETAIL_TOTAL])
    if (money === null || money.currency !== null) {
      flag('NO_AMOUNT')
      continue
    }

    bills.push({
      sheet: raw.sheet,
      row: raw.row,
      checkNumber,
      statedCheckRef: stated,
      apvNumber,
      amount: money.amount,
      poNumber,
      description: cleanCell(raw.cells[COL.DESCRIPTION]),
      glAccount: cleanCell(raw.cells[COL.GL_ACCOUNT]),
      dueDate: readDate(raw.cells[COL.DUE_DATE]),
      termsCode: cleanCell(raw.cells[COL.TERMS_CODE]),
      createdByName: cleanCell(raw.cells[COL.CREATED_BY]),
      cashAccountLabel: cleanCell(raw.cells[COL.BANK])?.toUpperCase() ?? null,
      financeRemark: cleanCell(raw.cells[COL.FINANCE_REMARKS])?.toUpperCase() ?? null,
    })
    report.bills++
  }

  return { bills, review, sheets: [...sheets.values()] }
}

export type UnmatchedBillReason = 'NO_CHECK_NUMBER' | 'NO_MATCHING_CHECK' | 'AMBIGUOUS_CHECK'

export type UnmatchedBill = {
  sheet: string
  row: number
  /** Null when the `check No.` cell held no cheque number at all. */
  checkNumber: string | null
  /** What that cell did hold, for the human who has to correct it. */
  statedCheckRef: string | null
  apvNumber: string
  poNumber: string | null
  reason: UnmatchedBillReason
  /** The company codes a contested cheque number resolves to, for the human
   * who has to settle it. Empty for NO_MATCHING_CHECK and NO_CHECK_NUMBER. */
  companies: string[]
}

/**
 * How a bill found its cheque.
 *
 * `CHECK_NUMBER` is the ordinary path and the one the workbook is supposed to
 * offer. `APV` is the fallback for a mis-keyed cheque cell, and it is recorded
 * on the row and written into the audit trail — attaching a bill to a cheque on
 * evidence OTHER than the number printed beside it is a decision somebody may
 * have to defend, so it never happens silently.
 */
export type BillMatchedOn = 'CHECK_NUMBER' | 'APV'

export type MatchedBill = { bill: ParsedBill; checkId: string; matchedOn: BillMatchedOn }

/**
 * Cited on every bill attached by its voucher rather than by the cheque number
 * printed beside it, so such a row is traceable to the instruction that allowed
 * it rather than to "the importer decided".
 */
export const BILL_CHECK_REF_RULING =
  'Client instruction of 2026-09-07: in the approval-for-release workbook, use Acumatica as the ' +
  'reference for check numbers'

export type BillImportSummary = {
  /** What was read, and from where. A run that read one sheet of three has to
   * say so on the way out as well as on the way in. */
  sheets: BillSheetReport[]
  bills: number
  created: number
  updated: number
  /** Bills attached by their voucher because the `check No.` cell was unusable. */
  resolvedByVoucher: number
  unmatched: UnmatchedBill[]
  /** Rows written to `StagedBill` by this run. Part of the summary rather than
   * a separate return, because an import that only reported them is precisely
   * what let a voucher go unnoticed. */
  staged: number
  /** Staged rows removed because the row they described now attaches. */
  cleared: number
}

/**
 * Which cheque each bill belongs to, or why it belongs to none. Reads; writes
 * nothing.
 *
 * Extracted so the import PREVIEW can tell an operator how many bills will find
 * their cheque *before* anything is written, using the same matching the write
 * path uses. A preview with its own lookup would be a second place for the "two
 * matches is a review item, not a coin toss" rule to live.
 */
export async function matchBills(
  db: Db,
  bills: readonly ParsedBill[],
): Promise<{ matched: MatchedBill[]; unmatched: UnmatchedBill[] }> {
  const matched: MatchedBill[] = []
  const unmatched: UnmatchedBill[] = []

  for (const bill of bills) {
    // Looked up on the cheque number alone rather than on
    // `(companyId, checkNumber)`. The `bank` column would resolve a company for
    // all 85 rows, but using it to *choose* between two cheques that share a
    // number would be this module deciding which company a bill belongs to,
    // which is exactly the ambiguity a human is meant to settle. Two matches is
    // a review item, not a coin toss.
    //
    // WHEN THE CELL HOLDS NO CHEQUE NUMBER, the row is resolved by its VOUCHER
    // instead — `Check.apvNumbers` contains it — under the client's instruction
    // of 2026-09-07 to treat Acumatica as the reference for cheque numbers in
    // this workbook. The fallback is deliberately narrow:
    //
    //   * it is reached ONLY when the cheque cell is unusable. A cell that
    //     holds a perfectly good number naming no cheque here is NOT re-resolved
    //     by voucher — that would be overruling the workbook on evidence it did
    //     not offer, and the cheque is simply not in this system yet.
    //   * exactly one match, or nothing. None and it is staged; more than one
    //     and it is staged, because a bill hung on the wrong cheque is a
    //     supplier told the wrong thing, and a mis-keyed cell is far cheaper.
    //
    // It was written for ONE row — row 81 of the 4 September LIST sheet. The
    // 7 September workbook has 50 of them, across two data sheets, and that
    // changes nothing here: each row is resolved on its own voucher against the
    // same "exactly one" rule. Fifty rows wanting to resolve is not a reason to
    // relax it. A row that stays staged is a cell somebody re-keys; a row
    // resolved by relaxing it is a cheque nobody can defend.
    //
    // A CANCELLED or VOIDED cheque is never a match (user ruling 2026-10-29: a
    // cancelled cheque is no longer connected to the AP it was applied to). So
    // a voucher that names a voided cheque and its live re-issue resolves to
    // the re-issue, and a number that names only a dead cheque stages as
    // NO_MATCHING_CHECK — the bill is waiting for its replacement to arrive.
    const checkNumber = bill.checkNumber
    const byVoucher = checkNumber === null
    const where: Prisma.CheckWhereInput = {
      ...(byVoucher ? { apvNumbers: { has: bill.apvNumber } } : { checkNumber }),
      status: { notIn: ['CANCELLED', 'VOIDED'] },
    }
    const matches = await db.check.findMany({
      where,
      select: { id: true, company: { select: { code: true } } },
    })

    if (matches.length === 1) {
      matched.push({ bill, checkId: matches[0].id, matchedOn: byVoucher ? 'APV' : 'CHECK_NUMBER' })
      continue
    }

    // Not an error. A bill whose cheque is missing is expected: the cheque may
    // be staged for want of a company, or simply absent from the register. The
    // bill is kept whole and put in front of somebody rather than dropped.
    unmatched.push({
      sheet: bill.sheet,
      row: bill.row,
      checkNumber: bill.checkNumber,
      statedCheckRef: bill.statedCheckRef,
      apvNumber: bill.apvNumber,
      poNumber: bill.poNumber,
      reason: matches.length > 1
        ? 'AMBIGUOUS_CHECK'
        // A cell that never held a number is a different problem from a number
        // that names nothing, and the fix is a different one — correct the
        // cell, versus wait for the cheque to arrive. Saying so is the whole
        // point of surfacing these.
        : byVoucher ? 'NO_CHECK_NUMBER' : 'NO_MATCHING_CHECK',
      companies: matches.map((m) => m.company.code),
    })
  }

  return { matched, unmatched }
}

export type BillPreview = {
  /** Every row on every sheet that was read: `bills + review` accounts for all
   * of them. Rows on a sheet with no bill header are NOT counted here; they are
   * in `sheets`, which is the only place that says a sheet was skipped. */
  totalRows: number
  /** What was read, and from where. Includes the sheets that were not read. */
  sheets: BillSheetReport[]
  bills: number
  review: BillReviewItem[]
  willImport: number
  /** Of those, how many would be attached by their voucher rather than by the
   * cheque number printed beside them. */
  willResolveByVoucher: number
  unmatched: UnmatchedBill[]
}

/**
 * What importing this file would do, without doing it. Same shape of honesty
 * the register preview owes: the rows that will NOT land are reported beside
 * the ones that will, not inferred from a shortfall.
 */
export async function previewBillImport(
  db: Db,
  args: {
    bills: readonly ParsedBill[]
    review: readonly BillReviewItem[]
    /** From `parseBillRows`, and required rather than optional: a preview that
     * did not say which sheets it read is exactly what let a renamed sheet
     * report success over zero rows. */
    sheets: readonly BillSheetReport[]
  },
): Promise<BillPreview> {
  const { matched, unmatched } = await matchBills(db, args.bills)
  return {
    totalRows: args.bills.length + args.review.length,
    sheets: [...args.sheets],
    bills: args.bills.length,
    review: [...args.review],
    willImport: matched.length,
    willResolveByVoucher: matched.filter((m) => m.matchedOn === 'APV').length,
    unmatched,
  }
}

export type StageBillsSummary = {
  /** Rows written or refreshed on `StagedBill` by this pass. */
  staged: number
  /** Staged rows removed because the row they described now attaches to a
   * cheque. Without this the queue only ever grows and a fixed cell never
   * stops being reported. */
  cleared: number
}

/**
 * Put every refused row of the approval-for-release workbook where somebody
 * sees it, and take away the ones that have since resolved.
 *
 * This is the point of the whole exercise. Voucher `AP-ST042652` never reached
 * the supplier portal because of one mis-keyed cell, and the importer DID
 * report it — to a terminal, once, during a run nobody was watching. A rejected
 * row has to survive the run that rejected it.
 *
 * Keyed on `(sourceSheet, sourceRow)`, the cell a human can be pointed at, so a
 * re-run refreshes a staged row rather than adding a second one. The key was
 * chosen when the workbook had one data sheet and it stays correct now that it
 * has two: row 6 of `local supplier` and row 6 of `BROKERAGE` are different
 * cells and stage separately.
 *
 * **Only rows this pass actually saw are cleared.** A row that has vanished from
 * a newer snapshot of the workbook leaves its staged row standing, because this
 * file is a snapshot and an absence in it is not evidence — the module's rule,
 * not an oversight. Deleting on absence would quietly empty the queue the first
 * time somebody exported a shorter list.
 *
 * Writes no `AuditLog`: the trail is check-scoped, and the defining property of
 * every row here is that it belongs to no cheque.
 */
export async function stageBills(
  db: Db,
  args: { matched: readonly MatchedBill[]; review: readonly BillReviewItem[]; unmatched: readonly UnmatchedBill[] },
): Promise<StageBillsSummary> {
  // The two kinds of refusal are written by one loop, so a row refused by the
  // parser and a row refused by the lookup cannot end up carrying different
  // columns. A row is either parsed into a bill or reviewed, never both, so the
  // two lists cannot collide on the key.
  const rows = [
    ...args.review.map((r) => ({ ...r, companies: [] as string[] })),
    ...args.unmatched,
  ]

  for (const item of rows) {
    const data = {
      reason: item.reason,
      statedCheckRef: item.statedCheckRef,
      checkNumber: item.checkNumber,
      apvNumber: item.apvNumber,
      poNumber: item.poNumber,
      companies: item.companies,
    }
    await db.stagedBill.upsert({
      where: { sourceSheet_sourceRow: { sourceSheet: item.sheet, sourceRow: item.row } },
      create: { sourceSheet: item.sheet, sourceRow: item.row, ...data },
      update: data,
    })
  }

  const cleared = args.matched.length
    ? await db.stagedBill.deleteMany({
        where: {
          OR: args.matched.map((m) => ({ sourceSheet: m.bill.sheet, sourceRow: m.bill.row })),
        },
      })
    : { count: 0 }

  return { staged: rows.length, cleared: cleared.count }
}

/**
 * Hang parsed bill detail on the cheques that already exist. Writes `CheckBill`
 * rows and nothing else.
 *
 * Never touches `Check`. Not "does not currently" — there is no code path here
 * that could, which is the point: this workbook's `FINANCE REMARKS = AVAILABLE`
 * looks like a status and is not one.
 *
 * Idempotent on `(checkId, apvNumber)`, which is a unique index on the table.
 * Note what that key does NOT say: it does not forbid a cheque carrying several
 * bills. All 85 rows of the 4 September snapshot happen to name distinct
 * cheques, but that is a property of one day's working list, not of the domain —
 * the register carries cheques settling several bills and `CheckBill` is
 * correctly one-to-many. Do not turn this into a unique constraint on `checkId`.
 *
 * That same key is what makes the two vouchers shared by `local supplier` and
 * `BROKERAGE` on 7 September harmless: both rows name the same cheque, so the
 * second updates the first instead of writing a duplicate. Both rows leave
 * their own audit entry, naming their own sheet.
 */
export async function importBills(
  db: Db,
  args: {
    bills: readonly ParsedBill[]
    review: readonly BillReviewItem[]
    sheets: readonly BillSheetReport[]
    now: Date
  },
): Promise<BillImportSummary> {
  const { matched, unmatched } = await matchBills(db, args.bills)
  const summary: Omit<BillImportSummary, keyof StageBillsSummary> = {
    sheets: [...args.sheets],
    bills: args.bills.length,
    created: 0,
    updated: 0,
    resolvedByVoucher: matched.filter((m) => m.matchedOn === 'APV').length,
    unmatched,
  }

  for (const { bill, checkId, matchedOn } of matched) {
    const data = {
      poNumber: bill.poNumber,
      description: bill.description,
      glAccount: bill.glAccount,
      dueDate: bill.dueDate,
      termsCode: bill.termsCode,
      // A decimal string all the way to Prisma. Never `Number(bill.amount)`.
      amount: bill.amount,
      createdByName: bill.createdByName,
    }

    const existing = await db.checkBill.findUnique({
      where: { checkId_apvNumber: { checkId, apvNumber: bill.apvNumber } },
      select: { id: true },
    })

    await db.checkBill.upsert({
      where: { checkId_apvNumber: { checkId, apvNumber: bill.apvNumber } },
      create: { checkId, apvNumber: bill.apvNumber, ...data },
      update: data,
    })

    if (existing) summary.updated++
    else summary.created++

    await writeAudit(db, {
      checkId,
      actorType: 'SYSTEM',
      action: existing ? 'bill_updated' : 'bill_imported',
      details: {
        source: 'WORKBOOK',
        apvNumber: bill.apvNumber,
        // The sheet is not decoration. Since 7 September the workbook separates
        // `BROKERAGE` from `local supplier`, and the supplier portal exposes
        // broker cheques on `POST /api/broker-checks/mark-available` rather
        // than `POST /api/checks/mark-available`. Nothing routes on it yet —
        // that is Plan 3, blocked on the portal's encoder account — so this is
        // recorded rather than acted on, and recorded on an append-only row so
        // the evidence for routing a bill later is not thrown away today.
        sourceSheet: bill.sheet,
        sourceRow: bill.row,
        // Recorded, not acted on. A human reading the trail should be able to
        // see that the workbook called this bill AVAILABLE and that the import
        // left the cheque's status exactly where it found it.
        financeRemark: bill.financeRemark,
        cashAccountLabel: bill.cashAccountLabel,
        // How this bill found this cheque, and what the workbook actually
        // printed where the cheque number belongs. Recorded on every row, not
        // only the resolved ones, so the ordinary case is legible beside the
        // exception rather than the exception being the only one described.
        matchedOn,
        statedCheckRef: bill.statedCheckRef,
        ...(matchedOn === 'APV' ? { basis: BILL_CHECK_REF_RULING } : {}),
        at: args.now.toISOString(),
      },
      remarks:
        `Bill ${bill.apvNumber} ${existing ? 'updated' : 'imported'} from the approval-for-release ` +
        `workbook (${bill.sheet} row ${bill.row}). Release status unchanged.` +
        (matchedOn === 'APV'
          ? ` Its check No. cell held ${bill.statedCheckRef ?? 'nothing'}, which is not a check ` +
            `number, so the bill was matched to this check by its voucher ${bill.apvNumber} — the ` +
            `only check carrying it. ${BILL_CHECK_REF_RULING}.`
          : ''),
    })
  }

  const staging = await stageBills(db, { matched, review: args.review, unmatched })

  return { ...summary, ...staging }
}
