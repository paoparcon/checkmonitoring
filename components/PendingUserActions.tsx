'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { AdminActionResult } from '@/app/admin/actions'
import { approveUserAction, rejectUserAction } from '@/app/admin/users/actions'

/**
 * APPROVE (with a role) and REJECT for one pending registration. The pattern
 * is `UserRowActions`: the server decides, this shows the result in the row.
 * Takes plain fields, not the row, so nothing it does not need crosses into
 * the browser.
 *
 * APPROVE also sends `pendingSince`, the registration this page showed. If the
 * account re-registered since, the server refuses with its own message and the
 * row shows it; REJECT does not need it.
 */
export function PendingUserActions({
  userId,
  name,
  pendingSince,
}: {
  userId: string
  name: string
  pendingSince: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<AdminActionResult | null>(null)
  const [role, setRole] = useState<'FINANCE_USER' | 'FINANCE_ADMIN'>('FINANCE_USER')

  const submit = (action: (f: FormData) => Promise<AdminActionResult>, extra: Record<string, string> = {}) => {
    const f = new FormData()
    f.append('userId', userId)
    for (const [k, v] of Object.entries(extra)) f.append(k, v)
    startTransition(async () => {
      const r = await action(f)
      setResult(r)
      // Refresh on EVERY result: a refused APPROVE (re-registered, or no
      // longer pending) means the row on screen is stale, and the new
      // REGISTERED time and ORIGIN should sit beside the message.
      router.refresh()
    })
  }

  const button = 'rounded-lg px-3 py-1.5 text-xs font-medium tracking-wide transition disabled:opacity-50'

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`pending-role-${userId}`}>Role for {name}</label>
        <select
          id={`pending-role-${userId}`}
          value={role}
          onChange={(e) => setRole(e.target.value as 'FINANCE_USER' | 'FINANCE_ADMIN')}
          className="h-9 rounded-lg border border-hairline bg-white px-2 text-xs text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy"
        >
          <option value="FINANCE_USER">FINANCE USER</option>
          <option value="FINANCE_ADMIN">FINANCE ADMIN</option>
        </select>
        <button
          type="button" disabled={pending}
          onClick={() => submit(approveUserAction, { role, pendingSince })}
          className={`${button} bg-navy text-white hover:bg-navy/90`}
        >
          APPROVE
        </button>
        <button
          type="button" disabled={pending}
          onClick={() => submit(rejectUserAction)}
          className={`${button} bg-white text-danger-ink ring-1 ring-danger-ink/30 hover:bg-danger-bg`}
        >
          REJECT
        </button>
      </div>
      {result && !result.ok && (
        <p className="rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning-ink">{result.message}</p>
      )}
    </div>
  )
}
