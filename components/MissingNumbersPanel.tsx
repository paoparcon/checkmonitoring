import Link from 'next/link'
import { prisma } from '@/lib/db'
import { listNumberingAccounts, listCheckBookOptions } from '@/lib/numbering/query'
import { missingPanel, formatCount, numberingHref } from '@/lib/numbering-view'
import { Panel } from '@/components/Panel'

const TITLE = 'MISSING CHECK NUMBERS'

/**
 * MISSING CHECK NUMBERS on the dashboard's TOTALS screen (admin request
 * 2026-11-05: MISSING was visible only on NUMBERING). A missing number has no
 * check, so it is a count here and not a row on ALL CHECKS; each book links to
 * its own gaps on NUMBERING, where the inventory tick and remark are.
 *
 * It narrows like NUMBERING: a company selects the books that company uses,
 * shown whole; a bank that is a check book shows that book; a bank that is a
 * cash account (PAYROLL…) has no number series. Eligibility does not apply —
 * a series holds every check in the book — and the panel says so.
 *
 * It reads every book's series (about three seconds from far away, less on
 * Vercel beside the database), so the page streams it inside <Suspense>: the
 * cards and TODAY'S RELEASE never wait for it. A failure is stated in the panel
 * and never takes the dashboard down.
 */
export async function MissingNumbersPanel({
  companyId, cashAccountId, eligibility,
}: { companyId?: string; cashAccountId?: string; eligibility?: string }) {
  const open = numberingHref({ company: cashAccountId ? undefined : companyId, account: cashAccountId })
  const aside = <Link href={open} className="text-xs font-medium tracking-wide text-navy underline underline-offset-2">OPEN NUMBERING</Link>

  try {
    if (cashAccountId) {
      const books = await listCheckBookOptions(prisma)
      if (!books.some((b) => b.id === cashAccountId)) {
        return (
          <Panel title={TITLE}>
            <p className="text-sm text-slate-600">The bank chosen is a cash account, not a check book, so it has no number series.</p>
          </Panel>
        )
      }
    }
    const accounts = await listNumberingAccounts(prisma, cashAccountId ? { checkBookId: cashAccountId } : { companyId })
    const p = missingPanel(accounts)

    return (
      <Panel title={TITLE} aside={aside}>
        <p className="text-3xl font-semibold tabular-nums text-slate-900">{formatCount(p.total)}</p>
        <p className="mt-1 text-sm text-slate-600">
          {p.bookCount === 0
            ? 'No check book holds a check in this view.'
            : p.total === '0'
            ? `No gaps in ${p.bookCount} check book${p.bookCount === 1 ? '' : 's'}.`
            : `Numbers no check holds, in ${p.runs.toLocaleString('en-PH')} gap${p.runs === 1 ? '' : 's'} across ${p.books.length} of ${p.bookCount} check book${p.bookCount === 1 ? '' : 's'}.`}
        </p>
        {p.books.length > 0 && (
          <table className="mt-4 w-full max-w-xl text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold tracking-widest text-slate-400">
                <th className="py-1 pr-4 font-semibold">CHECK BOOK</th>
                <th className="py-1 pr-4 text-right font-semibold">MISSING</th>
                <th className="py-1 pr-4 text-right font-semibold">GAPS</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {p.books.map((b) => (
                <tr key={b.accountId} className="border-t border-hairline">
                  <td className="py-1.5 pr-4 font-medium text-slate-800">{b.account}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums">{formatCount(b.missing)}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums text-slate-500">{b.runs.toLocaleString('en-PH')}</td>
                  <td className="py-1.5 text-right">
                    <Link href={b.href} className="text-xs text-navy underline underline-offset-2">SEE GAPS</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
          A number is missing when no check in Acumatica holds it. Numbers held by another book of the same bank or
          posted under PAYROLL are not counted. A check found on paper is posted in Acumatica, and the next sync brings it
          here; an unused or spoiled leaf is ticked with a remark on NUMBERING.
          {eligibility ? ' Not narrowed by PORTAL / INTERNAL: a number series holds every check in its book.' : ''}
        </p>
      </Panel>
    )
  } catch {
    return (
      <Panel title={TITLE} aside={aside}>
        <p className="text-sm text-amber-900">The missing numbers could not be counted just now. NUMBERING shows them.</p>
      </Panel>
    )
  }
}

/** Shown while the panel's count is still being read. */
export function MissingNumbersPanelLoading() {
  return (
    <Panel title={TITLE}>
      <p className="text-sm text-slate-500">Counting the missing numbers…</p>
    </Panel>
  )
}
