import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { loadAgingRows } from '@/lib/aging/query'
import { AppHeader } from '@/components/AppHeader'
import { AgingPicker } from '@/components/AgingPicker'

/**
 * AGING (spec 2026-10-15-aging-module-design.md): SIGNED and READY FOR
 * RELEASE checks in the Supplier Portal's buckets — days past the earliest due
 * date of the bills each check pays. Only the SIGNED ones can be ticked and
 * marked READY FOR RELEASE through the existing `bulkReadyForReleaseAction`;
 * the already-available ones are shown with a STATUS. No other write. `requireUser()` first: it
 * lists payees and amounts.
 */
export const dynamic = 'force-dynamic'
// A select-all MARK READY runs here; runEach stops at 45 s (2026-11-05).
export const maxDuration = 60

export default async function AgingPage() {
  const user = await requireUser()
  const now = new Date()
  const { rows, truncated } = await loadAgingRows(prisma, now)

  return (
    <main className="space-y-4 px-4 py-5">
      <AppHeader user={user} title="AGING" back={{ href: '/', label: '← DASHBOARD' }} />
      <AgingPicker rows={rows} truncated={truncated} />
    </main>
  )
}
