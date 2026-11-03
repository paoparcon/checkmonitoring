import Link from 'next/link'
import { signOutAction } from '@/app/actions'
import type { SessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { countUnread } from '@/lib/notifications/queries'
import { ModuleNav } from './ModuleNav'

/**
 * The header every signed-in page carries: the product, who you are and how
 * to stop being signed in, the module bar, and the page's own title.
 *
 * Three lines since 2026-09-12 — the client asked for every area to be a
 * module like CHECK RELEASE, so the bar is the same on every page and the
 * current module is lit rather than hidden. The bar highlights; it never
 * gates: every page keeps `requireUser()` / `requireAdmin()`.
 *
 * Restyled 2026-09-27: the product line carries the same navy mark as the
 * sign-in and landing pages, and the session sits in a white chip with the
 * role as a pastel pill. Same words, same controls, same order.
 *
 * The sign-out control is a plain `<form>` posting a server action, not a
 * client component with an onClick. It therefore works before React hydrates
 * and on a page with a JavaScript error — which is exactly when a shared
 * workstation most needs to be signable-out of. `/login` and `/welcome` are
 * the only pages without this header, and they have nothing to sign out of.
 *
 * Since 2026-10-16 it carries the NOTIFICATIONS link with the user's unread
 * count (spec 2026-10-16-notifications-design.md), so it is an async server
 * component.
 */
export async function AppHeader({
  user, title, back,
}: {
  user: SessionUser
  title: string
  back?: { href: string; label: string }
}) {
  // The bell's count: one indexed count per render, no polling. A failed count
  // shows no number rather than breaking the page.
  let unread: number | null = null
  try {
    unread = await countUnread(prisma, user.id)
  } catch (e) {
    console.error('unread notification count failed:', e instanceof Error ? e.message : e)
  }

  return (
    <header className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-9 min-w-[2.25rem] items-center justify-center rounded-xl bg-navy px-2 text-[11px] font-semibold tracking-widest text-white shadow-sm"
          >
            CRM
          </span>
          <p className="text-[11px] font-semibold tracking-widest text-slate-500">CHECK RELEASE MONITORING</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
          <Link
            href="/notifications"
            className="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm ring-1 ring-hairline transition hover:bg-navy-bg hover:text-navy"
          >
            NOTIFICATIONS
            {unread !== null && unread > 0 && (
              <span className="rounded-full bg-navy px-2 py-0.5 text-[10px] font-semibold text-white">{unread}</span>
            )}
          </Link>
          {/* The name, with the email beside it. Two people called "Ronald" is
              not a hypothetical in a finance department, and the address is what
              makes the session unambiguous on a shared machine. */}
          <span className="flex items-center gap-2 rounded-full bg-white py-1.5 pl-4 pr-1.5 text-xs text-slate-600 shadow-sm ring-1 ring-hairline">
            <span>
              {user.name} <span className="text-slate-400">({user.email})</span>
            </span>
            <span className="rounded-full bg-navy-bg px-2.5 py-1 text-[10px] font-semibold tracking-wide text-navy">
              {user.role.replace(/_/g, ' ')}
            </span>
          </span>
          <form action={signOutAction}>
            <button
              type="submit"
              className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm ring-1 ring-hairline transition hover:bg-navy-bg hover:text-navy"
            >
              SIGN OUT
            </button>
          </form>
        </div>
      </div>

      <ModuleNav role={user.role} />

      <div className="flex flex-wrap items-baseline gap-6">
        <h1 className="text-xl font-semibold tracking-wide text-navy">{title}</h1>
        {back && (
          <Link href={back.href} className="text-sm text-slate-500 underline underline-offset-2 hover:text-navy">
            {back.label}
          </Link>
        )}
      </div>
    </header>
  )
}
