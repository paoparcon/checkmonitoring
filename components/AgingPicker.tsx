'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { formatAmount } from '@/lib/transmittal'
import { bulkReadyForReleaseAction } from '@/app/checks/bulk-actions'
import type { BulkActionResult, BulkOutcome } from '@/lib/bulk-run'
import { AGING_BUCKETS, AGING_LABELS, type AgingBucket } from '@/lib/aging/buckets'
import type { AgingRow } from '@/lib/aging/query'
import {
  AGING_TABLE_ID, BUCKET_COLUMN_KEYS, agingColumns, agingValue, bucketColumnTotals, effectiveSelection, inBucket, selectionTotal, stripTotals, type BucketChoice,
} from '@/lib/aging-picker'
import type { KitSort } from '@/lib/table-kit/types'
import { applyKit, needleError } from '@/lib/table-kit/match'
import { setWidth, visibleColumns, widthStyle } from '@/lib/table-kit/layout'
import { useTableLayout } from './table-kit/useTableLayout'
import { KitHeaderRow } from './table-kit/KitHeaderRow'
import { FilterChips } from './table-kit/FilterChips'
import { ColumnConfigButton } from './table-kit/ColumnConfigDialog'

/** Rows drawn at once; SELECT ALL SHOWN still selects every match. */
const DRAW_LIMIT = 500

const BUCKET_BY_COLUMN = new Map<string, AgingBucket>(AGING_BUCKETS.map((b) => [BUCKET_COLUMN_KEYS[b], b]))

const BUCKET_TONE: Record<string, string> = {
  current: 'ring-emerald-300', b30: 'ring-amber-300', b60: 'ring-amber-400',
  b90: 'ring-rose-300', b90plus: 'ring-rose-400', noDue: 'ring-slate-300',
}

export function AgingPicker({ rows, cap, truncated }: { rows: readonly AgingRow[]; cap: number; truncated: boolean }) {
  const router = useRouter()
  const companies = useMemo(() => [...new Set(rows.map((r) => r.company))].sort(), [rows])
  const banks = useMemo(() => [...new Set(rows.map((r) => r.bank).filter((b): b is string => b !== null))].sort(), [rows])
  const columns = useMemo(() => agingColumns(companies, banks), [companies, banks])
  const { layout, preview, save, reset } = useTableLayout(AGING_TABLE_ID, columns)
  const [choice, setChoice] = useState<BucketChoice | 'SELECTED'>('OVERDUE')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [sort, setSort] = useState<KitSort>({ key: 'daysPastDue', dir: 'desc' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pickupDate, setPickupDate] = useState('')
  const [result, setResult] = useState<BulkActionResult | null>(null)
  const [pending, startTransition] = useTransition()

  const activeKeys = Object.keys(filters).filter((k) => filters[k].trim() !== '')
  const visible = visibleColumns(columns, layout, activeKeys)
  const errors: Record<string, string> = {}
  for (const k of activeKeys) {
    const c = columns.find((x) => x.key === k)
    const e = c ? needleError(c, filters[k]) : null
    if (e) errors[k] = e
  }
  // The strip counts the kit-filtered rows across every bucket, so a card's
  // count is the row count its table shows.
  const filtered = useMemo(() => applyKit(rows, columns, agingValue, filters, null), [rows, columns, filters])
  const strip = useMemo(() => stripTotals(filtered), [filtered])
  // What can be submitted: only ticked rows still on the page (see effectiveSelection).
  const chosen = useMemo(() => effectiveSelection(rows, selected), [rows, selected])
  const chosenIds = useMemo(() => new Set(chosen.map((r) => r.id)), [chosen])
  const picked = selectionTotal(rows, chosenIds)
  const overCap = chosen.length > cap
  // The SELECTED view lists every chosen check, deliberately not narrowed by the column filters.
  const matching = useMemo(
    () => choice === 'SELECTED'
      ? applyKit(chosen, columns, agingValue, {}, sort)
      : applyKit(inBucket(filtered, choice), columns, agingValue, {}, sort),
    [filtered, choice, chosen, columns, sort],
  )
  const columnTotals = useMemo(() => bucketColumnTotals(matching), [matching])
  const matchingTotal = useMemo(() => stripTotals(matching).all.amount, [matching])
  const firstTextKey = visible.find((c) => !BUCKET_BY_COLUMN.has(c.key))?.key
  const foot = (key: string) => {
    const b = BUCKET_BY_COLUMN.get(key)
    if (b) return columnTotals[b].count > 0 ? columnTotals[b].amount : null
    if (key === firstTextKey) return 'TOTAL (PHP)'
    if (key === 'amount') return matchingTotal
    return null
  }
  const matchingSigned = useMemo(() => matching.filter((r) => r.status === 'SIGNED'), [matching])
  const readyShown = matching.length - matchingSigned.length
  const matchingIds = useMemo(() => new Set(matching.map((r) => r.id)), [matching])
  const offScreen = chosen.filter((r) => !matchingIds.has(r.id)).length

  const toggle = (id: string) => {
    // Already available: never ticked from here (effectiveSelection would drop it anyway).
    if (rows.find((r) => r.id === id)?.status !== 'SIGNED') return
    setResult(null)
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }

  const ready = () => {
    // chosen.length, not picked.count: a ticked non-PHP check is readied too, it is only left out of the peso total.
    const nonPhpChosen = chosen.filter((r) => r.currency !== 'PHP').length
    if (!confirm(`Mark ${chosen.length} check(s), PHP ${picked.amount}${nonPhpChosen > 0 ? ` (+${nonPhpChosen} non-PHP, not in the peso amount)` : ''}, READY FOR RELEASE?`)) return
    const fd = new FormData()
    for (const r of chosen) fd.append('checkId', r.id)
    fd.append('availablePickupDate', pickupDate)
    startTransition(async () => {
      const r = await bulkReadyForReleaseAction(fd)
      setResult(r)
      if (r.ok) {
        // A refused check stays ticked for a retry; readied ones are cleared.
        setSelected(new Set(r.outcomes.filter((o) => !o.ok).map((o) => o.checkId)))
        if (r.succeeded > 0) router.refresh()
      }
    })
  }

  const failures = result?.ok
    ? result.outcomes.filter((o): o is Extract<BulkOutcome, { ok: false }> => !o.ok)
    : []

  const card = (key: BucketChoice | 'SELECTED', label: string, t: { count: number; amount: string }, tone: string) => (
    <button
      key={key} type="button" onClick={() => setChoice(key)} aria-pressed={choice === key}
      className={`rounded-xl bg-white px-3 py-2 text-left ring-1 ${tone} ${choice === key ? 'ring-2 ring-navy' : ''}`}
    >
      <div className="text-[11px] font-semibold tracking-widest text-slate-500">{label}</div>
      <div className="text-lg font-semibold text-slate-900">{t.count.toLocaleString('en-PH')}</div>
      <div className="text-xs tabular-nums text-slate-600">₱{t.amount}</div>
    </button>
  )

  const cell = (r: AgingRow, key: string) => {
    switch (key) {
      case 'checkNumber': return <Link href={`/checks/${r.id}`} className="underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>{r.checkNumber}</Link>
      case 'amount': return formatAmount(r.amount)
      case 'bucket': return AGING_LABELS[r.bucket]
      case 'status': return r.status === 'READY_FOR_RELEASE'
        ? <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700">READY FOR RELEASE</span>
        : 'SIGNED'
      default: {
        const b = BUCKET_BY_COLUMN.get(key)
        if (b) return b === r.bucket ? `${formatAmount(r.amount)}${r.currency !== 'PHP' ? ` ${r.currency}` : ''}` : null
        return agingValue(r, key) ?? '—'
      }
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs font-medium tracking-wide text-slate-600">
        SIGNED AND READY FOR RELEASE CHECKS. AGED BY THE EARLIEST DUE DATE OF THE BILLS EACH CHECK PAYS, AS IN THE SUPPLIER PORTAL.
        {strip.buckets.noDue.count > 0 && <> <button type="button" className="underline" onClick={() => setChoice('noDue')}>{strip.buckets.noDue.count.toLocaleString('en-PH')} HAVE NO DUE DATE.</button></>}
        {strip.nonPhp > 0 && <> {strip.nonPhp} NON-PHP CHECK(S) ARE COUNTED BUT NOT IN THE PESO AMOUNTS.</>}
        {strip.unpriced > 0 && <> {strip.unpriced} WITH NO READABLE AMOUNT ARE COUNTED BUT NOT IN THE PESO AMOUNTS.</>}
      </p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-9">
        {AGING_BUCKETS.map((b) => card(b, AGING_LABELS[b], strip.buckets[b], BUCKET_TONE[b]))}
        {card('OVERDUE', 'OVERDUE', strip.overdue, 'ring-rose-300')}
        {card('ALL', 'ALL', strip.all, 'ring-slate-300')}
        {card('SELECTED', 'SELECTED', { count: chosen.length, amount: picked.amount }, 'ring-navy')}
      </div>
      <p className="text-xs font-medium tracking-wide text-slate-600">
        {matchingSigned.length.toLocaleString('en-PH')} SIGNED · {readyShown.toLocaleString('en-PH')} READY FOR RELEASE (ALREADY AVAILABLE — NOT SELECTABLE)
      </p>
      {filters.bucket?.trim() && (
        <p className="text-xs font-medium tracking-wide text-slate-600">
          THE BUCKET COLUMN FILTER IS SET — CARDS OUTSIDE IT SHOW 0.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <ColumnConfigButton columns={columns} layout={layout} onSave={save} onReset={reset} />
        <button
          type="button" onClick={() => { setResult(null); setSelected(new Set(matchingSigned.map((r) => r.id))) }} disabled={matchingSigned.length === 0}
          className="h-9 rounded-lg bg-navy px-3 text-sm font-medium tracking-wide text-white disabled:opacity-40"
        >
          SELECT ALL SHOWN ({matchingSigned.length.toLocaleString('en-PH')})
        </button>
        <button
          type="button" onClick={() => { setResult(null); setSelected(new Set()) }} disabled={chosen.length === 0}
          className="h-9 rounded-lg bg-white px-3 text-sm font-medium tracking-wide text-slate-600 ring-1 ring-hairline disabled:opacity-40"
        >
          CLEAR
        </button>
        <a href="/api/export/aging" className="h-9 rounded-lg bg-white px-3 py-2 text-sm font-medium tracking-wide text-slate-700 ring-1 ring-hairline">
          EXPORT EXCEL
        </a>
      </div>

      <FilterChips
        columns={columns} filters={filters} errors={errors}
        onClear={(k) => setFilters((f) => ({ ...f, [k]: '' }))} onClearAll={() => setFilters({})}
        count={{ shown: matching.length, total: rows.length, capped: truncated }}
      />

      {choice === 'SELECTED' && (
        <p className="text-xs font-semibold tracking-wide text-slate-700">
          SHOWING EVERY SELECTED CHECK — COLUMN FILTERS DO NOT APPLY HERE.
        </p>
      )}

      <div className="max-h-[60vh] overflow-auto rounded-lg ring-1 ring-hairline">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-slate-50 text-left tracking-wide text-slate-500">
            <KitHeaderRow
              columns={visible} widths={layout.widths} sort={sort} filters={filters} errors={errors} cellClassName="px-2 py-2 font-semibold"
              onSort={(key, dir) => setSort(dir ? { key, dir } : null)}
              onFilter={(key, n) => setFilters((f) => ({ ...f, [key]: n }))}
              onResize={(key, w) => preview(setWidth(layout, key, w))}
              onResizeEnd={(key, w) => save(setWidth(layout, key, w))}
              leading={<th className="w-9 px-2 py-2" />}
            />
          </thead>
          <tbody>
            {matching.length === 0 && (
              <tr><td colSpan={visible.length + 1} className="px-2 py-6 text-center text-slate-500">NO CHECKS MATCH.</td></tr>
            )}
            {matching.slice(0, DRAW_LIMIT).map((r) => (
              <tr key={r.id} className={`border-t border-slate-100 hover:bg-navy-bg ${r.status === 'SIGNED' ? 'cursor-pointer' : ''}`} onClick={() => toggle(r.id)}>
                <td className="px-2 py-1.5">
                  {r.status === 'SIGNED' ? (
                    <input type="checkbox" checked={chosenIds.has(r.id)} onChange={() => toggle(r.id)}
                      onClick={(e) => e.stopPropagation()} aria-label={`Select ${r.checkNumber}`} />
                  ) : '—'}
                </td>
                {visible.map((col) => (
                  <td key={col.key} style={widthStyle(layout.widths[col.key])}
                    className={`truncate px-2 py-1.5 ${col.align === 'right' ? 'text-right' : ''} ${col.className ?? ''}`}>
                    {cell(r, col.key)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot className="sticky bottom-0 z-10">
            <tr className="border-t border-hairline bg-navy-bg font-semibold">
              <td className="px-2 py-1.5" />
              {visible.map((col) => (
                <td key={col.key} style={widthStyle(layout.widths[col.key])}
                  className={`truncate px-2 py-1.5 ${col.align === 'right' ? 'text-right' : ''} ${col.align === 'right' ? 'tabular-nums' : ''}`}>
                  {foot(col.key)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
        {matching.length > DRAW_LIMIT && (
          <p className="border-t border-slate-100 px-2 py-2 text-center text-xs text-slate-500">
            SHOWING THE FIRST {DRAW_LIMIT} OF {matching.length.toLocaleString('en-PH')} — FILTER TO NARROW, OR USE SELECT ALL SHOWN.
          </p>
        )}
      </div>

      <div className="sticky bottom-0 z-10 rounded-2xl bg-white p-4 shadow-lg ring-1 ring-slate-300">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold tracking-wide text-slate-900">
            {chosen.length.toLocaleString('en-PH')} SELECTED · ₱{picked.amount}
          </span>
          {offScreen > 0 && (
            <span className="text-xs font-semibold tracking-wide text-warning-ink">
              ({offScreen.toLocaleString('en-PH')} NOT IN THIS VIEW —{' '}
              <button type="button" onClick={() => setChoice('SELECTED')} className="underline">SHOW SELECTED</button>)
            </span>
          )}
          {overCap && (
            <span className="text-xs font-semibold tracking-wide text-warning-ink">
              AT MOST {cap.toLocaleString('en-PH')} AT A TIME — UNTICK SOME.
            </span>
          )}
          <label htmlFor="aging-pickup-date" className="text-xs font-medium tracking-wide text-slate-600">AVAILABLE PICKUP DATE</label>
          <input id="aging-pickup-date" type="date" value={pickupDate} onChange={(e) => setPickupDate(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm" />
          <button
            type="button" onClick={ready}
            disabled={pending || chosen.length === 0 || overCap || pickupDate === ''}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? 'WORKING…' : 'MARK READY FOR RELEASE'}
          </button>
        </div>
        {result && !result.ok && <p className="mt-2 text-sm text-warning-ink">{result.message}</p>}
        {result?.ok && (
          <div className="mt-2 text-sm text-slate-700">
            {result.succeeded} MARKED READY FOR RELEASE{result.failed > 0 && `, ${result.failed} REFUSED:`}
            {failures.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs text-warning-ink">
                {failures.map((f) => <li key={f.checkId}>{f.checkNumber ?? f.checkId}: {f.message}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
