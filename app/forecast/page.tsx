import { FilterForm } from '@/components/FilterForm'
import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getFilterOptions } from '@/lib/queries'
import { AppHeader } from '@/components/AppHeader'
import { EmptyState } from '@/components/EmptyState'
import { ForecastMatrix } from '@/components/ForecastMatrix'
import { listForecastRows, listPlannedRows, listBankCodes, countExcludedIncomplete } from '@/lib/forecast/query'
import { buildMatrices } from '@/lib/forecast/matrix'
import {
  FORECAST_PATH, FORECAST_EXPORT_PATH, STAGE_OPTIONS,
  parseStageParam, forecastHref, describeForecastFilters,
} from '@/lib/forecast-view'

/**
 * CASH OUTFLOW BY CHEQUE DATE — what is written and not yet handed over.
 *
 * The cheque-side of the daily cash position Finance asked for on
 * 2026-09-10. The axis is the cheque's own date, read as PRESENTABLE FROM:
 * no pickup or release date has ever been recorded (measured 2026-09-11), and
 * a cheque's date is the day from which it can be presented — which is how
 * Finance's own Cash Balance sheet treats an outstanding cheque. A cheque dated
 * in the past is not a missed forecast; it is exposure, and the buckets say
 * how long it has been exposure.
 *
 * Everything shown is decided in `lib/forecast/` and `lib/forecast-view.ts`;
 * the page reads parameters, runs one query, and renders. The export runs the
 * same query with the same filters, so the file and the screen agree.
 */
export default async function ForecastPage({
  searchParams,
}: {
  searchParams: Promise<{ bank?: string; company?: string; stage?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams

  const [options, banks] = await Promise.all([getFilterOptions(prisma), listBankCodes(prisma)])
  const bank = banks.includes(params.bank?.trim() ?? '') ? params.bank!.trim() : undefined
  const company = options.companies.find((c) => c.id === params.company?.trim())
  const stage = parseStageParam(params.stage)

  // Once per request, so the two matrices and the paragraph above them agree
  // about which day it is.
  const now = new Date()
  const [cheques, incompleteCount, planned] = await Promise.all([
    listForecastRows(prisma, { bankCode: bank, companyId: company?.id, stage }),
    // This report's own exclusion, not the database-wide count of
    // `Check.isIncomplete` — same population, same filters, or the number
    // below is about a different report. See `countExcludedIncomplete`.
    countExcludedIncomplete(prisma, { bankCode: bank, companyId: company?.id, stage }),
    listPlannedRows(prisma, { bankCode: bank, companyId: company?.id, stage }),
  ])
  const rows = [...cheques, ...planned]
  const expectedCount = cheques.filter((c) => c.expectedOutflowDate !== null).length
  const { byBank, byStage } = buildMatrices(rows, now)

  const anyFilter = Boolean(bank || company || stage)
  const current = { bank, company: company?.id, stage }
  const field = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

  return (
    <main className="space-y-4 px-4 py-5">
      <AppHeader user={user} title="CASH OUTFLOW" back={{ href: '/', label: '← DASHBOARD' }} />

      {/* The premise, stated once and always. Not a tooltip: a reader who takes
          "presentable from" for "expected on" will carry a wrong number into a
          meeting, and the sentence that prevents it has to be on the page. */}
      <p className="rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        Dates are the check&apos;s own date — the day from which it can be presented. A check on which
        Finance has typed an expected outflow date is placed on that date instead. Planned lines —
        payroll, tax, transfers — sit on their own day. A check dated in
        the past can leave on any day; the buckets say how long it has been presentable. No pickup or
        release dates have been recorded yet; as Finance releases through this system, the RELEASED
        view will begin to show actual outflow by day.
      </p>

      <FilterForm className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline">
        <label className="sr-only" htmlFor="forecast-bank">BANK</label>
        <select id="forecast-bank" name="bank" defaultValue={bank ?? ''} className={field}>
          <option value="">ANY BANK</option>
          {banks.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>

        <label className="sr-only" htmlFor="forecast-company">COMPANY</label>
        <select id="forecast-company" name="company" defaultValue={company?.id ?? ''} className={field}>
          <option value="">ANY COMPANY</option>
          {options.companies.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
        </select>

        <label className="sr-only" htmlFor="forecast-stage">STAGE</label>
        <select id="forecast-stage" name="stage" defaultValue={stage ?? ''} className={field}>
          <option value="">ANY STAGE</option>
          {STAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <button type="submit" className="h-10 rounded-lg bg-navy px-4 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90">
          APPLY
        </button>
        {anyFilter && (
          <Link href={FORECAST_PATH} className="text-sm text-slate-500 underline underline-offset-2">RESET</Link>
        )}
      </FilterForm>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-medium tracking-wide text-slate-600">
            {cheques.length.toLocaleString('en-PH')} CHECK{cheques.length === 1 ? '' : 'S'} WRITTEN AND NOT YET HANDED OVER
            {' AND '}{planned.length.toLocaleString('en-PH')} PLANNED LINE{planned.length === 1 ? '' : 'S'}
            {expectedCount > 0 && ` · ${expectedCount.toLocaleString('en-PH')} PLACED ON AN EXPECTED DATE`}
            {' · '}{describeForecastFilters({ bank, company: company?.code, stage })}
          </p>
          {/* The disclosure, as on the dashboard and /vouchers: the exclusion is
              a ruling (2026-09-06), and stating its count is the price of it.
              The count is struck over THIS report's own population and filters
              (`countExcludedIncomplete`) — not the database-wide count of
              `Check.isIncomplete`, most of which (CANCELLED, RELEASED, VOIDED)
              were never candidates for this report in the first place. */}
          {incompleteCount > 0 && (
            <p className="text-xs font-medium tracking-wide text-slate-500">
              EXCLUDES {incompleteCount.toLocaleString('en-PH')} CHECK{incompleteCount === 1 ? '' : 'S'} WITH NO
              RECORDED AMOUNT that would otherwise be in these figures and in the file.{' '}
              <Link href="/?incomplete=1" className="underline underline-offset-2">Show them</Link>.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-slate-500">The file holds this view, with these filters.</span>
          <Link href="/forecast/planned" className="rounded-lg border border-hairline bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy transition hover:bg-ground">
            PLANNED OUTFLOWS
          </Link>
          <a
            href={forecastHref(current, FORECAST_EXPORT_PATH)}
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90"
          >
            EXPORT EXCEL
          </a>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={anyFilter ? 'NOTHING MATCHES' : 'NOTHING IS WAITING TO LEAVE THE BANK'} tone={anyFilter ? 'plain' : 'good'}>
          {anyFilter
            ? 'No live check or planned line carries that bank, company and stage together.'
            : 'Every check has been released, cancelled or voided, and no planned outflow is open.'}
        </EmptyState>
      ) : (
        <>
          <ForecastMatrix title="BY BANK" matrix={byBank} />
          <ForecastMatrix title="BY STAGE" matrix={byStage} />
        </>
      )}
    </main>
  )
}
