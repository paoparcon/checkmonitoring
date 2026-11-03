import type { PrismaClient } from '@prisma/client'
import { getSyncOverview } from '@/lib/admin/sync-overview'
import { describeStaleness } from '@/lib/sync/staleness'
import { loadSettings } from '@/lib/settings/read'
import { safeNotify } from './notify'
import { staleNotices, syncFailureNotices } from './messages'

/**
 * The scheduled run's notices: one per FAILED or REFUSED read and for an
 * auto-sign FAILED, then one per stale tenant (once per stale stretch). Called
 * by the cron route after its reads. Never throws, and never changes the
 * route's HTTP status.
 *
 * Known limit (spec 2026-10-16-notifications-design.md): if the cron stops
 * running altogether, nothing runs the stale check. The dashboard's stale line
 * is the backstop.
 */
export async function notifyCronResults(
  db: PrismaClient, r: Parameters<typeof syncFailureNotices>[0], now: Date,
): Promise<void> {
  await safeNotify(db, syncFailureNotices(r))
  try {
    const settings = await loadSettings(db)
    const overview = await getSyncOverview(db, now, settings.values['sync.abandonedAfterMinutes'])
    const staleness = describeStaleness(
      overview.tenants.map((t) => ({ tenant: t.tenant, lastReadAt: t.lastSuccess?.startedAt ?? null })),
      now,
      settings.values['sync.staleAfterHours'],
    )
    await safeNotify(db, staleNotices(staleness))
  } catch (e) {
    console.error('stale-sync notification could not be computed:', e instanceof Error ? e.message : e)
  }
}
