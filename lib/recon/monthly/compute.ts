import type { CheckStatus, ClearingStatus } from '@/lib/domain/check-status'
import { issuedOn, clearedOn, isOutstandingAsOf } from '@/lib/recon/outstanding'
import { daysBetween } from '@/lib/recon/summary'
import { toCentavos, fromCentavos } from '@/lib/export/report'
import { add, sub, neg, sum, isZero, sameAmount, firstDay, lastDay, inMonth, type Month } from './period'

/**
 * ONE MONTH'S RECONCILIATION, COMPUTED. Pure: rows in, figures out. The period
 * page, the dashboard, the export and the approval snapshot all call this over
 * the same rows, so they cannot disagree.
 *
 * NOTHING IS CARRIED BY COPYING. Every reconciling item is decided by its own
 * dates against this month's last day, which is what makes the carry-forward
 * complete and duplicate-free at once:
 *
 * - OUTSTANDING CHECKS — `isOutstandingAsOf` (lib/recon/outstanding.ts, the
 *   rule /recon already uses): released by the month's end and not cleared by
 *   it. A cheque released in March and still uncleared in May is outstanding
 *   in March, April and May, and released (a book deduction) only in March.
 *   It leaves the list when the bank clears it or it is voided — never because
 *   a month began.
 * - DEPOSITS IN TRANSIT — a DEPOSIT book entry dated by the month's end whose
 *   statement line (if any) is dated after it. Recorded once, in the month it
 *   was booked.
 * - BANK-SIDE ADJUSTMENTS and BANK_ERROR lines — open from the month they were
 *   recorded until the month they are resolved.
 * - Bank charges, unrecorded credits, unidentified lines and book adjustments
 *   belong to their own month only: they are book-side corrections, and the
 *   month's ending book balance — the next month's beginning — includes them.
 *
 * THE TWO CALCULATIONS (the client's formula):
 *   Bank statement ending balance + deposits in transit − outstanding checks
 *     − outstanding non-cheque disbursements ± other bank adjustments
 *     = ADJUSTED BANK BALANCE
 *   Book ending balance + bank credits not yet recorded − bank charges and
 *     other unrecorded debits ± other book adjustments
 *     = ADJUSTED BOOK BALANCE
 * Reconciled when the two are equal to the centavo.
 */

export type ComputeCheck = {
  id: string
  checkNumber: string
  payee: string | null
  amount: string
  checkDate: Date | null
  releasedAt: Date | null
  clearingStatus: ClearingStatus
  clearedDate: Date | null
  status: CheckStatus
}

export type LineKind =
  | 'CHECK' | 'BOOK_ENTRY' | 'BANK_CHARGE' | 'BANK_CREDIT'
  | 'UNIDENTIFIED_DEBIT' | 'UNIDENTIFIED_CREDIT' | 'BANK_ERROR'

export type ComputeLine = {
  id: string
  /** The period the line was uploaded to. */
  month: Month
  lineDay: string
  description: string
  reference: string | null
  checkNumber: string | null
  debit: string | null
  credit: string | null
  kind: LineKind
  matchMethod: 'AUTO' | 'MANUAL' | null
  checkId: string | null
  bookEntryId: string | null
  remarks: string | null
  resolvedMonth: Month | null
  resolution: string | null
}

export type ComputeBookEntry = {
  id: string
  month: Month
  kind: 'DEPOSIT' | 'DISBURSEMENT'
  entryDay: string
  amount: string
  reference: string
  description: string | null
  /** The day of the statement line matched to it, if any. */
  matchedLineDay: string | null
  matchedLineId: string | null
}

export type ComputeAdjustment = {
  id: string
  month: Month
  side: 'BANK' | 'BOOK'
  direction: 'ADD' | 'LESS'
  amount: string
  description: string
  reference: string | null
  resolvedMonth: Month | null
  resolution: string | null
}

export type ComputeInput = {
  month: Month
  /** The account's first reconciliation month (its beginning balance date). */
  openingMonth: Month
  beginningBank: string
  beginningBook: string
  statementBeginningBalance: string | null
  statementEndingBalance: string | null
  /** RELEASED real cheques of the account, in the period's currency, with an amount. */
  checks: readonly ComputeCheck[]
  /** Every line of the account in this month or an earlier one. */
  lines: readonly ComputeLine[]
  /** Every book entry of the account dated on or before the month's end. */
  bookEntries: readonly ComputeBookEntry[]
  /** Every adjustment of the account recorded in this month or an earlier one. */
  adjustments: readonly ComputeAdjustment[]
}

export type CheckItem = {
  id: string
  checkNumber: string
  payee: string | null
  amount: string
  issuedDay: string | null
  basis: 'RELEASED AT' | 'CHECK DATE' | null
  clearedDay: string | null
  daysOutstanding: number | null
  /** Released before the account's first reconciliation month. */
  beforeOpening: boolean
}

export type VarianceHint = { kind: string; message: string; amount: string | null; ref: string | null }

export type ReconComputation = {
  month: Month
  figures: {
    beginningBank: string
    beginningBook: string
    totalBankCredits: string
    totalBankDebits: string
    /** Beginning + credits − debits from the uploaded lines. */
    computedEndingBank: string
    statementEndingBalance: string | null
    /** The stated balance when entered, else the computed one. */
    endingBank: string
    /** Stated − computed, when lines were uploaded and a balance stated; null otherwise. */
    statementFootingDifference: string | null
    /** Statement's own beginning − carried beginning, when the statement states one. */
    statementBeginningDifference: string | null
    totalBookDeposits: string
    totalBookDisbursements: string
    totalChecksReleased: string
    totalClearedChecks: string
    totalOutstandingChecks: string
    depositsInTransit: string
    outstandingDisbursements: string
    bankCharges: string
    unidentifiedDebits: string
    bankCreditsUnrecorded: string
    unidentifiedCredits: string
    /** Signed: + adds to the bank balance. Adjustments and open BANK_ERROR lines. */
    bankAdjustments: string
    /** Signed: + adds to the book balance. */
    bookAdjustments: string
    /** Beginning book + deposits − non-cheque disbursements − checks released. */
    bookBalanceBeforeAdjustments: string
    adjustedBank: string
    adjustedBook: string
    /** The ending book balance carried forward: the book balance after this month's adjustments. */
    endingBook: string
    /** Adjusted bank − adjusted book. Zero means reconciled. */
    difference: string
  }
  counts: {
    checksReleased: number
    clearedChecks: number
    outstandingChecks: number
    outstandingBeforeOpening: number
    depositsInTransit: number
    unidentified: number
    lines: number
  }
  released: CheckItem[]
  cleared: CheckItem[]
  outstanding: CheckItem[]
  depositsInTransit: ComputeBookEntry[]
  outstandingDisbursements: ComputeBookEntry[]
  bookEntries: ComputeBookEntry[]
  lines: ComputeLine[]
  /** Open BANK_ERROR lines from earlier months, still reversed out of the bank balance. */
  carriedBankErrors: ComputeLine[]
  /** UNIDENTIFIED lines from earlier months nobody has yet explained. Information only. */
  carriedUnidentified: ComputeLine[]
  bankAdjustments: (ComputeAdjustment & { carried: boolean })[]
  bookAdjustments: ComputeAdjustment[]
  variance: VarianceHint[]
}

const amountOf = (l: Pick<ComputeLine, 'debit' | 'credit'>) => l.debit ?? l.credit ?? '0.00'
/** A line as it moves the bank balance: credit +, debit −. */
const bankEffect = (l: Pick<ComputeLine, 'debit' | 'credit'>) => (l.credit ? l.credit : neg(l.debit ?? '0.00'))
const signed = (a: Pick<ComputeAdjustment, 'direction' | 'amount'>) => (a.direction === 'ADD' ? a.amount : neg(a.amount))
const openIn = (month: Month, resolvedMonth: Month | null) => resolvedMonth === null || resolvedMonth > month

function checkItem(c: ComputeCheck, endDay: string, openingStart: string): CheckItem {
  const issued = issuedOn(c)
  const cleared = clearedOn(c)
  return {
    id: c.id, checkNumber: c.checkNumber, payee: c.payee, amount: c.amount,
    issuedDay: issued?.day ?? null, basis: issued?.basis ?? null,
    clearedDay: cleared === 'UNKNOWN' ? null : cleared,
    daysOutstanding: issued ? daysBetween(issued.day, endDay) : null,
    beforeOpening: issued !== null && issued.day < openingStart,
  }
}

export function computeReconciliation(input: ComputeInput): ReconComputation {
  const { month } = input
  const startDay = firstDay(month)
  const endDay = lastDay(month)
  const openingStart = firstDay(input.openingMonth)

  // ── bank statement ──────────────────────────────────────────────────────
  const lines = input.lines.filter((l) => l.month === month).sort((a, b) => a.lineDay.localeCompare(b.lineDay))
  const totalBankCredits = sum(lines.filter((l) => l.credit).map((l) => l.credit!))
  const totalBankDebits = sum(lines.filter((l) => l.debit).map((l) => l.debit!))
  const computedEndingBank = sub(add(input.beginningBank, totalBankCredits), totalBankDebits)
  const endingBank = input.statementEndingBalance ?? computedEndingBank
  const statementFootingDifference = lines.length > 0 && input.statementEndingBalance !== null
    ? sub(input.statementEndingBalance, computedEndingBank) : null
  const statementBeginningDifference = input.statementBeginningBalance !== null
    ? sub(input.statementBeginningBalance, input.beginningBank) : null

  // ── cheques ─────────────────────────────────────────────────────────────
  const released: CheckItem[] = []
  const cleared: CheckItem[] = []
  const outstanding: CheckItem[] = []
  for (const c of input.checks) {
    const issued = issuedOn(c)
    const clearedDay = clearedOn(c)
    // A cheque issued before the opening month is already inside the opening
    // book balance: it is never "released" in a reconciliation month.
    if (issued && inMonth(issued.day, month) && issued.day >= openingStart) released.push(checkItem(c, endDay, openingStart))
    if (typeof clearedDay === 'string' && clearedDay !== 'UNKNOWN' && inMonth(clearedDay, month)) cleared.push(checkItem(c, endDay, openingStart))
    if (isOutstandingAsOf(c, endDay)) outstanding.push(checkItem(c, endDay, openingStart))
  }
  const byIssue = (a: CheckItem, b: CheckItem) => (a.issuedDay ?? '').localeCompare(b.issuedDay ?? '') || a.checkNumber.localeCompare(b.checkNumber)
  released.sort(byIssue); cleared.sort(byIssue); outstanding.sort(byIssue)
  const totalChecksReleased = sum(released.map((c) => c.amount))
  const totalClearedChecks = sum(cleared.map((c) => c.amount))
  const totalOutstandingChecks = sum(outstanding.map((c) => c.amount))

  // ── book entries ────────────────────────────────────────────────────────
  const entries = input.bookEntries.filter((e) => e.entryDay <= endDay)
  const thisMonthEntries = entries.filter((e) => e.month === month)
  // Booked this month: dated inside it (opening items dated before the first month are not).
  const bookedNow = thisMonthEntries.filter((e) => e.entryDay >= startDay)
  const totalBookDeposits = sum(bookedNow.filter((e) => e.kind === 'DEPOSIT').map((e) => e.amount))
  const totalBookDisbursements = sum(bookedNow.filter((e) => e.kind === 'DISBURSEMENT').map((e) => e.amount))
  const inTransit = (e: ComputeBookEntry) => e.matchedLineDay === null || e.matchedLineDay > endDay
  const depositsInTransit = entries.filter((e) => e.kind === 'DEPOSIT' && inTransit(e))
  const outstandingDisbursements = entries.filter((e) => e.kind === 'DISBURSEMENT' && inTransit(e))
  const ditTotal = sum(depositsInTransit.map((e) => e.amount))
  const odTotal = sum(outstandingDisbursements.map((e) => e.amount))

  // ── classified lines (book side, this month only) ───────────────────────
  const ofKind = (k: LineKind) => lines.filter((l) => l.kind === k).map(amountOf)
  const bankCharges = sum(ofKind('BANK_CHARGE'))
  const unidentifiedDebits = sum(ofKind('UNIDENTIFIED_DEBIT'))
  const bankCreditsUnrecorded = sum(ofKind('BANK_CREDIT'))
  const unidentifiedCredits = sum(ofKind('UNIDENTIFIED_CREDIT'))

  // ── adjustments ─────────────────────────────────────────────────────────
  const bankAdjustments = input.adjustments
    .filter((a) => a.side === 'BANK' && a.month <= month && openIn(month, a.resolvedMonth))
    .map((a) => ({ ...a, carried: a.month < month }))
  const bankErrorsOpen = input.lines.filter((l) => l.kind === 'BANK_ERROR' && l.month <= month && openIn(month, l.resolvedMonth))
  const carriedBankErrors = bankErrorsOpen.filter((l) => l.month < month)
  // A bank error is reversed out: a wrong credit comes off, a wrong debit goes back.
  const bankAdjNet = add(
    sum(bankAdjustments.map(signed)),
    sum(bankErrorsOpen.map((l) => neg(bankEffect(l)))),
  )
  const bookAdjustments = input.adjustments.filter((a) => a.side === 'BOOK' && a.month === month)
  const bookAdjNet = sum(bookAdjustments.map(signed))
  const carriedUnidentified = input.lines.filter((l) =>
    (l.kind === 'UNIDENTIFIED_DEBIT' || l.kind === 'UNIDENTIFIED_CREDIT') && l.month < month && openIn(month, l.resolvedMonth))

  // ── the two calculations ────────────────────────────────────────────────
  const bookBalanceBeforeAdjustments = sub(sub(add(input.beginningBook, totalBookDeposits), totalBookDisbursements), totalChecksReleased)
  const adjustedBank = add(sub(sub(add(endingBank, ditTotal), totalOutstandingChecks), odTotal), bankAdjNet)
  const adjustedBook = add(
    sub(sub(add(add(bookBalanceBeforeAdjustments, bankCreditsUnrecorded), unidentifiedCredits), bankCharges), unidentifiedDebits),
    bookAdjNet,
  )
  const difference = sub(adjustedBank, adjustedBook)

  const result: ReconComputation = {
    month,
    figures: {
      beginningBank: input.beginningBank, beginningBook: input.beginningBook,
      totalBankCredits, totalBankDebits, computedEndingBank,
      statementEndingBalance: input.statementEndingBalance, endingBank,
      statementFootingDifference, statementBeginningDifference,
      totalBookDeposits, totalBookDisbursements, totalChecksReleased, totalClearedChecks, totalOutstandingChecks,
      depositsInTransit: ditTotal, outstandingDisbursements: odTotal,
      bankCharges, unidentifiedDebits, bankCreditsUnrecorded, unidentifiedCredits,
      bankAdjustments: bankAdjNet, bookAdjustments: bookAdjNet,
      bookBalanceBeforeAdjustments, adjustedBank, adjustedBook, endingBook: adjustedBook, difference,
    },
    counts: {
      checksReleased: released.length, clearedChecks: cleared.length, outstandingChecks: outstanding.length,
      outstandingBeforeOpening: outstanding.filter((c) => c.beforeOpening).length,
      depositsInTransit: depositsInTransit.length,
      unidentified: lines.filter((l) => l.kind === 'UNIDENTIFIED_DEBIT' || l.kind === 'UNIDENTIFIED_CREDIT').length,
      lines: lines.length,
    },
    released, cleared, outstanding,
    depositsInTransit, outstandingDisbursements, bookEntries: thisMonthEntries,
    lines, carriedBankErrors, carriedUnidentified,
    bankAdjustments, bookAdjustments,
    variance: [],
  }
  result.variance = explainVariance(result, input)
  return result
}

/**
 * WHERE A DIFFERENCE COMES FROM. Not a guess at the answer: each hint is a
 * fact about the month that is known to produce a difference, or an item whose
 * amount equals the difference (or half of it — the sign of an item entered
 * the wrong way round). Listed whether or not the month balances, because a
 * statement that does not foot is wrong even when something else offsets it.
 */
export function explainVariance(r: ReconComputation, input: ComputeInput): VarianceHint[] {
  const hints: VarianceHint[] = []
  const f = r.figures
  if (f.statementFootingDifference !== null && !isZero(f.statementFootingDifference)) {
    hints.push({
      kind: 'STATEMENT_DOES_NOT_FOOT', amount: f.statementFootingDifference, ref: null,
      message: `The uploaded lines take the beginning balance to ${f.computedEndingBank}, but the statement ending balance entered is ${f.statementEndingBalance}. A line is missing, doubled, or the balance was typed wrong.`,
    })
  }
  if (f.statementBeginningDifference !== null && !isZero(f.statementBeginningDifference)) {
    hints.push({
      kind: 'BEGINNING_MISMATCH', amount: f.statementBeginningDifference, ref: null,
      message: `The statement's own beginning balance differs from the carried beginning bank balance ${f.beginningBank}.`,
    })
  }
  const checksById = new Map(input.checks.map((c) => [c.id, c]))
  const entriesById = new Map(input.bookEntries.map((e) => [e.id, e]))
  for (const l of r.lines) {
    if (l.kind === 'CHECK' && l.checkId) {
      const c = checksById.get(l.checkId)
      if (c && !sameAmount(c.amount, amountOf(l))) {
        hints.push({
          kind: 'CHECK_AMOUNT_DIFFERS', amount: sub(amountOf(l), c.amount), ref: c.checkNumber,
          message: `Check ${c.checkNumber} is ${c.amount} here and ${amountOf(l)} on the statement (${l.lineDay}).`,
        })
      }
      const cd = c ? clearedOn(c) : null
      if (c && typeof cd === 'string' && cd !== 'UNKNOWN' && !inMonth(cd, r.month)) {
        hints.push({
          kind: 'CLEARED_IN_ANOTHER_MONTH', amount: c.amount, ref: c.checkNumber,
          message: `Check ${c.checkNumber} is on this statement (${l.lineDay}) but was recorded as cleared on ${cd}.`,
        })
      }
    }
    if (l.kind === 'BOOK_ENTRY' && l.bookEntryId) {
      const e = entriesById.get(l.bookEntryId)
      if (e && !sameAmount(e.amount, amountOf(l))) {
        hints.push({
          kind: 'ENTRY_AMOUNT_DIFFERS', amount: sub(amountOf(l), e.amount), ref: e.reference,
          message: `Book entry ${e.reference} is ${e.amount}; the statement line it is matched to (${l.lineDay}) is ${amountOf(l)}.`,
        })
      }
    }
  }
  if (r.lines.length > 0) {
    const onStatement = new Set(r.lines.filter((l) => l.kind === 'CHECK').map((l) => l.checkId))
    for (const c of r.cleared) {
      if (!onStatement.has(c.id)) {
        hints.push({
          kind: 'CLEARED_NOT_ON_STATEMENT', amount: c.amount, ref: c.checkNumber,
          message: `Check ${c.checkNumber} is recorded as cleared on ${c.clearedDay}, but no line of this month's statement clears it.`,
        })
      }
    }
  }
  if (r.counts.unidentified > 0) {
    hints.push({
      kind: 'UNIDENTIFIED', amount: add(f.unidentifiedDebits, neg(f.unidentifiedCredits)), ref: null,
      message: `${r.counts.unidentified} statement line(s) are unidentified. They are carried in the book reconciliation, but should be explained.`,
    })
  }
  if (r.counts.outstandingBeforeOpening > 0) {
    const total = sum(r.outstanding.filter((c) => c.beforeOpening).map((c) => c.amount))
    hints.push({
      kind: 'OUTSTANDING_BEFORE_OPENING', amount: total, ref: null,
      message: `${r.counts.outstandingBeforeOpening} outstanding check(s), ${total}, were released before the beginning balance date. If the bank has paid them, record the clearing (CLEARING, or this statement); if not, the beginning balances should reflect them.`,
    })
  }
  if (!isZero(f.difference)) {
    const diffAbs = toCentavos(f.difference) < 0n ? -toCentavos(f.difference) : toCentavos(f.difference)
    const half = diffAbs % 2n === 0n ? diffAbs / 2n : null
    const candidates: { amount: string; ref: string; what: string }[] = [
      ...r.outstanding.map((c) => ({ amount: c.amount, ref: c.checkNumber, what: 'outstanding check' })),
      ...r.depositsInTransit.map((e) => ({ amount: e.amount, ref: e.reference, what: 'deposit in transit' })),
      ...r.outstandingDisbursements.map((e) => ({ amount: e.amount, ref: e.reference, what: 'outstanding disbursement' })),
      ...r.lines.map((l) => ({ amount: amountOf(l), ref: l.reference ?? l.checkNumber ?? l.description, what: `statement line ${l.lineDay}` })),
      ...r.bankAdjustments.map((a) => ({ amount: a.amount, ref: a.description, what: 'bank adjustment' })),
      ...r.bookAdjustments.map((a) => ({ amount: a.amount, ref: a.description, what: 'book adjustment' })),
    ]
    for (const c of candidates) {
      const cents = toCentavos(c.amount)
      if (cents === diffAbs) {
        hints.push({ kind: 'EQUALS_DIFFERENCE', amount: c.amount, ref: c.ref, message: `The ${c.what} ${c.ref} (${c.amount}) equals the difference.` })
      } else if (half !== null && cents === half) {
        hints.push({ kind: 'HALF_DIFFERENCE', amount: c.amount, ref: c.ref, message: `The ${c.what} ${c.ref} (${c.amount}) is half the difference — it may be entered on the wrong side.` })
      }
    }
  }
  return hints
}

/** The figures that are frozen into the period's columns on approval. */
export function frozenColumns(r: ReconComputation) {
  return {
    endingBankBalance: r.figures.endingBank,
    endingBookBalance: r.figures.endingBook,
    adjustedBankBalance: r.figures.adjustedBank,
    adjustedBookBalance: r.figures.adjustedBook,
    difference: r.figures.difference,
    totalOutstandingChecks: r.figures.totalOutstandingChecks,
    totalDepositsInTransit: r.figures.depositsInTransit,
    unidentifiedCount: r.counts.unidentified,
  }
}

export { fromCentavos }
