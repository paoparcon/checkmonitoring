import { SyncNowButton } from '@/components/SyncNowButton'
import { PortalActionButton } from '@/components/PortalRetryButton'
import { deliverPortalNowAction } from '@/app/admin/portal/actions'

/**
 * SYNC NOW per tenant and DELIVER NOW, on the dashboard for every Finance user
 * (user request 2026-10-15). `/admin` is FINANCE_ADMIN only, so a Finance user
 * could not reach either button there. RETRY on a parked portal event stays on
 * `/admin/portal`, admin-only.
 */
export function DashboardSyncControls() {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <SyncNowButton tenant="GOLIVE" label="GO-LIVE" />
      <SyncNowButton tenant="MANUFACTURING" label="MANUFACTURING" />
      <PortalActionButton label="DELIVER NOW · PORTAL" pending="DELIVERING…" action={deliverPortalNowAction} />
    </div>
  )
}
