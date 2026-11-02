'use client'

import { useState, useTransition } from 'react'
import { recordInventoryNoteAction } from '@/app/numbering/actions'

export type InventoryNoteView = { ticked: boolean; remarks: string | null; updatedBy: string; updatedAt: string }

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' })

/**
 * One MISSING number's (or run's) tick box and remarks (spec §H). Saves on
 * its own: the tick the moment it changes, the remark when the box is left
 * or Enter is pressed and the text differs from what is recorded. No page
 * reload — a book can show 7,000 lines — so the row keeps what the server
 * confirmed and says who recorded it and when.
 */
export function InventoryNoteCell({
  checkBookId, checkNumber, runTo, note, label,
}: {
  checkBookId: string
  checkNumber: string
  /** The end of the run this note stands for; absent for one number. */
  runTo?: string
  note: InventoryNoteView | null
  /** Names the line for assistive tech: "6000354301" or "6000354301 – 6000354349". */
  label: string
}) {
  const [saved, setSaved] = useState<InventoryNoteView | null>(note)
  const [ticked, setTicked] = useState(note?.ticked ?? false)
  const [remarks, setRemarks] = useState(note?.remarks ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const save = (next: { ticked: boolean; remarks: string }) => {
    const formData = new FormData()
    formData.set('checkBookId', checkBookId)
    formData.set('checkNumber', checkNumber)
    if (runTo) formData.set('runTo', runTo)
    formData.set('ticked', next.ticked ? '1' : '0')
    formData.set('remarks', next.remarks)
    startTransition(async () => {
      const r = await recordInventoryNoteAction(formData)
      if (r.ok) {
        setSaved(r.note)
        setTicked(r.note.ticked)
        setRemarks(r.note.remarks ?? '')
        setError(null)
      } else {
        // Back to what is recorded: a refused tick must not look ticked.
        setTicked(saved?.ticked ?? false)
        setRemarks(saved?.remarks ?? '')
        setError(r.message)
      }
    })
  }

  const remarksChanged = remarks.trim() !== (saved?.remarks ?? '')

  return (
    <div className="flex min-w-[18rem] flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label={`Ticked: ${label}`}
          checked={ticked}
          disabled={pending}
          onChange={(e) => {
            setTicked(e.target.checked)
            save({ ticked: e.target.checked, remarks })
          }}
          className="h-4 w-4 rounded border-hairline text-navy focus:ring-navy"
        />
        <input
          type="text"
          aria-label={`Remarks: ${label}`}
          placeholder="Remarks"
          value={remarks}
          maxLength={500}
          disabled={pending}
          onChange={(e) => setRemarks(e.target.value)}
          onBlur={() => { if (remarksChanged) save({ ticked, remarks }) }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          className="h-8 w-full rounded-lg border border-hairline bg-white px-2 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy disabled:opacity-60"
        />
      </div>
      {error
        ? <p className="text-[11px] text-amber-800">{error}</p>
        : pending
        ? <p className="text-[11px] text-slate-400">SAVING…</p>
        : saved
        ? <p className="text-[11px] text-slate-500">{saved.updatedBy} · {fmtWhen(saved.updatedAt)}</p>
        : null}
    </div>
  )
}
