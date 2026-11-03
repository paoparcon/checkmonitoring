'use client'

import { useRef } from 'react'
import { clampWidth } from '@/lib/table-kit/layout'

/**
 * Drag a header's right edge to size its column; double-click forgets the
 * width. Pointer capture keeps the drag alive once the pointer leaves the grip.
 */
export function ResizeGrip({ label, width, onResize, onCommit }: { label: string; width?: number; onResize: (width: number | null) => void; onCommit?: (width: number | null) => void }) {
  const drag = useRef<{ x: number; w: number; last: number | null } | null>(null)
  // A cancelled drag (touch scroll, lost capture) ends like a release: the width
  // it reached is on screen, so it is committed and a reload restores it.
  const endDrag = () => {
    const d = drag.current
    drag.current = null
    if (d && d.last !== null) onCommit?.(d.last)
  }
  return (
    <div
      role="separator" aria-orientation="vertical" aria-label={`Resize ${label}`}
      onPointerDown={(e) => {
        const th = e.currentTarget.parentElement
        drag.current = { x: e.clientX, w: width ?? th?.getBoundingClientRect().width ?? 120, last: null }
        e.currentTarget.setPointerCapture(e.pointerId)
        e.preventDefault()
        e.stopPropagation()
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d) { d.last = clampWidth(d.w + e.clientX - d.x); onResize(d.last) }
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={(e) => { e.stopPropagation(); onResize(null); onCommit?.(null) }}
      onClick={(e) => e.stopPropagation()}
      className="absolute right-0 top-0 h-full w-2 cursor-col-resize touch-none hover:bg-navy/20"
    />
  )
}
