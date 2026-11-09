import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { manilaDay } from '@/lib/forecast/buckets'
import { formatMoney } from '@/lib/money'
import { listBalanceDays, loadBankRecon } from '@/lib/bank-recon/query'
import { BANK_RECON_PATH, bankReconHref, parseReconDay, dayLabel } from '@/lib/bank-recon-view'
import { reconHref } from '@/lib/recon-view'
import { AppHeader } from '@/components/AppHeader'
import { EmptyState } from '@/components/EmptyState'
import { FilterForm } from '@/components/FilterForm'
import { Panel } from '@/components/Panel'
import { ReconTabs } from '@/components/ReconTabs'
import { BankReconTable } from '@/components/BankReconTable'
import { BookFiguresForm } from '@/components/BookFiguresForm'
import { CashWorkbookUpload } from '@/components/CashWorkbookUpload'

// The workbook upload reads a 2–3 MB file and writes up to ~900 balances in one transaction.
export const maxDuration = 60

/**
 * BANK RECONCILIATION (2026-11-09, user: "we will integrate bank recon i
 * think this is important").
 *
 * For a day, per account of Finance's cash schedule: the BANK balance the
 * monthly Cash workbook states (user ruling the same day: "those are bank
 * balance"), plus the deposits in transit Finance types, less the checks this
 * system holds as released and not yet cleared — the ADJUSTED bank balance,
 * the cash actually available — beside the BOOK balance Finance types, and
 * the difference. Every figure is decided in `lib/bank-recon/`; the page
 * reads the day, runs the queries and renders.
 * The outstanding checks are `/recon`'s, struck by the same rule over the
 * same rows, so the two screens cannot disagree.
 */
export default async function BankReconPage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const user = await requireUser()
  const params = await searchParams
  const today = manilaDay(new Date())
  const days = await listBalanceDays(prisma)
  const asOfDay = parseReconDay(params.asOf, days.map((d) => d.day), today)
  const { recon, silent } = await loadBankRecon(prisma, asOfDay)
  const held = days.find((d) => d.day === asOfDay)
  const field = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'
  const unmatchedCount = recon.unmatched.reduce((n, u) => n + u.count, 0)

  return (
    <main className="space-y-4 px-4 py-5">
      <AppHeader user={user} title="BANK RECONCILIATION" back={{ href: '/', label: '← DASHBOARD' }} />
      <ReconTabs active="BANK" />

      <p className="rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        For each account: the bank balance from Finance&rsquo;s Cash workbook, plus the deposits in transit, less the checks
        released and not yet cleared by the bank, is the <strong>adjusted bank balance</strong> — the cash actually available,
        and what the books should show. Type the book balance beside it and the difference is the variance —{' '}
        <strong>RECONCILED</strong> when it is zero. Outstanding checks are worked out from the checks here for the day chosen;
        record clearing on <Link href="/clearing" className="underline underline-offset-2">CLEARING</Link> and they come off.
        All amounts are in pesos.
      </p>

      <FilterForm className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline">
        <label htmlFor="bank-recon-asOf" className="text-[11px] font-semibold tracking-widest text-slate-400">AS OF</label>
        <input id="bank-recon-asOf" name="asOf" type="date" defaultValue={asOfDay} max={today} className={field} />
        <button type="submit" className="h-10 rounded-lg bg-navy px-4 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90">APPLY</button>
        {params.asOf && <Link href={BANK_RECON_PATH} className="text-sm text-slate-500 underline underline-offset-2">LATEST</Link>}
        {days.length > 0 && (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-2 text-xs text-slate-500">
            <span className="text-[11px] font-semibold tracking-widest text-slate-400">MONTH-ENDS ON FILE</span>
            {days.slice(0, 12).map((d) => (
              d.day === asOfDay
                ? <span key={d.day} className="font-semibold text-navy">{dayLabel(d.day)}</span>
                : <Link key={d.day} prefetch={false} href={bankReconHref(d.day)} className="underline underline-offset-2">{dayLabel(d.day)}</Link>
            ))}
            {days.length > 12 && <span>and {days.length - 12} earlier</span>}
          </span>
        )}
      </FilterForm>

      {days.length === 0 ? (
        <EmptyState title="NO CASH BALANCES YET">
          Upload the monthly Cash workbook below. The newest one carries every earlier month.
        </EmptyState>
      ) : (
        <>
          <div className="space-y-1">
            <p className="text-xs font-medium tracking-wide text-slate-600">
              AS OF {dayLabel(asOfDay).toUpperCase()} · {recon.lines.length} ACCOUNT{recon.lines.length === 1 ? '' : 'S'}
              {held
                ? ` · BANK BALANCE ${formatMoney(held.total, 'PHP')} OVER ${held.accounts} ACCOUNT${held.accounts === 1 ? '' : 'S'} · ADJUSTED ${formatMoney(recon.totals.adjustedBank, 'PHP')}`
                : ' · NO BANK BALANCE IS HELD FOR THIS DAY — the Cash workbook states month-ends only'}
              {recon.totals.bookTyped > 0 && ` · ${recon.totals.reconciled} OF ${recon.totals.bookTyped} WITH A BOOK BALANCE RECONCILED`}
            </p>
            {silent > 0 && (
              <p className="text-xs text-slate-500">
                {silent} other account{silent === 1 ? '' : 's'} of the cash schedule {silent === 1 ? 'has' : 'have'} no figure on this day and no check outstanding — not shown.
              </p>
            )}
            {unmatchedCount > 0 && (
              <p className="text-xs text-slate-500">
                NOT IN ANY ACCOUNT ABOVE: {unmatchedCount.toLocaleString('en-PH')} outstanding check{unmatchedCount === 1 ? '' : 's'} —{' '}
                {recon.unmatched.map((u, i) => (
                  <span key={u.accountId ?? u.account}>
                    {i > 0 && '; '}
                    {u.accountId
                      ? <Link prefetch={false} href={reconHref({ asOf: asOfDay, account: u.accountId })} className="underline underline-offset-2">{u.account}</Link>
                      : u.account}{' '}
                    {u.count.toLocaleString('en-PH')} ({formatMoney(u.total, 'PHP')})
                  </span>
                ))}
                . Their account matches no line of the cash schedule by its last four digits.
              </p>
            )}
            {recon.otherCurrencyChecks > 0 && (
              <p className="text-xs text-slate-500">
                {recon.otherCurrencyChecks.toLocaleString('en-PH')} outstanding check{recon.otherCurrencyChecks === 1 ? ' is' : 's are'} not in pesos and {recon.otherCurrencyChecks === 1 ? 'is' : 'are'} left out of every figure.
              </p>
            )}
          </div>

          {recon.lines.length === 0 ? (
            <EmptyState title="NOTHING ON THIS DAY">
              No account has a balance or an outstanding check as of {dayLabel(asOfDay)}. Pick a month-end above.
            </EmptyState>
          ) : (
            <>
              <BankReconTable recon={recon} asOfDay={asOfDay} />
              <Panel title={`BOOK BALANCE AND DEPOSITS IN TRANSIT — ${dayLabel(asOfDay).toUpperCase()}`}>
                <BookFiguresForm
                  key={asOfDay}
                  asOfDay={asOfDay}
                  rows={recon.lines.map((l) => ({
                    accountId: l.id, label: l.label, currency: l.currency,
                    bookBalance: l.bookBalance, depositsInTransit: l.depositsInTransit, note: l.note,
                  }))}
                />
              </Panel>
            </>
          )}
        </>
      )}

      <Panel title="UPDATE BANK BALANCES FROM THE CASH WORKBOOK">
        <CashWorkbookUpload />
      </Panel>
    </main>
  )
}
