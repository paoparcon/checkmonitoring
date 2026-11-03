import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { AppHeader } from '@/components/AppHeader'
import { AdminTabs } from '@/components/AdminTabs'

// Every admin route is FINANCE_ADMIN only (spec §12). Enforced here so a new
// page under /admin is gated by existing, not by its author remembering — and
// again in each page, because a layout is a convenience and the guard is not.
//
// `requireAdmin` REDIRECTS a Finance user, which is right for a page and wrong
// for a server action: an action returns its refusal instead, because a thrown
// redirect inside one is caught by the action's own error handling. See
// `app/admin/actions.ts`.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAdmin()
  // The one definition of pending, in SQL: inactive with the flag set
  // (`isPending`, lib/admin/users.ts). One count per admin page load.
  const pendingCount = await prisma.user.count({ where: { active: false, pendingSince: { not: null } } })

  const tabs = [
    ['/admin/users', 'USERS', pendingCount],
    ['/admin/sync', 'SYNC'],
    ['/admin/portal', 'PORTAL'],
    ['/admin/import', 'IMPORT'],
    ['/admin/staged', 'STAGED QUEUE'],
    ['/admin/audit', 'AUDIT'],
    ['/admin/settings', 'SETTINGS'],
  ] as const

  return (
    <main className="space-y-4 px-4 py-5">
      <AppHeader
        user={user}
        title="ADMINISTRATION"
        back={{ href: '/', label: '← DASHBOARD' }}
      />

      {/* Which tab you are on is a browser fact, so the tabs are a client
          component. They highlight; they do not gate. The gate is
          `requireAdmin()` above and again inside every page. */}
      <AdminTabs tabs={tabs} />

      {children}
    </main>
  )
}
