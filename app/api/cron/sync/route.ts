import { timingSafeEqual } from 'node:crypto'
import { prisma } from '@/lib/db'
import { createClientForTenant } from '@/lib/integrations/acumatica/from-env'
import { SYNC_TENANTS } from '@/lib/admin/sync-overview'
import { runScheduledSync, type ScheduledSyncOutcome } from '@/lib/sync/scheduled'
import { runScheduledBillsSync, type ScheduledBillsOutcome } from '@/lib/sync/bills'
import {
  recordBillRefsTimeBudgetSkip,
  runScheduledBillRefsSync,
  type ScheduledBillRefsOutcome,
} from '@/lib/sync/bill-refs'
import { runAutoSign } from '@/lib/sync/auto-sign'
import { kickPortalDelivery } from '@/lib/sync/portal-kick'
import { notifyCronResults } from '@/lib/notifications/cron'

/**
 * THE SCHEDULED SYNC. Vercel calls this twice a day — `crons` in vercel.json,
 * `0 4 * * *` and `0 10 * * *` UTC, 12:00 and 18:00 Manila, and never drifts because the
 * Philippines has no daylight saving.
 *
 * ── SECURITY ──────────────────────────────────────────────────────────────
 * `middleware.ts` DOES NOT RUN in this project. A route handler has nothing in
 * front of it, so this one authenticates on its first line: Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` when that environment variable exists,
 * and nothing else is allowed to trigger a read of the ERP.
 *
 * An UNSET secret refuses (500) rather than opening. The alternative — "no
 * secret configured, so anyone may run it" — is exactly the default that gets
 * shipped by accident.
 *
 * No session, no user. The run records itself as SCHEDULED.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Both tenants, in order, each inside `runScheduledSync`'s own try/catch, so
 * one tenant's trouble never skips the other. 500 if any tenant FAILED, so
 * Vercel's cron log shows the failure; a refusal for want of a watermark or a
 * run already in progress is recorded and is not a failure of the cron.
 *
 * Then THE VOUCHER READ (lib/sync/bills.ts), both tenants in the same order:
 * Acumatica's AP-PAYMENTS-WITH-BILLS, joined on the payment's own reference,
 * appends the AP vouchers each cheque pays to `apvNumbers` — add-only, one
 * audit row per changed cheque, never status. It has its own watermark (BILLS
 * rows on `SyncRun`); with none it records a refusal rather than reading the
 * year, because a first read is `scripts/sync.ts <TENANT> --bills` from a
 * terminal. A BILLS FAILED turns the response 500; a refusal does not. It runs
 * only for a tenant whose payment read RAN this time (SKIPPED_PAYMENT_NOT_RUN
 * otherwise, not a failure).
 *
 * Then THE PO READ (lib/sync/bill-refs.ts), both tenants in the same order:
 * Acumatica's AP-Bills and Adjustments, mirrored into AcumaticaBill (bill →
 * real POs, keyed by APV). Its own watermark (BILL_REFS rows); none → a
 * recorded refusal, because a first read is `scripts/sync.ts <TENANT>
 * --bill-refs` from a terminal. FAILED turns the response 500; a refusal or
 * SKIPPED_PAYMENT_NOT_RUN does not. Neither the BILLS nor the BILL_REFS read
 * is individually time-bounded. A tenant's BILL_REFS read is not begun once
 * 20 s of the run have passed (SKIPPED_TIME_BUDGET, recorded as a finished
 * BILL_REFS row with no watermark; the next run catches up), but one begun
 * before that — or an unusually large incremental BILLS read — can still run
 * long enough to push auto-sign past its 50 s deadline: auto-sign then
 * records FAILED, the response is 500, and the next run continues what it
 * left. That is the same exposure BILLS already had.
 *
 * Then AUTO-SIGN (lib/sync/auto-sign.ts): on a Manila Monday or Tuesday, every
 * due Acumatica check first read before that day becomes SIGNED; on any other
 * day the run records IDLE. It runs even when a tenant failed, and its own
 * failure also turns the response 500.
 *
 * Then NOTIFICATIONS (lib/notifications/cron.ts): every FAILED or REFUSED
 * read and an auto-sign FAILED notify the active FINANCE_ADMINs, and a tenant
 * past `sync.staleAfterHours` notifies them once per stale stretch. Never a
 * failure of the cron.
 */

// ExcelJS is not involved, but the Prisma client is Node-only all the same.
export const runtime = 'nodejs'
// Never cached, never prerendered.
export const dynamic = 'force-dynamic'
/**
 * Hobby honours 60 with or without Fluid Compute. An incremental run is
 * seconds; the FULL path that would need more is refused by design.
 */
export const maxDuration = 60

/**
 * The PO read (BILL_REFS) is not begun for a tenant once this much of the
 * route's time has passed since `now`. Auto-sign's deadline is `now` + 50 s
 * inside the 60 s `maxDuration`; an unbounded third Acumatica read per tenant
 * could otherwise leave auto-sign no time. 20 s leaves 30 s for it.
 */
// Not exported: a Next route module may export only its handlers and config.
const BILL_REFS_SKIP_AFTER_MS = 20_000

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Constant-time on equal lengths; a length mismatch is refused outright. */
function bearerMatches(request: Request, secret: string): boolean {
  const presented = Buffer.from(request.headers.get('authorization') ?? '')
  const expected = Buffer.from(`Bearer ${secret}`)
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

export async function GET(request: Request): Promise<Response> {
  // Read at request time, not module load, so a test can vary it and a
  // deployment that sets it later does not need a rebuild.
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return json({ error: 'CRON_SECRET is not set. The scheduled sync refuses to run open.' }, 500)
  }
  if (!bearerMatches(request, secret)) {
    return new Response('UNAUTHORISED', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  const now = new Date()
  const outcomes: ScheduledSyncOutcome[] = []
  for (const tenant of SYNC_TENANTS) {
    outcomes.push(
      await runScheduledSync(prisma, { tenant, now, client: () => createClientForTenant(tenant) }),
    )
  }

  // The vouchers each cheque pays (lib/sync/bills.ts), after the payments so a
  // cheque first read this run is already here to be linked. Never status.
  //
  // ONLY after a payment read that RAN for the same tenant. Applications for
  // cheques a failed, refused or in-progress payment read would have brought
  // in would count as not held, and the BILLS watermark would move past them
  // for good — a full re-read by hand would be the only way back. Skipping
  // instead leaves the BILLS watermark where it was, so the next run (after a
  // payment read that RAN) reads them. A skip is recorded in the response and
  // is not a failure of the cron.
  const bills: ScheduledBillsOutcome[] = []
  for (const tenant of SYNC_TENANTS) {
    const payment = outcomes.find((o) => o.tenant === tenant)
    if (payment?.outcome !== 'RAN') {
      bills.push({ tenant, outcome: 'SKIPPED_PAYMENT_NOT_RUN' })
      continue
    }
    bills.push(
      await runScheduledBillsSync(prisma, { tenant, now, client: () => createClientForTenant(tenant) }),
    )
  }

  // The POs each AP bill names (lib/sync/bill-refs.ts), into AcumaticaBill —
  // reference data keyed by APV, resolved against cheques when the PO NUMBER
  // column is drawn. Gated on the tenant's payment read like BILLS (a read
  // that could not reach the tenant's payments is no moment to read its
  // bills), but NOT on BILLS: nothing here depends on which cheques are held.
  const billRefs: ScheduledBillRefsOutcome[] = []
  for (const tenant of SYNC_TENANTS) {
    const payment = outcomes.find((o) => o.tenant === tenant)
    if (payment?.outcome !== 'RAN') {
      billRefs.push({ tenant, outcome: 'SKIPPED_PAYMENT_NOT_RUN' })
      continue
    }
    // Yield to the budget: auto-sign's 50 s deadline runs from `now`, so a PO
    // read begun late would eat the time auto-sign needs. Not a failure; the
    // BILL_REFS watermark stays, so the next run catches up. The skip is
    // recorded as a finished BILL_REFS row so /admin/sync shows it.
    const elapsedMs = Date.now() - now.getTime()
    if (elapsedMs > BILL_REFS_SKIP_AFTER_MS) {
      billRefs.push(await recordBillRefsTimeBudgetSkip(prisma, { tenant, now, elapsedMs }))
      continue
    }
    billRefs.push(
      await runScheduledBillRefsSync(prisma, { tenant, now, client: () => createClientForTenant(tenant) }),
    )
  }

  // After both tenants, whether or not either failed: cheques already in the
  // app keep ageing, and a failed read delays new cheques, not old ones.
  // A 50s budget, inside the route's 60s ceiling: it leaves room for the
  // response to be written and stops the run cleanly, as FAILED with a
  // record of what is left, rather than being killed by the platform with
  // nothing written at all.
  const autoSign = await runAutoSign(prisma, { now, deadline: new Date(now.getTime() + 50_000) })

  // Tell the admins what failed, and whether a tenant has gone stale (spec
  // 2026-10-16-notifications-design.md). Before the portal kick so the kick's
  // budget is measured after it; never throws, never changes the status code.
  await notifyCronResults(prisma, { outcomes, bills, billRefs, autoSign }, new Date())

  // The outbox: retries and the backlog. Whatever budget is left inside the
  // route's 60s ceiling, minus room for the response.
  const remaining = 55_000 - (Date.now() - now.getTime())
  const portal = await kickPortalDelivery(prisma, { budgetMs: Math.max(remaining, 5_000) })

  // Delivery failures do not turn the cron 500 (they are recorded per event).
  const failed =
    outcomes.some((o) => o.outcome === 'FAILED') ||
    bills.some((b) => b.outcome === 'FAILED') ||
    billRefs.some((b) => b.outcome === 'FAILED') ||
    autoSign.outcome === 'FAILED'
  return json({ ranAt: now.toISOString(), outcomes, bills, billRefs, autoSign, portal }, failed ? 500 : 200)
}
