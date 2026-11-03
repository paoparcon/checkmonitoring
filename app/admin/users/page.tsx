import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { isPending, listUsers } from '@/lib/admin/users'
import { BACKOFF_MINUTES, type ThrottleLimits } from '@/lib/login-throttle'
import { loadSettings } from '@/lib/settings/read'
import { CreateUserForm } from '@/components/CreateUserForm'
import { UserRowActions } from '@/components/UserRowActions'
import { PendingUserActions } from '@/components/PendingUserActions'
import { KitTable, type KitRow } from '@/components/table-kit/KitTable'
import type { KitColumn } from '@/lib/table-kit/types'
import { instantValue } from '@/lib/table-kit/match'

/**
 * `/admin/users` (spec §13). FINANCE_ADMIN only — gated by
 * `app/admin/layout.tsx` and again here, because a layout is a convenience and
 * the guard is not.
 *
 * **Nothing on this screen deletes a user.** A `User` is what
 * `Check.signedBy/readyBy/releasedBy/cancelledBy/eligibilityOverriddenBy` and
 * `AuditLog.user` point at, all of them nulling out on delete, so removing a row
 * would erase who released real money rather than failing. Removal is
 * deactivation. Deactivated accounts stay listed, greyed rather than hidden: an
 * admin who cannot see them cannot reactivate one, and would create a second
 * account for the same person instead.
 */

const fmtDateTime = (d: Date | null) =>
  d
    ? d.toLocaleString('en-PH', {
        month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : null

const fmtTime = (d: Date) =>
  d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })

export default async function UsersPage() {
  const me = await requireAdmin()
  const settings = await loadSettings(prisma)
  const limits: ThrottleLimits = {
    windowMinutes: settings.values['login.windowMinutes'],
    emailFreeFailures: settings.values['login.emailFreeFailures'],
    ipFreeFailures: settings.values['login.ipFreeFailures'],
  }
  const users = await listUsers(prisma, new Date(), limits)
  const pendingUsers = users
    .filter(isPending)
    .sort((a, b) => (b.pendingSince?.getTime() ?? 0) - (a.pendingSince?.getTime() ?? 0))
  // Pending accounts are neither ACTIVE nor DEACTIVATED and have their own
  // section; in the table they would carry a REACTIVATE button that refuses.
  const tableUsers = users.filter((u) => !isPending(u))

  const activeAdmins = users.filter((u) => u.active && u.role === 'FINANCE_ADMIN')
  const liveSeeded = users.filter((u) => u.isSeededTestAccount && u.active)
  // The seeded accounts can only be retired once a real admin exists — the
  // last-active-admin guard refuses the click otherwise, correctly. Say so up
  // front rather than letting the client discover it by being refused.
  const realAdminExists = activeAdmins.some((u) => !u.isSeededTestAccount)

  const originOf = (u: (typeof pendingUsers)[number]) =>
    u.previouslyDeactivated ? 'RE-REGISTERED — PREVIOUSLY DEACTIVATED'
      : u.hasPendingCredentials ? 'REGISTERED AGAIN WHILE PENDING' : 'NEW ACCOUNT'
  const pendingColumns: KitColumn[] = [
    { key: 'name', label: 'NAME', kind: 'text', locked: true, className: 'font-medium' },
    { key: 'email', label: 'EMAIL', kind: 'text', className: 'text-slate-600' },
    { key: 'registered', label: 'REGISTERED', kind: 'date', className: 'text-slate-600' },
    {
      key: 'origin', label: 'ORIGIN', kind: 'enum',
      options: ['RE-REGISTERED — PREVIOUSLY DEACTIVATED', 'REGISTERED AGAIN WHILE PENDING', 'NEW ACCOUNT'].map((v) => ({ value: v, label: v })),
    },
    { key: 'actions', label: 'ACTIONS', kind: 'text', noSort: true, noFilter: true, locked: true },
  ]
  const pendingRows: KitRow[] = pendingUsers.map((u) => ({
    key: u.id,
    className: 'border-b border-slate-100 last:border-0',
    values: { name: u.name, email: u.email, registered: instantValue(u.pendingSince), origin: originOf(u) },
    cells: {
      name: (
        <>
          {u.name}
          {u.pendingName !== null && u.pendingName !== u.name && (
            <div className="mt-0.5 text-xs font-normal text-warning-ink">
              <span className="mr-1 text-[10px] font-semibold tracking-wide">NAME ON APPROVAL</span>
              {`→ ${u.pendingName}`}
            </div>
          )}
        </>
      ),
      email: u.email,
      registered: fmtDateTime(u.pendingSince),
      origin: u.previouslyDeactivated ? (
        <span className="rounded bg-warning-bg px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-warning-ink">
          RE-REGISTERED — PREVIOUSLY DEACTIVATED
        </span>
      ) : u.hasPendingCredentials ? (
        <span className="rounded bg-warning-bg px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-warning-ink">
          REGISTERED AGAIN WHILE PENDING
        </span>
      ) : (
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-slate-600">
          NEW ACCOUNT
        </span>
      ),
      actions: <PendingUserActions userId={u.id} name={u.name} pendingSince={u.pendingSince!.toISOString()} />,
    },
  }))

  const userColumns: KitColumn[] = [
    { key: 'name', label: 'NAME', kind: 'text', locked: true, className: 'font-medium' },
    { key: 'email', label: 'EMAIL', kind: 'text', className: 'text-slate-600' },
    { key: 'role', label: 'ROLE', kind: 'enum', options: [...new Set(tableUsers.map((u) => u.role.replace(/_/g, ' ')))].sort().map((v) => ({ value: v, label: v })) },
    { key: 'status', label: 'STATUS', kind: 'enum', options: ['ACTIVE', 'DEACTIVATED'].map((v) => ({ value: v, label: v })) },
    { key: 'lastLogin', label: 'LAST LOGIN', kind: 'date', className: 'text-slate-600' },
    { key: 'failed', label: 'FAILED SIGN-INS', kind: 'amount' },
    { key: 'actions', label: 'ACTIONS', kind: 'text', noSort: true, noFilter: true, locked: true },
  ]
  const userRows: KitRow[] = tableUsers.map((u) => ({
    key: u.id,
    className: `border-b border-slate-100 last:border-0 ${u.active ? 'hover:bg-navy-bg' : 'bg-ground text-slate-500'}`,
    values: {
      name: u.name, email: u.email, role: u.role.replace(/_/g, ' '), status: u.active ? 'ACTIVE' : 'DEACTIVATED',
      lastLogin: instantValue(u.lastLoginAt), failed: String(u.recentFailedLogins),
    },
    cells: {
      name: (
        <>
          {u.name}
          {u.isSeededTestAccount && (
            <span className="ml-2 rounded bg-danger-bg px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-danger-ink">
              SEEDED TEST ACCOUNT
            </span>
          )}
        </>
      ),
      email: u.email,
      role: (
        <span
          className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium tracking-wide ${
            u.role === 'FINANCE_ADMIN' ? 'bg-navy-bg text-navy' : 'bg-slate-100 text-slate-700'
          }`}
        >
          {u.role.replace(/_/g, ' ')}
        </span>
      ),
      status: (
        <span
          className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium tracking-wide ${
            u.active ? 'bg-success-bg text-success-ink' : 'bg-danger-bg text-danger-ink'
          }`}
        >
          {u.active ? 'ACTIVE' : 'DEACTIVATED'}
        </span>
      ),
      // An em dash, not an empty cell: an account that has never been signed into
      // is a fact worth reading, and a blank reads as a rendering fault.
      lastLogin: fmtDateTime(u.lastLoginAt) ?? 'NEVER SIGNED IN',
      // The login throttle, made visible: the count is read from the same
      // function the gate itself uses, so the two cannot disagree.
      failed: u.lockedUntil ? (
        <span className="inline-block whitespace-nowrap rounded-full bg-danger-bg px-2.5 py-1 text-xs font-medium tracking-wide text-danger-ink">
          LOCKED UNTIL {fmtTime(u.lockedUntil)} · {u.recentFailedLogins} FAILED
        </span>
      ) : u.recentFailedLogins > 0 ? (
        <span className="inline-block rounded-full bg-warning-bg px-2.5 py-1 text-xs font-medium tracking-wide text-warning-ink">
          {u.recentFailedLogins} RECENT
        </span>
      ) : (
        <span className="text-slate-400">NONE</span>
      ),
      actions: (
        <UserRowActions
          userId={u.id} name={u.name} role={u.role} active={u.active}
          isSelf={u.id === me.id}
        />
      ),
    },
  }))

  return (
    <div className="space-y-6">
      {liveSeeded.length > 0 && (
        <section className="space-y-2 rounded-2xl bg-danger-bg p-6 ring-1 ring-danger-ink/20">
          <h2 className="text-sm font-semibold tracking-wide text-danger-ink">
            SEEDED TEST ACCOUNTS ARE STILL ACTIVE — DEACTIVATE BEFORE PRODUCTION
          </h2>
          <p className="text-sm text-danger-ink">
            {liveSeeded.map((u) => u.email).join(' and ')}{' '}
            {liveSeeded.length === 1 ? 'was' : 'were'} created by{' '}
            <code className="rounded bg-white/70 px-1">prisma/seed.ts</code> with a password that
            is committed to this repository, so anyone who can read the source can sign in.{' '}
            {realAdminExists
              ? 'A real Finance Admin now exists, so you can deactivate them: press DEACTIVATE on each row below.'
              : 'Create a real Finance Admin first — until one exists, deactivating these would ' +
                'leave nobody able to administer the system and will be refused.'}
          </p>
          <p className="text-sm text-danger-ink">
            Deactivate, never delete: these accounts may already be named in the audit trail, and a
            deleted row would take that attribution with it.
          </p>
        </section>
      )}

      {pendingUsers.length > 0 && (
        <section className="overflow-x-auto rounded-2xl bg-white ring-1 ring-warning-ink/30">
          <div className="flex flex-wrap items-baseline justify-between gap-3 px-6 pb-4 pt-6">
            <h2 className="text-[11px] font-semibold tracking-widest text-warning-ink">
              PENDING APPROVAL — {pendingUsers.length} ACCOUNT{pendingUsers.length === 1 ? '' : 'S'} WAITING
            </h2>
            <p className="text-xs text-slate-500">
              Created on the sign-up page. Nothing can sign in until you approve it with a role.
            </p>
          </div>
          <div className="px-4 pb-4">
            <KitTable tableId="users-pending" frameClassName="overflow-x-auto" columns={pendingColumns} rows={pendingRows} />
          </div>
          <div className="space-y-2 px-6 pb-5 text-xs leading-relaxed text-slate-500">
            {pendingUsers.some((u) => u.hasPendingCredentials) && (
              <p>
                A re-registered account keeps its current name and password until you approve; the typed name
                is shown beside it. REJECT discards what was typed and leaves the account exactly as it was, so
                REACTIVATE restores it. Confirm with the person before approving.
              </p>
            )}
            <p>REJECT leaves the account deactivated; it can be reactivated from the table later.</p>
          </div>
        </section>
      )}

      <CreateUserForm />

      <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
        <div className="flex flex-wrap items-baseline justify-between gap-3 px-6 pb-4 pt-6">
          <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">USERS</h2>
          <p className="text-[11px] font-medium tracking-wide text-slate-400">
            {activeAdmins.length} ACTIVE FINANCE ADMIN{activeAdmins.length === 1 ? '' : 'S'}
          </p>
        </div>

        <div className="px-4 pb-4">
          <KitTable tableId="users" frameClassName="overflow-x-auto" columns={userColumns} rows={userRows} />
        </div>
      </div>

      <p className="max-w-4xl rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        Accounts are never deleted here. A user is named on the checks they signed, marked ready,
        released or cancelled, and on every audit entry they wrote; deleting the row would blank
        that attribution out rather than fail. DEACTIVATE is removal — a deactivated account is
        refused at sign-in and keeps its history. The last active Finance Admin can be neither
        deactivated nor demoted, including by themselves.
      </p>

      <p className="max-w-4xl rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        FAILED SIGN-INS counts wrong passwords for that address in the last {limits.windowMinutes}{' '}
        minutes, and resets the moment the account signs in successfully. Past{' '}
        {limits.emailFreeFailures} failures the login is refused for a minute, then longer, up to a
        maximum of {BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1]} minutes. A lockout releases
        itself — there is nothing to press here, and nobody needs to be called. The same throttle
        counts failures per client address, so an attacker cannot spread guesses across accounts
        to avoid it.
      </p>
    </div>
  )
}
