import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { manilaDay } from '@/lib/forecast/buckets'
import { formatMoney } from '@/lib/money'
import { formatManila } from '@/lib/manila-format'
import { listReconAccounts, listDashboard } from '@/lib/recon/monthly/query'
import { parseDashboardFilters, MONTHLY_PATH, BALANCES_PATH, periodPath } from '@/lib/recon/monthly/view'
import { RECON_STATUSES, STATUS_LABEL, monthLabel, isZero } from '@/lib/recon/monthly/period'
import { AppHeader } from '@/components/AppHeader'
import { EmptyState } from '@/components/EmptyState'
import { FilterForm } from '@/components/FilterForm'
import { Panel } from '@/components/Panel'
import { ReconTabs } from '@/components/recon/ReconTabs'
import { ReconStatusPill } from '@/components/recon/ReconStatusPill'
import { ReconForm, BUTTON_QUIET, FIELD } from '@/components/recon/ReconForm'
import { openPeriodAction, decideReopenAction } from '../actions'

/**
 * THE RECONCILIATION DASHBOARD (spec 2026-11-09 §7). With no month or year
 * chosen, each account's CURRENT month — its latest — plus the accounts with a
 * beginning balance and nothing started. Choosing a month, year or status
 * turns it into the HISTORY: every matching month, newest first, each opening
 * its own page with its figures, lists, report and approval history.
 */
export const dynamic = 'force-dynamic'

export default async function MonthlyReconPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser()
  const params = await searchParams
  const accounts = await listReconAccounts(prisma)
  const filters = parseDashboardFilters(params, accounts.map((a) => a.accountKey))
  const today = manilaDay(new Date())
  const [rows, pendingReopens, openings] = await Promise.all([
    listDashboard(prisma, filters, today),
    prisma.reconReopenRequest.findMany({
      where: { status: 'PENDING' }, orderBy: { requestedAt: 'asc' },
      include: { requestedBy: { select: { name: true } }, period: { select: { id: true, accountKey: true, periodStart: true, status: true } } },
    }),
    prisma.reconOpeningBalance.count(),
  ])
  const byKey = new Map(accounts.map((a) => [a.accountKey, a]))
  const current = !filters.year && !filters.month
  const years = Array.from({ length: 6 }, (_, i) => Number(today.slice(0, 4)) - i)
  const m = (v: string | null, currency: string) => (v === null ? '—' : formatMoney(v, currency))
  const th = 'px-3 py-2 text-left text-[11px] font-semibold tracking-widest text-slate-500'
  const td = 'px-3 py-2 align-top'

  return (
    <main className="space-y-4 px-4 py-5">
      <AppHeader user={user} title="BANK RECONCILIATION" back={{ href: '/', label: '← DASHBOARD' }} />
      <ReconTabs />

      <p className="rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        One reconciliation per bank account per month. The first month starts from the account&rsquo;s{' '}
        <Link href={BALANCES_PATH} className="underline underline-offset-2">beginning balance</Link>; each month after starts from the previous
        month&rsquo;s approved ending balances. Outstanding checks and deposits in transit stay open until the bank shows them. A month moves
        DRAFT → FOR REVIEW → FOR APPROVAL → RECONCILED → CLOSED, and is locked once approved.
      </p>

      <FilterForm className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline">
        <label className="sr-only" htmlFor="f-account">BANK ACCOUNT</label>
        <select id="f-account" name="account" defaultValue={filters.accountKey ?? ''} className={FIELD}>
          <option value="">EVERY BANK ACCOUNT</option>
          {accounts.map((a) => <option key={a.accountKey} value={a.accountKey}>{a.code} · {a.bankCode}</option>)}
        </select>
        <label className="sr-only" htmlFor="f-month">MONTH</label>
        <select id="f-month" name="month" defaultValue={filters.month ? String(filters.month) : ''} className={FIELD}>
          <option value="">ANY MONTH</option>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{monthLabel(`2000-${String(n).padStart(2, '0')}`).split(' ')[0]}</option>)}
        </select>
        <label className="sr-only" htmlFor="f-year">YEAR</label>
        <select id="f-year" name="year" defaultValue={filters.year ? String(filters.year) : ''} className={FIELD}>
          <option value="">ANY YEAR</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <label className="sr-only" htmlFor="f-status">STATUS</label>
        <select id="f-status" name="status" defaultValue={filters.status ?? ''} className={FIELD}>
          <option value="">ANY STATUS</option>
          {RECON_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <button type="submit" className="h-10 rounded-lg bg-navy px-4 text-sm font-medium tracking-wide text-white hover:bg-navy/90">APPLY</button>
        {(filters.accountKey || filters.year || filters.month || filters.status) && <Link href={MONTHLY_PATH} className="text-sm text-slate-500 underline underline-offset-2">RESET</Link>}
        <span className="ml-auto text-xs text-slate-500">{current ? 'CURRENT MONTH OF EACH ACCOUNT' : 'HISTORY — EVERY MATCHING MONTH'}</span>
      </FilterForm>

      {pendingReopens.length > 0 && (
        <Panel title="RE-OPEN REQUESTS WAITING FOR APPROVAL" aside={<span className="text-xs text-slate-500">decided by a Finance Admin other than the one who asked</span>}>
          <ul className="space-y-3 px-6 pb-6">
            {pendingReopens.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 text-sm">
                <Link href={periodPath(r.period.id)} className="font-medium underline underline-offset-2">
                  {byKey.get(r.period.accountKey)?.code ?? '?'} · {monthLabel(r.period.periodStart.toISOString().slice(0, 7))}
                </Link>
                <span className="text-slate-600">asked by {r.requestedBy.name}, {formatManila(r.requestedAt, { dateStyle: 'medium', timeStyle: 'short' })}: “{r.reason}”</span>
                {user.role === 'FINANCE_ADMIN' && r.requestedById !== user.id && (
                  <>
                    <ReconForm action={decideReopenAction} hidden={{ requestId: r.id, decision: 'APPROVE' }} label="APPROVE RE-OPEN" buttonClass={BUTTON_QUIET} confirm="Re-open this month? It returns to DRAFT and must be approved again." className="inline-flex" />
                    <ReconForm action={decideReopenAction} hidden={{ requestId: r.id, decision: 'REJECT' }} label="REJECT" buttonClass={BUTTON_QUIET} className="inline-flex items-center gap-2">
                      <input name="note" placeholder="Why rejected (required)" className={`${FIELD} h-9`} />
                    </ReconForm>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {rows.length === 0 ? (
        <EmptyState title={openings === 0 ? 'NO BEGINNING BALANCES YET' : 'NOTHING MATCHES'}>
          {openings === 0
            ? <>Establish a bank account&rsquo;s beginning balance on <Link href={BALANCES_PATH} className="underline underline-offset-2">BEGINNING BALANCES</Link> to start its first reconciliation.</>
            : 'No reconciliation month matches these filters.'}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="border-b border-hairline bg-slate-50">
              <tr>
                <th className={th}>BANK ACCOUNT</th><th className={th}>MONTH</th>
                <th className={`${th} text-right`}>BEGINNING BANK</th><th className={`${th} text-right`}>BEGINNING BOOK</th>
                <th className={`${th} text-right`}>ENDING BANK</th><th className={`${th} text-right`}>ENDING BOOK</th>
                <th className={`${th} text-right`}>OUTSTANDING CHECKS</th><th className={`${th} text-right`}>DEPOSITS IN TRANSIT</th>
                <th className={`${th} text-right`}>UNIDENTIFIED</th><th className={`${th} text-right`}>DIFFERENCE</th>
                <th className={th}>STATUS</th><th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.account.accountKey}:${r.periodId ?? 'none'}`} className="border-t border-hairline">
                  <td className={`${td} font-medium`}>{r.account.code}<span className="block text-xs font-normal text-slate-500">{r.account.bankCode} · {r.account.kind === 'CHECK_BOOK' ? 'check book' : 'cash account'}</span></td>
                  <td className={td}>{r.month ? monthLabel(r.month) : '—'}</td>
                  <td className={`${td} text-right tabular-nums`}>{m(r.beginningBank, r.currency)}</td>
                  <td className={`${td} text-right tabular-nums`}>{m(r.beginningBook, r.currency)}{r.carryMismatch && <span className="block text-xs font-semibold text-danger-ink">CARRY MISMATCH</span>}</td>
                  <td className={`${td} text-right tabular-nums`}>{m(r.endingBank, r.currency)}</td>
                  <td className={`${td} text-right tabular-nums`}>{m(r.endingBook, r.currency)}</td>
                  <td className={`${td} text-right tabular-nums`}>{m(r.totalOutstandingChecks, r.currency)}</td>
                  <td className={`${td} text-right tabular-nums`}>{m(r.totalDepositsInTransit, r.currency)}</td>
                  <td className={`${td} text-right tabular-nums`}>{r.unidentified ?? '—'}</td>
                  <td className={`${td} text-right tabular-nums font-semibold ${r.difference !== null && !isZero(r.difference) ? 'text-danger-ink' : r.noStatement ? 'text-slate-500' : 'text-success-ink'}`}>
                    {m(r.difference, r.currency)}{r.periodId && r.noStatement && <span className="block text-xs font-normal text-amber-800">NO STATEMENT YET</span>}
                  </td>
                  <td className={td}><ReconStatusPill status={r.status} /></td>
                  <td className={`${td} whitespace-nowrap`}>
                    {r.periodId
                      ? <Link href={periodPath(r.periodId)} className={`${BUTTON_QUIET} inline-flex items-center`}>OPEN</Link>
                      : <ReconForm action={openPeriodAction} hidden={{ accountKey: r.account.accountKey }} label={`START ${r.month ? monthLabel(r.month) : ''}`} buttonClass={BUTTON_QUIET} />}
                    {r.canOpenNext && (
                      <ReconForm action={openPeriodAction} hidden={{ accountKey: r.account.accountKey }} label={`OPEN ${monthLabel(r.canOpenNext)}`} buttonClass={`${BUTTON_QUIET} mt-1`} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
