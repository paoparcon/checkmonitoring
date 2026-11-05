'use client'

import { useState, useTransition } from 'react'
import { readyForReleaseAction, type ActionResult } from '@/app/checks/actions'

/**
 * `approverName` (spec 2026-11-05 §7): set when this user's action becomes a
 * request for that person rather than the change itself — the button and the
 * confirmation say so, and the success copy says where the request went.
 */
export function ReadyForReleaseForm({ checkId, defaultDate, approverName = null }: {
  checkId: string; defaultDate: string; approverName?: string | null
}) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionResult | null>(null)

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!confirm(approverName
          ? `Send a READY FOR RELEASE request for this check to ${approverName}? The check moves, and the supplier is told, only when it is approved.`
          : 'Are you sure you want to mark this check as READY FOR RELEASE?')) return
        const formData = new FormData(e.currentTarget)
        startTransition(async () => setResult(await readyForReleaseAction(formData)))
      }}
    >
      <input type="hidden" name="checkId" value={checkId} />
      <label className="block text-xs font-medium tracking-wide text-slate-600">AVAILABLE PICKUP DATE</label>
      <input name="availablePickupDate" type="date" required defaultValue={defaultDate}
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />

      <button type="submit" disabled={pending}
        className="block rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {pending ? 'SAVING…' : approverName ? 'REQUEST READY FOR RELEASE' : 'MARK READY FOR RELEASE'}
      </button>

      {result && !result.ok && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
      )}
      {result?.ok && (
        <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
          {result.requested
            ? `Request sent to ${result.requested.approverName}. The check stays SIGNED until it is approved.`
            : 'Check is now READY FOR RELEASE.'}
        </p>
      )}
    </form>
  )
}
