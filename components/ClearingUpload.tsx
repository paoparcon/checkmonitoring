'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { uploadClearingFileAction, type ClearingUploadResult } from '@/app/clearing/actions'
import type { PreviewVerdict } from '@/lib/clearing-preview'
import { KitTable, type KitRow } from '@/components/table-kit/KitTable'
import { dateValue } from '@/lib/table-kit/match'

const VERDICT: Record<PreviewVerdict, { words: string; tone: string }> = {
  WILL_CLEAR: { words: 'WILL BE CLEARED', tone: 'text-success-ink' },
  ALREADY_CLEARED: { words: 'ALREADY CLEARED', tone: 'text-slate-500' },
  NOT_RELEASED: { words: 'NOT RELEASED', tone: 'text-warning-ink' },
  UNKNOWN: { words: 'UNKNOWN NUMBER', tone: 'text-danger-ink' },
  AMBIGUOUS: { words: 'TWO CHECKS SHARE THIS NUMBER — NOT CLEARED', tone: 'text-danger-ink' },
}

const DATE_FROM = { FILE: 'from the file', BATCH: 'the date above', NONE: 'no date' } as const

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—'

/**
 * Upload a bank file, preview, confirm (`lib/clearing-upload.ts`). The file
 * stays in the browser between the two steps and is sent again with CONFIRM;
 * the server re-reads it and decides again, so this component holds no ids.
 */
export function ClearingUpload() {
  const [pending, startTransition] = useTransition()
  const [file, setFile] = useState<File | null>(null)
  const [day, setDay] = useState('')
  const [result, setResult] = useState<ClearingUploadResult | null>(null)
  const [inputKey, setInputKey] = useState(0)

  const send = (confirm: boolean) => {
    if (!file) return
    const f = new FormData()
    f.append('file', file)
    f.append('clearedDate', day)
    if (confirm) f.append('confirm', 'true')
    startTransition(async () => setResult(await uploadClearingFileAction(f)))
  }
  const reset = () => { setFile(null); setResult(null); setDay(''); setInputKey((k) => k + 1) }

  const field = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'
  const label = 'block text-[11px] font-semibold tracking-widest text-slate-400'
  const plan = result?.ok ? result.plan : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="clearing-file" className={label}>BANK FILE — EXCEL, CSV, TEXT OR PDF</label>
          <input
            key={inputKey} id="clearing-file" type="file" disabled={pending}
            accept=".xlsx,.xlsm,.csv,.txt,.tsv,.pdf"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null) }}
            className="mt-1 block text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-navy-bg file:px-3 file:py-2 file:text-sm file:font-medium file:text-navy"
          />
        </div>
        <div>
          <label htmlFor="clearing-batch-date" className={label}>CLEARED DATE — WHEN A LINE SHOWS NONE</label>
          <input id="clearing-batch-date" type="date" value={day} disabled={pending}
            onChange={(e) => { setDay(e.target.value); setResult(null) }} className={`mt-1 ${field}`} />
        </div>
        <button type="button" disabled={pending || !file} onClick={() => send(false)}
          className="rounded-lg border border-hairline bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy hover:bg-ground disabled:opacity-50">
          {pending ? 'READING…' : 'PREVIEW'}
        </button>
        {result?.ok && result.stage === 'PREVIEW' && (
          <button type="button" disabled={pending || result.plan.willClear === 0} onClick={() => send(true)}
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white hover:bg-navy/90 disabled:opacity-50">
            CONFIRM — MARK {result.plan.willClear} CLEARED
          </button>
        )}
      </div>
      <p className="text-[11px] text-slate-500">
        Every line of the file is read. A number becomes a row only when a check here has that number; the
        rest of the statement&rsquo;s numbers are counted and left alone. Check the ACCOUNT and AMOUNT ON LINE
        columns before confirming. Nothing is written until you confirm.
      </p>

      {result && !result.ok && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
      )}

      {result?.ok && result.stage === 'APPLIED' && (
        <div className="space-y-2 rounded-xl bg-success-bg px-4 py-3 text-sm text-success-ink">
          <p>
            {result.summary.cleared} check{result.summary.cleared === 1 ? '' : 's'} marked CLEARED from {result.plan.fileName}
            {result.summary.failed.length > 0 ? `; ${result.summary.failed.length} refused` : ''}.
          </p>
          {result.summary.notReached > 0 && (
            <p className="text-amber-900">
              {result.summary.notReached} were not reached in time. Upload the same file again to finish them.
            </p>
          )}
          {result.summary.failed.map((f) => <p key={f.checkNumber} className="text-danger-ink">{f.checkNumber}: {f.message}</p>)}
          <button type="button" onClick={reset}
            className="rounded-lg border border-hairline bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy hover:bg-ground">
            UPLOAD ANOTHER FILE
          </button>
        </div>
      )}

      {plan && result?.ok && result.stage === 'PREVIEW' && (
        <>
          <p className="text-sm text-slate-700">
            {plan.fileName}: {plan.lines.toLocaleString('en-PH')} line{plan.lines === 1 ? '' : 's'} read,{' '}
            {plan.rows.length} name a check here, <strong>{plan.willClear} will be cleared</strong>.
            {plan.dateOrder && ` Dates read as ${plan.dateOrder === 'DMY' ? 'DAY/MONTH/YEAR' : 'MONTH/DAY/YEAR'}, as the file writes them.`}
          </p>
          {plan.unmatchedCount > 0 && (
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer">
                {plan.unmatchedCount.toLocaleString('en-PH')} other number{plan.unmatchedCount === 1 ? '' : 's'} on the file name no check here
              </summary>
              <p className="mt-1 font-mono">{plan.unmatchedSample.join('  ')}{plan.unmatchedCount > plan.unmatchedSample.length ? '  …' : ''}</p>
            </details>
          )}
          {plan.rows.length > 0 && (
            <KitTable
              tableId="clearing-upload"
              frameClassName="overflow-x-auto rounded-xl bg-white ring-1 ring-hairline"
              cellClassName="px-3 py-2"
              columns={[
                { key: 'place', label: 'WHERE IN THE FILE', kind: 'text', className: 'whitespace-nowrap text-slate-500' },
                { key: 'check', label: 'CHECK', kind: 'text', locked: true, className: 'tabular-nums whitespace-nowrap' },
                { key: 'payee', label: 'PAYEE', kind: 'text', className: 'text-slate-700' },
                { key: 'account', label: 'ACCOUNT', kind: 'text', className: 'whitespace-nowrap' },
                { key: 'amount', label: 'AMOUNT ON LINE', kind: 'enum', options: [{ value: 'YES', label: 'YES' }, { value: 'NO', label: 'NO' }, { value: '—', label: '—' }] },
                { key: 'date', label: 'CLEARED DATE', kind: 'date', className: 'whitespace-nowrap' },
                { key: 'verdict', label: 'WHAT CONFIRM DOES', kind: 'text', className: 'font-medium' },
                { key: 'line', label: 'THE LINE', kind: 'text', className: 'font-mono text-[11px] text-slate-500', defaultHidden: true },
              ]}
              rows={plan.rows.map((r, i): KitRow => {
                const amount = r.amountSeen === null ? '—' : r.amountSeen ? 'YES' : 'NO'
                return {
                  key: `r${i}`,
                  values: {
                    place: r.place, check: r.checkNumber, payee: r.payeeName, account: r.account, amount,
                    date: dateValue(r.clearedDate), verdict: VERDICT[r.verdict].words, line: r.lineText,
                  },
                  cells: {
                    place: <span title={r.lineText}>{r.place}</span>,
                    check: (
                      <>
                        {r.checkId
                          ? <Link prefetch={false} href={`/checks/${r.checkId}`} className="underline underline-offset-2">{r.checkNumber}</Link>
                          : r.checkNumber}
                        {r.companyCode && <span className="ml-2 text-xs text-slate-500">{r.companyCode}</span>}
                      </>
                    ),
                    payee: r.payeeName ?? '—',
                    account: r.account ?? '—',
                    amount: <span className={amount === 'NO' ? 'font-semibold text-warning-ink' : amount === 'YES' ? 'text-success-ink' : 'text-slate-400'}>{amount}</span>,
                    date: <>{fmtDate(r.clearedDate)} <span className="text-[11px] text-slate-400">{DATE_FROM[r.dateFrom]}</span></>,
                    verdict: <span className={VERDICT[r.verdict].tone}>{VERDICT[r.verdict].words}{r.detail ? ` · ${r.detail}` : ''}</span>,
                    line: r.lineText,
                  },
                }
              })}
            />
          )}
        </>
      )}
    </div>
  )
}
