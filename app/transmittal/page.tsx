import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { loadTransmittalCandidates } from '@/lib/transmittal-query'
import { AppHeader } from '@/components/AppHeader'
import { TransmittalBuilder } from '@/components/TransmittalBuilder'

/**
 * CHECKS TRANSMITTAL — the sheet that goes with a batch of checks to the
 * person who signs or collects them (client request 2026-10-06).
 *
 * The pick list opens with every real check at SIGNATURE PENDING or SIGNED
 * that has a recorded amount. RELEASED is a further option in the status
 * dropdown (client, 2026-10-09): those ~10,000 rows load from
 * `/api/transmittal/released` when it is chosen, not with every page view.
 * The page only reads: nothing here changes a status, so printing a
 * transmittal is safe to do twice. It has a `@media print` stylesheet, like
 * `/print`; "saved" is the browser's Save as PDF. `requireUser()` first: it
 * lists payees and amounts.
 */
export const dynamic = 'force-dynamic'

export default async function TransmittalPage() {
  const user = await requireUser()
  const { candidates, truncated } = await loadTransmittalCandidates(prisma, ['SIGNATURE_PENDING', 'SIGNED'])

  return (
    <main className="space-y-4 px-4 py-5">
      <div className="print-hide">
        <AppHeader user={user} title="CHECKS TRANSMITTAL" back={{ href: '/', label: '← DASHBOARD' }} />
      </div>
      <TransmittalBuilder candidates={candidates} preparedBy={user.name} truncated={truncated} />
    </main>
  )
}
