'use client'

import { useState, useTransition } from 'react'
import { uploadCashWorkbookAction, type CashUploadResult } from '@/app/recon/bank/actions'
import { formatMoney } from '@/lib/money'

/**
 * Upload the monthly Cash workbook, preview, confirm
 * (`lib/bank-recon/import.ts`). The file stays in the browser between the two
 * steps and is sent again with CONFIRM; the server reads it again and decides
 * again, so this component holds nothing the server trusts.
 */
export function CashWorkbookUpload() {
  const [pending, startTransition] = useTransition()
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<CashUploadResult | null>(null)
  const [inputKey, setInputKey] = useState(0)

  const send = (confirm: boolean) => {
    if (!file) return
    const f = new FormData()
    f.append('file', file)
    if (confirm) f.append('confirm', 'true')
    startTransition(async () => setResult(await uploadCashWorkbookAction(f)))
  }
  const reset = () => { setFile(null); setResult(null); setInputKey((k) => k + 1) }
  const plan = result?.ok ? result.plan : null
  const toWrite = plan ? plan.created + plan.changed.length : 0
  const disagree = plan ? plan.totals.filter((t) => !t.agrees) : []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="cash-workbook" className="block text-[11px] font-semibold tracking-widest text-slate-400">CASH WORKBOOK — .XLSX WITH A SHEET NAMED CASH</label>
          <input
            key={inputKey} id="cash-workbook" type="file" accept=".xlsx,.xlsm" disabled={pending}
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null) }}
            className="mt-1 block text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-navy-bg file:px-3 file:py-2 file:text-sm file:font-medium file:text-navy"
          />
        </div>
        <button type="button" disabled={pending || !file} onClick={() => send(false)}
          className="rounded-lg border border-hairline bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy hover:bg-ground disabled:opacity-50">
          {pending ? 'READING…' : 'PREVIEW'}
        </button>
        {result?.ok && result.stage === 'PREVIEW' && (
          <button type="button" disabled={pending || toWrite === 0} onClick={() => send(true)}
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white hover:bg-navy/90 disabled:opacity-50">
            CONFIRM — WRITE {toWrite.toLocaleString('en-PH')} BALANCE{toWrite === 1 ? '' : 'S'}
          </button>
        )}
      </div>
      <p className="text-[11px] text-slate-500">
        The newest monthly workbook carries every earlier month, so one file is enough. Only the CASH sheet is read: one line per
        account, one column per month-end, read as the BANK balance in pesos. Nothing is written until you confirm, and the book balances typed above are never touched.
      </p>

      {result && !result.ok && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>}

      {result?.ok && result.stage === 'APPLIED' && (
        <div className="space-y-2 rounded-xl bg-success-bg px-4 py-3 text-sm text-success-ink">
          <p>
            {result.plan.fileName}: {result.summary.created.toLocaleString('en-PH')} balance{result.summary.created === 1 ? '' : 's'} added,{' '}
            {result.summary.updated.toLocaleString('en-PH')} changed, {result.summary.unchanged.toLocaleString('en-PH')} already held
            {result.summary.accountsCreated > 0 ? `; ${result.summary.accountsCreated} new account${result.summary.accountsCreated === 1 ? '' : 's'}` : ''}.
          </p>
          <button type="button" onClick={reset}
            className="rounded-lg border border-hairline bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy hover:bg-ground">
            UPLOAD ANOTHER FILE
          </button>
        </div>
      )}

      {plan && result?.ok && result.stage === 'PREVIEW' && (
        <div className="space-y-3 text-sm text-slate-700">
          <p>
            {plan.fileName} › {plan.sheet}: {plan.accounts} account{plan.accounts === 1 ? '' : 's'} across {plan.days.length} month-end
            {plan.days.length === 1 ? '' : 's'} ({plan.days[plan.days.length - 1]} to {plan.days[0]}).{' '}
            <strong>{plan.created.toLocaleString('en-PH')} new</strong>, <strong>{plan.changed.length.toLocaleString('en-PH')} changed</strong>,{' '}
            {plan.same.toLocaleString('en-PH')} already held unchanged.
          </p>
          {plan.newAccounts.length > 0 && (
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer">{plan.newAccounts.length} account{plan.newAccounts.length === 1 ? '' : 's'} not yet on the schedule here</summary>
              <p className="mt-1">{plan.newAccounts.join(' · ')}</p>
            </details>
          )}
          {plan.createdByDay.length > 0 && (
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer">New balances by month-end</summary>
              <p className="mt-1 tabular-nums">{plan.createdByDay.map((d) => `${d.day}: ${d.count}`).join('  ·  ')}</p>
            </details>
          )}
          {plan.changed.length > 0 && (
            <div className="overflow-x-auto rounded-xl ring-1 ring-amber-200">
              <table className="w-full text-sm">
                <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
                  <tr><th className="px-3 py-2">CHANGED — ACCOUNT</th><th className="px-3 py-2">DAY</th><th className="px-3 py-2">CELL</th><th className="px-3 py-2 text-right">HELD NOW</th><th className="px-3 py-2 text-right">THIS FILE</th></tr>
                </thead>
                <tbody>
                  {plan.changed.map((c) => (
                    <tr key={`${c.key}|${c.day}`} className="border-b border-hairline last:border-0">
                      <td className="px-3 py-2">{c.label}</td>
                      <td className="px-3 py-2 tabular-nums">{c.day}</td>
                      <td className="px-3 py-2 text-slate-500">{c.cell}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatMoney(c.before, 'PHP')}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">{formatMoney(c.after, 'PHP')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {disagree.length > 0 && (
            <div className="rounded-lg bg-amber-50 p-3 text-amber-900">
              <p className="font-medium">The sheet&rsquo;s own TOTAL row does not equal the lines read on {disagree.length} day{disagree.length === 1 ? '' : 's'}:</p>
              {disagree.map((t) => (
                <p key={t.day} className="tabular-nums">{t.day}: sheet total {t.sheetTotal === null ? '—' : formatMoney(t.sheetTotal, 'PHP')}, lines read {formatMoney(t.linesTotal, 'PHP')}</p>
              ))}
            </div>
          )}
          {plan.problems.length > 0 && (
            <div className="rounded-lg bg-amber-50 p-3 text-amber-900">
              <p className="font-medium">Not read:</p>
              {plan.problems.map((p) => <p key={p}>{p}</p>)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
