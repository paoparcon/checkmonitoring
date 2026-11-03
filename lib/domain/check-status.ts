import { DomainError } from './errors'

export type CheckStatus =
  | 'GENERATED' | 'SIGNATURE_PENDING' | 'SIGNED'
  | 'READY_FOR_RELEASE' | 'SCHEDULED' | 'RELEASED' | 'CANCELLED' | 'VOIDED'

export type ClearingStatus = 'NONE' | 'DEPOSITED' | 'ENCASHED' | 'CLEARED'

// A check must be made available before it can be released, so SIGNED has no
// direct edge to RELEASED. SCHEDULED is optional: suppliers do collect without
// booking a slot in the portal.
//
// Acumatica can void a cheque at any point, including after Finance has
// released it. Refusing that transition would leave this system showing
// RELEASED for a cheque the ERP says no longer exists — the monitoring
// system disagreeing with the source of truth is worse than recording an
// uncomfortable fact. CANCELLED is excluded only because it is already a
// Finance decision with a recorded reason, so it has no void edge.
const TRANSITIONS: Record<CheckStatus, readonly CheckStatus[]> = {
  // SIGNED directly: a GENERATED cheque released at the counter is signed on
  // the way (`releaseDirectly`, client 2026-10-16).
  GENERATED:         ['SIGNATURE_PENDING', 'SIGNED', 'CANCELLED', 'VOIDED'],
  SIGNATURE_PENDING: ['SIGNED', 'CANCELLED', 'VOIDED'],
  // SIGNATURE_PENDING is the signature undone (client, 2026-10-01): any
  // Finance user, `revertSignature` in actions.ts. A cheque on the release
  // list goes back to SIGNED first, through `revertAvailability`.
  SIGNED:            ['READY_FOR_RELEASE', 'SIGNATURE_PENDING', 'CANCELLED', 'VOIDED'],
  READY_FOR_RELEASE: ['SCHEDULED', 'RELEASED', 'SIGNED', 'CANCELLED', 'VOIDED'],
  SCHEDULED:         ['RELEASED', 'SIGNED', 'CANCELLED', 'VOIDED'],
  // READY_FOR_RELEASE is the reversal: a FINANCE_ADMIN undoing a release that
  // was ticked by mistake goes back exactly one rung, to where the cheque was
  // available — never to SIGNED, which would withdraw it from the supplier.
  // `reverseRelease` in actions.ts refuses it when a receipt is on record or
  // the bank has cleared the cheque. RELEASED stays CLOSED for every scope;
  // this edge is a correction, not a stage.
  RELEASED:          ['READY_FOR_RELEASE', 'VOIDED'],
  // A cancellation can be undone (client, 2026-10-06): back to SIGNED, by
  // `restoreCancelled` in actions.ts, with a reason, and refused once the
  // portal has been told the cheque is cancelled.
  CANCELLED:         ['SIGNED'],
  VOIDED:            [],
}

export function canTransition(from: CheckStatus, to: CheckStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * The statuses at which a cheque has left the release workflow: the money has
 * moved, or it never will.
 *
 * Stated explicitly rather than derived from `TRANSITIONS`, because RELEASED
 * still has an outgoing edge (Acumatica can void a released cheque) and would
 * therefore read as "live" under a terminality test. Nor is it derived from the
 * enum's declaration order — Prisma will happily sort by that, and a future
 * reordering of the enum would silently re-rank every queue built on it.
 *
 * This is what makes the staged queue usable. Measured 2026-09-04: of the
 * register's 2,766 staged rows, 2,467 are RELEASED and 214 CANCELLED, leaving
 * about 28 that are actually live work. A queue that does not separate the two
 * buries the handful somebody has to do under two and a half thousand that
 * nobody does.
 */
export const CLOSED_STATUSES = ['RELEASED', 'CANCELLED', 'VOIDED'] as const satisfies readonly CheckStatus[]

export const LIVE_STATUSES = (
  ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED'] as const
) satisfies readonly CheckStatus[]

export function isLiveStatus(status: CheckStatus): boolean {
  return !(CLOSED_STATUSES as readonly CheckStatus[]).includes(status)
}

// Compile-time proof that the two lists above partition `CheckStatus` with
// nothing left over. The runtime test in check-status.test.ts checks the same
// thing, but against a hand-written `ALL` array that a ninth status would not
// automatically join — so it would keep passing while the partition silently
// developed a hole, and the staged queue would drop that status from every
// scope of itself.
//
// Type-only: erased entirely at build, costs nothing at runtime, and keeps this
// module free of imports. Same idiom as lib/status-bridge.ts. Adding a status
// to the union without adding it to one of the lists fails here with TS2344.
type AssertNever<T extends never> = T
export type _EveryStatusIsLiveOrClosed = AssertNever<
  Exclude<CheckStatus, (typeof LIVE_STATUSES)[number] | (typeof CLOSED_STATUSES)[number]>
>
export type _NoStatusIsBoth = AssertNever<
  Extract<(typeof LIVE_STATUSES)[number], (typeof CLOSED_STATUSES)[number]>
>

export function assertTransition(from: CheckStatus, to: CheckStatus): void {
  if (!canTransition(from, to)) {
    throw new DomainError('ILLEGAL_TRANSITION', `Cannot move a check from ${from} to ${to}.`)
  }
}

export type ReadyGuardInput = {
  status: CheckStatus
  checkNumber: string | null
  payeeName: string | null
  amount: string | null
  checkDate: Date | null
  cashAccountCode: string | null
  availablePickupDate: Date | null
  isCheque: boolean
}

export type GuardResult = { ok: true } | { ok: false; code: string; message: string }

const REQUIRED_FIELDS: readonly (readonly [keyof ReadyGuardInput, string])[] = [
  ['checkNumber', 'CHECK NUMBER'],
  ['payeeName', 'PAYEE'],
  ['amount', 'AMOUNT'],
  ['checkDate', 'CHECK DATE'],
  ['cashAccountCode', 'CASH ACCOUNT / CHECK BOOK'],
  ['availablePickupDate', 'AVAILABLE PICKUP DATE'],
]

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  return false
}

const NOT_A_CHEQUE_MESSAGE =
  'This payment is not a check, so it cannot be signed or released. It is tracked here for visibility only.'

// A non-cheque payment (an Acumatica transfer with no physical document) can
// never enter the release ladder. Thrown from markSigned and markReleased,
// which have no other guard function to route through.
export function assertReleasable(input: { isCheque: boolean }): void {
  if (!input.isCheque) {
    throw new DomainError('NOT_A_CHEQUE', NOT_A_CHEQUE_MESSAGE)
  }
}

// Order matters: NOT_A_CHEQUE is reported ahead of every other guard, because
// it is a structural fact about the payment, not a transient status one — no
// status change ever makes it releasable. ALREADY_RELEASED then comes before
// missing fields, because a released check is a terminal fact and telling the
// user to fill in a field would send them down a dead end.
export function checkReadyForRelease(input: ReadyGuardInput): GuardResult {
  if (!input.isCheque) {
    return { ok: false, code: 'NOT_A_CHEQUE', message: NOT_A_CHEQUE_MESSAGE }
  }

  if (input.status === 'RELEASED') {
    return {
      ok: false,
      code: 'ALREADY_RELEASED',
      message: 'This check cannot be released because it has already been RELEASED.',
    }
  }

  if (input.status !== 'SIGNED') {
    return {
      ok: false,
      code: 'NOT_SIGNED',
      message: 'This check cannot be released because it has not yet been marked as SIGNED.',
    }
  }

  const missing = REQUIRED_FIELDS.filter(([key]) => isBlank(input[key])).map(([, label]) => label)
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'MISSING_FIELDS',
      message: `This check cannot be released because required information is missing: ${missing.join(', ')}.`,
    }
  }

  return { ok: true }
}

// NONE → CLEARED is legal since 2026-09-11. A bank statement is proof of
// clearing whether or not a deposit was recorded first; refusing it would make
// Finance record a DEPOSITED they never observed to reach the rung they did.
// DEPOSITED and ENCASHED are two ways in, not an order; CLEARED is terminal.
const CLEARING_TRANSITIONS: Record<ClearingStatus, readonly ClearingStatus[]> = {
  NONE:      ['DEPOSITED', 'ENCASHED', 'CLEARED'],
  DEPOSITED: ['CLEARED'],
  ENCASHED:  ['CLEARED'],
  CLEARED:   [],
}

/** The rungs a cheque's clearing may move to from where it stands. Drives the form. */
export function clearingTargets(from: ClearingStatus): readonly ClearingStatus[] {
  return CLEARING_TRANSITIONS[from]
}

export function canSetClearing(status: CheckStatus, from: ClearingStatus, to: ClearingStatus): boolean {
  if (status !== 'RELEASED') return false
  return CLEARING_TRANSITIONS[from].includes(to)
}

export function assertClearing(status: CheckStatus, from: ClearingStatus, to: ClearingStatus): void {
  if (!canSetClearing(status, from, to)) {
    throw new DomainError('ILLEGAL_CLEARING', `Cannot set clearing status to ${to} from ${from} while the check is ${status}.`)
  }
}
