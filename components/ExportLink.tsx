'use client'

import type { ReactNode } from 'react'
import { DEFAULT_COLUMNS, withColumnOrder } from '@/lib/table-columns'
import { readMainListOrder } from '@/lib/table-kit/main-list'

/**
 * EXPORT EXCEL, in the viewer's column order (spec C3; since 2026-10-13 the
 * table kit's layout). The order lives only in this browser's `localStorage`,
 * so it is added to the link at click time. Without JavaScript — or with
 * storage blocked — the plain link exports in the default order. A modified
 * click (new tab, save link) is left alone.
 */
export function ExportLink({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        let order = DEFAULT_COLUMNS
        try {
          order = readMainListOrder(window.localStorage)
        } catch {
          // Blocked storage: the default order.
        }
        e.preventDefault()
        window.location.assign(withColumnOrder(href, order))
      }}
    >
      {children}
    </a>
  )
}
