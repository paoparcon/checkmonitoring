import type { KitColumn } from './types'

/**
 * A table's presentation, per browser (spec 2026-10-13 §1): the order of every
 * column, which are hidden, and any dragged widths. Pure; the hook in
 * `components/table-kit/useTableLayout.ts` does the storage I/O.
 *
 * Whatever storage holds is read defensively: a stored layout outlives
 * releases, so unknown keys are dropped, columns added since are inserted
 * beside their usual neighbour, a locked column is never hidden, and at least
 * one column always shows.
 */

export type Layout = { order: string[]; hidden: string[]; widths: Record<string, number> }

export const MIN_WIDTH = 60
export const MAX_WIDTH = 800

export const clampWidth = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)))

export const layoutStorageKey = (tableId: string) => `check-monitoring.table.${tableId}.v1`

export function defaultLayout(columns: readonly KitColumn[]): Layout {
  return {
    order: columns.map((c) => c.key),
    hidden: columns.filter((c) => c.defaultHidden && !c.locked).map((c) => c.key),
    widths: {},
  }
}

export function sanitizeLayout(raw: unknown, columns: readonly KitColumn[]): Layout {
  const def = defaultLayout(columns)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return def
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.order)) return def
  const keys = columns.map((c) => c.key)

  const stored: string[] = []
  for (const k of r.order) if (typeof k === 'string' && keys.includes(k) && !stored.includes(k)) stored.push(k)
  if (stored.length === 0) return def

  const order = [...stored]
  const added: string[] = []
  for (const k of keys) {
    if (order.includes(k)) continue
    const before = keys.slice(0, keys.indexOf(k)).reverse().find((p) => order.includes(p))
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, k)
    added.push(k)
  }

  const locked = new Set(columns.filter((c) => c.locked).map((c) => c.key))
  const hidden: string[] = []
  for (const k of Array.isArray(r.hidden) ? r.hidden : []) {
    if (typeof k === 'string' && stored.includes(k) && !locked.has(k) && !hidden.includes(k)) hidden.push(k)
  }
  for (const k of added) if (def.hidden.includes(k)) hidden.push(k)

  const widths: Record<string, number> = {}
  if (r.widths !== null && typeof r.widths === 'object') {
    for (const [k, v] of Object.entries(r.widths as Record<string, unknown>)) {
      if (keys.includes(k) && typeof v === 'number' && Number.isFinite(v)) widths[k] = clampWidth(v)
    }
  }
  return { order, hidden: hidden.length >= keys.length ? [] : hidden, widths }
}

function safeParse(raw: string | null): unknown {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

export function loadLayout(
  storage: Pick<Storage, 'getItem'>,
  tableId: string,
  columns: readonly KitColumn[],
  legacy?: (s: Pick<Storage, 'getItem'>) => unknown,
): Layout {
  const own = safeParse(storage.getItem(layoutStorageKey(tableId)))
  return sanitizeLayout(own ?? (legacy ? legacy(storage) : null), columns)
}

/** A stored JSON array of the VISIBLE keys in order (the main list's `columns.v3`) as a layout. */
export function fromVisibleList(raw: string | null, columns: readonly KitColumn[]): Layout | null {
  const parsed = safeParse(raw)
  if (!Array.isArray(parsed)) return null
  const keys = columns.map((c) => c.key)
  const visible = [...new Set(parsed.filter((k): k is string => typeof k === 'string' && keys.includes(k)))]
  if (visible.length === 0) return null
  const rest = keys.filter((k) => !visible.includes(k))
  return { order: [...visible, ...rest], hidden: rest, widths: {} }
}

/** The columns on screen, in order; a forced (filtered) column shows even when hidden. */
export function visibleColumns(columns: readonly KitColumn[], layout: Layout, forced: readonly string[] = []): KitColumn[] {
  const byKey = new Map(columns.map((c) => [c.key, c]))
  return layout.order
    .filter((k) => !layout.hidden.includes(k) || forced.includes(k))
    .map((k) => byKey.get(k))
    .filter((c): c is KitColumn => c !== undefined)
}

/** Shown again: it joins the end of the selected list. */
export function showColumn(layout: Layout, key: string): Layout {
  if (!layout.hidden.includes(key)) return layout
  return { ...layout, order: [...layout.order.filter((k) => k !== key), key], hidden: layout.hidden.filter((k) => k !== key) }
}

export function hideColumn(layout: Layout, key: string, columns: readonly KitColumn[]): Layout {
  const visible = layout.order.filter((k) => !layout.hidden.includes(k))
  const locked = columns.some((c) => c.key === key && c.locked)
  if (locked || !visible.includes(key) || visible.length <= 1) return layout
  return { ...layout, hidden: [...layout.hidden, key] }
}

/** Swap with the visible neighbour; hidden columns keep their slots. */
export function moveVisible(layout: Layout, key: string, by: -1 | 1): Layout {
  const visible = layout.order.filter((k) => !layout.hidden.includes(k))
  const i = visible.indexOf(key)
  const j = i + by
  if (i < 0 || j < 0 || j >= visible.length) return layout
  const order = [...layout.order]
  const a = order.indexOf(visible[i])
  const b = order.indexOf(visible[j])
  ;[order[a], order[b]] = [order[b], order[a]]
  return { ...layout, order }
}

/** A dragged width, or `null` to forget it (double-click on the grip). */
export function setWidth(layout: Layout, key: string, width: number | null): Layout {
  const widths = { ...layout.widths }
  if (width === null) delete widths[key]
  else widths[key] = clampWidth(width)
  return { ...layout, widths }
}

/** Inline style for a sized column's header and body cells. */
export const widthStyle = (w?: number) => (w ? { width: w, minWidth: w, maxWidth: w } : undefined)
