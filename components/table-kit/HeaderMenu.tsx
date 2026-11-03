'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { RANGE_OPS, type KitColumn, type RangeOp } from '@/lib/table-kit/types'
import { enumValues, manilaToday, parseRangeNeedle, rangeNeedle, thisMonth } from '@/lib/table-kit/match'

const OP_LABELS: Record<RangeOp, string> = {
  eq: 'Equals', ne: 'Does Not Equal', gt: 'Is Greater Than', ge: 'Is Greater Than or Equal To',
  lt: 'Is Less Than', le: 'Is Less Than or Equal To', between: 'Is Between',
}

const item = 'block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-navy-bg disabled:opacity-40 disabled:hover:bg-transparent'
const field = 'h-8 w-full rounded-md border border-hairline bg-white px-2 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

/**
 * The header menu (spec 2026-10-13 §1, modelled on Acumatica's and the
 * Supplier Portal's): sort, clear, then the column's filter. Rendered into
 * document.body so the table's overflow cannot clip it; fixed under the header
 * and kept inside the viewport. Escape or a click outside closes it.
 */
export function HeaderMenu({
  anchor, column, sortDir, needle, onSort, onFilter, onClose,
}: {
  anchor: HTMLElement
  column: KitColumn
  sortDir: 'asc' | 'desc' | null
  needle: string
  onSort: (dir: 'asc' | 'desc' | null) => void
  onFilter: (needle: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: -9999, top: -9999 })
  const isRange = column.kind === 'date' || column.kind === 'amount'
  const ops = column.ops ?? RANGE_OPS
  const parsed = isRange ? parseRangeNeedle(needle) : null
  const [op, setOp] = useState<RangeOp>(parsed && ops.includes(parsed.op) ? parsed.op : ops.includes('between') ? 'between' : ops[0])
  const [a, setA] = useState(parsed?.a ?? '')
  const [b, setB] = useState(parsed?.b ?? '')
  const [text, setText] = useState(isRange ? '' : needle.trim().replace(/^=/, ''))
  const multi = column.kind === 'enum' && column.multi === true
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(multi ? enumValues(column, needle) : []))
  const toggle = (v: string) => setTicked((prev) => {
    const next = new Set(prev)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    return next
  })

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect()
    const el = ref.current
    const w = el?.offsetWidth ?? 260
    const h = el?.offsetHeight ?? 300
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(r.bottom + 2, window.innerHeight - h - 8)),
    })
  }, [anchor])

  useEffect(() => {
    const outside = (e: MouseEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !anchor.contains(t)) onClose()
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', outside, true)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', outside, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [anchor, onClose])

  const apply = (v: string) => { onClose(); onFilter(v) }
  const ok = () => {
    if (isRange) apply(rangeNeedle(op, a.trim(), op === 'between' ? b.trim() : ''))
    else if (multi) {
      // In the options' order, so the same ticks always make the same URL.
      const picked = (column.options ?? []).map((o) => o.value).filter((v) => ticked.has(v))
      apply(picked.length > 0 ? `=${picked.join(',')}` : '')
    } else if (column.kind === 'enum') apply(text ? `=${text}` : '')
    else apply(text.trim())
  }
  const enter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); ok() } }
  const inputType = column.kind === 'date' ? 'date' : 'text'
  const today = manilaToday()

  return createPortal(
    <div
      ref={ref} role="menu" aria-label={`${column.label} menu`}
      style={{ position: 'fixed', left: pos.left, top: pos.top }}
      className="z-50 w-72 rounded-xl bg-white p-2 text-slate-800 shadow-lg ring-1 ring-hairline"
    >
      {!column.noSort && (
        <>
          <button type="button" className={`${item} ${sortDir === 'asc' ? 'font-semibold text-navy' : ''}`}
            onClick={() => { onClose(); onSort(sortDir === 'asc' ? null : 'asc') }}>Sort Ascending</button>
          <button type="button" className={`${item} ${sortDir === 'desc' ? 'font-semibold text-navy' : ''}`}
            onClick={() => { onClose(); onSort(sortDir === 'desc' ? null : 'desc') }}>Sort Descending</button>
        </>
      )}
      {!column.noFilter && (
        <>
          {!column.noSort && <div className="my-1 border-t border-hairline" />}
          <button type="button" className={item} disabled={!needle.trim()} onClick={() => apply('')}>Clear Filter</button>
          <div className="my-1 border-t border-hairline" />
          {isRange && (
            <>
              {ops.map((o) => (
                <button key={o} type="button" className={`${item} ${o === op ? 'font-semibold text-navy' : ''}`} onClick={() => setOp(o)}>
                  {OP_LABELS[o]}
                </button>
              ))}
              {column.kind === 'date' && ops.includes('between') && (
                <>
                  <button type="button" className={item} onClick={() => apply(rangeNeedle('between', today, today))}>Today</button>
                  <button type="button" className={item} onClick={() => { const [f, t] = thisMonth(today); apply(rangeNeedle('between', f, t)) }}>This Month</button>
                </>
              )}
              <div className="my-1 border-t border-hairline" />
              <label className="block px-3 py-1 text-xs font-semibold tracking-wide text-slate-500">
                {op === 'between' ? 'FROM' : column.kind === 'date' ? 'DATE' : 'AMOUNT'}
                <input autoFocus type={inputType} inputMode={column.kind === 'amount' ? 'decimal' : undefined}
                  value={a} onChange={(e) => setA(e.target.value)} onKeyDown={enter} className={`${field} mt-1`} />
              </label>
              {op === 'between' && (
                <label className="block px-3 py-1 text-xs font-semibold tracking-wide text-slate-500">
                  TO
                  <input type={inputType} inputMode={column.kind === 'amount' ? 'decimal' : undefined}
                    value={b} onChange={(e) => setB(e.target.value)} onKeyDown={enter} className={`${field} mt-1`} />
                </label>
              )}
            </>
          )}
          {multi && (
            <fieldset className="max-h-72 overflow-y-auto px-3 py-1" aria-label={`Filter ${column.label}`}>
              {(column.options ?? []).map((o, i) => (
                <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-navy-bg">
                  <input autoFocus={i === 0} type="checkbox" checked={ticked.has(o.value)} onChange={() => toggle(o.value)}
                    onKeyDown={enter} className="h-4 w-4 accent-navy" />
                  {o.label}
                </label>
              ))}
            </fieldset>
          )}
          {column.kind === 'enum' && !multi && (
            <div className="px-3 py-1">
              <select autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={enter} className={field} aria-label={`Filter ${column.label}`}>
                <option value="">ALL</option>
                {(column.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          )}
          {column.kind === 'text' && (
            <div className="px-3 py-1">
              <input autoFocus type="text" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={enter}
                placeholder={`Type to filter ${column.label}…`} aria-label={`Filter ${column.label}`} className={field} />
            </div>
          )}
          <div className="mt-2 flex justify-end gap-2 px-3 pb-1">
            <button type="button" onClick={ok} className="h-8 rounded-lg bg-navy px-3 text-xs font-medium tracking-wide text-white">OK</button>
            <button type="button" onClick={onClose} className="h-8 rounded-lg px-3 text-xs font-medium tracking-wide text-slate-600 ring-1 ring-hairline">CANCEL</button>
          </div>
        </>
      )}
    </div>,
    document.body,
  )
}
