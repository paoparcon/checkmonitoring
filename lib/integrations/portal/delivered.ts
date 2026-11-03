import type { PortalEventStatus } from '@prisma/client'

/**
 * Whether an outbox row was actually delivered to the portal, as opposed to
 * closed unsent. The worker records both as SYNCED and tells them apart by
 * `lastError`: a delivered row has none, or the portal's own `unmatched: …`
 * note; a row closed unsent carries `superseded by …`, `stale: …`,
 * `unmatchable: …` (scripts/close-unmatchable-cancelled.ts) or
 * `closed unsent: …` (a hand repair, 2026-11-03). `/admin/portal` counts the
 * same prefixes. Pure.
 */
export const CLOSED_UNSENT_PREFIXES = ['superseded by', 'stale:', 'unmatchable:', 'closed unsent:'] as const

export function deliveredToPortal(ev: { status: PortalEventStatus; lastError: string | null }): boolean {
  if (ev.status !== 'SYNCED') return false
  if (ev.lastError === null) return true
  return !CLOSED_UNSENT_PREFIXES.some((p) => ev.lastError!.startsWith(p))
}
