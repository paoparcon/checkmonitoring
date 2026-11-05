'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { approveRequestAction, rejectRequestAction, type DecisionResult } from '@/app/approvals/actions'

const APPROVE = 'rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium tracking-wide text-white disabled:opacity-50'
const REJECT = 'rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium tracking-wide text-white disabled:opacity-50'
const FIELD = 'h-8 rounded-lg border border-hairline bg-white px-2 text-xs text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

/**
 * APPROVE / REJECT over one request or a selection (spec 2026-11-05 §7). The
 * approver only — the page renders it for nobody else, and the server action
 * refuses anyone else by name. REJECT needs a note; APPROVE takes one.
 */
export function ApprovalDecision({ requestIds, compact = false, onDone }: {
  requestIds: string[]
  /** One row: the note box is narrow and the buttons small. */
  compact?: boolean
  onDone?: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState('')
  const [result, setResult] = useState<DecisionResult | null>(null)
  const n = requestIds.length

  const submit = (action: (f: FormData) => Promise<DecisionResult>) => {
    const f = new FormData()
    for (const id of requestIds) f.append('requestId', id)
    f.set('note', note.trim())
    startTransition(async () => {
      const r = await action(f)
      setResult(r)
      if (r.ok && r.decided > 0) { setNote(''); router.refresh(); onDone?.() }
    })
  }

  return (
    <div className={compact ? 'space-y-1' : 'space-y-2'}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={note} onChange={(e) => setNote(e.target.value)} disabled={pending}
          placeholder={compact ? 'Note (required to reject)' : 'Note — required to reject, optional to approve'}
          className={`${FIELD} ${compact ? 'w-48' : 'w-80'}`}
        />
        <button type="button" disabled={pending || n === 0} className={APPROVE}
          onClick={() => {
            if (!confirm(`Approve ${n} request(s)? The check${n === 1 ? '' : 's'} move${n === 1 ? 's' : ''} and the Supplier Portal is told.`)) return
            submit(approveRequestAction)
          }}>
          {pending ? 'WORKING…' : n === 1 ? 'APPROVE' : `APPROVE ${n}`}
        </button>
        <button type="button" disabled={pending || n === 0 || note.trim() === ''} className={REJECT}
          onClick={() => {
            if (!confirm(`Reject ${n} request(s)? The check${n === 1 ? ' stays' : 's stay'} as ${n === 1 ? 'it is' : 'they are'}.`)) return
            submit(rejectRequestAction)
          }}>
          {n === 1 ? 'REJECT' : `REJECT ${n}`}
        </button>
      </div>
      {result && !result.ok && <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">{result.message}</p>}
      {result?.ok && result.failed.length > 0 && (
        <ul className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
          {result.failed.map((f) => <li key={f.requestId}>{f.message}</li>)}
        </ul>
      )}
      {result?.ok && result.decided > 0 && result.failed.length === 0 && (
        <p className="text-xs text-success-ink">{result.decided} decided.</p>
      )}
    </div>
  )
}
