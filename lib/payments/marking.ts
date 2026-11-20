/**
 * OTHER PAYMENTS' markings (user, 2026-11-20: "Processing also can be done
 * here. Should have markings like processed, cleared, on process").
 *
 *   ON PROCESS  the payment is being prepared (application, approval, documents)
 *   PROCESSED   sent to the bank
 *   CLEARED     the bank has debited the account
 *
 * CANCELLED is not a marking anybody sets: it is what a payment Acumatica
 * voided reads as, whatever its marking (`displayMarking`). Follow Acumatica.
 *
 * Any marking may be set from any other - Finance corrects its own entries -
 * but a move BACKWARD needs a remark saying why, and drops the dates of the
 * stages it leaves. Pure: no database, no clock.
 */
import { isIsoDay } from '@/lib/domain/details'

export const PAYMENT_MARKINGS = ['ON_PROCESS', 'PROCESSED', 'CLEARED'] as const
export type Marking = (typeof PAYMENT_MARKINGS)[number]

export const MARKING_LABELS: Readonly<Record<Marking, string>> = {
  ON_PROCESS: 'ON PROCESS',
  PROCESSED: 'PROCESSED',
  CLEARED: 'CLEARED',
}

export const CANCELLED_LABEL = 'CANCELLED'
/** Every value the MARKING column can show, in ladder order. */
export const DISPLAY_MARKINGS = [...PAYMENT_MARKINGS.map((m) => MARKING_LABELS[m]), CANCELLED_LABEL] as const

export function isMarking(value: string): value is Marking {
  return (PAYMENT_MARKINGS as readonly string[]).includes(value)
}

/** What a reader sees: the marking, or CANCELLED for a payment Acumatica voided. */
export function displayMarking(p: { marking: Marking; voided: boolean }): string {
  return p.voided ? CANCELLED_LABEL : MARKING_LABELS[p.marking]
}

const RANK: Readonly<Record<Marking, number>> = { ON_PROCESS: 0, PROCESSED: 1, CLEARED: 2 }

export type MarkingRequest = {
  marking: Marking
  /** YYYY-MM-DD or ''. The day it was sent (PROCESSED) or debited (CLEARED). */
  date: string
  bankReference: string
  remarks: string
}

export type MarkingState = {
  marking: Marking
  voided: boolean
  /** YYYY-MM-DD or null. */
  processedDate: string | null
  clearedDate: string | null
  bankReference: string | null
  remarks: string | null
}

export type MarkingChange = {
  marking: Marking
  processedDate: string | null
  clearedDate: string | null
  bankReference: string | null
  remarks: string | null
}

export type MarkingVerdict =
  | { ok: true; change: MarkingChange }
  /** Nothing would change; not a refusal, and nothing is written. */
  | { ok: true; change: null }
  | { ok: false; code: string; message: string }

/**
 * Refusals that concern the request alone, checked once before any payment is
 * looked at. `today` is the Manila day (YYYY-MM-DD).
 */
export function checkMarkingRequest(req: { marking: string; date: string }, today: string): { ok: true } | { ok: false; code: string; message: string } {
  if (!isMarking(req.marking)) return { ok: false, code: 'UNKNOWN_MARKING', message: 'Choose a marking: ON PROCESS, PROCESSED or CLEARED.' }
  const date = req.date.trim()
  if (date !== '') {
    if (!isIsoDay(date)) {
      return { ok: false, code: 'INVALID_DATE', message: 'The date must be a day, YYYY-MM-DD.' }
    }
    if (date > today) return { ok: false, code: 'FUTURE_DATE', message: 'The date cannot be in the future.' }
    if (req.marking === 'ON_PROCESS') return { ok: false, code: 'DATE_NOT_USED', message: 'ON PROCESS takes no date. Clear the date, or choose PROCESSED or CLEARED.' }
  } else if (req.marking === 'CLEARED') {
    return { ok: false, code: 'CLEARED_DATE_REQUIRED', message: 'CLEARED needs the day the bank debited the account.' }
  }
  return { ok: true }
}

/** One payment against a request that already passed `checkMarkingRequest`. */
export function planMarking(state: MarkingState, req: MarkingRequest): MarkingVerdict {
  if (state.voided) {
    return { ok: false, code: 'VOIDED_IN_ACUMATICA', message: 'Voided in Acumatica; it reads CANCELLED and takes no marking.' }
  }
  const date = req.date.trim() || null
  const bankReference = req.bankReference.trim() || null
  const remarks = req.remarks.trim() || null
  const backward = RANK[req.marking] < RANK[state.marking]
  if (backward && remarks === null) {
    return {
      ok: false, code: 'REMARKS_REQUIRED',
      message: `Moving back from ${MARKING_LABELS[state.marking]} to ${MARKING_LABELS[req.marking]} needs a remark saying why.`,
    }
  }

  const change: MarkingChange = {
    marking: req.marking,
    // A stage the payment is no longer at keeps no date; a stage it is at or
    // past keeps the date it has unless this request states one for it.
    processedDate:
      req.marking === 'ON_PROCESS' ? null
      : req.marking === 'PROCESSED' ? (date ?? state.processedDate)
      : state.processedDate,
    clearedDate: req.marking === 'CLEARED' ? (date ?? state.clearedDate) : null,
    // A blank box changes nothing: a bulk marking must not wipe references typed earlier.
    bankReference: bankReference ?? state.bankReference,
    remarks: remarks ?? state.remarks,
  }
  const same =
    change.marking === state.marking && change.processedDate === state.processedDate &&
    change.clearedDate === state.clearedDate && change.bankReference === state.bankReference &&
    change.remarks === state.remarks
  return { ok: true, change: same ? null : change }
}
