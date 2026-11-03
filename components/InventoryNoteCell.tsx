'use client'

import { useEffect, useState } from 'react'
import { inventoryRowKey, useInventoryForm } from '@/components/InventoryForm'

export type InventoryNoteView = { ticked: boolean; remarks: string | null; updatedBy: string; updatedAt: string }

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' })

/**
 * One number's (or run's) tick box and remarks (spec §H). Nothing is written
 * here: a change files a draft with the page's InventoryForm, whose SAVE
 * INVENTORY button records every draft at once and answers per row. The row
 * shows UNSAVED while a draft is open, the refusal when its save was refused,
 * and who recorded it and when once it is saved.
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
  void checkBookId // the form carries the book; the prop names it for readers of the markup
  const form = useInventoryForm()
  const key = inventoryRowKey(checkNumber, runTo)
  const [saved, setSaved] = useState<InventoryNoteView | null>(note)
  const [ticked, setTicked] = useState(note?.ticked ?? false)
  const [remarks, setRemarks] = useState(note?.remarks ?? '')
  const [error, setError] = useState<string | null>(null)

  const result = form.results.get(key)
  useEffect(() => {
    if (!result) return
    if ('note' in result) {
      setSaved(result.note)
      setTicked(result.note.ticked)
      setRemarks(result.note.remarks ?? '')
      setError(null)
    } else setError(result.error)
  }, [result])

  const file = (next: { ticked: boolean; remarks: string }) => {
    const same = next.ticked === (saved?.ticked ?? false) && next.remarks.trim() === (saved?.remarks ?? '')
    form.setDraft(key, same ? null : { checkNumber, runTo, ticked: next.ticked, remarks: next.remarks })
    if (!same) setError(null)
  }
  const dirty = form.drafts.has(key)

  return (
    <div className="flex min-w-[18rem] flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label={`Ticked: ${label}`}
          checked={ticked}
          disabled={form.pending}
          onChange={(e) => {
            setTicked(e.target.checked)
            file({ ticked: e.target.checked, remarks })
          }}
          className="h-4 w-4 rounded border-hairline text-navy focus:ring-navy"
        />
        <input
          type="text"
          aria-label={`Remarks: ${label}`}
          placeholder="Remarks"
          value={remarks}
          maxLength={500}
          disabled={form.pending}
          onChange={(e) => {
            setRemarks(e.target.value)
            file({ ticked, remarks: e.target.value })
          }}
          className={`h-8 w-full rounded-lg border bg-white px-2 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy disabled:opacity-60 ${dirty ? 'border-amber-400' : 'border-hairline'}`}
        />
      </div>
      {error
        ? <p className="text-[11px] text-amber-800">{error}</p>
        : dirty
        ? <p className="text-[11px] font-semibold text-amber-800">UNSAVED</p>
        : saved
        ? <p className="text-[11px] text-slate-500">{saved.updatedBy} · {fmtWhen(saved.updatedAt)}</p>
        : null}
    </div>
  )
}
