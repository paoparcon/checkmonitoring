'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { formatAmount } from '@/lib/transmittal'
import {
  DEFAULT_PREFS, NO_FILTERS, PICK_LABELS, clampWidth, filterCandidates, filterErrors, hasFilters,
  moveColumn, readPrefs, sortCandidates, visibleColumns, widthOf,
  type ColumnPrefs, type PickColumn, type PickFilters, type SortSpec, type StatusChoice, type TransmittalCandidate,
} from '@/lib/transmittal-picker'

/** Rows drawn at once; the rest are reached by filtering. ADD ALL SHOWN still adds every match. */
const DRAW_LIMIT = 500

/** Per browser: which columns, in what order and how wide. A convenience only. */
const PREFS_KEY = 'check-monitoring.transmittal.columns.v1'

const field =
  'h-9 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'
const box =
  'h-7 w-full min-w-0 rounded-md border bg-white px-2 text-xs font-normal text-slate-900 placeholder:text-slate-400 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

export type ReleasedState = 'idle' | 'loading' | 'failed'

export function TransmittalPicker({
  candidates, selected, onToggle, onAdd, onClear, status, onStatus, released, onRetry, truncated,
}: {
  candidates: readonly TransmittalCandidate[]
  selected: ReadonlySet<string>
  onToggle: (id: string) => void
  onAdd: (ids: string[]) => void
  onClear: () => void
  status: StatusChoice
  onStatus: (s: StatusChoice) => void
  released: ReleasedState
  onRetry: () => void
  truncated: boolean
}) {
  const [filters, setFilters] = useState<PickFilters>(NO_FILTERS)
  const [sort, setSort] = useState<SortSpec>({ column: 'checkNumber', dir: 'asc' })
  const [prefs, setPrefs] = useState<ColumnPrefs>(DEFAULT_PREFS)
  const loaded = useRef(false)

  // Read after mount, so the server and first client render agree.
  useEffect(() => {
    try { setPrefs(readPrefs(JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null'))) } catch { /* blocked storage */ }
    loaded.current = true
  }, [])
  useEffect(() => {
    if (!loaded.current) return
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* ignore */ }
  }, [prefs])

  const columns = visibleColumns(prefs)
  const errors = filterErrors(filters)
  const companies = useMemo(() => [...new Set(candidates.map((c) => c.company))].sort(), [candidates])
  const matching = useMemo(
    () => sortCandidates(filterCandidates(candidates, status, filters), sort),
    [candidates, status, filters, sort],
  )
  const allPicked = matching.length > 0 && matching.every((c) => selected.has(c.id))
  const set = (k: keyof PickFilters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }))

  const toggleSort = (column: PickColumn) =>
    setSort((s) => (s.column === column ? { column, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { column, dir: 'asc' }))

  // Drag a header's right edge. Pointer capture keeps the drag alive off the handle.
  const drag = useRef<{ column: PickColumn; x: number; width: number } | null>(null)
  const startResize = (column: PickColumn) => (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { column, x: e.clientX, width: widthOf(prefs, column) }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  const resize = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const width = clampWidth(d.width + e.clientX - d.x)
    setPrefs((p) => ({ ...p, widths: { ...p.widths, [d.column]: width } }))
  }
  const endResize = () => { drag.current = null }

  const total = columns.reduce((n, c) => n + widthOf(prefs, c), 36)

  const cell = (c: TransmittalCandidate, column: PickColumn) => {
    switch (column) {
      case 'checkNumber': return <span className="font-medium">{c.checkNumber}</span>
      case 'payee': return c.payee || '—'
      case 'status': return c.status.replace(/_/g, ' ')
      case 'amount': return formatAmount(c.amount)
      default: return c[column] || '—'
    }
  }

  const textFilter = (column: 'checkNumber' | 'cashAccount' | 'poNumber' | 'voucher' | 'payee') => (
    <input
      type="text" value={filters[column]} onChange={(e) => set(column)(e.target.value)}
      placeholder="contains…" aria-label={`Filter ${PICK_LABELS[column]}`} className={`${box} border-hairline`}
    />
  )

  const filterCell = (column: PickColumn) => {
    switch (column) {
      case 'company':
        return (
          <select value={filters.company} onChange={(e) => set('company')(e.target.value)} aria-label="Filter COMPANY" className={`${box} border-hairline`}>
            <option value="">ALL</option>
            {companies.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )
      case 'status':
        // The status choice is the dropdown above the table; this cell says so.
        return <span className="text-[10px] font-normal text-slate-400">SEE ABOVE</span>
      case 'amount':
        return (
          <div className="flex gap-1">
            <input
              type="text" inputMode="decimal" value={filters.amountMin} onChange={(e) => set('amountMin')(e.target.value)}
              placeholder="MIN" aria-label="Filter AMOUNT minimum" aria-invalid={errors.amountMin}
              className={`${box} ${errors.amountMin ? 'border-danger-ink' : 'border-hairline'}`}
            />
            <input
              type="text" inputMode="decimal" value={filters.amountMax} onChange={(e) => set('amountMax')(e.target.value)}
              placeholder="MAX" aria-label="Filter AMOUNT maximum" aria-invalid={errors.amountMax}
              className={`${box} ${errors.amountMax ? 'border-danger-ink' : 'border-hairline'}`}
            />
          </div>
        )
      default:
        return textFilter(column)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Status" value={status} onChange={(e) => onStatus(e.target.value as StatusChoice)} className={field}>
          <option value="ALL">SIGNATURE PENDING + SIGNED</option>
          <option value="SIGNATURE_PENDING">SIGNATURE PENDING</option>
          <option value="SIGNED">SIGNED</option>
          <option value="RELEASED">RELEASED</option>
        </select>

        <details className="relative">
          <summary className={`${field} flex cursor-pointer list-none items-center gap-2 font-medium tracking-wide text-navy`}>
            COLUMNS
          </summary>
          <div className="absolute left-0 top-full z-20 mt-1 w-72 rounded-xl bg-white p-3 shadow-lg ring-1 ring-hairline">
            <p className="mb-2 text-[11px] font-semibold tracking-widest text-slate-400">SHOW, HIDE AND REORDER</p>
            <ul className="space-y-1">
              {prefs.order.map((column, i) => {
                const visible = !prefs.hidden.includes(column)
                return (
                  <li key={column} className="flex items-center gap-2 text-sm">
                    <label className="flex flex-1 items-center gap-2">
                      <input
                        type="checkbox" checked={visible} disabled={visible && columns.length === 1}
                        onChange={() => setPrefs((p) => ({
                          ...p, hidden: visible ? [...p.hidden, column] : p.hidden.filter((h) => h !== column),
                        }))}
                      />
                      {PICK_LABELS[column]}
                    </label>
                    <button
                      type="button" disabled={i === 0} aria-label={`Move ${PICK_LABELS[column]} left`}
                      onClick={() => setPrefs((p) => ({ ...p, order: moveColumn(p.order, column, -1) }))}
                      className="rounded px-1.5 text-slate-500 hover:bg-navy-bg disabled:opacity-30"
                    >▲</button>
                    <button
                      type="button" disabled={i === prefs.order.length - 1} aria-label={`Move ${PICK_LABELS[column]} right`}
                      onClick={() => setPrefs((p) => ({ ...p, order: moveColumn(p.order, column, 1) }))}
                      className="rounded px-1.5 text-slate-500 hover:bg-navy-bg disabled:opacity-30"
                    >▼</button>
                  </li>
                )
              })}
            </ul>
            <button
              type="button" onClick={() => setPrefs(DEFAULT_PREFS)}
              className="mt-3 text-xs font-medium tracking-wide text-slate-500 underline underline-offset-2"
            >
              RESET COLUMNS
            </button>
            <p className="mt-2 text-[11px] text-slate-400">Drag the edge of a column header to change its width.</p>
          </div>
        </details>

        <button
          type="button" onClick={() => onAdd(matching.map((c) => c.id))} disabled={allPicked || matching.length === 0}
          className="h-9 rounded-lg bg-navy px-3 text-sm font-medium tracking-wide text-white disabled:opacity-40"
        >
          ADD ALL SHOWN ({matching.length.toLocaleString('en-PH')})
        </button>
        <button
          type="button" onClick={onClear} disabled={selected.size === 0}
          className="h-9 rounded-lg bg-white px-3 text-sm font-medium tracking-wide text-slate-600 ring-1 ring-hairline disabled:opacity-40"
        >
          CLEAR
        </button>
        {hasFilters(filters) && (
          <button
            type="button" onClick={() => setFilters(NO_FILTERS)}
            className="text-sm font-medium tracking-wide text-slate-500 underline underline-offset-2"
          >
            RESET FILTERS
          </button>
        )}
        <span className="ml-auto text-xs font-medium tracking-wide text-slate-600">
          {selected.size.toLocaleString('en-PH')} SELECTED
        </span>
      </div>

      {status === 'RELEASED' && released === 'loading' && (
        <p className="text-xs font-medium tracking-wide text-slate-500">LOADING RELEASED CHECKS…</p>
      )}
      {status === 'RELEASED' && released === 'failed' && (
        <p className="text-xs font-semibold tracking-wide text-warning-ink">
          COULD NOT LOAD THE RELEASED CHECKS.{' '}
          <button type="button" className="underline" onClick={onRetry}>Try again</button>
        </p>
      )}
      {(errors.amountMin || errors.amountMax) && (
        <p role="alert" className="text-xs font-semibold tracking-wide text-warning-ink">
          AN AMOUNT BOX COULD NOT BE READ, SO NOTHING IS LISTED. Use digits, with or without commas.
        </p>
      )}
      {truncated && (
        <p className="text-xs font-semibold tracking-wide text-warning-ink">
          THE LIST IS CAPPED — FILTER TO FIND THE REST.
        </p>
      )}

      <div className="max-h-96 overflow-auto rounded-lg ring-1 ring-hairline">
        <table className="border-collapse text-xs" style={{ tableLayout: 'fixed', width: total, minWidth: '100%' }}>
          <colgroup>
            <col style={{ width: 36 }} />
            {columns.map((c) => <col key={c} style={{ width: widthOf(prefs, c) }} />)}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-slate-50 text-left tracking-wide text-slate-500">
            <tr>
              <th className="px-2 py-2" />
              {columns.map((column) => (
                <th
                  key={column} className={`relative px-2 py-2 font-semibold ${column === 'amount' ? 'text-right' : ''}`}
                  aria-sort={sort.column === column ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  <button type="button" onClick={() => toggleSort(column)} className="max-w-full truncate hover:text-navy">
                    {PICK_LABELS[column]}{sort.column === column ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </button>
                  <div
                    role="separator" aria-orientation="vertical" aria-label={`Resize ${PICK_LABELS[column]}`}
                    onPointerDown={startResize(column)} onPointerMove={resize} onPointerUp={endResize} onPointerCancel={endResize}
                    className="absolute right-0 top-0 h-full w-2 cursor-col-resize touch-none hover:bg-navy/20"
                  />
                </th>
              ))}
            </tr>
            <tr className="align-top">
              <th className="px-2 pb-2" />
              {columns.map((column) => <th key={column} className="px-2 pb-2">{filterCell(column)}</th>)}
            </tr>
          </thead>
          <tbody>
            {matching.length === 0 && (
              <tr><td colSpan={columns.length + 1} className="px-2 py-6 text-center text-slate-500">NO CHECKS MATCH.</td></tr>
            )}
            {matching.slice(0, DRAW_LIMIT).map((c) => (
              <tr key={c.id} className="cursor-pointer border-t border-slate-100 hover:bg-navy-bg" onClick={() => onToggle(c.id)}>
                <td className="px-2 py-1.5">
                  <input
                    type="checkbox" checked={selected.has(c.id)} onChange={() => onToggle(c.id)}
                    onClick={(e) => e.stopPropagation()} aria-label={`Select ${c.checkNumber}`}
                  />
                </td>
                {columns.map((column) => (
                  <td key={column} className={`truncate px-2 py-1.5 ${column === 'amount' ? 'text-right tabular-nums' : ''}`}>
                    {cell(c, column)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {matching.length > DRAW_LIMIT && (
          <p className="border-t border-slate-100 px-2 py-2 text-center text-xs text-slate-500">
            SHOWING THE FIRST {DRAW_LIMIT} OF {matching.length.toLocaleString('en-PH')} — FILTER TO NARROW, OR USE ADD ALL SHOWN.
          </p>
        )}
      </div>
    </div>
  )
}
