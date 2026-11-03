import Link from 'next/link'
import { cookies } from 'next/headers'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { listChecks, countChecks, toTableRow, getFilterOptions } from '@/lib/queries'
import { resolveDashboardQuery, type RawDashboardSearchParams } from '@/lib/dashboard-params'
import { dashboardHref } from '@/lib/dashboard-view'
import { formatMoney } from '@/lib/money'
import { statusPillClass } from '@/lib/status-pill'
import { PrintButton } from '@/components/PrintButton'
import { SORT_COOKIE } from '@/lib/list-sort'
import { describeRefusal } from '@/lib/column-filters'
import { formatManila } from '@/lib/manila-format'

/**
 * PRINT RELEASE LIST.
 *
 * ── SECURITY ──────────────────────────────────────────────────────────────
 * `middleware.ts` DOES NOT RUN in this project — Node-runtime middleware is
 * unsupported in Next 15.5.25 and the file is silently never registered. Every
 * page is protected because it calls `requireUser()` itself, on its first line,
 * and this one is no exception: it lists payees, amounts, banks and cheque
 * numbers.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * A page with a `@media print` stylesheet, not a PDF library. The client asked
 * for a print-friendly view of the current selection; a PDF dependency would be
 * a second renderer to keep in step with the table for no gain over what the
 * browser already does well.
 *
 * The selection is carried in the URL and resolved by `resolveDashboardQuery` —
 * the same function the dashboard and the Excel export run, so the sheet holds
 * exactly the cheques that were on screen. A second parser that agreed today
 * would drift the first time a filter was added to one of them.
 */

// Derived from a session and from live financial data; never prerendered.
export const dynamic = 'force-dynamic'

/**
 * How many rows a sheet will print.
 *
 * Lower than the export's 10,000 on purpose: this is paper. A thousand cheques
 * is about twenty-five pages, which is already more than anybody carries to the
 * vault, and the cap is stated on the sheet when it bites so a short list can
 * never be mistaken for a complete one.
 */
const PRINT_ROW_LIMIT = 1_000

const fmtDate = (d: Date | null) =>
  d ? formatManila(d, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

export default async function PrintPage({
  searchParams,
}: {
  searchParams: Promise<RawDashboardSearchParams>
}) {
  const user = await requireUser()
  const params = await searchParams

  // The remembered order (part C4): the sheet follows the screen's sort even
  // when the URL names none. Its COLUMNS stay fixed — this is a release sheet
  // carried to the vault, not a copy of the screen.
  const sortCookie = (await cookies()).get(SORT_COOKIE)?.value

  const options = await getFilterOptions(prisma)
  const {
    selection, filters, viewLabel, filterDescription, incomplete, sort, refused, filterErrors,
  } = resolveDashboardQuery(params, options, { sortCookie })

  // A refused box prints the refusal, never rows: `buildWhere` would match
  // nothing anyway, so the database is not asked.
  const [rows, matching] = refused
    ? [[] as Awaited<ReturnType<typeof listChecks>>, 0] as const
    : await Promise.all([
      listChecks(prisma, filters, PRINT_ROW_LIMIT, sort),
      countChecks(prisma, filters),
    ])

  // Mapped through `toTableRow` exactly as the dashboard table is: it is what
  // turns a `Prisma.Decimal` into a decimal string, and it drops the fields —
  // cancellation reasons, portal sync state, source sheet and row — that have
  // no business on a sheet of paper that leaves the room.
  const printed = rows.map(toTableRow)

  // The link back to the exact view this sheet was made from, so the reader is
  // not left pressing Back. Built by the same module every other dashboard link
  // comes from.
  const backHref = dashboardHref(selection)

  return (
    <main className="print-sheet mx-auto max-w-[1100px] p-8 text-slate-900">
      <div className="print-hide mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link href={backHref} className="text-sm text-slate-500 underline underline-offset-2">
          ← BACK TO THE DASHBOARD
        </Link>
        <div className="flex items-center gap-3">
          {/* The button is an enhancement. The page prints correctly from the
              browser's own Print command whether or not it loaded. */}
          <span className="text-xs text-slate-500">OR USE YOUR BROWSER’S PRINT COMMAND</span>
          <PrintButton />
        </div>
      </div>

      <header className="border-b-2 border-navy pb-3">
        <h1 className="text-lg font-semibold tracking-wide text-navy">CHECK RELEASE LIST</h1>
        <p className="mt-1 text-sm font-medium tracking-wide text-slate-700">{viewLabel}</p>
        {/* Not when refused: the description would name the very value that
            could not be read, as if it were a filter this sheet applied. */}
        {!refused && filterDescription && (
          <p className="mt-0.5 text-xs tracking-wide text-slate-600">{filterDescription}</p>
        )}
        <p className="mt-2 text-xs tracking-wide text-slate-500">
          {/* Who printed it and when. A sheet of cheque numbers found on a desk
              with no date on it cannot be told from a current one. */}
          {matching.toLocaleString('en-PH')} CHECK{matching === 1 ? '' : 'S'} · PRINTED{' '}
          {formatManila(new Date(), {
            year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
          })} BY {user.name}
        </p>
        {matching > printed.length && (
          // Never silent. A short sheet that does not say it is short is
          // indistinguishable from a complete one.
          <p className="mt-2 text-xs font-semibold tracking-wide text-warning-ink">
            THIS SHEET HOLDS THE FIRST {printed.length.toLocaleString('en-PH')} OF{' '}
            {matching.toLocaleString('en-PH')} MATCHING CHECKS. Narrow the filters and print again
            for the rest.
          </p>
        )}
        {refused && (
          // The sheet refuses with the screen and says why it holds no rows.
          <p role="alert" className="mt-2 whitespace-pre-line text-xs font-semibold tracking-wide text-warning-ink">
            {describeRefusal(filterErrors)}
          </p>
        )}
      </header>

      {refused ? null : printed.length === 0 ? (
        <p className="mt-8 text-sm text-slate-500">NO CHECKS MATCH THIS SELECTION.</p>
      ) : (
        <table className="mt-4 w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-hairline text-left tracking-wide text-slate-500">
              <th className="py-2 pr-3 font-semibold">CHECK NUMBER</th>
              <th className="py-2 pr-3 font-semibold">APV NUMBER</th>
              <th className="py-2 pr-3 font-semibold">PO NUMBER</th>
              <th className="py-2 pr-3 font-semibold">CHECK DATE</th>
              <th className="py-2 pr-3 font-semibold">SUPPLIER NAME</th>
              <th className="py-2 pr-3 font-semibold">COMPANY</th>
              <th className="py-2 pr-3 font-semibold">BANK</th>
              <th className="py-2 pr-3 text-right font-semibold">AMOUNT</th>
              <th className="py-2 font-semibold">STATUS</th>
            </tr>
          </thead>
          <tbody>
            {printed.map((r) => (
              <tr key={r.id} className="border-b border-slate-100 align-top">
                <td className="py-1.5 pr-3 font-medium">{r.checkNumber}</td>
                <td className="py-1.5 pr-3">{r.apvNumbers.length ? r.apvNumbers.join(', ') : '—'}</td>
                <td className="py-1.5 pr-3">{r.poNumbers.length ? r.poNumbers.join(', ') : '—'}</td>
                <td className="py-1.5 pr-3">{fmtDate(r.checkDate)}</td>
                {/* An em dash, not a blank: 153 register rows have no payee, and
                    an empty cell on paper reads as a printing fault. */}
                <td className="py-1.5 pr-3">{r.payeeName ?? '—'}</td>
                <td className="py-1.5 pr-3">{r.companyCode}</td>
                <td className="py-1.5 pr-3">{r.cashAccountCode ?? '—'}</td>
                {/* A decimal string, formatted. Null renders as an em dash —
                    "no amount was recorded" is not "worth nothing". */}
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {formatMoney(r.amount, r.currency)}
                </td>
                <td className="py-1.5">
                  <span className={`inline-block rounded px-1.5 py-0.5 font-semibold ${statusPillClass(r.status)}`}>
                    {r.status.replace(/_/g, ' ')}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* The same statement the dashboard makes, because a sheet that leaves the
          room has to say what it leaves out — more so than a screen, which at
          least has a link to press. Both halves of the toggle are stated, since
          this sheet can be printed from either. */}
      <p className="mt-4 text-[10px] tracking-wide text-slate-500">
        {incomplete
          ? 'THESE ARE THE CHECKS WITH NO RECORDED AMOUNT, WHICH IS WHY EVERY AMOUNT PRINTS AS “—”. THEY ARE REAL CHECKS; THERE IS SIMPLY NO FIGURE OF THEIRS TO SHOW.'
          : 'CHECKS WITH NO RECORDED AMOUNT ARE NOT ON THIS SHEET. THEY ARE REAL CHECKS AND ARE STILL IN THE SYSTEM — PRINT AGAIN WITH THE INCOMPLETE ONLY FILTER TO LIST THEM.'}
      </p>
    </main>
  )
}
