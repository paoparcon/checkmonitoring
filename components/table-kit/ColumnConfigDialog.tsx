'use client'

import { useEffect, useState } from 'react'
import type { KitColumn } from '@/lib/table-kit/types'
import { hideColumn, moveVisible, showColumn, type Layout } from '@/lib/table-kit/layout'

type Side = 'avail' | 'sel'

const arrow = 'h-8 w-8 rounded-lg text-sm text-slate-700 ring-1 ring-hairline hover:bg-navy-bg disabled:opacity-30'
const search = 'h-8 w-full rounded-md border border-hairline px-2 text-sm focus:border-navy focus:outline-none'

/**
 * Column Configuration (spec 2026-10-13 §1): Available (hidden, A–Z) and
 * Selected (shown, in table order), each searchable; → ← or double-click move a
 * column across, ↑ ↓ reorder. Staged until OK; Cancel, ✕, Escape or the
 * backdrop discard. RESET TO DEFAULT also forgets every width.
 */
function ColumnConfigDialog({
  columns, layout, onOk, onReset, onClose,
}: {
  columns: readonly KitColumn[]
  layout: Layout
  onOk: (l: Layout) => void
  onReset: () => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(layout)
  const [picked, setPicked] = useState<{ side: Side; key: string } | null>(null)
  const [q, setQ] = useState<Record<Side, string>>({ avail: '', sel: '' })
  const label = (k: string) => columns.find((c) => c.key === k)?.label ?? k
  const locked = (k: string) => columns.some((c) => c.key === k && c.locked)

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [onClose])

  const sel = draft.order.filter((k) => !draft.hidden.includes(k))
  const avail = draft.order.filter((k) => draft.hidden.includes(k)).sort((x, y) => label(x).localeCompare(label(y)))
  const shown = (side: Side) => (side === 'avail' ? avail : sel).filter((k) => label(k).toLowerCase().includes(q[side].trim().toLowerCase()))

  const add = (k: string) => { setDraft((d) => showColumn(d, k)); setPicked({ side: 'sel', key: k }) }
  const remove = (k: string) => {
    const next = hideColumn(draft, k, columns)
    if (next !== draft) { setDraft(next); setPicked({ side: 'avail', key: k }) }
  }
  const at = picked?.side === 'sel' ? sel.indexOf(picked.key) : -1

  const list = (side: Side, title: string) => (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <p className="text-[11px] font-semibold tracking-widest text-slate-400">{title}</p>
      <input type="search" placeholder="Search" aria-label={`Search ${title.toLowerCase()}`} value={q[side]}
        onChange={(e) => setQ((x) => ({ ...x, [side]: e.target.value }))} className={search} />
      <div role="listbox" aria-label={title} className="h-64 overflow-auto rounded-lg ring-1 ring-hairline">
        {shown(side).length === 0 && <p className="px-3 py-2 text-sm text-slate-400">—</p>}
        {shown(side).map((k) => (
          <div
            key={k} role="option" aria-selected={picked?.side === side && picked.key === k}
            onClick={() => setPicked({ side, key: k })}
            onDoubleClick={() => (side === 'avail' ? add(k) : remove(k))}
            className={`cursor-pointer px-3 py-1.5 text-sm ${picked?.side === side && picked.key === k ? 'bg-navy text-white' : 'hover:bg-navy-bg'}`}
          >
            {label(k)}{side === 'sel' && locked(k) && <span className="ml-1 text-[10px] opacity-70">(ALWAYS SHOWN)</span>}
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-modal="true" aria-label="Column Configuration" className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-xl ring-1 ring-hairline">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold tracking-widest text-slate-700">COLUMN CONFIGURATION</h3>
          <button type="button" aria-label="Close" onClick={onClose} className="text-slate-500 hover:text-slate-900">✕</button>
        </div>
        <div className="flex items-center gap-3">
          {list('avail', 'AVAILABLE COLUMNS')}
          <div className="flex flex-col gap-2">
            <button type="button" className={arrow} title="Show the column" disabled={picked?.side !== 'avail'} onClick={() => picked && add(picked.key)}>→</button>
            <button type="button" className={arrow} title="Hide the column"
              disabled={picked?.side !== 'sel' || locked(picked.key) || sel.length <= 1} onClick={() => picked && remove(picked.key)}>←</button>
          </div>
          {list('sel', 'SELECTED COLUMNS')}
          <div className="flex flex-col gap-2">
            <button type="button" className={arrow} title="Move up" disabled={at <= 0} onClick={() => picked && setDraft((d) => moveVisible(d, picked.key, -1))}>↑</button>
            <button type="button" className={arrow} title="Move down" disabled={at < 0 || at >= sel.length - 1} onClick={() => picked && setDraft((d) => moveVisible(d, picked.key, 1))}>↓</button>
          </div>
        </div>
        <div className="mt-5 flex items-center gap-2">
          <button type="button" onClick={() => { onReset(); onClose() }} className="text-xs font-medium tracking-wide text-slate-500 underline underline-offset-2">RESET TO DEFAULT</button>
          <span className="flex-1" />
          <button type="button" onClick={() => { onOk(draft); onClose() }} className="h-9 rounded-lg bg-navy px-4 text-sm font-medium tracking-wide text-white">OK</button>
          <button type="button" onClick={onClose} className="h-9 rounded-lg px-4 text-sm font-medium tracking-wide text-slate-600 ring-1 ring-hairline">CANCEL</button>
        </div>
      </div>
    </div>
  )
}

/** ⚙ CUSTOMIZE COLUMNS and its dialog. */
export function ColumnConfigButton({
  columns, layout, onSave, onReset,
}: {
  columns: readonly KitColumn[]
  layout: Layout
  onSave: (l: Layout) => void
  onReset: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="h-8 rounded-lg bg-white px-3 text-xs font-medium tracking-wide text-navy ring-1 ring-hairline hover:bg-navy-bg">
        ⚙ CUSTOMIZE COLUMNS
      </button>
      {open && <ColumnConfigDialog columns={columns} layout={layout} onOk={onSave} onReset={onReset} onClose={() => setOpen(false)} />}
    </>
  )
}
