'use client'

import { useEffect, useLayoutEffect, useState } from 'react'
import type { KitColumn } from '@/lib/table-kit/types'
import { defaultLayout, layoutStorageKey, loadLayout, type Layout } from '@/lib/table-kit/layout'

/** Runs before paint on the client; an ordinary effect on the server, where layout effects warn. */
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * One table's layout, per browser. Starts at the default so the server render
 * and the first client render agree, and is corrected before paint. Storage
 * that throws (a private window, blocked site data) leaves the default.
 */
export function useTableLayout(
  tableId: string,
  columns: readonly KitColumn[],
  legacy?: (s: Pick<Storage, 'getItem'>) => unknown,
) {
  const [layout, setLayout] = useState<Layout>(() => defaultLayout(columns))

  useBeforePaint(() => {
    try {
      setLayout(loadLayout(window.localStorage, tableId, columns, legacy))
    } catch {
      // Blocked storage: the default stays.
    }
    // Columns are rebuilt every render; the layout is read once per table.
  }, [tableId])

  /** Live state only (a drag in progress); `save` is what persists. */
  const preview = (next: Layout) => setLayout(next)
  const save = (next: Layout) => {
    setLayout(next)
    try { window.localStorage.setItem(layoutStorageKey(tableId), JSON.stringify(next)) } catch { /* not remembered */ }
  }
  const reset = () => {
    setLayout(defaultLayout(columns))
    try { window.localStorage.removeItem(layoutStorageKey(tableId)) } catch { /* nothing stored */ }
  }
  return { layout, preview, save, reset }
}
