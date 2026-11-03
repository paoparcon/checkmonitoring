// app/numbering/page.tsx
import { FilterForm } from '@/components/FilterForm'
import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getFilterOptions } from '@/lib/queries'
import { listNumberingAccounts, countChequesWithoutCheckBook, countRegisterOnlyCheques, listCheckBookOptions } from '@/lib/numbering/query'
import {
  NUMBERING_PATH, NUMBERING_EXPORT_PATH, NUMBERING_SCOPE_NOTE,
  numberingHref, isMissingOnly, visibleEntries, describeNumberingFilters, registerOnlyLine, noBookLine, unbookedShown,
  numberingTotals, totalChecksLine,
} from '@/lib/numbering-view'
import { AppHeader } from '@/components/AppHeader'
import { EmptyState } from '@/components/EmptyState'
import { NumberingSummaryTable, NumberingEntriesTable, NotNumericTable, OutOfPatternTable } from '@/components/NumberingTables'
import { InventoryForm } from '@/components/InventoryForm'

/**
 * CHEQUE NUMBERING — consecutives per cheque book (spec
 * 2026-10-01-cheque-numbering-and-cancel-guard-design §B3), and since §H
 * (2026-11-03) the check INVENTORY: every cheque of every status in number
 * order, each MISSING number on its own line with Finance's tick box and
 * remarks (a run of more than INVENTORY_LIST_MAX numbers as one line with one
 * note), so the status of a check Acumatica does not hold is recorded here.
 * Everything shown is decided in `lib/numbering/`; the export reads the same
 * parameters, so the file and the screen agree.
 */
export default async function NumberingPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; account?: string; missing?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams
  const [options, books] = await Promise.all([getFilterOptions(prisma), listCheckBookOptions(prisma)])
  const company = options.companies.find((c) => c.id === params.company?.trim())
  const accountParam = params.account?.trim() || undefined
  const account = books.find((b) => b.id === accountParam)
  const missingOnly = isMissingOnly(params.missing)
  const fmtBig = (s: string) => (s.length <= 15 ? Number(s).toLocaleString('en-PH') : s)
  const field = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

  if (accountParam && !account) {
    return (
      <main className="space-y-4 px-4 py-5">
        <AppHeader user={user} title="CHECK NUMBERING" back={{ href: NUMBERING_PATH, label: '← ALL CHECK BOOKS' }} />
        <EmptyState title="NO SUCH CHECK BOOK">That check book is not on record. Choose one from the list.</EmptyState>
      </main>
    )
  }

  // With an account open the company filter is not applied, so it must not be described or counted either.
  const scopedCompany = account ? undefined : company
  const [accounts, noAccountCount, registerOnlyCount] = await Promise.all([
    listNumberingAccounts(prisma, { companyId: scopedCompany?.id, checkBookId: account?.id }),
    account ? Promise.resolve(0) : countChequesWithoutCheckBook(prisma, { companyId: scopedCompany?.id }),
    account ? Promise.resolve(0) : countRegisterOnlyCheques(prisma, { companyId: scopedCompany?.id }),
  ])
  const current = { company: company?.id, account: account?.id, missing: missingOnly }
  const one = account ? accounts[0] : undefined

  return (
    <main className="space-y-4 px-4 py-5">
      <AppHeader user={user} title="CHECK NUMBERING" back={{ href: '/', label: '← DASHBOARD' }} />

      <p className="rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        {NUMBERING_SCOPE_NOTE}
      </p>

      {!account && (
        <FilterForm className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline">
          <label className="sr-only" htmlFor="numbering-company">COMPANY</label>
          <select id="numbering-company" name="company" defaultValue={company?.id ?? ''} className={field}>
            <option value="">ANY COMPANY</option>
            {options.companies.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
          </select>
          <button type="submit" className="h-10 rounded-lg bg-navy px-4 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90">APPLY</button>
          {company && <Link href={NUMBERING_PATH} className="text-sm text-slate-500 underline underline-offset-2">RESET</Link>}
        </FilterForm>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-medium tracking-wide text-slate-600">
            {account ? account.code : `${accounts.length.toLocaleString('en-PH')} CHECK BOOK${accounts.length === 1 ? '' : 'S'}`}
            {' · '}{describeNumberingFilters({ company: scopedCompany?.code, account: account?.code, missingOnly })}
          </p>
          {!account && accounts.length > 0 && (
            <p className="text-xs font-semibold tracking-wide text-slate-700">{totalChecksLine(numberingTotals(accounts))}</p>
          )}
          {one && (
            <p className="text-xs font-medium tracking-wide text-slate-500">
              INVENTORY: {one.series.summary.held.toLocaleString('en-PH')} HELD · {fmtBig(one.series.summary.missingNumbers)} MISSING NUMBER{one.series.summary.missingNumbers === '1' ? '' : 'S'} ON {one.inventory.lines.toLocaleString('en-PH')} LINE{one.inventory.lines === 1 ? '' : 'S'}
              {' · '}{fmtBig(one.inventory.ticked)} TICKED · {one.inventory.remarked.toLocaleString('en-PH')} WITH REMARKS
              {one.series.summary.noBook > 0 && (
                <> · {one.series.summary.noBook.toLocaleString('en-PH')} CHECK{one.series.summary.noBook === 1 ? '' : 'S'} WITH NO CHECK BOOK SHOWN WHERE {one.series.summary.noBook === 1 ? 'ITS' : 'THEIR'} NUMBER FALLS (ACUMATICA POSTED THEM ON A CASH ACCOUNT SUCH AS PAYROLL)</>
              )}
              . Every number, held or missing, has a tick box; press SAVE INVENTORY to record your changes.
            </p>
          )}
          {!account && noAccountCount > 0 && (
            <p className="text-xs font-medium tracking-wide text-slate-500">{noBookLine(noAccountCount, unbookedShown(accounts))}</p>
          )}
          {!account && registerOnlyCount > 0 && (
            <p className="text-xs font-medium tracking-wide text-slate-500">{registerOnlyLine(registerOnlyCount)}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {account && (
            <>
              <Link href={numberingHref({ company: company?.id })} className="text-sm text-slate-600 underline underline-offset-2">← ALL CHECK BOOKS</Link>
              <Link href={numberingHref({ ...current, missing: !missingOnly })} className="rounded-lg px-3 py-2 text-sm font-medium tracking-wide text-navy ring-1 ring-hairline">
                {missingOnly ? 'SHOW ALL' : 'MISSING ONLY'}
              </Link>
            </>
          )}
          <a href={numberingHref(current, NUMBERING_EXPORT_PATH)} className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90">EXPORT EXCEL</a>
        </div>
      </div>

      {!account && (accounts.length === 0
        ? <EmptyState title="NO CHECKS IN ANY CHECK BOOK">{company ? 'No check of this company is in any check book.' : 'No check carries a check book yet.'}</EmptyState>
        : <NumberingSummaryTable accounts={accounts} company={company?.id} />)}

      {account && !one && <EmptyState title="NO CHECKS IN THIS CHECK BOOK">No check on record carries this check book.</EmptyState>}

      {one && (() => {
        const entries = visibleEntries(one.lines, missingOnly)
        return (
          <>
            {entries.length === 0 && one.series.summary.first === null && !missingOnly
              ? <EmptyState title="NO NUMERIC CHECKS">Every check in this check book carries a number that is not all digits; they are listed below.</EmptyState>
              : entries.length === 0
              ? <EmptyState title="NOTHING MISSING" tone="good">Every number from {one.series.summary.first ?? '—'} to {one.series.summary.last ?? '—'} is used here — held as a check or staged as a re-use.</EmptyState>
              : <InventoryForm checkBookId={one.accountId}><NumberingEntriesTable lines={entries} checkBookId={one.accountId} /></InventoryForm>}
            {!missingOnly && one.series.notNumeric.length > 0 && (
              <>
                <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">NOT NUMERIC — NOT IN THE SEQUENCE</h2>
                <NotNumericTable cheques={one.series.notNumeric} />
              </>
            )}
            {!missingOnly && one.series.outOfPattern.length > 0 && (
              <>
                <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">OUT OF PATTERN — NOT IN THE SEQUENCE</h2>
                {one.series.pattern && (
                  <p className="text-sm text-slate-600">
                    This check book&apos;s numbers are {one.series.pattern.digits} digits starting {one.series.pattern.lead}; these are not. Usually a mistyped or misfiled number in Acumatica.
                  </p>
                )}
                <OutOfPatternTable entries={one.series.outOfPattern} />
              </>
            )}
          </>
        )
      })()}
    </main>
  )
}
