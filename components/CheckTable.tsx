'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { formatMoney } from '@/lib/money'
import { RECEIPT_TYPES } from '@/lib/domain/receipt'
import {
  isTickable, takesReceipt, draftTypeMissing, EMPTY_DRAFT, type ReceiptDraft,
} from '@/lib/row-receipts'
import { COLUMN_LABELS, type ColumnKey } from '@/lib/table-columns'
import { isSortKey, type SortKey, type SortSpec } from '@/lib/list-sort'
import { LIST_FILTER_FORM } from '@/lib/column-filters'
import type { FilterOptions } from '@/lib/queries'
import type { CheckTableRow } from '@/lib/queries'
import { bindingError, bindingParams, needleToParams, paramsToNeedle } from '@/lib/table-kit/url-binding'
import { MAIN_LIST_BINDINGS, MAIN_LIST_TABLE_ID, legacyMainList, mainListColumns } from '@/lib/table-kit/main-list'
import { setWidth, visibleColumns, widthStyle } from '@/lib/table-kit/layout'
import { writeSortCookie } from './sort-cookie'
import { StatusPill } from './StatusPill'
import { BulkActionBar } from './BulkActionBar'
import { useTableLayout } from './table-kit/useTableLayout'
import { useUrlUpdate } from './table-kit/useUrlUpdate'
import { KitHeaderRow } from './table-kit/KitHeaderRow'
import { FilterChips } from './table-kit/FilterChips'
import { ColumnConfigButton } from './table-kit/ColumnConfigDialog'

/** The list's filters as the server read them (spec 2026-10-13 §3). */
export type FilterRowState = {
  options: FilterOptions
  /** Each parameter's value as typed (company and bank as ids). */
  values: Readonly<Record<string, string>>
  /** Parameter → message, for the values the server could not read. */
  errors: Readonly<Record<string, string>>
  /** STATUS filters on ALL CHECKS only. */
  showStatus: boolean
  /** DATE RELEASED filters on RELEASED and ALL CHECKS only. */
  showReleasedRange: boolean
}

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

/**
 * A cheque can be ticked if a bulk action could conceivably apply to it: a
 * live cheque, as before, or a RELEASED one still waiting for its receipt — a
 * late receipt is typed by ticking the row and filling its OR box.
 * `isTickable` (`lib/row-receipts.ts`) is the same predicate the domain and the
 * server actions share — restating the list here is how the two would drift.
 *
 * This is presentation, not a control. Every refusal is re-decided by
 * `lib/domain/actions.ts` on the server, which is why a hidden checkbox can
 * never be the reason a cheque was not released.
 */
const selectable = isTickable

/** Every column but ACTION, which is pinned last and rendered after OR / CR. */
type DataColumn = Exclude<ColumnKey, 'action'>

/** One data cell. The markup of each case is the cell the table rendered before part C. */
function DataCell({ column, r, width }: { column: DataColumn; r: CheckTableRow; width?: number }) {
  switch (column) {
    case 'checkNumber':
      return <td style={widthStyle(width)} className="px-2 py-2 font-medium">{r.checkNumber}</td>
    case 'apvNumbers':
      return <td style={widthStyle(width)} className="px-2 py-2 text-slate-600">{r.apvNumbers.length ? r.apvNumbers.join(', ') : '—'}</td>
    case 'poNumbers':
      return <td style={widthStyle(width)} className="px-2 py-2 text-slate-600">{r.poNumbers.length ? r.poNumbers.join(', ') : '—'}</td>
    case 'payeeName':
      return (
        <td style={widthStyle(width)} className="px-2 py-2">
          {/* An em dash, not the bare null React would render as nothing:
              153 register rows have no payee, and an empty cell reads as a
              rendering bug rather than as a fact about the cheque. Matches
              fmtDate and the APV column above. */}
          {r.payeeName ?? '—'}
          {r.eligibility === 'INTERNAL' && (
            <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] tracking-wide text-slate-600">
              INTERNAL
            </span>
          )}
        </td>
      )
    case 'companyCode':
      return <td style={widthStyle(width)} className="px-2 py-2 text-slate-600">{r.companyCode}</td>
    case 'bank':
      // The cash account code, because "BPI STK" is the label Finance uses;
      // the bank code is the title, for the reader who knows the institution
      // but not the account. An em dash where no cash account is recorded —
      // the column is nullable.
      return <td style={widthStyle(width)} className="px-2 py-2 text-slate-600" title={r.bankCode ?? undefined}>{r.cashAccountCode ?? '—'}</td>
    case 'checkDate':
      return <td style={widthStyle(width)} className="px-2 py-2 text-slate-600">{fmtDate(r.checkDate)}</td>
    case 'amount':
      // Right-aligned and tabular, so the decimal points line up down the
      // column and an eight-figure amount is visibly an eight-figure amount.
      return <td style={widthStyle(width)} className="px-2 py-2 text-right font-medium tabular-nums">{formatMoney(r.amount, r.currency)}</td>
    case 'status':
      // STALED: Finance's word for a cheque past its presentment life (ruling
      // 2026-10-06). It stays CANCELLED; the tag says why.
      return (
        <td style={widthStyle(width)} className="px-2 py-2">
          <StatusPill status={r.status} />
          {r.isStale && <span className="ml-1 text-[10px] font-semibold tracking-widest text-amber-700">STALED</span>}
        </td>
      )
    case 'availablePickupDate':
      return <td style={widthStyle(width)} className="px-2 py-2 text-slate-600">{fmtDate(r.availablePickupDate)}</td>
    case 'scheduledPickupDate':
      return <td style={widthStyle(width)} className="px-2 py-2 text-slate-600">{fmtDate(r.scheduledPickupDate)}</td>
    case 'releasedAt':
      // The app's own timestamp when it has one; otherwise the day the retired
      // register stated, tagged so nobody reads a spreadsheet date as a release
      // this system recorded.
      return (
        <td style={widthStyle(width)} className="px-2 py-2 text-slate-600">
          {r.releasedAt
            ? fmtDate(r.releasedAt)
            : r.statedReleaseDate
              ? <>{fmtDate(r.statedReleaseDate)}<span className="ml-1 text-[10px] font-semibold tracking-widest text-slate-400">REGISTER</span></>
              : '—'}
        </td>
      )
    default: {
      const unreachable: never = column
      return unreachable
    }
  }
}

export function CheckTable({
  rows, canRelease, bulkCap, sort, filters,
}: {
  rows: CheckTableRow[]
  canRelease: boolean
  bulkCap: number
  /** The order in force (URL, cookie or default) — which header shows an arrow. */
  sort: SortSpec
  /** The filters as the server read them: values, refusals, which columns may filter. */
  filters: FilterRowState
}) {
  const router = useRouter()
  const search = useSearchParams()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  // Keyed by check id. A row's draft is read back on release and on SAVE
  // RECEIPTS (`lib/row-receipts.ts`'s `receiptEntries`), which is what lets a
  // batch carry more than one supplier's receipt safely — each has exactly one
  // owner, the row it was typed in.
  const [drafts, setDrafts] = useState<Record<string, ReceiptDraft>>({})

  const columns = useMemo(
    () => mainListColumns({ options: filters.options, showStatus: filters.showStatus, showReleasedRange: filters.showReleasedRange }),
    [filters.options, filters.showStatus, filters.showReleasedRange],
  )
  const { layout, preview, save, reset } = useTableLayout(MAIN_LIST_TABLE_ID, columns, legacyMainList)
  // The menu changes only parameters nothing else on the page draws uncontrolled
  // (the hidden inputs below are controlled), so the filter bar is not remounted.
  const navigate = useUrlUpdate({ markOwn: true })
  // On NEEDS ACTION (no `status`, no `scope`) every change also writes
  // `scope=live`, as the filter bar's hidden field do: clearing
  // the last filter or sort must not land on `/` or `/?company=…`, which are
  // the TOTALS screen (`dashboardScreen`).
  const update = (updates: Readonly<Record<string, string>>) =>
    navigate(!search.get('status') && !search.get('scope') ? { ...updates, scope: 'live' } : updates)

  // Needles read back from the server's values — the URL stays the one truth.
  const needles: Record<string, string> = {}
  const errors: Record<string, string> = {}
  for (const c of columns) {
    const b = MAIN_LIST_BINDINGS[c.key as SortKey]
    needles[c.key] = paramsToNeedle(b, filters.values)
    const e = bindingError(b, filters.errors)
    if (e) errors[c.key] = e
  }
  const filtered = Object.keys(needles).filter((k) => needles[k] !== '')
  // A column with a filter in force is never hidden (part C2).
  const visibleKitColumns = visibleColumns(columns, layout, filtered)
  const shown = visibleKitColumns.map((c) => c.key as DataColumn)

  const applyFilter = (key: string, needle: string) => update(needleToParams(MAIN_LIST_BINDINGS[key as SortKey], needle))
  // The menu's Sort Ascending / Descending, or neither (null). The cookie is
  // written before the navigation, as the old header links did, so the server
  // render that follows — and the next visit — use it.
  const applySort = (key: string, dir: 'asc' | 'desc' | null) => {
    if (!isSortKey(key)) return
    const next: SortSpec | null = dir ? { key, dir } : null
    writeSortCookie(next)
    update(next ? { sort: next.key, dir: next.dir } : { sort: '', dir: '' })
  }

  const selectableRows = rows.filter(selectable)
  // Only ids still on screen count. A filter change re-renders with different
  // rows, and a stale id would put a cheque the user can no longer see into a
  // batch they thought they were reading.
  const selectedIds = rows.filter((r) => selected.has(r.id)).map((r) => r.id)
  const allSelected = selectableRows.length > 0 && selectedIds.length === selectableRows.length

  const toggle = (id: string) => {
    // Read outside the updater: a `setSelected` updater must stay pure, and
    // React can invoke it twice in development, which would fire the
    // `setDrafts` side effect below twice for one click.
    const wasSelected = selected.has(id)
    setSelected((prev) => {
      const next = new Set(prev)
      if (wasSelected) next.delete(id)
      else next.add(id)
      return next
    })
    if (wasSelected) {
      // Unticking a row throws away whatever it had typed. Left ticked, its
      // box is closed too — clearing on tick, not on close, keeps the box's
      // contents attached to the tick that opened it.
      setDrafts((d) => {
        if (!(id in d)) return d
        const { [id]: _omit, ...rest } = d
        return rest
      })
    }
  }

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set())
      setDrafts({})
    } else {
      setSelected(new Set(selectableRows.map((r) => r.id)))
    }
  }

  const open = (id: string) => router.push(`/checks/${id}`)

  return (
    <div className="space-y-3">
      {/* ⚙ CUSTOMIZE COLUMNS and the chips. Outside the table, as the old
          COLUMNS chooser was: a reader who narrowed the table to three columns
          must be able to widen it again. */}
      <div className="flex flex-wrap items-center gap-2">
        <ColumnConfigButton columns={columns} layout={layout} onSave={save} onReset={reset} />
        <FilterChips
          columns={columns} filters={needles} errors={errors}
          onClear={(k) => applyFilter(k, '')}
          onClearAll={() => update(Object.fromEntries(
            columns.flatMap((c) => bindingParams(MAIN_LIST_BINDINGS[c.key as SortKey])).map((p) => [p, '']),
          ))}
        />
        {/* The filter bar's form submits these, so a search typed in the bar keeps the
            column filters (they used to ride on the filter row's boxes, `form=`-joined). */}
        {Object.entries(filters.values)
          .filter(([name]) => columns.some((c) => bindingParams(MAIN_LIST_BINDINGS[c.key as SortKey]).includes(name)))
          .map(([name, value]) => <input key={name} type="hidden" form={LIST_FILTER_FORM} name={name} value={value} />)}
      </div>

      {/* Scrolls in BOTH directions, and the vertical scroll is what makes the
          sticky header work: a sticky element pins to its nearest SCROLLING
          ancestor, and a container that only scrolls sideways — height set by
          its content — gives it nothing to stick to. The capped height gives it
          one. Two hundred rows of cheque numbers under a header that has
          scrolled off the top is a table nobody can read. */}
      <div className="max-h-[80vh] overflow-auto rounded-2xl bg-white ring-1 ring-hairline">
        <table className="w-full text-[13px]">
          {/* Opaque, not tinted: a translucent header would let the banded rows
              show through it as they scroll underneath. The bottom rule is an
              inset shadow rather than a border, because a border on a sticky
              header scrolls away with the cell box in some browsers. */}
          <thead className="sticky top-0 z-10 bg-white text-left text-xs tracking-wide text-slate-500 shadow-[inset_0_-1px_0_#E5E7EB]">
            <KitHeaderRow
              columns={visibleKitColumns} widths={layout.widths} sort={sort} filters={needles} errors={errors}
              cellClassName="px-2 py-2"
              onSort={applySort} onFilter={applyFilter}
              onResize={(key, w) => preview(setWidth(layout, key, w))}
              onResizeEnd={(key, w) => save(setWidth(layout, key, w))}
              leading={
                <th className="px-2 py-2">
                  <input
                    type="checkbox" checked={allSelected} onChange={toggleAll}
                    disabled={selectableRows.length === 0}
                    aria-label="Select every actionable check on this page"
                  />
                </th>
              }
              trailing={<><th className="px-2 py-2">OR / CR</th><th className="px-2 py-2">{COLUMN_LABELS.action}</th></>}
            />
          </thead>
          <tbody>
            {rows.length === 0 ? (
              // Kept inside the table (part C2): the headers — and their filter
              // menus — must survive a filter that matches nothing.
              <tr>
                <td colSpan={shown.length + 3} className="p-8 text-center text-sm text-slate-500">
                  NO CHECKS MATCH THESE FILTERS.
                </td>
              </tr>
            ) : rows.map((r) => (
              // The whole row navigates: the cheque number alone was a
              // few-pixel target in a table this wide. The row is focusable and
              // answers Enter, and the OPEN link at the end survives as the
              // real anchor — a div with an onClick is not a link to a screen
              // reader, and middle-click and "open in new tab" have to keep
              // working.
              <tr
                key={r.id}
                onClick={() => open(r.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') open(r.id) }}
                tabIndex={0}
                // Banded, so the eye can carry a row across eleven columns
                // without losing its place. Hover and focus are declared after
                // the bands so they win on both the odd and the even rows —
                // a hover tint the banding beats is a hover tint that flickers.
                className="cursor-pointer border-b border-slate-100 last:border-0 odd:bg-white even:bg-ground hover:bg-navy-bg focus:bg-navy-bg focus:outline-none"
              >
                {/* The tick-box must not navigate. Stopping the event on the
                    cell, not just the input, keeps the generous click target
                    the padding gives it. */}
                <td
                  className="px-2 py-2"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  {selectable(r) ? (
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      aria-label={`Select check ${r.checkNumber}`}
                    />
                  ) : (
                    // Deliberately not a disabled checkbox: a released or
                    // cancelled cheque is not a thing the user failed to tick,
                    // and an empty cell says so more quietly.
                    <span className="sr-only">Not actionable</span>
                  )}
                </td>
                {shown.map((key) => <DataCell key={key} column={key} r={r} width={layout.widths[key]} />)}
                {/* The supplier's receipt. A ticked row that can carry one gets
                    its own box, which is what lets a batch carry receipts safely:
                    every reference has exactly one cheque. Keys and clicks stop
                    here so typing never opens the cheque (the row navigates on
                    click and on Enter). */}
                <td className="px-2 py-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  {/* A live (READY/SCHEDULED) row's box is useful only to
                      someone who can press MARK RELEASED — that is the only
                      action that reads it. A RELEASED row keeps its box for
                      everyone, because SAVE RECEIPTS is open to any Finance
                      user. */}
                  {selected.has(r.id) && takesReceipt(r) && (r.status === 'RELEASED' || canRelease) ? (
                    <div className="flex items-center gap-2">
                      <select
                        aria-label={`Receipt type for check ${r.checkNumber}`}
                        aria-invalid={draftTypeMissing(drafts[r.id] ?? EMPTY_DRAFT)}
                        value={(drafts[r.id] ?? EMPTY_DRAFT).receiptType}
                        onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: { ...(d[r.id] ?? EMPTY_DRAFT), receiptType: e.target.value as ReceiptDraft['receiptType'] } }))}
                        className={`rounded-lg border px-2 py-1 text-sm ${draftTypeMissing(drafts[r.id] ?? EMPTY_DRAFT) ? 'border-amber-500' : 'border-slate-300'}`}
                      >
                        <option value="">TYPE</option>
                        {RECEIPT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <input
                        aria-label={`Receipt reference for check ${r.checkNumber}`}
                        value={(drafts[r.id] ?? EMPTY_DRAFT).orNumber}
                        placeholder="Reference"
                        onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: { ...(d[r.id] ?? EMPTY_DRAFT), orNumber: e.target.value } }))}
                        className="w-32 rounded-lg border border-slate-300 px-2 py-1 text-sm"
                      />
                    </div>
                  ) : r.orNumber ? (
                    <span>{r.orNumber} <span className="text-xs text-slate-500">({r.receiptType ?? '?'})</span></span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                  <Link prefetch={false} href={`/checks/${r.id}`} className="text-sm font-medium text-slate-900 underline underline-offset-2">
                    OPEN
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedIds.length > 0 && (
        <BulkActionBar
          selectedRows={rows.filter((r) => selected.has(r.id))}
          drafts={drafts}
          canRelease={canRelease}
          cap={bulkCap}
          onDone={() => { setSelected(new Set()); setDrafts({}) }}
        />
      )}
    </div>
  )
}
