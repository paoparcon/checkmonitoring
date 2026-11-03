/**
 * AUTO-SIGN, THE RULE. User request 2026-10-16, replacing the 2026-10-01
 * "Monday's checks on Tuesday, the rest by SIGN ALL": "Monday - it will be
 * signed on tuesday. The rest of the day, will be signed on Monday." Spec
 * `2026-10-16-auto-sign-monday-and-tuesday-design.md`.
 *
 * Runs on a Manila MONDAY and a Manila TUESDAY. Each run signs every due check
 * first read before 00:00 Manila on the run's own day, with no lower bound: on
 * Monday that is last Tuesday to Sunday and any older backlog (user ruling
 * 2026-10-16); on Tuesday it is Monday's checks and anything Monday's runs did
 * not reach. Wednesday to Sunday sign nothing.
 *
 * "First read" is `createdAt` — when the sync first brought the check in —
 * because Acumatica publishes no creation timestamp and its one date,
 * PaymentDate, is post-dated on some checks.
 *
 * A check a person reverted (`signature_reverted`) is never signed by the
 * clock again: the next run would otherwise quietly undo the revert.
 *
 * The Philippines is UTC+8 with no daylight saving, so a fixed offset is
 * exact. Pure. No database, no clock: the caller passes `now`.
 */

export const AUTO_SIGNED_ACTION = 'auto_signed'
export const AUTO_SIGN_RUN_ACTION = 'auto_sign_run'
/** A person undid a signature. A check carrying one is never auto-signed again. */
export const SIGNATURE_REVERTED_ACTION = 'signature_reverted'

export type AutoSignRunDay = 'MONDAY' | 'TUESDAY'

const DAY_MS = 86_400_000
const MANILA_OFFSET_MS = 8 * 3_600_000
/** 1970-01-01 was a Thursday; with Sunday = 0 that is weekday 4. */
const EPOCH_WEEKDAY = 4
const MONDAY = 1
const TUESDAY = 2

export type AutoSignFacts = {
  status: string
  acumaticaPaymentId: string | null
  isCheque: boolean
  acumaticaStatus: string | null
  createdAt: Date
  /** Carries a `signature_reverted` audit row. */
  reverted: boolean
}

/** The Manila calendar day index (days since the epoch, in UTC+8) an instant falls on. */
function dayIndex(t: number): number {
  return Math.floor((t + MANILA_OFFSET_MS) / DAY_MS)
}

/** The UTC instant at which Manila day `index` begins. */
function dayStart(index: number): Date {
  return new Date(index * DAY_MS - MANILA_OFFSET_MS)
}

/** Which auto-sign run `now` falls on, by the Manila day; null Wednesday to Sunday. */
export function autoSignRunDay(now: Date): AutoSignRunDay | null {
  const weekday = (dayIndex(now.getTime()) + EPOCH_WEEKDAY) % 7
  if (weekday === MONDAY) return 'MONDAY'
  if (weekday === TUESDAY) return 'TUESDAY'
  return null
}

/** 00:00 Manila on `now`'s Manila day. A run signs checks first read before it. */
export function signingCutoff(now: Date): Date {
  return dayStart(dayIndex(now.getTime()))
}

export function isDueForAutoSign(c: AutoSignFacts, now: Date, enabled: boolean): boolean {
  if (!enabled) return false
  if (autoSignRunDay(now) === null) return false
  if (c.status !== 'SIGNATURE_PENDING') return false
  // Only what Acumatica generated. A register-only check waits for a person.
  if (c.acumaticaPaymentId === null) return false
  // DEBIT ADV and TT are never signed by anyone.
  if (!c.isCheque) return false
  // A voided payment is the sync's or a person's to settle, not the clock's.
  if (c.acumaticaStatus === 'Voided') return false
  if (c.reverted) return false
  return c.createdAt.getTime() < signingCutoff(now).getTime()
}
