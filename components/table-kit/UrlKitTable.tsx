'use client'

import type { KitColumn } from '@/lib/table-kit/types'
import { setWidth, visibleColumns, widthStyle } from '@/lib/table-kit/layout'
import { bindingParams, needleToParams, paramsToNeedle, type Binding } from '@/lib/table-kit/url-binding'
import { useTableLayout } from './useTableLayout'
import { useUrlUpdate } from './useUrlUpdate'
import { KitHeaderRow } from './KitHeaderRow'
import { FilterChips } from './FilterChips'
import { ColumnConfigButton } from './ColumnConfigDialog'
import type { KitRow } from './KitTable'

/**
 * URL mode for a server-rendered page (spec 2026-10-13 §2): the server filtered
 * the rows; the menu rewrites the page's parameters and navigates. Band rows
 * are not supported here. Sorting is not offered (every URL-mode page outside
 * the check list pages in a fixed order).
 */
export function UrlKitTable({
  tableId, columns, rows, bindings, values, drop, markOwn, empty = 'NO ROWS MATCH.',
}: {
  tableId: string
  columns: readonly KitColumn[]
  rows: readonly KitRow[]
  bindings: Readonly<Record<string, Binding>>
  /** The page's parameters as it read them. */
  values: Readonly<Record<string, string>>
  /** Parameters any filter change invalidates (a pagination cursor). */
  drop?: readonly string[]
  markOwn: boolean
  empty?: string
}) {
  const { layout, preview, save, reset } = useTableLayout(tableId, columns)
  const update = useUrlUpdate({ markOwn, drop })
  const needles: Record<string, string> = {}
  for (const c of columns) if (bindings[c.key]) needles[c.key] = paramsToNeedle(bindings[c.key], values)
  const filtered = Object.keys(needles).filter((k) => needles[k] !== '')
  const visible = visibleColumns(columns, layout, filtered)
  const apply = (key: string, needle: string) => { if (bindings[key]) update(needleToParams(bindings[key], needle)) }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <ColumnConfigButton columns={columns} layout={layout} onSave={save} onReset={reset} />
        <FilterChips
          columns={columns} filters={needles} onClear={(k) => apply(k, '')}
          onClearAll={() => update(Object.fromEntries(Object.values(bindings).flatMap(bindingParams).map((p) => [p, ''])))}
        />
      </div>
      <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
        <table className="w-full text-sm">
          <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
            <KitHeaderRow
              columns={visible} widths={layout.widths} sort={null} filters={needles}
              onSort={() => {}} onFilter={apply} onResize={(key, w) => preview(setWidth(layout, key, w))}
              onResizeEnd={(key, w) => save(setWidth(layout, key, w))}
            />
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={visible.length} className="p-8 text-center text-sm text-slate-500">{empty}</td></tr>}
            {rows.map((r) => 'band' in r ? null : (
              <tr key={r.key} className={r.className ?? 'border-b border-slate-100 last:border-0 odd:bg-white even:bg-ground'}>
                {visible.map((c) => (
                  <td key={c.key} style={widthStyle(layout.widths[c.key])} className={`px-4 py-3 ${c.className ?? ''}`}>{r.cells[c.key] ?? '—'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
