import { FilterForm } from '@/components/FilterForm'
import type { CheckStatus, StagedReason } from '@prisma/client'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import {
  countStagedChecks, getStagedBillSummary, getStagedSummary, listStagedBills, listStagedChecks,
  type StagedScope,
} from '@/lib/admin/staged-queue'
import { formatMoney } from '@/lib/money'
import { EmptyState } from '@/components/EmptyState'
import { KitTable, type KitRow } from '@/components/table-kit/KitTable'
import type { KitColumn } from '@/lib/table-kit/types'
import { dateValue } from '@/lib/table-kit/match'

/**
 * The staged queue: rows the importer could not write, kept whole.
 *
 * **This is a reading surface, not a data-entry one.** Measured 2026-09-04:
 * 2,467 of the register's 2,766 staged rows are cheques already handed over and
 * 214 are cancelled, leaving about 28 that anyone has to do anything about, and
 * Finance already reconciles the closed ones in the Supplier Portal or in
 * Acumatica. A bulk correction workflow here would serve twenty-eight rows.
 * What it needs to be is legible, filterable, and opened on the live ones —
 * which is why the scope below defaults to LIVE rather than to everything.
 */

const n = (v: number) => v.toLocaleString('en-PH')

// The one field treatment, matching `components/FilterBar.tsx`. Two filter bars
// in one application that focus in different colours is exactly the drift the
// palette work exists to end.
const FIELD =
  'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 ' +
  'focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

const distinct = (vals: string[]) => [...new Set(vals)].sort().map((v) => ({ value: v, label: v }))
const underscored = (v: string) => v.replace(/_/g, ' ')

const SCOPES: readonly StagedScope[] = ['LIVE', 'CLOSED', 'ALL']
const REASONS: readonly StagedReason[] = ['NO_COMPANY', 'AMBIGUOUS_COMPANY', 'NO_CHECK_NUMBER', 'SHARED_NUMBER']
const STATUSES: readonly CheckStatus[] = [
  'GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE',
  'SCHEDULED', 'RELEASED', 'CANCELLED', 'VOIDED',
]

/**
 * A count card, in the dashboard's own shape: white on the tinted ground with a
 * hairline ring, the label small and tracked above the figure.
 *
 * `accent` is the warning tone and is spent on exactly two of the seven — the
 * rows still in the release workflow, and the approval rows that attached to
 * nothing — because those are the two somebody has to act on. Seven tinted
 * cards would be the screen the client complained about.
 */
function Card({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl p-5 ring-1 ${accent ? 'bg-warning-bg ring-warning-ink/20' : 'bg-white ring-hairline'}`}>
      <p className={`text-[11px] font-semibold tracking-widest ${accent ? 'text-warning-ink' : 'text-slate-400'}`}>
        {label}
      </p>
      <p className={`mt-2 text-2xl font-semibold tabular-nums ${accent ? 'text-warning-ink' : 'text-navy'}`}>
        {value}
      </p>
    </div>
  )
}

export default async function StagedPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; reason?: string; impliedStatus?: string; q?: string }>
}) {
  await requireAdmin()
  const params = await searchParams

  // Everything off the URL is validated rather than cast. A hand-edited or
  // stale bookmarked link would otherwise hand Prisma an invalid enum value and
  // crash the page.
  const scope = SCOPES.includes(params.scope as StagedScope) ? (params.scope as StagedScope) : 'LIVE'
  const reason = REASONS.includes(params.reason as StagedReason)
    ? (params.reason as StagedReason) : undefined
  const impliedStatus = STATUSES.includes(params.impliedStatus as CheckStatus)
    ? (params.impliedStatus as CheckStatus) : undefined

  const filters = { scope, reason, impliedStatus, q: params.q }

  const [summary, rows, matching, billSummary, billRows] = await Promise.all([
    getStagedSummary(prisma),
    listStagedChecks(prisma, filters),
    countStagedChecks(prisma, filters),
    getStagedBillSummary(prisma),
    listStagedBills(prisma),
  ])

  const checkColumns: KitColumn[] = [
    { key: 'checkNumber', label: 'CHECK NUMBER', kind: 'text', locked: true, className: 'font-medium' },
    { key: 'payee', label: 'PAYEE', kind: 'text' },
    { key: 'checkDate', label: 'CHECK DATE', kind: 'date', className: 'text-slate-600' },
    { key: 'amount', label: 'AMOUNT', kind: 'amount', align: 'right', className: 'tabular-nums' },
    { key: 'reason', label: 'WHY IT IS HERE', kind: 'enum', options: distinct(rows.map((r) => underscored(r.reason))), className: 'text-slate-600' },
    { key: 'implied', label: 'REGISTER IMPLIES', kind: 'enum', options: distinct(rows.map((r) => underscored(r.impliedStatus))) },
    { key: 'cashAccount', label: 'CASH ACCOUNT', kind: 'text', className: 'text-slate-600' },
    { key: 'checkBook', label: 'CHECK BOOK', kind: 'text', className: 'text-slate-600' },
    { key: 'companies', label: 'COMPANIES CLAIMED', kind: 'text', className: 'text-slate-600' },
    { key: 'source', label: 'SOURCE', kind: 'text', className: 'text-slate-600' },
  ]
  const checkRows: KitRow[] = rows.map((r) => {
    const companies = r.conflictingCompanies.length ? r.conflictingCompanies.join(' / ') : r.companyCode
    const source = r.source === 'WORKBOOK'
      ? `${r.sourceSheet} row ${r.sourceRow}`
      : `Acumatica ${r.acumaticaTenant} ${r.acumaticaRef}`
    return {
      key: r.id,
      className: 'border-b border-slate-100 last:border-0 odd:bg-white even:bg-ground hover:bg-navy-bg',
      values: {
        checkNumber: r.checkNumber ?? r.statedCheckRef, payee: r.payeeName, checkDate: dateValue(r.checkDate),
        amount: r.amount === null ? null : r.amount.toString(),
        reason: underscored(r.reason), implied: underscored(r.impliedStatus),
        cashAccount: r.cashAccountCode, checkBook: r.checkBookCode, companies, source,
      },
      cells: {
        // For a NO_CHECK_NUMBER row the check number is null and this shows what
        // the cell actually held, which is what a human replaces with the real
        // number. It is never promoted into `checkNumber`.
        checkNumber: r.checkNumber ?? r.statedCheckRef ?? '—',
        payee: r.payeeName ?? '—',
        checkDate: fmtDate(r.checkDate),
        amount: formatMoney(r.amount, r.currency ?? 'PHP'),
        reason: underscored(r.reason),
        implied: underscored(r.impliedStatus),
        cashAccount: r.cashAccountCode ?? '—',
        checkBook: r.checkBookCode ?? '—',
        companies: companies ?? '—',
        source: (
          <>
            {source}
            {r.promotedCheckId && (
              <span className="ml-2 rounded bg-success-bg px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-success-ink">
                PLACED
              </span>
            )}
          </>
        ),
      },
    }
  })
  const billColumns: KitColumn[] = [
    { key: 'cell', label: 'CELL', kind: 'text', locked: true, className: 'text-slate-600' },
    { key: 'voucher', label: 'VOUCHER', kind: 'text', className: 'font-medium' },
    { key: 'po', label: 'PO NUMBER', kind: 'text', className: 'text-slate-600' },
    { key: 'checkNumber', label: 'CHECK NUMBER', kind: 'text' },
    { key: 'said', label: 'WHAT THE CELL SAID', kind: 'text', className: 'text-slate-600' },
    { key: 'reason', label: 'WHY IT IS HERE', kind: 'enum', options: distinct(billRows.map((b) => underscored(b.reason))), className: 'text-slate-600' },
    { key: 'companies', label: 'COMPANIES CLAIMED', kind: 'text', className: 'text-slate-600' },
  ]
  const billKitRows: KitRow[] = billRows.map((b) => {
    const cell = `${b.sourceSheet} row ${b.sourceRow}`
    const companies = b.companies.length ? b.companies.join(' / ') : null
    return {
      key: b.id,
      className: 'border-b border-slate-100 last:border-0 odd:bg-white even:bg-ground hover:bg-navy-bg',
      values: {
        cell, voucher: b.apvNumber, po: b.poNumber, checkNumber: b.checkNumber, said: b.statedCheckRef,
        reason: underscored(b.reason), companies,
      },
      cells: {
        cell,
        voucher: b.apvNumber ?? '—',
        po: b.poNumber ?? '—',
        checkNumber: b.checkNumber ?? '—',
        // Verbatim, and never promoted into the column beside it. This is what a
        // human replaces with the real number.
        said: b.statedCheckRef ?? '—',
        reason: underscored(b.reason),
        companies: companies ?? '—',
      },
    }
  })

  return (
    <div className="space-y-6">
      {/* Eight since 2026-10-06 (SHARED NUMBER). Seven, not six, since 2026-09-07: the approval workbook's refused rows
          are a count of their own and belong on the same line as the rest. */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-8">
        <Card label="STILL IN THE RELEASE WORKFLOW" value={n(summary.live)} accent />
        <Card label="ALREADY RELEASED OR CANCELLED" value={n(summary.closed)} />
        <Card label="NO COMPANY" value={n(summary.byReason.NO_COMPANY)} />
        <Card label="AMBIGUOUS COMPANY" value={n(summary.byReason.AMBIGUOUS_COMPANY)} />
        <Card label="NO CHECK NUMBER" value={n(summary.byReason.NO_CHECK_NUMBER)} />
        <Card label="SHARED NUMBER" value={n(summary.byReason.SHARED_NUMBER)} />
        <Card label="SINCE PLACED BY A SYNC" value={n(summary.promoted)} />
        {/* Toned only when it is not zero. This card exists because voucher
            AP-ST042652 never reached the supplier portal over one mis-keyed
            cell, and the importer's own report of it went to a terminal during
            a run nobody was watching. A number nobody sees is not a report. */}
        <Card
          label="APPROVAL ROWS NOT ATTACHED"
          value={n(billSummary.total)}
          accent={billSummary.total > 0}
        />
      </section>

      <p className="max-w-4xl rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        These {n(summary.total)} rows were kept whole because they could not be written as checks.
        Most of them are closed history — Finance reconciles those in the Supplier Portal or in
        Acumatica, and this system is not their system of record. The {n(summary.live)} still in the
        release workflow are the ones worth reading. Nothing here is deleted: a staged row is the
        record of why a check was held, and the Acumatica sync places some of them automatically.
      </p>

      {/* The dashboard's filter bar, in a card, with the same field treatment —
          a plain `method="get"` form, so every filter is in the URL and a
          narrowed queue stays linkable. There is no auto-submit enhancement
          here and the APPLY button is therefore real and stays visible. */}
      <FilterForm className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline">
        <input
          name="q" defaultValue={params.q ?? ''}
          placeholder="SEARCH CHECK NO., WHAT THE CELL SAID, OR PAYEE"
          className={`${FIELD} min-w-[16rem] flex-1`}
        />
        <select name="scope" defaultValue={scope} className={FIELD}>
          <option value="LIVE">STILL IN THE RELEASE WORKFLOW</option>
          <option value="CLOSED">RELEASED OR CANCELLED</option>
          <option value="ALL">ALL — LIVE ROWS FIRST</option>
        </select>
        <select name="reason" defaultValue={params.reason ?? ''} className={FIELD}>
          <option value="">ANY REASON</option>
          {REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
        </select>
        <select name="impliedStatus" defaultValue={params.impliedStatus ?? ''} className={FIELD}>
          <option value="">ANY IMPLIED STATUS</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
        <button
          type="submit"
          className="h-10 rounded-lg bg-navy px-4 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90"
        >
          APPLY
        </button>
      </FilterForm>

      {matching > rows.length && (
        <p className="rounded-lg bg-warning-bg px-4 py-2 text-sm text-warning-ink">
          SHOWING {n(rows.length)} OF {n(matching)} MATCHING ROWS. Narrow the filters to see the rest.
        </p>
      )}

      {rows.length === 0 ? (
        // Two different emptinesses, and telling them apart is the whole point:
        // an unfiltered LIVE queue with nothing in it means every cheque the
        // register named found a company and a number, which is good news and
        // says so. A filtered one that matched nothing is just a filter.
        summary.total === 0 ? (
          <EmptyState tone="good" title="NOTHING IS HELD FOR REVIEW">
            Every row of every workbook imported so far was written as a check. Rows land here
            when the importer cannot tell whose check they are, or cannot find a check number
            on them — nothing is ever discarded.
          </EmptyState>
        ) : (
          <EmptyState title="NO STAGED ROWS MATCH THESE FILTERS">
            {n(summary.total)} row(s) are held for review in total. Widen the scope, or clear the
            reason and implied-status filters, to see them.
          </EmptyState>
        )
      ) : (
        <KitTable tableId="staged-checks" columns={checkColumns} rows={checkRows} capped={matching > rows.length} />
      )}

      {/* The approval-for-release workbook's refused rows.
          A second table rather than more rows in the one above, because a bill
          is not a cheque: it has no implied status, no company and no amount of
          its own that belongs beside cheque amounts. Same page, though — the
          person who has to fix a mis-keyed cell should not have to know which
          of two queues it landed in. */}
      <section className="space-y-3">
        <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">
          APPROVAL-FOR-RELEASE ROWS THAT ATTACHED TO NO CHECK
        </h2>
        {billRows.length === 0 ? (
          // Good news, and the reason this queue exists: voucher AP-ST042652
          // reached no cheque and nobody saw it. An empty list here means every
          // approved voucher found its cheque.
          <EmptyState tone="good" title="EVERY APPROVAL ROW IS ATTACHED TO A CHECK">
            No voucher from the approval-for-release workbook is stranded. A row appears here when
            its <em>check No.</em> cell holds something that is not a check number and its voucher
            matches no check — never silently, and never only in a terminal.
          </EmptyState>
        ) : (
          <>
            <p className="max-w-4xl rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
              These rows carry a voucher that reached no check, so nothing about them reaches the
              Supplier Portal either. NO CHECK NUMBER means the workbook&apos;s <em>check No.</em>{' '}
              cell holds something that is not a check number — a date, usually — and the
              row&apos;s voucher matched no check here; correct the cell, or import the register so
              the voucher can find it. Nothing is deleted, and re-importing the workbook clears a
              row that has since attached.
            </p>
            <KitTable tableId="staged-bills" columns={billColumns} rows={billKitRows} capped={billSummary.total > billRows.length} />
          </>
        )}
      </section>
    </div>
  )
}
