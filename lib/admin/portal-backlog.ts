import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { portalRoute, type Eligibility } from '@/lib/domain/eligibility'
import { portalApvs } from '@/lib/integrations/portal/apvs'
import { kindMatchesStatus } from '@/lib/sync/portal-outbox'

type Db = PrismaClient | Prisma.TransactionClient

const OPEN = ['PENDING', 'FAILED', 'IN_FLIGHT'] as const

/**
 * What the worker WOULD deliver, without delivering (spec §2.5): the newest
 * non-terminal event per cheque, and how many older ones it would close as
 * superseded. Reviewed with the client before the first production run.
 * No amounts: this is printed to a console.
 *
 * `stale` marks a winner the worker would close unsent because its kind no
 * longer matches the cheque's status - the same rule, kindMatchesStatus
 * (final review 2026-09-26).
 */
export async function summariseBacklog(db: Db) {
  const open = await db.portalEvent.findMany({
    where: { status: { in: [...OPEN] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { check: { select: { checkNumber: true, payeeName: true, status: true, eligibility: true } } },
  })
  const newest = new Map<string, (typeof open)[number]>()
  const byKind: Record<string, number> = {}
  for (const ev of open) { newest.set(ev.checkId, ev); byKind[ev.kind] = (byKind[ev.kind] ?? 0) + 1 }
  const winners = [...newest.values()].map((ev) => ({
    eventId: ev.id, kind: ev.kind, checkNumber: ev.check.checkNumber, payeeName: ev.check.payeeName,
    checkStatus: ev.check.status, eligibility: ev.check.eligibility, createdAt: ev.createdAt,
    stale: !kindMatchesStatus(ev.kind, ev.check.status),
  }))
  return {
    total: open.length, winners, superseded: open.length - winners.length,
    stale: winners.filter((w) => w.stale).length, byKind,
  }
}

/**
 * The backlog's data step (final review 2026-09-26). Before this branch
 * cancelCheck and voidCheck queued nothing for the portal, so a cheque that
 * was announced available and later cancelled or voided has an open
 * MARK_AVAILABLE and no CANCELLED event: the worker closes that row as stale,
 * and the portal would never learn the cheque is gone. This finds those
 * cheques and, with `apply`, queues the CANCELLED event cancelCheck would
 * have queued - one per cheque, with a SYSTEM audit row in the same
 * transaction. Idempotent: a cheque that has any CANCELLED event is skipped,
 * so a second apply queues nothing.
 *
 * Only a routed cheque with at least one APV number (portalApvs) is queued:
 * the portal matches on APV, so a CANCELLED event for a cheque without one
 * would park forever.
 *
 * SUPERSEDED 2026-10-29 — DO NOT RUN `--queue-cancelled` AGAIN. The user ruled
 * that a cancelled cheque is detached from its AP bills and the portal is not
 * told (`detachFromBills`, lib/domain/actions.ts): a CANCELLED event cancels
 * the BILL's row in the portal, which refused the re-issued cheque's RELEASED.
 * Kept as the record of the 2026-09-26 backlog; after
 * `scripts/detach-cancelled-apvs.ts` it finds nothing to queue.
 */
export async function queueCancelledForStale(db: Db, args: { now: Date; apply: boolean }) {
  const candidates = await db.check.findMany({
    where: {
      eligibility: { not: 'INTERNAL' },
      status: { in: ['CANCELLED', 'VOIDED'] },
      portalEvents: {
        some: { kind: 'MARK_AVAILABLE', status: { in: [...OPEN] } },
        none: { kind: 'CANCELLED' },
      },
    },
    orderBy: [{ checkNumber: 'asc' }, { id: 'asc' }],
    select: {
      id: true, checkNumber: true, payeeName: true, status: true, eligibility: true,
      apvNumbers: true, bills: { select: { apvNumber: true } },
    },
  })
  // portalRoute is the rule; the query's `not INTERNAL` only narrows the read.
  const cheques = candidates.filter((c) => portalRoute(c.eligibility as Eligibility) !== null && portalApvs(c).length > 0)
  if (!args.apply) return { found: cheques.length, queued: 0, cheques }

  const runIso = args.now.toISOString()
  let queued = 0
  for (const c of cheques) {
    const created = await atomically(db, async (tx) => {
      // Re-checked inside the transaction so a concurrent cancel (or a second
      // apply) cannot leave the cheque with two CANCELLED events.
      const existing = await tx.portalEvent.count({ where: { checkId: c.id, kind: 'CANCELLED' } })
      if (existing) return false
      const ev = await tx.portalEvent.create({
        data: {
          checkId: c.id, direction: 'OUT', kind: 'CANCELLED', status: 'PENDING',
          idempotencyKey: `${c.id}:CANCELLED:backfill-${runIso}`,
          payload: { action: 'CANCELLED', checkNumber: c.checkNumber },
        },
      })
      await tx.check.update({
        where: { id: c.id },
        data: { portalSyncStatus: 'PENDING', portalDomain: portalRoute(c.eligibility as Eligibility) },
      })
      await writeAudit(tx, {
        checkId: c.id, actorType: 'SYSTEM', action: 'portal_event_backfilled',
        details: { eventId: ev.id, kind: 'CANCELLED', checkStatus: c.status, reason: 'cancelled/voided before cancellations were queued' },
      })
      return true
    })
    if (created) queued += 1
  }
  return { found: cheques.length, queued, cheques }
}

/**
 * The released twin of queueCancelledForStale (user report 2026-10-06). The
 * register catch-up (lib/admin/register-releases.ts) moves a cheque to
 * RELEASED with no portal event, so a cheque the portal had been told was
 * available stayed on its Checks Available list. This finds routed RELEASED
 * cheques that were announced available (any MARK_AVAILABLE) and were never
 * told released (no RELEASED event), and with `apply` queues the RELEASED
 * event markReleased would have queued, with a SYSTEM audit row. A cheque
 * with neither releasedAt nor statedReleaseDate has no day to send and is
 * listed in `noDate` instead. Idempotent: a cheque with any RELEASED event is
 * skipped. Run after every register catch-up (both scripts call it).
 */
/**
 * Since 2026-10-07 a cheque the portal was NEVER told about is reported too
 * (user: "why not upon clicking the delivery that those checks are
 * automatically released?") — `6000330355`, `6000338827`, `6000338828`,
 * `6000337892`, released 1 Oct by the register catch-up, had no portal event
 * at all, because their availability was withdrawn (Detail1) before the portal
 * heard of it. Bounded by REPORT_RELEASES_FROM — the day the app went live —
 * so the ~7,700 older register releases are not sent, and by `limit`, newest
 * release first, so one Deliver / cron / action kick stays inside its time
 * budget and the backlog drains over successive runs.
 */
export const REPORT_RELEASES_FROM = new Date('2026-09-01T00:00:00Z')

export async function queueReleasedForStale(db: Db, args: { now: Date; apply: boolean; limit?: number }) {
  const candidates = await db.check.findMany({
    where: {
      status: 'RELEASED',
      isCheque: true,
      portalEvents: { none: { kind: 'RELEASED' } },
      OR: [
        { releasedAt: { gte: REPORT_RELEASES_FROM } },
        { releasedAt: null, statedReleaseDate: { gte: REPORT_RELEASES_FROM } },
        // No day at all: listed in `noDate`, never sent.
        { releasedAt: null, statedReleaseDate: null, portalEvents: { some: { kind: 'MARK_AVAILABLE' } } },
      ],
    },
    orderBy: [{ statedReleaseDate: { sort: 'desc', nulls: 'last' } }, { checkNumber: 'asc' }, { id: 'asc' }],
    select: {
      id: true, checkNumber: true, payeeName: true, status: true, eligibility: true,
      releasedAt: true, statedReleaseDate: true,
      apvNumbers: true, bills: { select: { apvNumber: true } },
    },
  })
  // An INTERNAL release goes too, flagged internal at delivery (ruling 2026-10-19,
  // portal spec 2026-10-19-cm-internal-release-quiet); it still needs an APV.
  const routed = candidates.filter((c) =>
    (portalRoute(c.eligibility as Eligibility) !== null || c.eligibility === 'INTERNAL') && portalApvs(c).length > 0)
  const cheques = routed.filter((c) => c.releasedAt || c.statedReleaseDate)
  const noDate = routed.filter((c) => !c.releasedAt && !c.statedReleaseDate)
  if (!args.apply) return { found: cheques.length, queued: 0, cheques, noDate }

  const runIso = args.now.toISOString()
  let queued = 0
  const batch = args.limit ? cheques.slice(0, args.limit) : cheques
  for (const c of batch) {
    const created = await atomically(db, async (tx) => {
      const existing = await tx.portalEvent.count({ where: { checkId: c.id, kind: 'RELEASED' } })
      if (existing) return false
      const ev = await tx.portalEvent.create({
        data: {
          checkId: c.id, direction: 'OUT', kind: 'RELEASED', status: 'PENDING',
          idempotencyKey: `${c.id}:RELEASED:backfill-${runIso}`,
          payload: { action: 'RELEASED', checkNumber: c.checkNumber },
          // Due at the run's own clock, so the delivery that queued it (the
          // kick, lib/sync/portal-kick.ts) sends it in the same pass.
          nextAttemptAt: args.now,
        },
      })
      const route = portalRoute(c.eligibility as Eligibility)
      // check_internal_never_routes_to_portal: an INTERNAL check carries no portal state.
      if (route !== null) {
        await tx.check.update({ where: { id: c.id }, data: { portalSyncStatus: 'PENDING', portalDomain: route } })
      }
      await writeAudit(tx, {
        checkId: c.id, actorType: 'SYSTEM', action: 'portal_event_backfilled',
        details: { eventId: ev.id, kind: 'RELEASED', checkStatus: c.status, reason: c.eligibility === 'INTERNAL' ? 'INTERNAL release, sent quietly so the portal stops aging the bill (ruling 2026-10-19)' : 'released by the register catch-up, which queues no portal event' },
      })
      return true
    })
    if (created) queued += 1
  }
  return { found: cheques.length, queued, cheques, noDate }
}

async function atomically<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return '$transaction' in db ? db.$transaction((tx) => fn(tx)) : fn(db)
}
