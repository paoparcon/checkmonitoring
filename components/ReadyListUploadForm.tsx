'use client'

import { useState, useTransition } from 'react'
import { uploadReadyListAction, type ReadyUploadResult } from '@/app/admin/actions'
import { formatMoney } from '@/lib/money'
import type { LeftAlone, ReadyUploadPlan } from '@/lib/admin/ready-upload'

/**
 * Upload → preview → confirm → READY FOR RELEASE.
 *
 * The same discipline as `ImportWorkbookForm`: the first submission returns
 * the plan, having written nothing; only a second submission carrying
 * `confirm` writes. The file and the pickup date are held HERE and re-sent
 * with the confirmation — the server keeps nothing between the two requests,
 * so a confirmation can never apply to a file other than the one previewed.
 * Changing either control clears the report, for the same reason: a stale
 * plan next to a CONFIRM button is how somebody confirms something they are
 * no longer looking at.
 */

const n = (v: number) => v.toLocaleString('en-PH')
const ROWS_SHOWN = 300

const LEFT_ALONE_LABEL: Readonly<Record<LeftAlone['kind'], string>> = {
  ALREADY_READY: 'ALREADY READY — nothing to do',
  RELEASED: 'ALREADY RELEASED — left alone',
  NO_CHECK: 'NO CHECK WITH THIS NUMBER',
  ONLY_CANCELLED_OR_VOIDED: 'CANCELLED OR VOIDED',
  AMBIGUOUS: 'MORE THAN ONE LIVE CHECK HOLDS THE NUMBER',
  BILL_NOT_ON_CHECK: 'AP BILL IS NOT ON THAT CHECK',
  NOT_PROMOTABLE: 'CANNOT BE MADE READY',
  INVALID_ROW: 'ROW CANNOT BE READ',
}
const LEFT_ALONE_ORDER: readonly LeftAlone['kind'][] = [
  'BILL_NOT_ON_CHECK', 'NO_CHECK', 'AMBIGUOUS', 'NOT_PROMOTABLE', 'INVALID_ROW',
  'ONLY_CANCELLED_OR_VOIDED', 'RELEASED', 'ALREADY_READY',
]

function Figure({ label, value, tone }: { label: string; value: string; tone: 'good' | 'warn' | 'quiet' }) {
  const skin = tone === 'good'
    ? 'bg-success-bg ring-success-ink/20 text-success-ink'
    : tone === 'warn'
      ? 'bg-warning-bg ring-warning-ink/20 text-warning-ink'
      : 'bg-ground ring-hairline text-slate-600'
  return (
    <div className={`rounded-2xl p-6 ring-1 ${skin}`}>
      <p className="text-[11px] font-semibold tracking-widest">{label}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}

const TH = 'px-4 py-3'
const TD = 'px-4 py-2'

function PlanReport({ plan, applied }: { plan: ReadyUploadPlan; applied: boolean }) {
  const signFirst = plan.toReady.filter((t) => t.signFirst).length
  const groups = LEFT_ALONE_ORDER
    .map((kind) => [kind, plan.leftAlone.filter((l) => l.kind === kind)] as const)
    .filter(([, rows]) => rows.length > 0)

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Figure label={applied ? 'CHECKS IN THE PLAN' : 'WILL BE MARKED READY'} value={n(plan.toReady.length)} tone="good" />
        <Figure label="ROWS LEFT ALONE" value={n(plan.leftAlone.length)} tone={plan.leftAlone.length > 0 ? 'warn' : 'quiet'} />
        <Figure label="ROWS READ" value={n(plan.rows)} tone="quiet" />
      </div>

      <p className="text-sm text-slate-600">
        Sheets:{' '}
        {plan.sheets.map((s, i) => (
          <span key={s.sheet}>
            {i > 0 && ' · '}
            <span className="font-medium">{s.sheet}</span>{' '}
            {s.read ? `${n(s.rows)} row(s)` : `skipped (${s.reason})`}
          </span>
        ))}
        {signFirst > 0 && (
          <>. {n(signFirst)} of the checks are SIGNATURE PENDING and will be marked SIGNED first, under your name.</>
        )}
      </p>

      {plan.toReady.length > 0 && (
        <details open={!applied} className="rounded-2xl bg-white ring-1 ring-hairline">
          <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
            {n(plan.toReady.length)} · {applied ? 'IN THE PLAN' : 'WILL BE MARKED READY FOR RELEASE'}
          </summary>
          <div className="overflow-x-auto border-t border-slate-100">
            <table className="w-full text-sm">
              <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
                <tr>
                  <th className={TH}>CHECK NUMBER</th>
                  <th className={TH}>COMPANY</th>
                  <th className={TH}>PAYEE</th>
                  <th className={`${TH} text-right`}>AMOUNT</th>
                  <th className={TH}>STATUS NOW</th>
                  <th className={TH}>AP BILL ON THE LIST</th>
                  <th className={TH}>LIST ROW</th>
                </tr>
              </thead>
              <tbody>
                {plan.toReady.slice(0, ROWS_SHOWN).map(({ check, signFirst, rows }) => (
                  <tr key={check.id} className="border-b border-slate-50">
                    <td className={`${TD} font-mono`}>{check.checkNumber}</td>
                    <td className={TD}>{check.companyCode}</td>
                    <td className={TD}>{check.payeeName ?? '—'}</td>
                    <td className={`${TD} text-right tabular-nums`}>{check.amount ? formatMoney(check.amount, check.currency) : '—'}</td>
                    <td className={TD}>{check.status.replace(/_/g, ' ')}{signFirst ? ' → SIGNED' : ''}</td>
                    <td className={`${TD} font-mono`}>{[...new Set(rows.map((r) => r.voucher))].join(', ')}</td>
                    <td className={`${TD} text-slate-500`}>{rows.map((r) => `${r.sheet} ${r.row}`).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {plan.toReady.length > ROWS_SHOWN && (
              <p className="px-6 py-3 text-sm text-slate-500">
                Showing the first {n(ROWS_SHOWN)} of {n(plan.toReady.length)}.
              </p>
            )}
          </div>
        </details>
      )}

      {groups.map(([kind, rows]) => (
        <details key={kind} className="rounded-2xl bg-white ring-1 ring-hairline">
          <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
            {n(rows.length)} · {LEFT_ALONE_LABEL[kind]}
          </summary>
          <div className="overflow-x-auto border-t border-slate-100">
            <table className="w-full text-sm">
              <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
                <tr>
                  <th className={TH}>SHEET</th>
                  <th className={`${TH} text-right`}>ROW</th>
                  <th className={TH}>CHECK NUMBER AS TYPED</th>
                  <th className={TH}>AP BILL AS TYPED</th>
                  <th className={TH}>STATUS HERE</th>
                  <th className={TH}>WHY</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, ROWS_SHOWN).map((l) => (
                  <tr key={`${l.row.sheet}:${l.row.row}`} className="border-b border-slate-50">
                    <td className={TD}>{l.row.sheet}</td>
                    <td className={`${TD} text-right tabular-nums`}>{l.row.row}</td>
                    <td className={`${TD} font-mono`}>{l.row.rawCheckNumber ?? '—'}</td>
                    <td className={`${TD} font-mono`}>{l.row.rawVoucher ?? '—'}</td>
                    <td className={TD}>
                      {l.status ? l.status.replace(/_/g, ' ') : '—'}
                      {l.acumaticaStatus ? <span className="text-slate-400"> · Acumatica {l.acumaticaStatus}</span> : null}
                    </td>
                    <td className={`${TD} text-slate-600`}>{l.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > ROWS_SHOWN && (
              <p className="px-6 py-3 text-sm text-slate-500">Showing the first {n(ROWS_SHOWN)} of {n(rows.length)}.</p>
            )}
          </div>
        </details>
      ))}
    </div>
  )
}

export function ReadyListUploadForm({ defaultPickupDate }: { defaultPickupDate: string }) {
  const [file, setFile] = useState<File | null>(null)
  const [pickupDate, setPickupDate] = useState(defaultPickupDate)
  const [result, setResult] = useState<ReadyUploadResult | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = (confirm: boolean) => {
    if (!file) return
    const formData = new FormData()
    formData.append('list', file)
    formData.append('availablePickupDate', pickupDate)
    if (confirm) formData.append('confirm', 'true')
    startTransition(async () => setResult(await uploadReadyListAction(formData)))
  }

  const previewed = result?.ok === true && result.stage === 'PREVIEW'
  const applied = result?.ok === true && result.stage === 'APPLIED'
  const nothingToDo = previewed && result.plan.toReady.length === 0

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-2xl bg-white p-6 ring-1 ring-hairline">
        <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">UPLOAD THE LIST</h2>
        <p className="text-sm text-slate-600">
          An .xlsx with a <span className="font-medium">CHECK NUMBER</span> column and an{' '}
          <span className="font-medium">AP BILL</span> column (headed CHECK NUMBER / CHECK NO and AP BILL /
          BILL / VOUCHER / REFERENCE NBR.), the header within the first five rows. Every sheet with both
          columns is read; any other sheet is skipped and named.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[16rem] flex-1">
            <label className="block text-xs font-medium tracking-wide text-slate-600">LIST (.XLSX)</label>
            <input
              type="file"
              accept=".xlsx"
              className="mt-1 block w-full text-sm text-slate-600 file:mr-4 file:rounded-lg file:border-0 file:bg-navy-bg file:px-4 file:py-2 file:text-sm file:font-medium file:tracking-wide file:text-navy hover:file:bg-navy-bg/70"
              onChange={(e) => { setFile(e.currentTarget.files?.[0] ?? null); setResult(null) }}
            />
          </div>
          <div>
            <label className="block text-xs font-medium tracking-wide text-slate-600">AVAILABLE PICKUP DATE</label>
            <input
              name="availablePickupDate"
              type="date"
              required
              value={pickupDate}
              onChange={(e) => { setPickupDate(e.currentTarget.value); setResult(null) }}
              className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            disabled={!file || !pickupDate || pending}
            onClick={() => submit(false)}
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90 disabled:opacity-50"
          >
            {pending && !previewed ? 'READING…' : 'PREVIEW'}
          </button>
          {previewed && !nothingToDo && (
            <button
              type="button"
              disabled={pending}
              onClick={() => submit(true)}
              // The one control here that writes — and tells the portal — so
              // it is the one that is not navy, and it exists only once a
              // preview has been read.
              className="rounded-lg bg-success-ink px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-success-ink/90 disabled:opacity-50"
            >
              {pending ? 'MARKING READY…' : `CONFIRM — MARK ${n(result.plan.toReady.length)} READY FOR RELEASE`}
            </button>
          )}
        </div>
      </section>

      {result && !result.ok && (
        <p className="rounded-lg bg-warning-bg p-4 text-sm text-warning-ink">{result.message}</p>
      )}

      {result?.ok && (
        <>
          <p className={`rounded-lg p-4 text-sm ${applied ? 'bg-success-bg text-success-ink' : 'bg-navy-bg text-navy'}`}>
            {applied
              ? `DONE — ${result.fileName}. ${n(result.summary.readied)} check(s) marked READY FOR RELEASE with pickup ${result.pickupDate}` +
                (result.summary.signed > 0 ? `, ${n(result.summary.signed)} of them signed first` : '') +
                '. The Supplier Portal is being told.'
              : nothingToDo
                ? `PREVIEW ONLY — ${result.fileName}. No row of this list can be marked ready; see why below. Nothing has been written.`
                : `PREVIEW ONLY — ${result.fileName}. Nothing has been written. Read the plan below, then confirm.`}
          </p>

          {applied && (result.summary.failed.length > 0 || result.summary.notReached > 0) && (
            <section className="rounded-2xl bg-warning-bg p-6 ring-1 ring-warning-ink/20">
              <h2 className="text-[11px] font-semibold tracking-widest text-warning-ink">NOT MARKED</h2>
              {result.summary.notReached > 0 && (
                <p className="mt-2 text-sm text-warning-ink">
                  {n(result.summary.notReached)} check(s) were not reached before the time budget ran out.
                  Upload the same file again: the ones already marked read as ALREADY READY and are skipped.
                </p>
              )}
              {result.summary.failed.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm text-warning-ink">
                  {result.summary.failed.map((f) => (
                    <li key={f.checkNumber}><span className="font-mono">{f.checkNumber}</span> — {f.message}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <PlanReport plan={result.plan} applied={applied} />
        </>
      )}
    </div>
  )
}
