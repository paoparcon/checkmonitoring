import { candidateNumbers } from '@/lib/clearing-upload'
import { issuedOn, clearedOn } from '@/lib/recon/outstanding'
import type { CheckStatus, ClearingStatus } from '@/lib/domain/check-status'
import { sameAmount } from './period'
import type { LineKind } from './compute'
import type { ParsedLine } from './statement'

/**
 * AUTOMATIC MATCHING. Pure: the parsed lines, the account's cheques and its
 * open book entries in; one proposal per line out. Nothing here writes — the
 * preview shows every proposal and CONFIRM applies them.
 *
 * A DEBIT is a cleared cheque (AUTO) only when every one of these holds:
 *   - CHECK NUMBER: the line's check-number cell, else a 6–13 digit number
 *     standing alone in its description or reference (the reading /clearing
 *     uses), names a cheque of THIS account (book, else cash account);
 *   - AMOUNT: the debit equals the cheque's amount to the centavo;
 *   - DATE: the line is not dated before the cheque was issued;
 *   - the cheque is RELEASED, in the period's currency, and not cleared on any
 *     other day; no other line of the file claims it.
 * PAYEE is shown — whether the payee's name appears on the line — but never
 * decides, because banks rarely print it.
 * Anything short of that is a SUGGESTION with the reason, left UNIDENTIFIED
 * for a person to match by hand with a remark.
 *
 * A debit or credit is a BOOK ENTRY (AUTO) when exactly one open entry of the
 * same direction has the same amount and is dated on, or up to 10 days before,
 * the line. Otherwise a debit whose words say charge/fee/tax is a BANK CHARGE,
 * a credit whose words say interest is a BANK CREDIT, and the rest are
 * UNIDENTIFIED.
 */

export type MatchCheck = {
  id: string
  checkNumber: string
  payee: string | null
  amount: string | null
  currency: string
  checkDate: Date | null
  releasedAt: Date | null
  clearingStatus: ClearingStatus
  clearedDate: Date | null
  status: CheckStatus
  /** This account (book, else cash account) — false for a cheque of another account found by number. */
  inAccount: boolean
  accountCode: string | null
}

export type MatchEntry = { id: string; kind: 'DEPOSIT' | 'DISBURSEMENT'; entryDay: string; amount: string; reference: string }

export type Proposal = {
  kind: LineKind
  method: 'AUTO' | null
  checkId: string | null
  bookEntryId: string | null
  /** Why — shown on the preview beside the line. */
  note: string
  /** A cheque the line looks like but could not be matched to automatically. */
  suggestedCheckId: string | null
  /** The cheque is already CLEARED on this line's day: link only, no clearing written. */
  alreadyCleared: boolean
  payeeOnLine: boolean | null
}

const CHARGE = /\b(service charge|svc ?chg|serv(ice)? fee|bank charge|charges?|chg|fees?|commission|penalty|dst|doc(umentary)? stamps?|w\/?tax|withholding tax|tax withheld|maintaining balance|below maintaining|annual fee|handling fee)\b/i
const INTEREST = /\b(interest|int\.? (earned|income|credit)|credit memo)\b/i
const ENTRY_WINDOW_DAYS = 10

export const stripZeros = (n: string) => n.replace(/^0+(?=\d)/, '')

function daysAfter(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000)
}

function payeeAppears(payee: string | null, text: string): boolean | null {
  if (!payee) return null
  const words = payee.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 4 && !['CORP', 'CORPORATION', 'INC', 'PHILIPPINES', 'COMPANY', 'ENTERPRISES'].includes(w))
  if (words.length === 0) return null
  const t = text.toUpperCase()
  return words.some((w) => t.includes(w))
}

/** The cheque numbers a line names: its check-number cell first, then numbers in its words. */
export function lineCheckNumbers(l: Pick<ParsedLine, 'checkNumber' | 'description' | 'reference'>): string[] {
  const found = new Set<string>()
  if (l.checkNumber) found.add(stripZeros(l.checkNumber))
  for (const n of candidateNumbers(`${l.description} ${l.reference ?? ''}`)) found.add(stripZeros(n))
  return [...found]
}

export function proposeMatches(
  lines: readonly Pick<ParsedLine, 'lineDay' | 'description' | 'reference' | 'checkNumber' | 'debit' | 'credit'>[],
  checks: readonly MatchCheck[],
  entries: readonly MatchEntry[],
  currency: string,
): Proposal[] {
  const byNumber = new Map<string, MatchCheck[]>()
  for (const c of checks) {
    const key = stripZeros(c.checkNumber)
    byNumber.set(key, [...(byNumber.get(key) ?? []), c])
  }
  const claimedChecks = new Set<string>()
  const claimedEntries = new Set<string>()
  const none = (kind: LineKind, note: string, extra: Partial<Proposal> = {}): Proposal => ({
    kind, method: null, checkId: null, bookEntryId: null, note, suggestedCheckId: null, alreadyCleared: false, payeeOnLine: null, ...extra,
  })

  return lines.map((l) => {
    const amount = l.debit ?? l.credit!
    const text = `${l.description} ${l.reference ?? ''}`

    if (l.debit) {
      const numbers = lineCheckNumbers(l)
      const named = numbers.flatMap((n) => byNumber.get(n) ?? [])
      const mine = named.filter((c) => c.inAccount)
      if (mine.length > 1) return none('UNIDENTIFIED_DEBIT', `Names ${mine.length} checks of this account (${mine.map((c) => c.checkNumber).join(', ')}) — match by hand.`)
      const c = mine[0]
      if (c) {
        const payeeOnLine = payeeAppears(c.payee, text)
        const suggest = (note: string) => none('UNIDENTIFIED_DEBIT', note, { suggestedCheckId: c.id, payeeOnLine })
        if (claimedChecks.has(c.id)) return suggest(`Check ${c.checkNumber} is claimed by an earlier line of this file — a second presentment?`)
        if (c.status !== 'RELEASED') return suggest(`Check ${c.checkNumber} is ${c.status} here, not RELEASED.`)
        if (c.currency !== currency) return suggest(`Check ${c.checkNumber} is in ${c.currency}; this reconciliation is in ${currency}.`)
        if (c.amount === null) return suggest(`Check ${c.checkNumber} has no recorded amount.`)
        if (!sameAmount(c.amount, l.debit)) return suggest(`Check ${c.checkNumber} is ${c.amount} here; the line says ${l.debit}.`)
        const issued = issuedOn(c)
        if (issued && l.lineDay < issued.day) return suggest(`Check ${c.checkNumber} is dated/released ${issued.day}, after this line (${l.lineDay}).`)
        const cleared = clearedOn(c)
        if (cleared === 'UNKNOWN') return suggest(`Check ${c.checkNumber} is already CLEARED with no date recorded.`)
        if (cleared !== null && cleared !== l.lineDay) return suggest(`Check ${c.checkNumber} is already CLEARED on ${cleared}.`)
        claimedChecks.add(c.id)
        return {
          kind: 'CHECK', method: 'AUTO', checkId: c.id, bookEntryId: null, suggestedCheckId: null, payeeOnLine,
          alreadyCleared: cleared !== null,
          note: cleared !== null
            ? `Check ${c.checkNumber} — already cleared on this day; linked.`
            : `Check ${c.checkNumber} — number, amount and date agree; will be marked CLEARED on ${l.lineDay}.`,
        }
      }
      const elsewhere = named.find((c) => !c.inAccount)
      if (elsewhere) {
        return none('UNIDENTIFIED_DEBIT', `Check ${elsewhere.checkNumber} belongs to ${elsewhere.accountCode ?? 'another account'}, not this one.`)
      }
    }

    // Book entries: same direction, same amount, dated on or up to 10 days before the line.
    const kind = l.debit ? 'DISBURSEMENT' : 'DEPOSIT'
    const fits = entries.filter((e) => e.kind === kind && !claimedEntries.has(e.id) && sameAmount(e.amount, amount)
      && daysAfter(e.entryDay, l.lineDay) >= 0 && daysAfter(e.entryDay, l.lineDay) <= ENTRY_WINDOW_DAYS)
    if (fits.length === 1) {
      claimedEntries.add(fits[0].id)
      return {
        kind: 'BOOK_ENTRY', method: 'AUTO', checkId: null, bookEntryId: fits[0].id, suggestedCheckId: null,
        alreadyCleared: false, payeeOnLine: null,
        note: `${kind === 'DEPOSIT' ? 'Deposit' : 'Disbursement'} ${fits[0].reference} of ${fits[0].entryDay} — same amount.`,
      }
    }
    const several = fits.length > 1 ? ` ${fits.length} book entries have this amount — match by hand.` : ''
    if (l.debit) {
      return CHARGE.test(text)
        ? none('BANK_CHARGE', `Reads as a bank charge.${several}`)
        : none('UNIDENTIFIED_DEBIT', `No check or book entry found.${several}`)
    }
    return INTEREST.test(text)
      ? none('BANK_CREDIT', `Reads as interest / a credit memo.${several}`)
      : none('UNIDENTIFIED_CREDIT', `No book entry found.${several}`)
  })
}

export { classificationsFor, LINE_KIND_LABEL } from './labels'
