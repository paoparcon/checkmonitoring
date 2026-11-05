'use client'

import { useState, useTransition } from 'react'
import type { ActionResult } from '@/app/checks/actions'

export function ActionForm({
  action, checkId, label, className, children,
}: {
  action: (formData: FormData) => Promise<ActionResult>
  checkId: string
  label: string
  className?: string
  children?: React.ReactNode
}) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionResult | null>(null)

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        const formData = new FormData(e.currentTarget)
        startTransition(async () => setResult(await action(formData)))
      }}
    >
      <input type="hidden" name="checkId" value={checkId} />
      {children}
      <button type="submit" disabled={pending} className={className}>
        {pending ? 'SAVING…' : label}
      </button>
      {result && !result.ok && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
      )}
      {/* A gated action that became a request (2026-11-05): the check did not
          move, so the page re-rendering says nothing — this line does. */}
      {result?.ok && result.requested && (
        <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
          Request sent to {result.requested.approverName}. The check stays as it is until it is approved.
        </p>
      )}
    </form>
  )
}
