import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { AppHeader } from '@/components/AppHeader'
import { EmptyState } from '@/components/EmptyState'
import { listNotifications, NOTIFICATION_PAGE_LIMIT } from '@/lib/notifications/queries'
import { markAllReadAction, openNotificationAction } from './actions'

export const dynamic = 'force-dynamic'

const fmt = (d: Date) =>
  d.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })

const BUTTON =
  'rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm ring-1 ring-hairline transition hover:bg-navy-bg hover:text-navy'

/**
 * The session user's own notifications, newest first (spec
 * 2026-10-16-notifications-design.md). Plain forms posting server actions: no
 * client JavaScript.
 */
export default async function NotificationsPage() {
  const user = await requireUser()
  const rows = await listNotifications(prisma, user.id)
  const unread = rows.filter((r) => r.readAt === null).length

  return (
    <main className="space-y-4 px-4 py-5">
      <AppHeader user={user} title="NOTIFICATIONS" back={{ href: '/', label: '← DASHBOARD' }} />
      {rows.length === 0 ? (
        <EmptyState title="No notifications yet.">
          Failed or stale Acumatica reads, parked portal events and checks marked READY FOR RELEASE appear here.
        </EmptyState>
      ) : (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-500">
              {unread} unread{rows.length === NOTIFICATION_PAGE_LIMIT ? ` · the newest ${NOTIFICATION_PAGE_LIMIT} shown` : ''}
            </p>
            {unread > 0 && (
              <form action={markAllReadAction}>
                <button type="submit" className={BUTTON}>MARK ALL READ</button>
              </form>
            )}
          </div>
          <ul className="divide-y divide-hairline rounded-xl bg-white shadow-sm ring-1 ring-hairline">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0 space-y-0.5">
                  <p className={`text-sm ${r.readAt === null ? 'font-semibold text-navy' : 'text-slate-600'}`}>{r.message}</p>
                  <p className="text-xs text-slate-400">{fmt(r.createdAt)}</p>
                </div>
                {r.link && (
                  <form action={openNotificationAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit" className={BUTTON}>OPEN</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}
