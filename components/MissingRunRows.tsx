'use client'

import { useState } from 'react'
import { INVENTORY_EXPAND_PAGE, listRun } from '@/lib/numbering/inventory'
import { InventoryNoteCell, type InventoryNoteView } from '@/components/InventoryNoteCell'
import { MissingNumberRow } from '@/components/MissingNumberRow'
import { MissingPill, TH } from '@/components/numbering-cells'

/**
 * A MISSING run too long to list by default (spec §H, second pass): one amber
 * line with the run's own tick and remark, which OPENS on a click into one row
 * per number — INVENTORY_EXPAND_PAGE at a time, SHOW MORE for the next page —
 * and closes on another. Numbers are listed in the browser from `from` and
 * `to` (BigInt; a run can be billions, so nothing is listed until asked);
 * each gets the note recorded on it, keyed by canonical number.
 */
export function MissingRunRows({
  checkBookId, from, to, count, label, runNote, stale, notes,
}: {
  checkBookId: string
  from: string
  to: string
  count: string
  /** `missingLabel(e)`: "174267 – 174389 · MISSING · 123". */
  label: string
  runNote: InventoryNoteView | null
  /** The run the note was recorded on, when it no longer matches this run; null otherwise. */
  stale: { from: string; to: string } | null
  /** Notes on single numbers inside the run, keyed by canonical number. */
  notes: Record<string, InventoryNoteView>
}) {
  const [open, setOpen] = useState(false)
  const [pages, setPages] = useState(1)
  const shown = open ? listRun(from, to, pages * INVENTORY_EXPAND_PAGE, from.length) : []
  const total = BigInt(count)
  const left = total - BigInt(shown.length)
  const fmt = (n: bigint) => (n.toString().length <= 15 ? Number(n).toLocaleString('en-PH') : n.toString())
  const canonical = (n: string) => BigInt(n).toString()

  return (
    <>
      <tr className="border-b border-amber-200 bg-amber-50">
        <td colSpan={4} className={`${TH} font-semibold tabular-nums text-amber-800`}>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="inline-flex items-center gap-2 rounded text-left hover:underline focus:outline-none focus:ring-1 focus:ring-navy"
          >
            <span aria-hidden="true" className="text-xs">{open ? '▾' : '▸'}</span>
            {label}
            <span className="font-normal text-amber-800/70">· {open ? 'CLICK TO CLOSE' : 'CLICK TO LIST EACH NUMBER'}</span>
          </button>
          {!open && <span className="ml-2 font-normal text-amber-800/70">one tick and one remark for the whole run</span>}
        </td>
        <td className={TH}><MissingPill /></td>
        <td className={`${TH} py-2`}>
          <InventoryNoteCell checkBookId={checkBookId} checkNumber={from} runTo={to} note={runNote} label={`${from} – ${to}`} />
          {stale && (
            <p className="mt-1 text-[11px] text-amber-800">
              Recorded on the run {stale.from} – {stale.to}; the run has since changed. Tick or remark again to confirm it for {from} – {to}.
            </p>
          )}
        </td>
      </tr>
      {shown.map((number) => <MissingNumberRow key={number} checkBookId={checkBookId} number={number} note={notes[canonical(number)] ?? null} />)}
      {open && left > BigInt(0) && (
        <tr className="border-b border-amber-200 bg-amber-50/60">
          <td colSpan={6} className={`${TH} text-sm text-amber-800`}>
            <button type="button" onClick={() => setPages((p) => p + 1)} className="font-semibold underline underline-offset-2">
              SHOW NEXT {fmt(left < BigInt(INVENTORY_EXPAND_PAGE) ? left : BigInt(INVENTORY_EXPAND_PAGE))}
            </button>
            <span className="ml-2 text-amber-800/70">{fmt(left)} of {fmt(total)} not yet listed</span>
            <button type="button" onClick={() => { setOpen(false); setPages(1) }} className="ml-4 underline underline-offset-2">CLOSE</button>
          </td>
        </tr>
      )}
    </>
  )
}
