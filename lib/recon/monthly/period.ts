import { toCentavos, fromCentavos } from '@/lib/export/report'

/**
 * THE MONTHLY RECONCILIATION'S RULES — months, amounts and the status ladder.
 * Pure: no database, no clock (the caller passes `now`'s Manila day). The
 * actions in `actions.ts` call these and refuse with the code they return.
 */

export type ReconStatus = 'DRAFT' | 'FOR_REVIEW' | 'FOR_APPROVAL' | 'RECONCILED' | 'CLOSED'
export const RECON_STATUSES: readonly ReconStatus[] = ['DRAFT', 'FOR_REVIEW', 'FOR_APPROVAL', 'RECONCILED', 'CLOSED']
export const STATUS_LABEL: Record<ReconStatus, string> = {
  DRAFT: 'DRAFT', FOR_REVIEW: 'FOR REVIEW', FOR_APPROVAL: 'FOR APPROVAL', RECONCILED: 'RECONCILED', CLOSED: 'CLOSED',
}
/** Approved: figures frozen, never recomputed. */
export const APPROVED_STATUSES: readonly ReconStatus[] = ['RECONCILED', 'CLOSED']
export const isApproved = (s: ReconStatus) => APPROVED_STATUSES.includes(s)

// ─── months ───────────────────────────────────────────────────────────────

/** `YYYY-MM`. */
export type Month = string
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/

export function isMonth(s: string): boolean {
  return MONTH.test(s) && Number(s.slice(0, 4)) >= 2000
}

/** The 1st of the month as the UTC-midnight instant every date column stores. */
export function monthStart(month: Month): Date {
  return new Date(`${month}-01T00:00:00.000Z`)
}

export function monthOf(d: Date): Month {
  return d.toISOString().slice(0, 7)
}

/** `YYYY-MM-DD` of the 1st and of the last day. */
export function firstDay(month: Month): string {
  return `${month}-01`
}
export function lastDay(month: Month): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m, 0))
  return d.toISOString().slice(0, 10)
}

export function nextMonth(month: Month): Month {
  const [y, m] = month.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}
export function previousMonth(month: Month): Month {
  const [y, m] = month.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER']
export function monthLabel(month: Month): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
}

/** A day (`YYYY-MM-DD`) inside the month. */
export function inMonth(day: string, month: Month): boolean {
  return day.slice(0, 7) === month
}

// ─── amounts (rule 8: decimal strings, centavo arithmetic) ─────────────────

const AMOUNT = /^-?\d{1,16}(\.\d{1,2})?$/

/**
 * A typed amount: commas and spaces dropped, at most two decimals, at most
 * 16 integer digits (Decimal(18,2)). Null when it is not one — never a guess,
 * never a float.
 */
export function parseAmount(raw: string, opts: { allowNegative?: boolean } = {}): string | null {
  const s = raw.replace(/[,\s]/g, '').replace(/^\+/, '')
  if (!AMOUNT.test(s)) return null
  if (s.startsWith('-') && !opts.allowNegative) return null
  return fromCentavos(toCentavos(s))
}

export const add = (...xs: string[]): string => fromCentavos(xs.reduce((n, x) => n + toCentavos(x), 0n))
export const sub = (a: string, b: string): string => fromCentavos(toCentavos(a) - toCentavos(b))
export const neg = (a: string): string => fromCentavos(-toCentavos(a))
export const isZero = (a: string): boolean => toCentavos(a) === 0n
export const sameAmount = (a: string, b: string): boolean => toCentavos(a) === toCentavos(b)
export const sum = (xs: readonly string[]): string => add('0', ...xs)

// ─── the ladder ───────────────────────────────────────────────────────────

export type ReconActor = { id: string; role: 'FINANCE_USER' | 'FINANCE_ADMIN' }
export type WorkflowPeriod = {
  status: ReconStatus
  submittedById: string | null
  reviewedById: string | null
  statementEndingBalance: string | null
  difference: string
  /** The month before is RECONCILED or CLOSED, or there is none (the first period). */
  previousApproved: boolean
  previousClosed: boolean
}
export type WorkflowAction = 'SUBMIT' | 'REVIEW' | 'RETURN' | 'APPROVE' | 'CLOSE'
export type Refusal = { ok: false; code: string; message: string }
export type Verdict = { ok: true; to: ReconStatus } | Refusal

const refuse = (code: string, message: string): Refusal => ({ ok: false, code, message })

/**
 * Who may move a period, and where to. Separation of duties: the reviewer is
 * not the preparer who submitted it, and the approver — a FINANCE_ADMIN — is
 * neither of them. Approval needs both adjusted balances equal to the centavo
 * and the month before already approved, so months are approved in order.
 */
export function workflowVerdict(action: WorkflowAction, p: WorkflowPeriod, actor: ReconActor): Verdict {
  switch (action) {
    case 'SUBMIT':
      if (p.status !== 'DRAFT') return refuse('NOT_DRAFT', 'Only a DRAFT reconciliation can be submitted for review.')
      if (p.statementEndingBalance === null) {
        return refuse('NO_STATEMENT_BALANCE', 'Enter the bank statement ending balance before submitting.')
      }
      return { ok: true, to: 'FOR_REVIEW' }
    case 'REVIEW':
      if (p.status !== 'FOR_REVIEW') return refuse('NOT_FOR_REVIEW', 'This reconciliation is not waiting for review.')
      if (p.submittedById === actor.id) {
        return refuse('SAME_PERSON', 'The person who submitted a reconciliation cannot review it.')
      }
      return { ok: true, to: 'FOR_APPROVAL' }
    case 'RETURN':
      if (p.status !== 'FOR_REVIEW' && p.status !== 'FOR_APPROVAL') {
        return refuse('NOT_IN_REVIEW', 'Only a reconciliation under review or approval can be returned to draft.')
      }
      if (p.status === 'FOR_APPROVAL' && actor.role !== 'FINANCE_ADMIN') {
        return refuse('ADMIN_ONLY', 'Only a Finance Admin can return a reconciliation that is waiting for approval.')
      }
      return { ok: true, to: 'DRAFT' }
    case 'APPROVE':
      if (p.status !== 'FOR_APPROVAL') return refuse('NOT_FOR_APPROVAL', 'This reconciliation is not waiting for approval.')
      if (actor.role !== 'FINANCE_ADMIN') return refuse('ADMIN_ONLY', 'Only a Finance Admin can approve a reconciliation.')
      if (p.submittedById === actor.id || p.reviewedById === actor.id) {
        return refuse('SAME_PERSON', 'The approver must be someone other than the person who submitted or reviewed it.')
      }
      if (!p.previousApproved) {
        return refuse('PREVIOUS_NOT_APPROVED', 'Approve the previous month first — months are reconciled in order.')
      }
      if (!isZero(p.difference)) {
        return refuse('NOT_BALANCED', `The adjusted bank and book balances differ by ${p.difference}. A reconciliation is approved only when they are equal.`)
      }
      return { ok: true, to: 'RECONCILED' }
    case 'CLOSE':
      if (p.status !== 'RECONCILED') return refuse('NOT_RECONCILED', 'Only a RECONCILED month can be closed.')
      if (actor.role !== 'FINANCE_ADMIN') return refuse('ADMIN_ONLY', 'Only a Finance Admin can close a month.')
      if (!p.previousClosed) return refuse('PREVIOUS_NOT_CLOSED', 'Close the previous month first.')
      return { ok: true, to: 'CLOSED' }
  }
}

/**
 * Re-opening an approved month. Asked by a FINANCE_ADMIN with a reason,
 * approved by a DIFFERENT one. Refused while the month after it has moved past
 * DRAFT: re-opening it would change the beginning balance of a month already
 * under review or approved — re-open that month first.
 */
export function reopenRequestVerdict(
  p: { status: ReconStatus; nextStatus: ReconStatus | null; hasPendingRequest: boolean },
  actor: ReconActor, reason: string,
): { ok: true } | Refusal {
  if (!isApproved(p.status)) return refuse('NOT_APPROVED', 'Only a RECONCILED or CLOSED month can be re-opened.')
  if (actor.role !== 'FINANCE_ADMIN') return refuse('ADMIN_ONLY', 'Only a Finance Admin can ask to re-open a month.')
  if (reason.trim() === '') return refuse('REASON_REQUIRED', 'Say why the month must be re-opened.')
  if (p.hasPendingRequest) return refuse('ALREADY_REQUESTED', 'A request to re-open this month is already waiting for approval.')
  if (p.nextStatus !== null && p.nextStatus !== 'DRAFT') {
    return refuse('NEXT_MONTH_MOVED', 'The following month is already under review or approved. Re-open it first.')
  }
  return { ok: true }
}

export function reopenDecisionVerdict(
  request: { status: 'PENDING' | 'APPROVED' | 'REJECTED'; requestedById: string },
  actor: ReconActor, decision: 'APPROVE' | 'REJECT', note: string,
): { ok: true } | Refusal {
  if (request.status !== 'PENDING') return refuse('NOT_PENDING', 'This request has already been decided.')
  if (actor.role !== 'FINANCE_ADMIN') return refuse('ADMIN_ONLY', 'Only a Finance Admin can decide a re-open request.')
  if (request.requestedById === actor.id) {
    return refuse('SAME_PERSON', 'A re-open request must be decided by a Finance Admin other than the one who asked.')
  }
  if (decision === 'REJECT' && note.trim() === '') return refuse('NOTE_REQUIRED', 'Say why the request is rejected.')
  return { ok: true }
}

/** A new period may not start in a month that has not begun (Manila). */
export function monthHasBegun(month: Month, todayManila: string): boolean {
  return firstDay(month) <= todayManila
}
