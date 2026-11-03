import { Prisma } from '@prisma/client'
import { formatMoney } from '@/lib/money'
import type { ScheduledSyncOutcome } from '@/lib/sync/scheduled'
import type { ScheduledBillsOutcome } from '@/lib/sync/bills'
import type { ScheduledBillRefsOutcome } from '@/lib/sync/bill-refs'
import type { AutoSignRun } from '@/lib/sync/auto-sign'
import type { Staleness } from '@/lib/sync/staleness'

/**
 * What each notification says, and to whom (spec 2026-10-16-notifications-design.md).
 * Pure: outcomes in, notices out. `notify` (./notify.ts) resolves the audience
 * to people and writes the rows.
 */
export type NotificationKind = 'SYNC_FAILED' | 'AUTO_SIGN_FAILED' | 'SYNC_STALE' | 'PORTAL_PARKED' | 'READY_FOR_RELEASE'
export type Audience = 'ADMINS' | 'FINANCE'
export type Notice = {
  kind: NotificationKind
  audience: Audience
  message: string
  link: string | null
  dedupeKey?: string
  checkId?: string
}

const SYNC_LINK = '/admin/sync'
const NO_WATERMARK = 'no watermark. A first read must be run from a terminal.'

type ReadOutcome = { tenant: string; outcome: string; message?: string }

function readNotices(read: string, list: readonly ReadOutcome[]): Notice[] {
  return list.flatMap((o): Notice[] => {
    if (o.outcome === 'FAILED') {
      return [{ kind: 'SYNC_FAILED', audience: 'ADMINS', link: SYNC_LINK,
        message: `Scheduled Acumatica ${read} failed for ${o.tenant}: ${o.message ?? 'no detail recorded'}` }]
    }
    if (o.outcome === 'REFUSED_NO_WATERMARK') {
      return [{ kind: 'SYNC_FAILED', audience: 'ADMINS', link: SYNC_LINK,
        message: `Scheduled Acumatica ${read} refused for ${o.tenant}: ${NO_WATERMARK}` }]
    }
    // RAN, IN_PROGRESS, SKIPPED_PAYMENT_NOT_RUN, SKIPPED_TIME_BUDGET: not failures.
    return []
  })
}

/** The cron's results, as notices. Only FAILED and REFUSED notify. */
export function syncFailureNotices(r: {
  outcomes: readonly ScheduledSyncOutcome[]
  bills: readonly ScheduledBillsOutcome[]
  billRefs: readonly ScheduledBillRefsOutcome[]
  autoSign: AutoSignRun
}): Notice[] {
  const notices = [
    ...readNotices('payment read', r.outcomes as readonly ReadOutcome[]),
    ...readNotices('voucher read (BILLS)', r.bills as readonly ReadOutcome[]),
    ...readNotices('PO number read (BILL_REFS)', r.billRefs as readonly ReadOutcome[]),
  ]
  if (r.autoSign.outcome === 'FAILED') {
    notices.push({ kind: 'AUTO_SIGN_FAILED', audience: 'ADMINS', link: SYNC_LINK,
      message: `Auto-sign failed: ${r.autoSign.error ?? 'no detail recorded'}` })
  }
  return notices
}

/** One notice per stale tenant, once per stale stretch (keyed on its last good read). */
export function staleNotices(s: Staleness): Notice[] {
  return s.tenants.filter((t) => t.stale).map((t): Notice => ({
    kind: 'SYNC_STALE', audience: 'ADMINS', link: SYNC_LINK,
    dedupeKey: `stale:${t.tenant}:${t.lastReadAt?.toISOString() ?? 'never'}`,
    message: t.lastReadAt === null
      ? `Acumatica has never been read successfully for ${t.tenant}.`
      : `No successful Acumatica read for ${t.tenant} in ${t.hoursAgo} hours.`,
  }))
}

/** A portal outbox event that needs a person. Once per event. */
export function parkedNotice(a: {
  eventId: string; kind: string; checkId: string | null; checkNumber: string | null; error: string | null
}): Notice {
  const which = a.checkId === null ? 'a check no longer held' : `check ${a.checkNumber ?? '(no number)'}`
  return {
    kind: 'PORTAL_PARKED', audience: 'ADMINS', link: '/admin/portal', dedupeKey: `parked:${a.eventId}`,
    ...(a.checkId === null ? {} : { checkId: a.checkId }),
    message: `Portal event ${a.kind} for ${which} parked: ${a.error ?? 'no detail recorded'}`,
  }
}

/** One notice for one ready action. Totals per currency, in Decimal, never a float. */
export function readyNotice(a: {
  actorName: string
  checks: readonly { checkNumber: string | null; amount: string | null; currency: string }[]
}): Notice | null {
  if (a.checks.length === 0) return null
  const totals = new Map<string, Prisma.Decimal>()
  for (const c of a.checks) {
    if (c.amount === null) continue
    totals.set(c.currency, (totals.get(c.currency) ?? new Prisma.Decimal(0)).plus(c.amount))
  }
  const money = [...totals].map(([cur, sum]) => formatMoney(sum.toFixed(2), cur)).join(', ')
  const what = a.checks.length === 1
    ? `check ${a.checks[0].checkNumber ?? '(no number)'}`
    : `${a.checks.length} checks`
  return {
    kind: 'READY_FOR_RELEASE', audience: 'FINANCE', link: '/?status=READY_FOR_RELEASE',
    message: `${a.actorName} marked ${what} READY FOR RELEASE${money ? `: ${money}` : ''}`,
  }
}

/** An in-app path, or null. Never lets a stored value send someone off-site. */
export function safeLink(link: string | null): string | null {
  if (!link || !link.startsWith('/') || link.startsWith('//') || link.startsWith('/\\')) return null
  return link
}
