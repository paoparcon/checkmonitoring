'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useTransition } from 'react'
import { saveInventoryAction, type InventoryChange } from '@/app/numbering/actions'
import type { InventoryNoteView } from '@/components/InventoryNoteCell'

/** One row's unsaved tick and remark. */
export type InventoryDraft = { checkNumber: string; runTo?: string; ticked: boolean; remarks: string }
/** What SAVE INVENTORY answered for one row. */
export type InventoryRowResult = { note: InventoryNoteView } | { error: string }

type Ctx = {
  drafts: ReadonlyMap<string, InventoryDraft>
  setDraft: (key: string, draft: InventoryDraft | null) => void
  results: ReadonlyMap<string, InventoryRowResult>
  pending: boolean
}
const InventoryContext = createContext<Ctx | null>(null)

/** The key a row's draft and result are filed under: the number, and the run end for a run note. */
export const inventoryRowKey = (checkNumber: string, runTo?: string) => `${checkNumber}|${runTo ?? ''}`

export function useInventoryForm(): Ctx {
  const ctx = useContext(InventoryContext)
  if (!ctx) throw new Error('InventoryNoteCell must sit inside an InventoryForm')
  return ctx
}

/**
 * The inventory as a form (user, 2026-11-03: "there should be save button so
 * the inventory will be save"). Every tick box and remarks field on the page
 * files a DRAFT here as it changes; SAVE INVENTORY sends every draft in one
 * server action, which writes them one by one — each its own row and audit
 * entry — and answers per row, so a refused row keeps its draft and says why
 * while the rest are recorded. A draft left unsaved holds the page: leaving
 * it asks first.
 */
export function InventoryForm({ checkBookId, children }: { checkBookId: string; children: React.ReactNode }) {
  const [drafts, setDrafts] = useState<Map<string, InventoryDraft>>(() => new Map())
  const [results, setResults] = useState<Map<string, InventoryRowResult>>(() => new Map())
  const [summary, setSummary] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const setDraft = useCallback((key: string, draft: InventoryDraft | null) => {
    setDrafts((prev) => {
      const next = new Map(prev)
      if (draft) next.set(key, draft)
      else next.delete(key)
      return next
    })
  }, [])

  useEffect(() => {
    if (drafts.size === 0) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [drafts.size])

  const save = () => {
    const changes: InventoryChange[] = [...drafts.entries()].map(([key, d]) => ({ key, ...d }))
    const formData = new FormData()
    formData.set('checkBookId', checkBookId)
    formData.set('changes', JSON.stringify(changes))
    startTransition(async () => {
      const r = await saveInventoryAction(formData)
      if (!r.ok) {
        setSummary(r.message)
        return
      }
      setResults((prev) => {
        const next = new Map(prev)
        for (const s of r.saved) next.set(s.key, { note: s.note })
        for (const f of r.failed) next.set(f.key, { error: f.message })
        return next
      })
      setDrafts((prev) => {
        const next = new Map(prev)
        for (const s of r.saved) next.delete(s.key)
        return next
      })
      const parts = [`Saved ${r.saved.length.toLocaleString('en-PH')}.`]
      if (r.failed.length) parts.push(`${r.failed.length.toLocaleString('en-PH')} refused — see the rows.`)
      if (r.unreached) parts.push(`${r.unreached.toLocaleString('en-PH')} not reached in time — press SAVE INVENTORY again.`)
      setSummary(parts.join(' '))
    })
  }

  const value = useMemo<Ctx>(() => ({ drafts, setDraft, results, pending }), [drafts, setDraft, results, pending])
  const unsaved = drafts.size

  return (
    <InventoryContext.Provider value={value}>
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-xl bg-white/95 px-4 py-3 ring-1 ring-hairline backdrop-blur">
        <button
          type="button"
          onClick={save}
          disabled={pending || unsaved === 0}
          className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90 disabled:opacity-50"
        >
          {pending ? 'SAVING…' : 'SAVE INVENTORY'}
        </button>
        <span className={`text-xs font-medium tracking-wide ${unsaved ? 'text-amber-800' : 'text-slate-500'}`}>
          {unsaved ? `${unsaved.toLocaleString('en-PH')} UNSAVED CHANGE${unsaved === 1 ? '' : 'S'}` : 'NO UNSAVED CHANGES'}
        </span>
        {summary && <span className="text-xs text-slate-600">{summary}</span>}
      </div>
      {children}
    </InventoryContext.Provider>
  )
}
