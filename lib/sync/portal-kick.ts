import type { Prisma, PrismaClient } from '@prisma/client'
import { after as nextAfter } from 'next/server'
import { createPortalClientFromEnv } from '@/lib/integrations/portal/from-env'
import type { PortalClient } from '@/lib/integrations/portal/client'
import { deliverPortalEvents, emptyOutcome, type PortalOutboxOutcome } from './portal-outbox'
import { queueReleasedForStale } from '@/lib/admin/portal-backlog'
import { pushChecksToPortal, type PortalChecksPushResult } from './portal-checks'
import type { PortalCheckListClient } from '@/lib/integrations/portal/client'
import type { SyncTrigger } from './run'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * Best-effort delivery within a time budget: from a server action (after the
 * response, via next/server `after`), from the cron, from the admin button.
 * Never throws - a portal outage must never fail a Finance action, and an
 * unconfigured portal is a skip that says which setting is missing (the
 * message names the setting, never a value).
 */
/** The check-list push's share of a kick (spec 2026-11-03): skipped when less than this is left. */
const CHECK_LIST_MIN_MS = 2_000

export type PortalKickOutcome = PortalOutboxOutcome & {
  /** The check list push that followed the outbox (spec 2026-11-03-check-list-in-portal-design). */
  checks?: PortalChecksPushResult | { skipped: string }
}

export async function kickPortalDelivery(
  db: Db, args: { budgetMs: number; client?: PortalClient & Partial<PortalCheckListClient>; now?: Date; trigger?: SyncTrigger },
): Promise<PortalKickOutcome | { skipped: string }> {
  const now = args.now ?? new Date()
  // User demand 2026-10-06 ("this should be always the trigger", "make sure
  // it will always work"): a cheque released by any path that queues nothing
  // (the register catch-up, the Acumatica reconcile, the older backfills) is
  // queued here, before every delivery — the cron, Deliver now, and every
  // action's after-response kick — so the portal always hears of it. Runs
  // even when the portal is not configured, so the event waits in the outbox.
  try {
    // 50 per kick, newest release first: the backlog drains over successive runs
    // inside each run's time budget (2026-10-07).
    await queueReleasedForStale(db, { now, apply: true, limit: 50 })
  } catch (e) {
    console.error('queueing released checks for the portal failed:', e instanceof Error ? e.message : e)
  }
  let client = args.client
  if (!client) {
    try { client = createPortalClientFromEnv() }
    catch (e) { return { skipped: (e instanceof Error ? e.message : String(e)).split(',')[0] } }
  }
  const deadline = new Date(now.getTime() + args.budgetMs)
  let outcome: PortalOutboxOutcome
  try {
    outcome = await deliverPortalEvents(db, { now, deadline, client })
  } catch (e) {
    console.error('portal delivery failed:', e instanceof Error ? e.message : e)
    outcome = { ...emptyOutcome(), error: e instanceof Error ? e.message : String(e) }
  }
  // Then the check list (user ruling 2026-11-03: every cheque, cancelled and
  // voided included, is in the portal): whatever the budget has left, so a
  // Finance action's cheque reaches the portal's list on the same kick. A run
  // cut short leaves its watermark for the next kick; never a failure of the
  // delivery.
  const left = deadline.getTime() - Date.now()
  if (left < CHECK_LIST_MIN_MS) return { ...outcome, checks: { skipped: 'no time left in this kick; the next one continues' } }
  const checks = await pushChecksToPortal(db, { budgetMs: left, client, trigger: args.trigger ?? 'MANUAL' })
  return { ...outcome, checks }
}

/**
 * Schedules `fn` to run after the response is sent, via next/server `after`
 * (or an injected `afterImpl` for tests) - so a Finance user is never made
 * to wait on the portal.
 *
 * OUTSIDE A REQUEST SCOPE (this repo's own tests call server actions
 * directly, not through Next's request pipeline) `after` throws rather than
 * scheduling anything. There is no response to wait for in that case, and no
 * need to kick the portal here either: the daily cron and the admin button
 * already cover delivery (spec 2026-09-26-check-monitoring-integration-design
 * §2.4). That specific error is swallowed; anything else is a real bug and
 * must propagate.
 */
export function afterResponse(
  fn: () => Promise<unknown>,
  afterImpl: (fn: () => Promise<unknown>) => void = nextAfter,
): void {
  try {
    afterImpl(fn)
  } catch (e) {
    if (e instanceof Error && /outside a request scope/i.test(e.message)) return
    throw e
  }
}
