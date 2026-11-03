'use client'

import type { KitColumn, KitFilters } from '@/lib/table-kit/types'
import { humanNeedle } from '@/lib/table-kit/match'

const n = (x: number) => x.toLocaleString('en-PH')

/** One chip per active filter, each with ✕; the row count; CLEAR FILTERS. Nothing when no filter is set. */
export function FilterChips({
  columns, filters, errors = {}, onClear, onClearAll, count, note,
}: {
  columns: readonly KitColumn[]
  filters: KitFilters
  errors?: Readonly<Record<string, string>>
  onClear: (key: string) => void
  onClearAll?: () => void
  /** Client mode: rows shown of rows held; `capped` when the page drew only some of the set. */
  count?: { shown: number; total: number; capped: boolean }
  /** A line of its own, e.g. why NUMBERING's MISSING lines are not on screen. */
  note?: string
}) {
  const active = columns.filter((c) => (filters[c.key] ?? '').trim() !== '')
  if (active.length === 0 && !note) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {active.map((c) => (
        <span
          key={c.key} title={errors[c.key]}
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium tracking-wide ${
            errors[c.key] ? 'bg-red-50 text-red-700 ring-1 ring-red-300' : 'bg-navy-bg text-navy'}`}
        >
          {c.label}: {humanNeedle(c, filters[c.key])}
          {errors[c.key] && <span role="alert"> — {errors[c.key]}</span>}
          <button type="button" aria-label={`Clear the ${c.label} filter`} onClick={() => onClear(c.key)} className="ml-1 hover:text-slate-900">✕</button>
        </span>
      ))}
      {count && active.length > 0 && (
        <span className="tracking-wide text-slate-500">
          {n(count.shown)} OF {count.capped ? 'THE ' : ''}{n(count.total)} ROWS{count.capped ? ' SHOWN' : ''}
        </span>
      )}
      {onClearAll && active.length > 0 && (
        <button type="button" onClick={onClearAll} className="tracking-wide text-slate-500 underline underline-offset-2">✕ CLEAR FILTERS</button>
      )}
      {note && <span className="tracking-wide text-slate-500">{note}</span>}
    </div>
  )
}
