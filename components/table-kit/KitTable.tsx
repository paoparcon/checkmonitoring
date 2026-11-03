'use client'

import { useState, type ReactNode } from 'react'
import type { KitColumn, KitSort } from '@/lib/table-kit/types'
import { applyKit, needleError } from '@/lib/table-kit/match'
import { setWidth, visibleColumns, widthStyle } from '@/lib/table-kit/layout'
import { useTableLayout } from './useTableLayout'
import { KitHeaderRow } from './KitHeaderRow'
import { FilterChips } from './FilterChips'
import { ColumnConfigButton } from './ColumnConfigDialog'

type DataRow = { key: string; values: Readonly<Record<string, string | null>>; cells: Readonly<Record<string, ReactNode>>; className?: string }
type BandRow = { key: string; band: ReactNode; className?: string }

/**
 * A row as a server page hands it over: `values` are what the kit filters and
 * sorts on (strings; dates as YYYY-MM-DD, amounts as decimal strings, null for
 * nothing), `cells` what it draws. A `band` row spans the table and is shown
 * only while no filter or sort is in force (NUMBERING's MISSING lines).
 */
export type KitRow = DataRow | BandRow

const isBand = (r: KitRow): r is BandRow => 'band' in r

/**
 * Client mode (spec 2026-10-13 §2): every row is in the browser; the header
 * menu sorts and filters them here. Filters are per visit, not remembered.
 */
export function KitTable({
  tableId, columns, rows, footer, capped = false, empty = 'NO ROWS MATCH.', bandsNote,
  frameClassName = 'overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline',
  cellClassName = 'px-4 py-3',
  headClassName = 'border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400',
}: {
  tableId: string
  columns: readonly KitColumn[]
  rows: readonly KitRow[]
  /** A totals row, keyed by column; never sorted, filtered or recomputed. */
  footer?: Readonly<Record<string, ReactNode>>
  /** The page drew only part of the set. */
  capped?: boolean
  empty?: string
  /** Shown while bands are left out, e.g. "MISSING LINES HIDDEN WHILE FILTERED OR SORTED". */
  bandsNote?: string
  frameClassName?: string
  cellClassName?: string
  headClassName?: string
}) {
  const { layout, preview, save, reset } = useTableLayout(tableId, columns)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [sort, setSort] = useState<KitSort>(null)

  const activeKeys = Object.keys(filters).filter((k) => filters[k].trim() !== '')
  const visible = visibleColumns(columns, layout, activeKeys)
  const narrowed = activeKeys.length > 0 || sort !== null
  const data = rows.filter((r): r is DataRow => !isBand(r))
  const errors: Record<string, string> = {}
  for (const k of activeKeys) {
    const c = columns.find((x) => x.key === k)
    const e = c ? needleError(c, filters[k]) : null
    if (e) errors[k] = e
  }
  const shown: readonly KitRow[] = narrowed
    ? applyKit(data, columns, (r, k) => r.values[k] ?? null, filters, sort)
    : rows
  const shownData = shown.filter((r) => !isBand(r)).length
  const hadBands = rows.length !== data.length

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <ColumnConfigButton columns={columns} layout={layout} onSave={save} onReset={reset} />
        <FilterChips
          columns={columns} filters={filters} errors={errors}
          onClear={(k) => setFilters((f) => ({ ...f, [k]: '' }))} onClearAll={() => setFilters({})}
          count={{ shown: shownData, total: data.length, capped }}
          note={narrowed && hadBands ? bandsNote : undefined}
        />
      </div>
      <div className={frameClassName}>
        <table className="w-full text-sm">
          <thead className={headClassName}>
            <KitHeaderRow
              columns={visible} widths={layout.widths} sort={sort} filters={filters} errors={errors} cellClassName={cellClassName}
              onSort={(key, dir) => setSort(dir ? { key, dir } : null)}
              onFilter={(key, n) => setFilters((f) => ({ ...f, [key]: n }))}
              onResize={(key, w) => preview(setWidth(layout, key, w))}
              onResizeEnd={(key, w) => save(setWidth(layout, key, w))}
            />
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={visible.length} className="p-8 text-center text-sm text-slate-500">{empty}</td></tr>
            )}
            {shown.map((r) => isBand(r) ? (
              <tr key={r.key} className={r.className}><td colSpan={visible.length}>{r.band}</td></tr>
            ) : (
              <tr key={r.key} className={r.className ?? 'border-b border-slate-100 last:border-0 odd:bg-white even:bg-ground'}>
                {visible.map((c) => (
                  <td key={c.key} style={widthStyle(layout.widths[c.key])}
                    className={`${cellClassName} ${c.align === 'right' ? 'text-right' : ''} ${c.className ?? ''}`}>
                    {r.cells[c.key] ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {footer && (
            <tfoot>
              <tr className="border-t border-hairline bg-navy-bg font-semibold">
                {visible.map((c) => (
                  <td key={c.key} className={`${cellClassName} ${c.align === 'right' ? 'text-right' : ''}`}>{footer[c.key] ?? null}</td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  )
}
