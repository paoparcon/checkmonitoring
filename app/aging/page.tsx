import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { loadSettings } from '@/lib/settings/read'
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

export default async function AgingPage() {
  const user = await requireUser()
  const now = new Date()
  const [{ rows, truncated }, settings] = await Promise.all([loadAgingRows(prisma, now), loadSettings(prisma)])

  return (
    <main className="space-y-4 px-4 py-5">
      <AppHeader user={user} title="AGING" back={{ href: '/', label: '← DASHBOARD' }} />
      <AgingPicker rows={rows} cap={settings.values['caps.bulkSelection']} truncated={truncated} />
    </main>
  )
}
