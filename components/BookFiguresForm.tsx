'use client'

import { useState, useTransition } from 'react'
import { saveBookFiguresAction, type BookFiguresResult } from '@/app/recon/bank/actions'

export type BookFigureRow = {
  accountId: string
  label: string
  currency: string
  bookBalance: string | null
  depositsInTransit: string | null
  note: string | null
}

/**
 * The typed side of the reconciliation: the BOOK balance per the ledger and
 * the deposits in transit per account, for the day on the page (the bank
 * balance comes from the Cash workbook). One SAVE for the table; the server
 * writes only the rows that changed and answers per row. A blank box means
 * "not known" — it is never read as zero.
 */
export function BookFiguresForm({ asOfDay, rows }: { asOfDay: string; rows: BookFigureRow[] }) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<BookFiguresResult | null>(null)
  const field = 'h-9 w-full rounded-lg border border-hairline bg-white px-2 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'
  const head = 'px-3 py-2 text-left text-[11px] font-semibold tracking-widest text-slate-400'

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        // Not `action=`: React resets an uncontrolled form after an action, wiping what was typed on a refused row.
        e.preventDefault()
        const formData = new FormData(e.currentTarget)
        startTransition(async () => setResult(await saveBookFiguresAction(formData)))
      }}
    >
      <input type="hidden" name="asOf" value={asOfDay} />
      <div className="overflow-x-auto rounded-xl ring-1 ring-hairline">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-hairline">
            <tr>
              <th className={head}>ACCOUNT</th>
              <th className={head}>BOOK BALANCE (PHP)</th>
              <th className={head}>DEPOSITS IN TRANSIT (PHP)</th>
              <th className={head}>NOTE</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.accountId} className="border-b border-hairline last:border-0">
                <td className="px-3 py-2 font-medium text-slate-800">
                  <input type="hidden" name="account" value={r.accountId} />
                  {r.label}
                  {r.currency !== 'PHP' && <span className="ml-2 text-[11px] text-slate-500">{r.currency} account — type the peso equivalent</span>}
                </td>
                <td className="px-3 py-2">
                  <input name={`book.${r.accountId}`} defaultValue={r.bookBalance ?? ''} inputMode="decimal" autoComplete="off"
                    aria-label={`Book balance, ${r.label}`} placeholder="not typed" className={`${field} text-right tabular-nums`} />
                </td>
                <td className="px-3 py-2">
                  <input name={`dit.${r.accountId}`} defaultValue={r.depositsInTransit ?? ''} inputMode="decimal" autoComplete="off"
                    aria-label={`Deposits in transit, ${r.label}`} placeholder="none" className={`${field} text-right tabular-nums`} />
                </td>
                <td className="px-3 py-2">
                  <input name={`note.${r.accountId}`} defaultValue={r.note ?? ''} maxLength={500} autoComplete="off"
                    aria-label={`Note, ${r.label}`} className={field} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending}
          className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90 disabled:opacity-50">
          {pending ? 'SAVING…' : 'SAVE BOOK BALANCES'}
        </button>
        <span className="text-[11px] text-slate-500">For {asOfDay}. A blank box is "not known", never zero. Only rows you changed are written.</span>
      </div>
      {result && !result.ok && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>}
      {result?.ok && (
        <div className="space-y-1 rounded-lg bg-success-bg px-4 py-3 text-sm text-success-ink">
          <p>{result.saved} account{result.saved === 1 ? '' : 's'} saved; {result.unchanged} unchanged.</p>
          {result.refused.map((f) => <p key={f.account} className="text-danger-ink">{f.account}: {f.message}</p>)}
        </div>
      )}
    </form>
  )
}
