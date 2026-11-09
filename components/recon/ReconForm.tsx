'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { ReconActionResult } from '@/app/recon/actions'

/**
 * A reconciliation form: posts its fields to one server action and says what
 * happened. On success the page re-renders from the server (`router.refresh`),
 * so every figure on it is the server's, never this component's. `confirm`
 * asks first, for an action that cannot be taken back.
 */
export function ReconForm({
  action, hidden = {}, label, children, className = '', buttonClass, confirm, resetOnSuccess = true,
}: {
  action: (f: FormData) => Promise<ReconActionResult>
  hidden?: Record<string, string>
  label: string
  children?: React.ReactNode
  className?: string
  buttonClass?: string
  confirm?: string
  resetOnSuccess?: boolean
}) {
  const [pending, start] = useTransition()
  const [result, setResult] = useState<ReconActionResult | null>(null)
  const router = useRouter()
  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault()
        if (confirm && !window.confirm(confirm)) return
        const form = e.currentTarget
        const f = new FormData(form)
        for (const [k, v] of Object.entries(hidden)) f.set(k, v)
        start(async () => {
          const r = await action(f)
          setResult(r)
          if (r.ok) { if (resetOnSuccess) form.reset(); router.refresh() }
        })
      }}
    >
      {children}
      <button type="submit" disabled={pending} className={buttonClass ?? BUTTON}>{pending ? 'SAVING…' : label}</button>
      {result && (
        <p role="status" className={`mt-2 basis-full rounded-lg p-2 text-sm ${result.ok ? 'bg-emerald-50 text-emerald-900' : 'bg-amber-50 text-amber-900'}`}>
          {result.ok ? result.message ?? 'Saved.' : result.message}
        </p>
      )}
    </form>
  )
}

export const BUTTON = 'h-10 rounded-lg bg-navy px-4 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90 disabled:opacity-50'
export const BUTTON_QUIET = 'h-9 rounded-lg bg-white px-3 text-xs font-medium tracking-wide text-navy ring-1 ring-hairline transition hover:bg-navy-bg disabled:opacity-50'
export const FIELD = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'
export const LABEL = 'block text-[11px] font-semibold tracking-widest text-slate-400'
