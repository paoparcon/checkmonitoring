'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { markPaymentsAction, refreshPaymentsAction, type MarkPaymentsActionResult, type RefreshPaymentsResult } from '@/app/payments/actions'
import { MARKING_LABELS, PAYMENT_MARKINGS, type Marking } from '@/lib/payments/marking'
import type { PaymentRow } from '@/lib/payments/query'
import { PAYMENTS_TABLE_ID, markable, markingCards, paymentColumns, paymentValue, type MarkingCard } from '@/lib/payments-view'
import { formatAmount } from '@/lib/transmittal'
import type { KitSort } from '@/lib/table-kit/types'
import { applyKit, needleError } from '@/lib/table-kit/match'
import { setWidth, visibleColumns, widthStyle } from '@/lib/table-kit/layout'
import { useTableLayout } from './table-kit/useTableLayout'
import { KitHeaderRow } from './table-kit/KitHeaderRow'
import { FilterChips } from './table-kit/FilterChips'
import { ColumnConfigButton } from './table-kit/ColumnConfigDialog'

/** Rows drawn at once; SELECT ALL SHOWN still selects every match. */
const DRAW_LIMIT = 500

const TONE: Record<string, string> = {
  'ON PROCESS': 'bg-amber-50 text-amber-800 ring-amber-200',
  PROCESSED: 'bg-sky-50 text-sky-800 ring-sky-200',
  CLEARED: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  CANCELLED: 'bg-slate-100 text-slate-500 ring-slate-200',
}

const fmtDay = (day: string | null) =>
  day ? new Date(`${day}T00:00:00Z`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—'

/**
 * OTHER PAYMENTS: the list, its cards and the marking bar (2026-11-20). The
 * table kit filters and sorts in the browser; a card is a shortcut to the
 * MARKING filter. Only ticked payments still on the page and not voided are
 * ever submitted (`markable`).
 */
export function PaymentsPicker({ rows, today }: { rows: readonly PaymentRow[]; today: string }) {
  const router = useRouter()
  const columns = useMemo(() => paymentColumns(rows), [rows])
  const { layout, preview, save, reset } = useTableLayout(PAYMENTS_TABLE_ID, columns)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [sort, setSort] = useState<KitSort>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [marking, setMarking] = useState<Marking>('PROCESSED')
  const [date, setDate] = useState('')
  const [bankReference, setBankReference] = useState('')
  const [remarks, setRemarks] = useState('')
  const [result, setResult] = useState<MarkPaymentsActionResult | null>(null)
  const [refresh, setRefresh] = useState<RefreshPaymentsResult | null>(null)
  const [pending, startTransition] = useTransition()
  const [refreshing, startRefresh] = useTransition()

  const activeKeys = Object.keys(filters).filter((k) => filters[k].trim() !== '')
  const visible = visibleColumns(columns, layout, activeKeys)
  const errors: Record<string, string> = {}
  for (const k of activeKeys) {
    const c = columns.find((x) => x.key === k)
    const e = c ? needleError(c, filters[k]) : null
    if (e) errors[k] = e
  }

  // The cards count every filter except MARKING's own, so each card says what its click would show.
  const cardRows = useMemo(() => applyKit(rows, columns, paymentValue, { ...filters, marking: '' }, null), [rows, columns, filters])
  const { all, cards } = useMemo(() => markingCards(cardRows), [cardRows])
  const matching = useMemo(() => applyKit(rows, columns, paymentValue, filters, sort), [rows, columns, filters, sort])
  const matchingMarkable = useMemo(() => matching.filter((r) => !r.voided), [matching])
  const chosen = useMemo(() => markable(rows, selected), [rows, selected])
  const chosenIds = useMemo(() => new Set(chosen.map((r) => r.id)), [chosen])
  const matchingIds = useMemo(() => new Set(matching.map((r) => r.id)), [matching])
  const offScreen = chosen.filter((r) => !matchingIds.has(r.id)).length
  const cardFilter = (filters.marking ?? '').trim()

  const toggle = (r: PaymentRow) => {
    if (r.voided) return
    setResult(null)
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(r.id)) n.delete(r.id); else n.add(r.id)
      return n
    })
  }

  const apply = () => {
    if (!confirm(`Mark ${chosen.length} payment(s) ${MARKING_LABELS[marking]}?`)) return
    const fd = new FormData()
    for (const r of chosen) fd.append('paymentId', r.id)
    fd.append('marking', marking)
    fd.append('date', marking === 'ON_PROCESS' ? '' : date)
    fd.append('bankReference', bankReference)
    fd.append('remarks', remarks)
    startTransition(async () => {
      const r = await markPaymentsAction(fd)
      setResult(r)
      if (r.ok) {
        // A refused payment stays ticked for a retry; the rest are cleared.
        const refused = new Set(r.refused.map((x) => x.referenceNbr))
        setSelected(new Set(chosen.filter((c) => refused.has(c.referenceNbr)).map((c) => c.id)))
        setBankReference('')
        setRemarks('')
        if (r.marked > 0) router.refresh()
      }
    })
  }

  const card = (c: MarkingCard, needle: string) => (
    <button
      key={c.label} type="button" aria-pressed={cardFilter === needle}
      onClick={() => setFilters((f) => ({ ...f, marking: cardFilter === needle ? '' : needle }))}
      className={`rounded-xl bg-white px-3 py-2 text-left ring-1 ring-hairline ${cardFilter === needle ? 'ring-2 ring-navy' : ''}`}
    >
      <div className="text-[11px] font-semibold tracking-widest text-slate-500">{c.label}</div>
      <div className="text-lg font-semibold text-slate-900">{c.count.toLocaleString('en-PH')}</div>
      <div className="space-y-0.5 text-xs tabular-nums text-slate-600">
        {c.totals.length === 0 ? <div>—</div> : c.totals.map((t) => <div key={t.currency}>{t.currency} {t.total}</div>)}
      </div>
    </button>
  )

  const cell = (r: PaymentRow, key: string) => {
    switch (key) {
      case 'method': return <span title={r.methodLabel}>{r.methodLabel}</span>
      case 'marking': return (
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ring-1 ${TONE[r.display] ?? ''}`}>{r.display}</span>
      )
      case 'amount': return formatAmount(r.amount)
      case 'paymentDate': return fmtDay(r.paymentDate)
      case 'processedDate': return fmtDay(r.processedDate)
      case 'clearedDate': return fmtDay(r.clearedDate)
      case 'markedBy': return r.markedBy ?? 'ON ARRIVAL'
      default: return paymentValue(r, key) ?? '—'
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {card(all, '')}
        {cards.map((c) => card(c, `=${c.label}`))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ColumnConfigButton columns={columns} layout={layout} onSave={save} onReset={reset} />
        <button
          type="button" disabled={matchingMarkable.length === 0}
          onClick={() => { setResult(null); setSelected(new Set(matchingMarkable.map((r) => r.id))) }}
          className="h-9 rounded-lg bg-navy px-3 text-sm font-medium tracking-wide text-white disabled:opacity-40"
        >
          SELECT ALL SHOWN ({matchingMarkable.length.toLocaleString('en-PH')})
        </button>
        <button
          type="button" disabled={chosen.length === 0} onClick={() => { setResult(null); setSelected(new Set()) }}
          className="h-9 rounded-lg bg-white px-3 text-sm font-medium tracking-wide text-slate-600 ring-1 ring-hairline disabled:opacity-40"
        >
          CLEAR
        </button>
        <a href="/api/export/payments" className="h-9 rounded-lg bg-white px-3 py-2 text-sm font-medium tracking-wide text-slate-700 ring-1 ring-hairline">
          EXPORT EXCEL
        </a>
        <button
          type="button" disabled={refreshing}
          onClick={() => startRefresh(async () => { const r = await refreshPaymentsAction(); setRefresh(r); router.refresh() })}
          className="h-9 rounded-lg bg-white px-3 text-sm font-medium tracking-wide text-slate-700 ring-1 ring-hairline disabled:opacity-50"
        >
          {refreshing ? 'READING ACUMATICA…' : 'REFRESH FROM ACUMATICA'}
        </button>
      </div>
      {refresh && (
        <ul className={`text-xs font-medium tracking-wide ${refresh.ok ? 'text-slate-600' : 'text-warning-ink'}`}>
          {refresh.lines.map((l) => <li key={l}>{l}</li>)}
        </ul>
      )}

      <FilterChips
        columns={columns} filters={filters} errors={errors}
        onClear={(k) => setFilters((f) => ({ ...f, [k]: '' }))} onClearAll={() => setFilters({})}
        count={{ shown: matching.length, total: rows.length, capped: false }}
      />

      <div className="max-h-[60vh] overflow-auto rounded-lg bg-white ring-1 ring-hairline">
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
              <tr><td colSpan={visible.length + 1} className="px-2 py-6 text-center text-slate-500">
                {rows.length === 0 ? 'NO PAYMENTS HAVE BEEN READ FROM ACUMATICA YET. PRESS REFRESH FROM ACUMATICA.' : 'NO PAYMENTS MATCH.'}
              </td></tr>
            )}
            {matching.slice(0, DRAW_LIMIT).map((r) => (
              <tr key={r.id} onClick={() => toggle(r)}
                className={`border-t border-slate-100 hover:bg-navy-bg ${r.voided ? 'text-slate-400' : 'cursor-pointer'}`}>
                <td className="px-2 py-1.5">
                  {r.voided ? '—' : (
                    <input type="checkbox" checked={chosenIds.has(r.id)} onChange={() => toggle(r)}
                      onClick={(e) => e.stopPropagation()} aria-label={`Select ${r.referenceNbr}`} />
                  )}
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
        </table>
        {matching.length > DRAW_LIMIT && (
          <p className="border-t border-slate-100 px-2 py-2 text-center text-xs text-slate-500">
            SHOWING THE FIRST {DRAW_LIMIT} OF {matching.length.toLocaleString('en-PH')} — FILTER TO NARROW, OR USE SELECT ALL SHOWN.
          </p>
        )}
      </div>

      <div className="sticky bottom-0 z-10 rounded-2xl bg-white p-4 shadow-lg ring-1 ring-slate-300">
        <div className="flex flex-wrap items-end gap-3">
          <span className="pb-2 text-sm font-semibold tracking-wide text-slate-900">
            {chosen.length.toLocaleString('en-PH')} SELECTED
            {offScreen > 0 && <span className="ml-2 text-xs text-warning-ink">({offScreen.toLocaleString('en-PH')} NOT IN THIS VIEW)</span>}
          </span>
          <label className="text-xs font-medium tracking-wide text-slate-600">
            MARK AS
            <select value={marking} onChange={(e) => setMarking(e.target.value as Marking)}
              className="mt-1 block rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
              {PAYMENT_MARKINGS.map((m) => <option key={m} value={m}>{MARKING_LABELS[m]}</option>)}
            </select>
          </label>
          {marking !== 'ON_PROCESS' && (
            <label className="text-xs font-medium tracking-wide text-slate-600">
              {marking === 'CLEARED' ? 'DEBITED BY THE BANK ON' : 'SENT TO THE BANK ON (OPTIONAL)'}
              <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)}
                className="mt-1 block rounded-lg border border-slate-300 px-2 py-1 text-sm" />
            </label>
          )}
          <label className="text-xs font-medium tracking-wide text-slate-600">
            BANK REFERENCE (OPTIONAL)
            <input type="text" value={bankReference} maxLength={120} onChange={(e) => setBankReference(e.target.value)}
              className="mt-1 block w-44 rounded-lg border border-slate-300 px-2 py-1 text-sm" />
          </label>
          <label className="grow text-xs font-medium tracking-wide text-slate-600">
            REMARKS (NEEDED TO MOVE A PAYMENT BACK)
            <input type="text" value={remarks} maxLength={500} onChange={(e) => setRemarks(e.target.value)}
              className="mt-1 block w-full min-w-40 rounded-lg border border-slate-300 px-2 py-1 text-sm" />
          </label>
          <button
            type="button" onClick={apply}
            disabled={pending || chosen.length === 0 || (marking === 'CLEARED' && date === '')}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? 'WORKING…' : 'APPLY MARKING'}
          </button>
        </div>
        {result && !result.ok && <p className="mt-2 text-sm text-warning-ink">{result.message}</p>}
        {result?.ok && (
          <div className="mt-2 text-sm text-slate-700">
            {result.marked} MARKED{result.unchanged > 0 && `, ${result.unchanged} ALREADY SO`}{result.refused.length > 0 && `, ${result.refused.length} REFUSED (STILL TICKED):`}
            {result.refused.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs text-warning-ink">
                {result.refused.slice(0, 20).map((f, i) => <li key={`${f.referenceNbr}-${i}`}>{f.referenceNbr ?? 'UNKNOWN'}: {f.message}</li>)}
                {result.refused.length > 20 && <li>…and {result.refused.length - 20} more.</li>}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
