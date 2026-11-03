'use client'

import { useRef, useState, type ReactNode } from 'react'
import type { KitColumn, KitFilters, KitSort } from '@/lib/table-kit/types'
import { widthStyle } from '@/lib/table-kit/layout'
import { HeaderMenu } from './HeaderMenu'
import { ResizeGrip } from './ResizeGrip'

function HeaderCell({
  column, width, sortDir, needle, error, onSort, onFilter, onResize, onResizeEnd, className,
}: {
  column: KitColumn
  width?: number
  sortDir: 'asc' | 'desc' | null
  needle: string
  error?: string
  onSort: (dir: 'asc' | 'desc' | null) => void
  onFilter: (needle: string) => void
  onResize: (width: number | null) => void
  onResizeEnd: (width: number | null) => void
  className: string
}) {
  const ref = useRef<HTMLTableCellElement>(null)
  const [open, setOpen] = useState(false)
  const hasMenu = !(column.noSort && column.noFilter)
  const filtered = needle.trim() !== ''
  return (
    <th
      ref={ref} style={widthStyle(width)}
      aria-sort={sortDir === 'asc' ? 'ascending' : sortDir === 'desc' ? 'descending' : 'none'}
      className={`relative select-none ${className} ${column.align === 'right' ? 'text-right' : ''}`}
    >
      {hasMenu ? (
        <button
          type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
          className={`inline-flex max-w-full items-center gap-1 hover:text-slate-900 ${filtered ? 'text-navy' : ''}`}
        >
          <span className="truncate">{column.label}</span>
          {sortDir && <span aria-hidden className="text-navy">{sortDir === 'asc' ? '▲' : '▼'}</span>}
          {filtered && (
            <span title={error ?? 'Filtered'} aria-label={error ? `Filter refused: ${error}` : 'Filtered'}
              className={error ? 'text-red-700' : 'text-navy'}>▾</span>
          )}
        </button>
      ) : (
        <span>{column.label}</span>
      )}
      <ResizeGrip label={column.label} width={width} onResize={onResize} onCommit={onResizeEnd} />
      {open && ref.current && (
        <HeaderMenu
          anchor={ref.current} column={column} sortDir={sortDir} needle={needle}
          onSort={onSort} onFilter={onFilter} onClose={() => setOpen(false)}
        />
      )}
    </th>
  )
}

/** One header row: `leading` and `trailing` cells (checkboxes, actions) around the kit's columns. */
export function KitHeaderRow({
  columns, widths, sort, filters, errors = {}, onSort, onFilter, onResize, onResizeEnd, leading, trailing, cellClassName = 'px-4 py-3',
}: {
  columns: readonly KitColumn[]
  widths: Readonly<Record<string, number>>
  sort: KitSort
  filters: KitFilters
  errors?: Readonly<Record<string, string>>
  onSort: (key: string, dir: 'asc' | 'desc' | null) => void
  onFilter: (key: string, needle: string) => void
  onResize: (key: string, width: number | null) => void
  onResizeEnd: (key: string, width: number | null) => void
  leading?: ReactNode
  trailing?: ReactNode
  cellClassName?: string
}) {
  return (
    <tr>
      {leading}
      {columns.map((c) => (
        <HeaderCell
          key={c.key} column={c} width={widths[c.key]} className={cellClassName}
          sortDir={sort?.key === c.key ? sort.dir : null} needle={filters[c.key] ?? ''} error={errors[c.key]}
          onSort={(dir) => onSort(c.key, dir)} onFilter={(n) => onFilter(c.key, n)} onResize={(w) => onResize(c.key, w)} onResizeEnd={(w) => onResizeEnd(c.key, w)}
        />
      ))}
      {trailing}
    </tr>
  )
}
