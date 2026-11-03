import { FilterForm } from '@/components/FilterForm'
import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getFilterOptions } from '@/lib/queries'
import { listBankCodes } from '@/lib/forecast/query'
import { listOutstandingCandidates, countExcludedIncomplete } from '@/lib/recon/query'
import { summariseByAccount } from '@/lib/recon/summary'
import { RECON_PATH, RECON_EXPORT_PATH, parseAsOf, reconHref, describeReconFilters } from '@/lib/recon-view'
import { AppHeader } from '@/components/AppHeader'
import { EmptyState } from '@/components/EmptyState'
import { ReconTable } from '@/components/ReconTable'
import { OutstandingList } from '@/components/OutstandingList'

/**
 * OUTSTANDING CHEQUES — the cheque side of the bank reconciliation.
 *
 * For a day, every cash account's released-and-not-cleared cheques: the OC
 * column of Finance's Cash Balance sheet, computed from what this system
 * records (built 2026-09-12). Everything shown is decided in `lib/recon/`;
 * the page reads parameters, runs one query, and renders. The export runs
 * the same query with the same day and filters, so the file and the screen
 * agree.
 */
export default async function ReconPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string; bank?: string; company?: string; account?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams
  const now = new Date()
  const asOfDay = parseAsOf(params.asOf, now)

  const [options, banks] = await Promise.all([getFilterOptions(prisma), listBankCodes(prisma)])
  const bank = banks.includes(params.bank?.trim() ?? '') ? params.bank!.trim() : undefined
  const company = options.companies.find((c) => c.id === params.company?.trim())
  const account = options.cashAccounts.find((a) => a.id === params.account?.trim())
  const filters = { bankCode: bank, companyId: company?.id, cashAccountId: account?.id }

  const [rows, incompleteCount] = await Promise.all([
    listOutstandingCandidates(prisma, filters),
    countExcludedIncomplete(prisma, filters),
  ])
  const summary = summariseByAccount(rows, asOfDay)

  const current = { asOf: asOfDay, bank, company: company?.id, account: account?.id }
  // Two questions: is anything NARROWING the population (the empty state's
  // wording), and is anything set at all (whether RESET is offered). A day
  // alone narrows nothing — the count line says "No filters applied" for it.
  const narrowed = Boolean(bank || company || account)
  const anyFilter = narrowed || Boolean(params.asOf)
  const field = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

  return (
    <main className="space-y-4 px-4 py-5">
      <AppHeader user={user} title="OUTSTANDING CHECKS" back={{ href: '/', label: '← DASHBOARD' }} />

      <p className="rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        Outstanding means released and not yet cleared by the bank as of the date. Where no release date
        was recorded, the check date stands in — so a released check dated after the day is not counted, and
        the line below says how many. Record clearing on the check or on{' '}
        <Link href="/clearing" className="underline underline-offset-2">CLEARING</Link> to move a check off this list.
      </p>

      <FilterForm className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline">
        <label htmlFor="recon-asOf" className="text-[11px] font-semibold tracking-widest text-slate-400">AS OF</label>
        <input id="recon-asOf" name="asOf" type="date" defaultValue={asOfDay} className={field} />
        <label className="sr-only" htmlFor="recon-bank">BANK</label>
        <select id="recon-bank" name="bank" defaultValue={bank ?? ''} className={field}>
          <option value="">ANY BANK</option>
          {banks.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <label className="sr-only" htmlFor="recon-company">COMPANY</label>
        <select id="recon-company" name="company" defaultValue={company?.id ?? ''} className={field}>
          <option value="">ANY COMPANY</option>
          {options.companies.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
        </select>
        {account && <input type="hidden" name="account" value={account.id} />}
        <button type="submit" className="h-10 rounded-lg bg-navy px-4 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90">APPLY</button>
        {anyFilter && <Link href={RECON_PATH} className="text-sm text-slate-500 underline underline-offset-2">RESET</Link>}
      </FilterForm>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-medium tracking-wide text-slate-600">
            {summary.lines.length.toLocaleString('en-PH')} CHECK{summary.lines.length === 1 ? '' : 'S'} OUTSTANDING AS OF {asOfDay}
            {' · '}{describeReconFilters({ bank, company: company?.code, account: account?.code })}
          </p>
          {summary.notYetIssued > 0 && (
            <p className="text-xs font-medium tracking-wide text-slate-500">
              NOT COUNTED: {summary.notYetIssued.toLocaleString('en-PH')} RELEASED CHECK{summary.notYetIssued === 1 ? '' : 'S'} DATED AFTER {asOfDay} — not yet presentable on that day.
            </p>
          )}
          {incompleteCount > 0 && (
            <p className="text-xs font-medium tracking-wide text-slate-500">
              EXCLUDES {incompleteCount.toLocaleString('en-PH')} RELEASED CHECK{incompleteCount === 1 ? '' : 'S'} WITH NO RECORDED AMOUNT.{' '}
              <Link href="/?incomplete=1" className="underline underline-offset-2">Show them</Link>.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-slate-500">The file holds this view, as of this day, with these filters.</span>
          <a href={reconHref(current, RECON_EXPORT_PATH)} className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90">EXPORT EXCEL</a>
        </div>
      </div>

      {summary.lines.length === 0 ? (
        <EmptyState title="NOTHING OUTSTANDING" tone={narrowed ? 'plain' : 'good'}>
          {narrowed ? 'No released check under these filters was uncleared on that day.' : `No released check was uncleared as of ${asOfDay}.`}
        </EmptyState>
      ) : (
        <>
          <ReconTable summary={summary} params={current} />
          {account && (
            <>
              <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">{account.code} — THE CHECKS</h2>
              <OutstandingList lines={summary.lines} />
            </>
          )}
        </>
      )}
    </main>
  )
}
