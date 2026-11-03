import { randomUUID } from 'node:crypto'
import type { CheckStatus, Prisma, PrismaClient, PortalEvent, PortalEventKind } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { notify } from '@/lib/notifications/notify'
import { parkedNotice } from '@/lib/notifications/messages'
import {
  buildPortalEventBody, PortalPayloadError, type PortalClient, type PortalDeliveryResult,
} from '@/lib/integrations/portal/client'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * THE OUTBOX WORKER (spec 2026-09-26-check-monitoring-integration-design §2.3).
 *
 * Latest wins per cheque. The portal is told the cheque's current truth, not
 * its history: among a cheque's non-terminal events only the newest is
 * delivered and the older ones are closed as superseded. This is what makes
 * the backlog queued since 2026-09-04 safe to drain - a stale MARK_AVAILABLE
 * for a cheque since released must not email a supplier "ready for pickup"
 * seconds before "picked up". Since spec 2026-10-02 "latest wins" runs per
 * lane - the status lane and the RECEIPT lane - see deliverPortalEvents.
 *
 * Claims are exclusive (a conditional updateMany), backoff is a timestamp so
 * the worker stays stateless, and PARKED is the human's queue.
 */
export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000] as const
const DAILY_MS = 24 * 3_600_000
export const MAX_ATTEMPTS = 12
export const UNMATCHED_MAX_ATTEMPTS = 7
/** A claim older than this belongs to a run the platform killed. */
export const STALE_CLAIM_MS = 10 * 60_000
/** One request never waits longer than this, nor past the run's deadline. */
export const REQUEST_TIMEOUT_MS = 10_000
/**
 * A RECEIPT carries the scanned receipt base64 inside the request (a ~4 MB
 * body uploaded from Manila), so it gets longer (spec 2026-10-02). Still
 * capped by the run's deadline.
 */
export const RECEIPT_REQUEST_TIMEOUT_MS = 30_000
/**
 * A RECEIPT is not started with less than this left in the run (review
 * 2026-10-02): a request likely to time out would only cost an attempt.
 * The row is left untouched for the next run. 6 s, below the 8 s after-action
 * kick, so an ordinary kick still sends a receipt; the receipt actions kick with
 * 25 s (review 2026-10-02, second pass).
 */
export const RECEIPT_MIN_REMAINING_MS = 6_000
const MIN_REQUEST_TIMEOUT_MS = 1_000

export type PortalOutboxOutcome = {
  delivered: number
  synced: number
  failed: number
  parked: number
  superseded: number
  /** Closed unsent because the event's kind contradicts the cheque's current status. */
  stale: number
  stoppedAtDeadline: boolean
  /** The portal refused the token (401): the run stopped after parking that one event. */
  stoppedOnAuth: boolean
  error?: string
}

export function emptyOutcome(): PortalOutboxOutcome {
  return { delivered: 0, synced: 0, failed: 0, parked: 0, superseded: 0, stale: 0, stoppedAtDeadline: false, stoppedOnAuth: false }
}

/**
 * Whether an event of this kind still describes the cheque as it stands
 * (spec 2026-09-26-check-monitoring-integration-design §2.3; final review
 * 2026-09-26). Latest-wins alone is not enough, for two reasons:
 *  - before this branch cancelCheck/voidCheck queued nothing, so the backlog
 *    holds MARK_AVAILABLE rows for cheques since cancelled or voided - the
 *    newest event for such a cheque would announce a pickup that will never
 *    happen;
 *  - RETRY on /admin/portal can resurrect an old row after a newer one has
 *    already gone out (the newer one is SYNCED, so the old one wins again).
 * An event whose kind contradicts the cheque's status is closed unsent.
 */
export function kindMatchesStatus(kind: PortalEventKind, status: CheckStatus): boolean {
  switch (kind) {
    case 'MARK_AVAILABLE':
    case 'RELEASE_REVERSED':
      return status === 'READY_FOR_RELEASE' || status === 'SCHEDULED'
    case 'RELEASED':
      return status === 'RELEASED'
    case 'REVERT':
      return status === 'SIGNED' || status === 'SIGNATURE_PENDING' || status === 'GENERATED'
    case 'CANCELLED':
      return status === 'CANCELLED' || status === 'VOIDED'
    // The supplier's receipt is only ever handed over for a collected cheque
    // (user request 2026-10-01): a release reversed since closes it unsent.
    case 'RECEIPT':
      return status === 'RELEASED'
    default:
      return false
  }
}

function backoff(attempts: number): number {
  return RETRY_DELAYS_MS[attempts - 1] ?? DAILY_MS
}

const cap = (s: string) => s.slice(0, 300)

/**
 * Audit rows are written in the same transaction as the change they record
 * (global constraint). A caller already inside a transaction passes its
 * TransactionClient, which has no $transaction of its own: run inline there.
 */
async function atomically<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return '$transaction' in db ? db.$transaction((tx) => fn(tx)) : fn(db)
}

type Verdict =
  | { status: 'SYNCED'; releaseId: number | null; note?: string }
  | { status: 'FAILED'; error: string; delayMs: number; maxAttempts: number; unmatchedOnly?: true }
  | { status: 'PARKED'; error: string }

function judge(res: PortalDeliveryResult, attempts: number): Verdict {
  if (res.status === 200 && res.body) {
    // Precedence (spec §2.3 step 3): refused, then nothing matched, then synced.
    const refused = res.body.results.find((r) => r.outcome === 'refused')
    if (refused) return { status: 'PARKED', error: `refused ${refused.ref}: ${refused.reason ?? 'no reason given'}` }
    if (res.body.results.length === 0) {
      // The portal receives bills from Acumatica nightly; a cheque can precede
      // its bill, so an unmatched cheque is retried daily for a week.
      return { status: 'FAILED', error: `unmatched: ${res.body.unmatched.join(', ')}`, delayMs: DAILY_MS, maxAttempts: UNMATCHED_MAX_ATTEMPTS, unmatchedOnly: true }
    }
    const first = res.body.results.find((r) => r.releaseId !== null)
    const note = res.body.unmatched.length ? `unmatched: ${res.body.unmatched.join(', ')}` : undefined
    return { status: 'SYNCED', releaseId: first?.releaseId ?? null, note }
  }
  if (res.status === 401) return { status: 'PARKED', error: 'portal refused the token (401): check PORTAL_TOKEN' }
  if (res.status === 400) return { status: 'PARKED', error: `portal rejected the payload (400)${res.error ? `: ${res.error}` : ''}` }
  return { status: 'FAILED', error: `portal answered ${res.status}`, delayMs: backoff(attempts), maxAttempts: MAX_ATTEMPTS }
}

/**
 * `flagCheck` is also false for a RECEIPT, whose outcome is not the cheque's
 * portal state (review 2026-10-02).
 * `flagCheck` is false when the cheque must not carry portal state: an
 * INTERNAL cheque (the database's check_internal_never_routes_to_portal
 * constraint requires portalSyncStatus = NOT_APPLICABLE) or one that no
 * longer exists. The event row and the audit are still written.
 *
 * The settle is conditional on this run still holding the claim (review fix
 * 2026-09-26): if another run reclaimed the row as stale and settled it first,
 * the event row, the cheque and the audit are left to that run's settle and
 * this returns null (counted as nothing).
 */
async function settle(
  db: Db, ev: PortalEvent, verdict: Verdict, now: Date, flagCheck: boolean, claimedBy: string, internal = false,
): Promise<Verdict['status'] | null> {
  const attempts = ev.attempts + 1
  let status: Verdict['status'] = verdict.status
  let lastError: string | null = null
  let nextAttemptAt = ev.nextAttemptAt
  if (verdict.status === 'FAILED') {
    lastError = cap(verdict.error)
    if (attempts >= verdict.maxAttempts) {
      // ruling 2026-10-19: payroll, petty-cash and government CVs often have no portal bill, so an
      // INTERNAL event nothing matched after the full week closes SYNCED (audited), never parked.
      if (verdict.unmatchedOnly && internal) {
        status = 'SYNCED'
        lastError = cap(lastError.replace(/^unmatched:/, 'unmatched (internal):'))
      } else status = 'PARKED'
    }
    else nextAttemptAt = new Date(now.getTime() + verdict.delayMs)
  } else if (verdict.status === 'PARKED') {
    lastError = cap(verdict.error)
  } else if (verdict.note) {
    lastError = cap(verdict.note)
  }
  const held = await atomically(db, async (tx) => {
    const r = await tx.portalEvent.updateMany({
      where: { id: ev.id, status: 'IN_FLIGHT', claimedBy },
      data: { status, attempts, lastError, nextAttemptAt },
    })
    if (!r.count) return false
    if (!flagCheck) {
      // no cheque-level portal state to write
    } else if (status === 'SYNCED') {
      await tx.check.update({
        where: { id: ev.checkId },
        data: { portalSyncStatus: 'SYNCED', ...(verdict.status === 'SYNCED' && verdict.releaseId !== null ? { portalTradeId: verdict.releaseId } : {}) },
      })
    } else if (status === 'PARKED') {
      await tx.check.update({ where: { id: ev.checkId }, data: { portalSyncStatus: 'FAILED' } })
    }
    await writeAudit(tx, {
      checkId: ev.checkId, actorType: 'SYSTEM', action: `portal_event_${status.toLowerCase()}`,
      details: { eventId: ev.id, kind: ev.kind, attempts, lastError },
    })
    // The admins are told in the same transaction (spec 2026-10-16
    // notifications, "Portal event parked"): the notice exists exactly when
    // the parked state does. Once per event (dedupeKey), so RETRY then parked
    // again does not repeat it. checkId only when the check still exists, or
    // the FK would refuse the row.
    if (status === 'PARKED') {
      const parkedCheck = await tx.check.findUnique({ where: { id: ev.checkId }, select: { checkNumber: true } })
      await notify(tx, parkedNotice({
        eventId: ev.id, kind: ev.kind,
        checkId: parkedCheck ? ev.checkId : null,
        checkNumber: parkedCheck?.checkNumber ?? null,
        error: lastError,
      }))
    }
    return true
  })
  return held ? status : null
}

/**
 * Close a claimed event unsent because its kind no longer matches the cheque
 * (see kindMatchesStatus). SYNCED, like a superseded row, but its audit says
 * `stale: true` so it is never mistaken for a delivery or a supersede. The
 * cheque's own portal state is left alone: nothing was said to the portal.
 * Conditional on still holding the claim, like settle.
 */
async function closeStale(db: Db, ev: PortalEvent, checkStatus: CheckStatus, claimedBy: string): Promise<boolean> {
  const lastError = `stale: check is now ${checkStatus}`
  return atomically(db, async (tx) => {
    const r = await tx.portalEvent.updateMany({
      where: { id: ev.id, status: 'IN_FLIGHT', claimedBy },
      data: { status: 'SYNCED', lastError },
    })
    if (!r.count) return false
    await writeAudit(tx, {
      checkId: ev.checkId, actorType: 'SYSTEM', action: 'portal_event_synced',
      details: { eventId: ev.id, kind: ev.kind, attempts: ev.attempts, lastError, checkStatus, stale: true },
    })
    return true
  })
}

/**
 * Drain the outbox once.
 *
 * Contract: `deadline` must be derived from the same `now` the caller passes
 * (e.g. `deadline = new Date(now.getTime() + budgetMs)`). The worker's clock
 * is `now` plus the wall time this run has spent, so a deadline taken from a
 * different clock would stop the run too early or never.
 */
export async function deliverPortalEvents(
  db: Db,
  args: { now: Date; deadline: Date; client: PortalClient; claimedBy?: string },
): Promise<PortalOutboxOutcome> {
  const out = emptyOutcome()
  // The UUID keeps two runs started in the same millisecond (a cron and an
  // after-response kick) from sharing a claim identity (final review 2026-09-26).
  const claimedBy = args.claimedBy ?? `run-${args.now.toISOString()}-${randomUUID()}`
  const staleBefore = new Date(args.now.getTime() - STALE_CLAIM_MS)
  // The run's clock is `now` advanced by the wall time this run has spent, so
  // the deadline is judged on the same clock as `now` (the caller passes
  // new Date() in production; a test's fixed `now` is not overtaken by the
  // real date).
  const startedWall = Date.now()
  const clock = () => args.now.getTime() + (Date.now() - startedWall)
  const pastDeadline = () => clock() > args.deadline.getTime()

  // Every non-terminal event, oldest first, so the newest per cheque is the
  // last one seen. Latest-wins runs over ALL of them, not only the ones due
  // now: a due MARK_AVAILABLE must not go out while a newer RELEASED for the
  // same cheque sits in backoff. A stale IN_FLIGHT claim is retried.
  const open = await db.portalEvent.findMany({
    where: { status: { in: ['PENDING', 'FAILED', 'IN_FLIGHT'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const isLive = (ev: PortalEvent) =>
    ev.status === 'IN_FLIGHT' && ev.claimedAt !== null && ev.claimedAt.getTime() >= staleBefore.getTime()
  // A live claim freezes its whole cheque for this run (spec §2.3 step 1;
  // review fix 2026-09-26). Protecting only the live row was not enough: a
  // newer PENDING event for the same cheque was still delivered while the
  // older one was in flight, so the portal could apply them out of order
  // (MARK_AVAILABLE after RELEASED). The cheque is reconsidered next run,
  // once the live claim has settled or gone stale.
  const frozen = new Set(open.filter(isLive).map((ev) => ev.checkId))
  // Two lanes per cheque (spec 2026-10-02): the status lane (MARK_AVAILABLE,
  // REVERT, RELEASED, RELEASE_REVERSED, CANCELLED) and the receipt lane.
  // Latest-wins runs inside a lane only: a RECEIPT must never close the
  // RELEASED it accompanies, and a later status event must not drop a receipt.
  const laneOf = (ev: PortalEvent) => `${ev.checkId}|${ev.kind === 'RECEIPT' ? 'receipt' : 'status'}`
  const newest = new Map<string, PortalEvent>()
  for (const ev of open) if (!frozen.has(ev.checkId)) newest.set(laneOf(ev), ev)

  for (const ev of open) {
    if (frozen.has(ev.checkId)) continue
    const winner = newest.get(laneOf(ev))!
    if (winner.id === ev.id) continue
    if (pastDeadline()) { out.stoppedAtDeadline = true; return out }
    const lastError = `superseded by ${winner.id}`
    const closed = await atomically(db, async (tx) => {
      const r = await tx.portalEvent.updateMany({
        where: { id: ev.id, status: ev.status, claimedAt: ev.claimedAt },
        data: { status: 'SYNCED', lastError },
      })
      if (!r.count) return false
      await writeAudit(tx, {
        checkId: ev.checkId, actorType: 'SYSTEM', action: 'portal_event_synced',
        // `superseded: true` tells a row closed unsent from a delivered SYNCED.
        details: { eventId: ev.id, kind: ev.kind, attempts: ev.attempts, lastError, supersededBy: winner.id, superseded: true },
      })
      return true
    })
    if (closed) out.superseded += 1
    // A lost supersede (final review 2026-09-26): the older row changed under
    // us - another run claimed it, or it settled. Its cheque is frozen for the
    // rest of this run, exactly as a live claim is, so the winner cannot go
    // out while the older row may still be in flight.
    else frozen.add(ev.checkId)
  }

  // Status lanes first, receipts after (a stable sort keeps the oldest-first
  // order inside each group).
  const winners = [...newest.values()].sort((a, b) =>
    (a.kind === 'RECEIPT' ? 1 : 0) - (b.kind === 'RECEIPT' ? 1 : 0))
  // THE RECEIPT HOLD, across runs (spec 2026-10-02; review 2026-10-02): a
  // RECEIPT is delivered only once its cheque's NEWEST status-lane event
  // (any kind but RECEIPT, by createdAt then id, whatever its status) is
  // SYNCED - delivered, superseded or closed as stale. While that event is
  // PENDING, FAILED (due or not), IN_FLIGHT or PARKED the receipt waits
  // untouched: the portal must hear RELEASED before the receipt that goes
  // with it, and a parked status event waits for a human, so does its receipt.
  // A cheque with no status-lane event at all does not hold.
  //  - statusOpen: the status winner is open in this run; it is released in
  //    the loop below when that event settles SYNCED or closes stale.
  //  - statusStuck: the newest status event is closed but not SYNCED
  //    (PARKED); nothing in this run releases it.
  const statusOpen = new Set([...newest.values()].filter((e) => e.kind !== 'RECEIPT').map((e) => e.checkId))
  const statusStuck = new Set<string>()
  const receiptCheques = [...newest.values()].filter((e) => e.kind === 'RECEIPT').map((e) => e.checkId)
  if (receiptCheques.length) {
    const statusEvents = await db.portalEvent.findMany({
      where: { checkId: { in: receiptCheques }, kind: { not: 'RECEIPT' } },
      select: { checkId: true, status: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const newestStatus = new Map<string, PortalEvent['status']>()
    for (const e of statusEvents) newestStatus.set(e.checkId, e.status)
    for (const [checkId, status] of newestStatus) {
      if (status !== 'SYNCED' && !statusOpen.has(checkId)) statusStuck.add(checkId)
    }
  }
  for (const ev of winners) {
    if (frozen.has(ev.checkId)) continue
    if (ev.kind === 'RECEIPT' && (statusOpen.has(ev.checkId) || statusStuck.has(ev.checkId))) continue
    if (pastDeadline()) { out.stoppedAtDeadline = true; break }
    if (ev.status !== 'IN_FLIGHT' && ev.nextAttemptAt.getTime() > args.now.getTime()) continue
    // Too little time left for a ~4 MB upload (review 2026-10-02): leave the
    // RECEIPT untouched for the next run rather than spend an attempt.
    if (ev.kind === 'RECEIPT' && args.deadline.getTime() - clock() < RECEIPT_MIN_REMAINING_MS) continue

    // One bad row never aborts the run (review fix 2026-09-26): an unexpected
    // error (a DB failure, say) is recorded and the next event is tried. The
    // row is left as it stands; an IN_FLIGHT claim goes stale and is retried.
    try {
      // Exclusive claim: conditional on the row still being exactly as read
      // (status and claim), so two runs - or a run and a stale-claim retry -
      // cannot both deliver it. claimedAt is the run clock at claim time
      // (review fix 2026-09-26), so staleness is measured from the real claim.
      const claim = await db.portalEvent.updateMany({
        where: { id: ev.id, status: ev.status, claimedAt: ev.claimedAt },
        data: { status: 'IN_FLIGHT', claimedAt: new Date(clock()), claimedBy },
      })
      if (!claim.count) continue

      const check = await db.check.findUnique({
        where: { id: ev.checkId },
        include: {
          cashAccount: { include: { bank: true } }, checkBook: { include: { bank: true } }, bills: true,
          releasedBy: { select: { name: true } },
          // The receipt's bytes are read only for a RECEIPT delivery (spec 2026-10-02).
          ...(ev.kind === 'RECEIPT' ? { receiptFile: { select: { fileName: true, contentType: true, bytes: true } } } : {}),
        },
      })
      if (!check) {
        if (await settle(db, ev, { status: 'PARKED', error: 'check no longer exists' }, args.now, false, claimedBy)) out.parked += 1
        continue
      }

      if (!kindMatchesStatus(ev.kind, check.status)) {
        if (await closeStale(db, ev, check.status, claimedBy)) {
          out.stale += 1
          // A closed status event no longer stands before the receipt.
          if (ev.kind !== 'RECEIPT') statusOpen.delete(ev.checkId)
        }
        continue
      }

      let verdict: Verdict
      let authRefused = false
      try {
        // RULE 2 is asserted inside buildPortalEventBody; an INTERNAL cheque
        // sending MARK_AVAILABLE, REVERT or RECEIPT throws before any request
        // exists and parks below (RELEASED, RELEASE_REVERSED and CANCELLED go
        // out flagged internal, ruling 2026-10-19).
        const body = buildPortalEventBody({ id: ev.id, kind: ev.kind }, check)
        out.delivered += 1
        const remaining = args.deadline.getTime() - clock()
        const capMs = ev.kind === 'RECEIPT' ? RECEIPT_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS
        const timeoutMs = Math.max(MIN_REQUEST_TIMEOUT_MS, Math.min(remaining, capMs))
        const res = await args.client.deliver(body, { timeoutMs })
        authRefused = res.status === 401
        verdict = judge(res, ev.attempts + 1)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        // A payload defect (INTERNAL cheque, missing required date) never fixes
        // itself by retrying: park it for a human. Anything else thrown is a
        // delivery failure and backs off.
        verdict = e instanceof PortalPayloadError
          ? { status: 'PARKED', error: message }
          : { status: 'FAILED', error: message, delayMs: backoff(ev.attempts + 1), maxAttempts: MAX_ATTEMPTS }
      }
      // null: another run reclaimed the row and settled it first - count nothing.
      // A RECEIPT settles its own row and audit only: the cheque-level
      // portalSyncStatus / portalTradeId belong to the status lane (review
      // 2026-10-02), so a receipt's success or parking never rewrites them.
      const flagCheck = check.eligibility !== 'INTERNAL' && ev.kind !== 'RECEIPT'
      const status = await settle(db, ev, verdict, args.now, flagCheck, claimedBy, check.eligibility === 'INTERNAL')
      if (ev.kind !== 'RECEIPT' && status === 'SYNCED') statusOpen.delete(ev.checkId)
      if (status === 'SYNCED') out.synced += 1
      else if (status === 'FAILED') out.failed += 1
      else if (status === 'PARKED') out.parked += 1
      // 401 stops the run (final review 2026-09-26): a wrong token fails every
      // event the same way, so one parked row says it all - parking the whole
      // backlog would only leave a human hundreds of rows to retry.
      if (authRefused) { out.stoppedOnAuth = true; break }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error(`portal outbox: event ${ev.id} (check ${ev.checkId}) failed unexpectedly: ${message}`)
      out.error ??= cap(`event ${ev.id}: ${message}`)
    }
  }
  return out
}
