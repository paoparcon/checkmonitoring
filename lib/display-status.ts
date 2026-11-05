import type { CheckStatus, ClearingStatus, Prisma } from '@prisma/client'
import { LIVE_STATUSES } from './domain/check-status'

/**
 * CLEARED, as a status Finance reads (user request 2026-11-05: "add CLEARED
 * in the status").
 *
 * It is a STATUS ON SCREEN and not a rung of `CheckStatus`, deliberately. In
 * the database a cleared cheque stays RELEASED with `clearingStatus = CLEARED`
 * — the bank's fact recorded beside the release, by `recordClearing` only.
 * Keeping the ladder unchanged keeps every rule that reads RELEASED intact:
 * the portal outbox (`kindMatchesStatus`), REVERSE RELEASE (refused once a
 * clearing is recorded), the outstanding-cheques report (released and not
 * cleared), the sync's immutable list. A ninth enum value would have to be
 * taught to each of them, and one that was not would treat a cleared cheque
 * as unreleased.
 *
 * What changes is what a reader sees: the STATUS column, the STATUS filter,
 * the dashboard's cards and the export all say CLEARED for such a cheque, and
 * RELEASED there means released and NOT yet cleared — so the two never count
 * the same cheque. ALL CHECKS still holds both.
 */
export const CLEARED = 'CLEARED' as const
export type DisplayStatus = CheckStatus | typeof CLEARED

/** Every status a reader can pick, in ladder order, CLEARED straight after RELEASED. */
export const DISPLAY_STATUSES: readonly DisplayStatus[] = [
  ...LIVE_STATUSES, 'RELEASED', CLEARED, 'CANCELLED', 'VOIDED',
]

export function isDisplayStatus(value: string): value is DisplayStatus {
  return (DISPLAY_STATUSES as readonly string[]).includes(value)
}

/** The status a cheque is shown with. Only a RELEASED cheque the bank has cleared reads CLEARED. */
export function displayStatus(status: CheckStatus, clearingStatus: ClearingStatus | null | undefined): DisplayStatus {
  return status === 'RELEASED' && clearingStatus === 'CLEARED' ? CLEARED : status
}

/** The database condition for one shown status: the one definition the list, cards and filters use. */
export function displayStatusWhere(s: DisplayStatus): Prisma.CheckWhereInput {
  if (s === CLEARED) return { status: 'RELEASED', clearingStatus: 'CLEARED' }
  if (s === 'RELEASED') return { status: 'RELEASED', clearingStatus: { not: 'CLEARED' } }
  return { status: s }
}
