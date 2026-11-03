'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { previewClearingAction, confirmClearingAction, type ClearingPreviewResult } from '@/app/clearing/actions'
import type { BulkActionResult } from '@/lib/bulk-run'
import type { PreviewVerdict } from '@/lib/clearing-preview'
import { KitTable, type KitRow } from '@/components/table-kit/KitTable'
import { dateValue } from '@/lib/table-kit/match'

const VERDICT: Record<PreviewVerdict, { words: string; tone: string }> = {
  WILL_CLEAR: { words: 'WILL BE CLEARED', tone: 'text-success-ink' },
  ALREADY_CLEARED: { words: 'ALREADY CLEARED', tone: 'text-slate-500' },
  NOT_RELEASED: { words: 'NOT RELEASED', tone: 'text-warning-ink' },
  UNKNOWN: { words: 'UNKNOWN NUMBER', tone: 'text-danger-ink' },
  AMBIGUOUS: { words: 'TWO COMPANIES — NOT CLEARED', tone: 'text-danger-ink' },
}

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—'

/**
 * Paste, preview, confirm. Nothing is written until CONFIRM, and the preview
 * says per line what CONFIRM will do. The text is re-sent on confirm and the
 * server decides again; this component holds no ids.
 */
export function ClearingPaste({ maxLines }: { maxLines: number }) {
  const [pending, startTransition] = useTransition()
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<ClearingPreviewResult | null>(null)
  const [result, setResult] = useState<BulkActionResult | null>(null)

  const willClear = preview?.ok ? preview.rows.filter((r) => r.verdict === 'WILL_CLEAR').length : 0
  const field = 'w-full rounded-lg border border-hairline bg-white px-3 py-2 font-mono text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

  const doPreview = () => {
    const f = new FormData()
    f.append('lines', text)
    startTransition(async () => {
      const r = await previewClearingAction(f)
      setPreview(r)
      setResult(null)
    })
  }

  const doConfirm = () => {
    const f = new FormData()
    f.append('lines', text)
    startTransition(async () => {
      const r = await confirmClearingAction(f)
      setResult(r)
    })
  }

  if (result?.ok) {
    return (
      <div className="space-y-4">
        <p className="rounded-xl bg-success-bg px-4 py-3 text-sm text-success-ink">
          {result.succeeded} check{result.succeeded === 1 ? '' : 's'} marked CLEARED
          {result.failed > 0 ? `; ${result.failed} refused` : ''}.
        </p>
        <ul className="divide-y divide-hairline rounded-xl bg-white ring-1 ring-hairline">
          {result.outcomes.map((o) => (
            <li key={o.checkId} className="flex items-baseline justify-between gap-4 px-4 py-2 text-sm">
              <Link prefetch={false} href={`/checks/${o.checkId}`} className="tabular-nums underline underline-offset-2">{o.checkNumber ?? o.checkId}</Link>
              <span className={o.ok ? 'text-success-ink' : 'text-danger-ink'}>{o.ok ? 'CLEARED' : o.message}</span>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => { setText(''); setPreview(null); setResult(null) }}
          className="rounded-lg border border-hairline bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy hover:bg-ground">
          START AGAIN
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <label htmlFor="clearing-lines" className="block text-[11px] font-semibold tracking-widest text-slate-400">
        ONE CHECK PER LINE — NUMBER, OR NUMBER, DATE, BANK REFERENCE
      </label>
      <textarea id="clearing-lines" rows={10} value={text} disabled={pending}
        onChange={(e) => { setText(e.target.value); setPreview(null) }}
        placeholder={'6000319079\n6000319080, 2026-09-10, BPI 88123'} className={field} />
      <p className="text-[11px] text-slate-500">
        Up to {maxLines} lines at a time. Dates as YYYY-MM-DD or DD/MM/YYYY. Nothing is written until you confirm.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={pending || text.trim() === ''}
          onClick={doPreview}
          className="rounded-lg border border-hairline bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy hover:bg-ground disabled:opacity-50">
          {pending ? 'WORKING…' : 'PREVIEW'}
        </button>
        {preview?.ok && (
          <button type="button" disabled={pending || willClear === 0}
            onClick={doConfirm}
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white hover:bg-navy/90 disabled:opacity-50">
            CONFIRM — MARK {willClear} CLEARED
          </button>
        )}
      </div>

      {preview && !preview.ok && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{preview.message}</p>
      )}
      {result && !result.ok && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
      )}

      {preview?.ok && (
        <KitTable
          tableId="clearing-paste"
          frameClassName="overflow-x-auto rounded-xl bg-white ring-1 ring-hairline"
          cellClassName="px-4 py-2"
          columns={[
            { key: 'line', label: 'LINE', kind: 'amount', className: 'tabular-nums text-slate-500' },
            { key: 'check', label: 'CHECK', kind: 'text', locked: true, className: 'tabular-nums' },
            { key: 'payee', label: 'PAYEE', kind: 'text', className: 'text-slate-700' },
            { key: 'date', label: 'DATE', kind: 'date' },
            { key: 'bankRef', label: 'BANK REF', kind: 'text' },
            { key: 'verdict', label: 'WHAT CONFIRM DOES', kind: 'text', className: 'font-medium' },
          ]}
          rows={[
            ...preview.rows.map((r): KitRow => ({
              key: `r${r.line}`,
              values: {
                line: String(r.line), check: r.checkNumber, payee: r.payeeName, date: dateValue(r.clearedDate),
                bankRef: r.crNumber, verdict: `${VERDICT[r.verdict].words}${r.detail ? ` · ${r.detail}` : ''}`,
              },
              cells: {
                line: r.line,
                check: (
                  <>
                    {r.checkId
                      ? <Link prefetch={false} href={`/checks/${r.checkId}`} className="underline underline-offset-2">{r.checkNumber}</Link>
                      : r.checkNumber}
                    {r.companyCode && <span className="ml-2 text-xs text-slate-500">{r.companyCode}</span>}
                  </>
                ),
                payee: r.payeeName ?? '—',
                date: fmtDate(r.clearedDate),
                bankRef: r.crNumber ?? '—',
                verdict: <span className={VERDICT[r.verdict].tone}>{VERDICT[r.verdict].words}{r.detail ? ` · ${r.detail}` : ''}</span>,
              },
            })),
            ...preview.errors.map((e): KitRow => ({
              key: `e${e.line}`,
              values: { line: String(e.line), check: e.raw, payee: null, date: null, bankRef: null, verdict: `NOT READ · ${e.message}` },
              cells: {
                line: e.line,
                check: <span className="font-mono text-xs text-slate-500">{e.raw}</span>,
                verdict: <span className="text-danger-ink">NOT READ · {e.message}</span>,
              },
            })),
          ]}
        />
      )}
    </div>
  )
}
