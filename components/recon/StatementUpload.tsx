'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { uploadStatementAction, type StatementUploadResult } from '@/app/recon/actions'
import { LINE_KIND_LABEL } from '@/lib/recon/monthly/labels'
import { formatMoney } from '@/lib/money'
import { BUTTON, BUTTON_QUIET, LABEL } from './ReconForm'

/**
 * UPLOAD THE BANK STATEMENT, preview, confirm. The file stays in the browser
 * between the two steps and is sent again with CONFIRM; the server re-reads
 * and re-matches it, so nothing here decides what is written.
 */
export function StatementUpload({ periodId, currency }: { periodId: string; currency: string }) {
  const [pending, start] = useTransition()
  const [file, setFile] = useState<File | null>(null)
  const [setBalances, setSetBalances] = useState(true)
  const [result, setResult] = useState<StatementUploadResult | null>(null)
  const [inputKey, setInputKey] = useState(0)
  const router = useRouter()

  const send = (confirm: boolean) => {
    if (!file) return
    const f = new FormData()
    f.append('file', file)
    f.append('periodId', periodId)
    f.append('setBalances', String(setBalances))
    if (confirm) f.append('confirm', 'true')
    start(async () => {
      const r = await uploadStatementAction(f)
      setResult(r)
      if (r.ok && r.stage === 'APPLIED') router.refresh()
    })
  }
  const plan = result?.ok ? result.plan : null
  const money = (v: string | null) => (v === null ? '' : formatMoney(v, currency))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="stmt-file" className={LABEL}>BANK STATEMENT — EXCEL (.XLSX) OR CSV</label>
          <input
            key={inputKey} id="stmt-file" type="file" accept=".xlsx,.xlsm,.csv,.txt,.tsv" disabled={pending}
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null) }}
            className="mt-1 block text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-navy-bg file:px-3 file:py-2 file:text-sm file:font-medium file:text-navy"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={setBalances} onChange={(e) => setSetBalances(e.target.checked)} />
          Take the statement&rsquo;s beginning and ending balances from the file
        </label>
        <button type="button" disabled={!file || pending} onClick={() => send(false)} className={BUTTON}>{pending ? 'READING…' : 'PREVIEW'}</button>
      </div>
      <p className="text-xs text-slate-500">
        A header row with DATE and DEBIT/CREDIT (or one signed AMOUNT) is found by its words; DESCRIPTION, CHECK NO., REFERENCE and BALANCE are read when present.
        Lines dated outside this month are listed and left out. A line already uploaded to this account — this month or another — is never added twice.
      </p>

      {result && !result.ok && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>}

      {plan && (
        <div className="space-y-3">
          <p className="text-sm text-slate-700">
            <strong>{plan.newLines}</strong> new line(s) · <strong>{plan.autoChecks}</strong> check(s) matched automatically ·{' '}
            <strong>{plan.autoEntries}</strong> book entr{plan.autoEntries === 1 ? 'y' : 'ies'} matched · {plan.duplicates} already uploaded ·{' '}
            {plan.parsed.skipped.length} row(s) left out
            {plan.parsed.statementEnding && <> · statement ending balance <strong>{money(plan.parsed.statementEnding)}</strong></>}
            {plan.parsed.statementBeginning && <> · beginning <strong>{money(plan.parsed.statementBeginning)}</strong></>}
          </p>
          {plan.parsed.sheetsSkipped.length > 0 && <p className="text-xs text-slate-500">Sheets with no statement header, skipped: {plan.parsed.sheetsSkipped.join(', ')}.</p>}
          <div className="max-h-[50vh] overflow-auto rounded-xl ring-1 ring-hairline">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-[11px] tracking-widest text-slate-500">
                <tr><th className="px-3 py-2">DATE</th><th className="px-3 py-2">DESCRIPTION</th><th className="px-3 py-2 text-right">DEBIT</th><th className="px-3 py-2 text-right">CREDIT</th><th className="px-3 py-2">WILL BE</th><th className="px-3 py-2">WHY</th></tr>
              </thead>
              <tbody>
                {plan.lines.map((l) => (
                  <tr key={l.fingerprint} className={`border-t border-hairline ${l.duplicate ? 'text-slate-400' : ''}`}>
                    <td className="px-3 py-1.5 tabular-nums">{l.lineDay}</td>
                    <td className="px-3 py-1.5">{l.description}{l.checkNumber && <span className="ml-1 text-slate-500">#{l.checkNumber}</span>}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(l.debit)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(l.credit)}</td>
                    <td className="px-3 py-1.5 font-medium">{l.duplicate ? 'ALREADY UPLOADED' : `${LINE_KIND_LABEL[l.proposal.kind]}${l.proposal.method ? ' · AUTO' : ''}`}</td>
                    <td className="px-3 py-1.5 text-xs text-slate-600">{l.proposal.note}{l.checkLabel && <span className="block text-slate-500">{l.checkLabel}{l.proposal.payeeOnLine ? ' · payee on line' : ''}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.parsed.skipped.length > 0 && (
            <details className="text-xs text-slate-600">
              <summary className="cursor-pointer">Rows left out ({plan.parsed.skipped.length})</summary>
              <ul className="mt-1 list-disc pl-5">{plan.parsed.skipped.slice(0, 200).map((s) => <li key={s.place}>{s.place}: {s.reason}</li>)}</ul>
            </details>
          )}
          {result?.ok && result.stage === 'PREVIEW' && plan.newLines > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" disabled={pending} onClick={() => send(true)} className={BUTTON}>{pending ? 'APPLYING…' : `CONFIRM — ADD ${plan.newLines} LINE(S)`}</button>
              <span className="text-xs text-slate-500">Matched checks are marked CLEARED on the line&rsquo;s date. A clearing cannot be undone.</span>
            </div>
          )}
          {result?.ok && result.stage === 'APPLIED' && (
            <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
              Added {result.applied.inserted} line(s); {result.applied.checksCleared} check(s) marked CLEARED, {result.applied.checksLinked} linked.
              {result.applied.balancesSet && ' Statement balances taken from the file.'}
              {result.applied.notReached > 0 && ` ${result.applied.notReached} not reached in time — upload the same file again to finish.`}
              {result.applied.refused.length > 0 && <ul className="mt-1 list-disc pl-5 text-amber-900">{result.applied.refused.map((r) => <li key={r.place}>{r.place}: {r.message}</li>)}</ul>}
              <button type="button" className={`${BUTTON_QUIET} ml-3`} onClick={() => { setFile(null); setResult(null); setInputKey((k) => k + 1) }}>DONE</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
