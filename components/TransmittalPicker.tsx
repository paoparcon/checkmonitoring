'use client'

import { useMemo, useState } from 'react'
import { formatAmount } from '@/lib/transmittal'
import {
  LEGACY_PREFS_KEY, TRANSMITTAL_TABLE_ID, byStatus, pickColumns, pickValue,
  type StatusChoice, type TransmittalCandidate,
} from '@/lib/transmittal-picker'
import type { KitSort } from '@/lib/table-kit/types'
import { applyKit, needleError } from '@/lib/table-kit/match'
import { setWidth, visibleColumns, widthStyle } from '@/lib/table-kit/layout'
import { useTableLayout } from './table-kit/useTableLayout'
import { KitHeaderRow } from './table-kit/KitHeaderRow'
import { FilterChips } from './table-kit/FilterChips'
import { ColumnConfigButton } from './table-kit/ColumnConfigDialog'

/** Rows drawn at once; the rest are reached by filtering. ADD ALL SHOWN still adds every match. */
const DRAW_LIMIT = 500

const field =
  'h-9 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

const legacy = (s: Pick<Storage, 'getItem'>) => {
  try { return JSON.parse(s.getItem(LEGACY_PREFS_KEY) ?? 'null') } catch { return null }
}

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
  const companies = useMemo(() => [...new Set(candidates.map((c) => c.company))].sort(), [candidates])
  const columns = useMemo(() => pickColumns(companies), [companies])
  const { layout, preview, save, reset } = useTableLayout(TRANSMITTAL_TABLE_ID, columns, legacy)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [sort, setSort] = useState<KitSort>({ key: 'checkNumber', dir: 'asc' })

  const activeKeys = Object.keys(filters).filter((k) => filters[k].trim() !== '')
  const visible = visibleColumns(columns, layout, activeKeys)
  const errors: Record<string, string> = {}
  for (const k of activeKeys) {
    const c = columns.find((x) => x.key === k)
    const e = c ? needleError(c, filters[k]) : null
    if (e) errors[k] = e
  }
  const pool = useMemo(() => byStatus(candidates, status), [candidates, status])
  const matching = useMemo(() => applyKit(pool, columns, pickValue, filters, sort), [pool, columns, filters, sort])
  const allPicked = matching.length > 0 && matching.every((c) => selected.has(c.id))

  const cell = (c: TransmittalCandidate, key: string) => {
    switch (key) {
      case 'amount': return formatAmount(c.amount)
      case 'status': return c.status.replace(/_/g, ' ')
      default: return pickValue(c, key) ?? '—'
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
        <ColumnConfigButton columns={columns} layout={layout} onSave={save} onReset={reset} />
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
        <span className="ml-auto text-xs font-medium tracking-wide text-slate-600">
          {selected.size.toLocaleString('en-PH')} SELECTED
        </span>
      </div>

      <FilterChips
        columns={columns} filters={filters} errors={errors}
        onClear={(k) => setFilters((f) => ({ ...f, [k]: '' }))} onClearAll={() => setFilters({})}
        count={{ shown: matching.length, total: pool.length, capped: truncated }}
      />

      {status === 'RELEASED' && released === 'loading' && (
        <p className="text-xs font-medium tracking-wide text-slate-500">LOADING RELEASED CHECKS…</p>
      )}
      {status === 'RELEASED' && released === 'failed' && (
        <p className="text-xs font-semibold tracking-wide text-warning-ink">
          COULD NOT LOAD THE RELEASED CHECKS.{' '}
          <button type="button" className="underline" onClick={onRetry}>Try again</button>
        </p>
      )}
      {truncated && (
        <p className="text-xs font-semibold tracking-wide text-warning-ink">
          THE LIST IS CAPPED — FILTER TO FIND THE REST.
        </p>
      )}

      <div className="max-h-96 overflow-auto rounded-lg ring-1 ring-hairline">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-slate-50 text-left tracking-wide text-slate-500">
            <KitHeaderRow
              columns={visible} widths={layout.widths} sort={sort} filters={filters} errors={errors} cellClassName="px-2 py-2 font-semibold"
              onSort={(key, dir) => setSort(dir ? { key, dir } : null)}
              onFilter={(key, n) => setFilters((f) => ({ ...f, [key]: n }))}
              onResize={(key, w) => preview(setWidth(layout, key, w))}
              onResizeEnd={(key, w) => save(setWidth(layout, key, w))}
              leading={<th className="w-9 px-2 py-2" />}
            />
          </thead>
          <tbody>
            {matching.length === 0 && (
              <tr><td colSpan={visible.length + 1} className="px-2 py-6 text-center text-slate-500">NO CHECKS MATCH.</td></tr>
            )}
            {matching.slice(0, DRAW_LIMIT).map((c) => (
              <tr key={c.id} className="cursor-pointer border-t border-slate-100 hover:bg-navy-bg" onClick={() => onToggle(c.id)}>
                <td className="px-2 py-1.5">
                  <input
                    type="checkbox" checked={selected.has(c.id)} onChange={() => onToggle(c.id)}
                    onClick={(e) => e.stopPropagation()} aria-label={`Select ${c.checkNumber}`}
                  />
                </td>
                {visible.map((col) => (
                  <td key={col.key} style={widthStyle(layout.widths[col.key])}
                    className={`truncate px-2 py-1.5 ${col.align === 'right' ? 'text-right' : ''} ${col.className ?? ''}`}>
                    {cell(c, col.key)}
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
