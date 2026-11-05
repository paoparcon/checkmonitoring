'use client'

import { useState, useTransition } from 'react'
import { uploadReadyListAction, type ReadyUploadResult } from '@/app/admin/actions'
import { formatMoney } from '@/lib/money'
import { amountToCentavos, formatAmount } from '@/lib/transmittal'
import type { LeftAlone, OffListCheck, ReadyUploadPlan, UploadMode } from '@/lib/admin/ready-upload'

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
 *
 * Several files may be chosen at once and are read as one list (2026-11-05).
 * REPLACE adds the off-list section: every READY check the list does not
 * name, each needing KEEP READY or REVERT TO SIGNED before CONFIRM enables.
 */

type Decision = 'KEEP' | 'REVERT'

/** Centavos as the decimal string `formatAmount` reads. */
function centavosString(c: bigint): string {
  const neg = c < BigInt(0)
  const a = neg ? -c : c
  const hundred = BigInt(100)
  return `${neg ? '-' : ''}${a / hundred}.${(a % hundred).toString().padStart(2, '0')}`
}

const n = (v: number) => v.toLocaleString('en-PH')
const ROWS_SHOWN = 300

const LEFT_ALONE_LABEL: Readonly<Record<LeftAlone['kind'], string>> = {
  ALREADY_READY: 'ALREADY READY — nothing to do',
  RELEASED: 'ALREADY RELEASED — left alone',
  NO_CHECK: 'NO CHECK FOUND',
  ONLY_CANCELLED_OR_VOIDED: 'CANCELLED OR VOIDED',
  AMBIGUOUS: 'MORE THAN ONE LIVE CHECK',
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
            {s.read ? `${n(s.rows)} row(s)${s.keyedBy === 'BILL' ? ', by AP bill' : ''}` : `skipped (${s.reason})`}
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

function OffListSection({
  offList, decisions, setDecision, setAll, reason, setReason, locked,
}: {
  offList: readonly OffListCheck[]
  decisions: Readonly<Record<string, Decision>>
  setDecision: (id: string, d: Decision) => void
  setAll: (d: Decision) => void
  reason: string
  setReason: (v: string) => void
  locked: boolean
}) {
  const reverting = offList.filter((c) => decisions[c.id] === 'REVERT').length
  const keeping = offList.filter((c) => decisions[c.id] === 'KEEP').length
  const undecided = offList.length - reverting - keeping
  // Centavo-exact, PHP only (rule 8: amounts are decimal strings, never JS numbers).
  let centavos = BigInt(0)
  for (const c of offList) {
    const v = c.currency === 'PHP' && c.amount ? amountToCentavos(c.amount) : null
    if (v !== null) centavos += v
  }
  return (
    <section className="rounded-2xl bg-white ring-1 ring-warning-ink/30">
      <div className="space-y-3 px-6 py-4">
        <h2 className="text-sm font-semibold tracking-wide text-warning-ink">
          {n(offList.length)} · READY FOR RELEASE NOW, NOT ON THIS LIST · ₱{formatAmount(centavosString(centavos))}
        </h2>
        <p className="text-sm text-slate-600">
          These checks are available to the supplier today and no row of the uploaded list names them, by check
          number or by AP bill. Decide each one. <span className="font-medium">KEEP READY</span> leaves it as it is.
          {' '}<span className="font-medium">REVERT TO SIGNED</span> takes it off the release list and tells the Supplier
          Portal it is no longer available.
        </p>
        {!locked && (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => setAll('KEEP')}
              className="rounded-lg bg-navy-bg px-3 py-1.5 text-xs font-medium tracking-wide text-navy hover:bg-navy-bg/70">
              SET ALL TO KEEP READY
            </button>
            <button type="button" onClick={() => setAll('REVERT')}
              className="rounded-lg bg-warning-bg px-3 py-1.5 text-xs font-medium tracking-wide text-warning-ink hover:bg-warning-bg/70">
              SET ALL TO REVERT TO SIGNED
            </button>
            <span className="text-xs font-semibold tracking-wide text-slate-600">
              {n(keeping)} KEEP · {n(reverting)} REVERT{undecided > 0 ? ` · ${n(undecided)} NOT DECIDED` : ''}
            </span>
          </div>
        )}
        {!locked && reverting > 0 && (
          <div>
            <label htmlFor="revert-reason" className="block text-xs font-medium tracking-wide text-slate-600">REASON FOR REVERTING (ON EACH CHECK&apos;S RECORD)</label>
            <input id="revert-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </div>
        )}
      </div>
      <div className="overflow-x-auto border-t border-slate-100">
        <table className="w-full text-sm">
          <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
            <tr>
              <th className={TH}>DECISION</th>
              <th className={TH}>CHECK NUMBER</th>
              <th className={TH}>COMPANY</th>
              <th className={TH}>PAYEE</th>
              <th className={`${TH} text-right`}>AMOUNT</th>
              <th className={TH}>STATUS</th>
              <th className={TH}>PICKUP DATE</th>
              <th className={TH}>MADE READY FROM</th>
            </tr>
          </thead>
          <tbody>
            {offList.map((c) => {
              const d = decisions[c.id]
              return (
                <tr key={c.id} className={`border-b border-slate-50 ${d === 'REVERT' ? 'bg-warning-bg/40' : ''}`}>
                  <td className={TD}>
                    {locked
                      ? <span className="text-xs font-semibold">{d === 'REVERT' ? 'REVERT TO SIGNED' : d === 'KEEP' ? 'KEEP READY' : '—'}</span>
                      : (
                        <div className="flex gap-3 whitespace-nowrap text-xs font-medium">
                          <label className="flex items-center gap-1">
                            <input type="radio" name={`decide-${c.id}`} checked={d === 'KEEP'} onChange={() => setDecision(c.id, 'KEEP')} />
                            KEEP READY
                          </label>
                          <label className="flex items-center gap-1 text-warning-ink">
                            <input type="radio" name={`decide-${c.id}`} checked={d === 'REVERT'} onChange={() => setDecision(c.id, 'REVERT')} />
                            REVERT TO SIGNED
                          </label>
                        </div>
                      )}
                  </td>
                  <td className={`${TD} font-mono`}><a href={`/checks/${c.id}`} target="_blank" rel="noreferrer" className="underline decoration-slate-300">{c.checkNumber}</a></td>
                  <td className={TD}>{c.companyCode}</td>
                  <td className={TD}>{c.payeeName ?? '—'}</td>
                  <td className={`${TD} text-right tabular-nums`}>{c.amount ? formatMoney(c.amount, c.currency) : '—'}</td>
                  <td className={TD}>{c.status.replace(/_/g, ' ')}</td>
                  <td className={`${TD} tabular-nums`}>{c.pickupDate ?? '—'}</td>
                  <td className={`${TD} text-slate-600`}>
                    {c.readySource ?? (c.readyAt ? `readied ${c.readyAt.slice(0, 10)}` : 'an earlier list or catch-up')}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function ReadyListUploadForm({ defaultPickupDate }: { defaultPickupDate: string }) {
  const [files, setFiles] = useState<File[]>([])
  const [pickupDate, setPickupDate] = useState(defaultPickupDate)
  const [mode, setMode] = useState<UploadMode>('ADD')
  const [result, setResult] = useState<ReadyUploadResult | null>(null)
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [reason, setReason] = useState('')
  const [pending, startTransition] = useTransition()

  const submit = (confirm: boolean) => {
    if (files.length === 0) return
    const formData = new FormData()
    for (const f of files) formData.append('list', f)
    formData.append('availablePickupDate', pickupDate)
    formData.append('mode', mode)
    if (confirm) {
      formData.append('confirm', 'true')
      for (const [id, d] of Object.entries(decisions)) formData.append(d === 'REVERT' ? 'revert' : 'keep', id)
      formData.append('revertReason', reason)
    }
    startTransition(async () => {
      const r = await uploadReadyListAction(formData)
      setResult(r)
      if (!confirm && r.ok) {
        // A fresh preview: no decision carries over from the last one.
        setDecisions({})
        setReason(`Not on the replacement release list (${r.fileName}).`)
      }
    })
  }
  const clear = () => { setResult(null); setDecisions({}) }

  const previewed = result?.ok === true && result.stage === 'PREVIEW'
  const applied = result?.ok === true && result.stage === 'APPLIED'
  const offList = result?.ok ? result.plan.offList : []
  const reverting = offList.filter((c) => decisions[c.id] === 'REVERT').length
  const undecided = offList.filter((c) => decisions[c.id] === undefined).length
  const nothingToDo = previewed && result.plan.toReady.length === 0 && offList.length === 0
  const confirmBlocked = undecided > 0 || (reverting > 0 && reason.trim() === '')

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-2xl bg-white p-6 ring-1 ring-hairline">
        <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">UPLOAD THE LIST</h2>
        <p className="text-sm text-slate-600">
          An .xlsx with an <span className="font-medium">AP BILL</span> column (headed AP BILL / BILL /
          VOUCHER / REFERENCE NBR.), the header within the first five rows — Acumatica&apos;s AP bill
          export as it comes. A <span className="font-medium">CHECK NUMBER</span> column (CHECK NUMBER /
          CHECK NO) beside it is optional: with one, the number finds the check and the bill must be on
          it; without one, the bill finds the one live check that pays it. Every sheet with an AP BILL
          column is read; any other sheet is skipped and named.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[16rem] flex-1">
            <label className="block text-xs font-medium tracking-wide text-slate-600">LIST (.XLSX) — ONE OR SEVERAL FILES</label>
            <input
              type="file"
              accept=".xlsx"
              multiple
              className="mt-1 block w-full text-sm text-slate-600 file:mr-4 file:rounded-lg file:border-0 file:bg-navy-bg file:px-4 file:py-2 file:text-sm file:font-medium file:tracking-wide file:text-navy hover:file:bg-navy-bg/70"
              onChange={(e) => { setFiles([...(e.currentTarget.files ?? [])]); clear() }}
            />
            {files.length > 1 && (
              <p className="mt-1 text-xs text-slate-500">{files.length} files, read as one list: {files.map((f) => f.name).join(' + ')}</p>
            )}
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
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium tracking-wide text-slate-600">THIS LIST IS</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="mode" className="mt-1" checked={mode === 'ADD'} onChange={() => { setMode('ADD'); clear() }} />
            <span><span className="font-medium">ADDITIONAL</span> — mark these checks ready; every check already ready stays ready.</span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="mode" className="mt-1" checked={mode === 'REPLACE'} onChange={() => { setMode('REPLACE'); clear() }} />
            <span>
              <span className="font-medium">A REPLACEMENT</span> — this is the whole release list. The preview lists every check
              ready now that is not on it, and you decide for each whether it stays ready or reverts to SIGNED (the Supplier
              Portal is told). Choose every file of the list together.
            </span>
          </label>
        </fieldset>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={files.length === 0 || !pickupDate || pending}
            onClick={() => submit(false)}
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90 disabled:opacity-50"
          >
            {pending && !previewed ? 'READING…' : 'PREVIEW'}
          </button>
          {previewed && !nothingToDo && (
            <button
              type="button"
              disabled={pending || confirmBlocked}
              onClick={() => submit(true)}
              // The one control here that writes — and tells the portal — so
              // it is the one that is not navy, and it exists only once a
              // preview has been read.
              className="rounded-lg bg-success-ink px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-success-ink/90 disabled:opacity-50"
            >
              {pending
                ? 'WORKING…'
                : `CONFIRM — MARK ${n(result.plan.toReady.length)} READY FOR RELEASE` +
                  (offList.length > 0 ? ` · REVERT ${n(reverting)} TO SIGNED` : '')}
            </button>
          )}
          {previewed && !nothingToDo && undecided > 0 && (
            <span className="self-center text-xs font-semibold tracking-wide text-warning-ink">
              DECIDE THE {n(undecided)} CHECK{undecided === 1 ? '' : 'S'} NOT ON THE LIST BEFORE CONFIRMING
            </span>
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
                (result.summary.requested > 0 ? `, ${n(result.summary.requested)} sent to the approver as requests (they stay as they are until approved)` : '') +
                (result.summary.signed > 0 ? `, ${n(result.summary.signed)} of them signed first` : '') +
                (result.summary.reverted > 0 ? `. ${n(result.summary.reverted)} check(s) not on the list reverted to SIGNED` : '') +
                (result.summary.revertRequested > 0 ? `, ${n(result.summary.revertRequested)} revert(s) sent to the approver` : '') +
                (result.summary.kept > 0 ? `; ${n(result.summary.kept)} kept READY` : '') +
                (result.summary.readied > 0 || result.summary.reverted > 0 ? '. The Supplier Portal is being told.' : '.')
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

          {offList.length > 0 && (
            <OffListSection
              offList={offList}
              decisions={decisions}
              setDecision={(id, d) => setDecisions((prev) => ({ ...prev, [id]: d }))}
              setAll={(d) => setDecisions(Object.fromEntries(offList.map((c) => [c.id, d])))}
              reason={reason}
              setReason={setReason}
              locked={applied}
            />
          )}
          {result.plan.mode === 'REPLACE' && offList.length === 0 && (
            <p className="rounded-lg bg-success-bg p-4 text-sm text-success-ink">
              REPLACEMENT — every check ready for release now is on this list. Nothing to revert.
            </p>
          )}

          <PlanReport plan={result.plan} applied={applied} />
        </>
      )}
    </div>
  )
}
