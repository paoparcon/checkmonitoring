import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { formatMoney } from '@/lib/money'
import { formatManila } from '@/lib/manila-format'
import { loadPeriodView, loadPeriodHistory } from '@/lib/recon/monthly/query'
import { monthLabel, monthOf, isZero, isApproved, add, neg, STATUS_LABEL, type ReconStatus } from '@/lib/recon/monthly/period'
import { classificationsFor, LINE_KIND_LABEL } from '@/lib/recon/monthly/labels'
import type { CheckItem, ComputeLine } from '@/lib/recon/monthly/compute'
import { MONTHLY_PATH, periodPath, periodExportPath } from '@/lib/recon/monthly/view'
import { AppHeader } from '@/components/AppHeader'
import { Panel } from '@/components/Panel'
import { KitTable, type KitRow } from '@/components/table-kit/KitTable'
import type { KitColumn } from '@/lib/table-kit/types'
import { ReconTabs } from '@/components/recon/ReconTabs'
import { ReconStatusPill } from '@/components/recon/ReconStatusPill'
import { StatementUpload } from '@/components/recon/StatementUpload'
import { ReconForm, FIELD, LABEL, BUTTON, BUTTON_QUIET } from '@/components/recon/ReconForm'
import {
  transitionAction, statementBalancesAction, addBookEntryAction, removeBookEntryAction, addAdjustmentAction,
  removeAdjustmentAction, resolveItemAction, matchCheckAction, matchEntryAction, classifyLineAction, removeUploadAction,
  requestReopenAction, recarryAction,
} from '../../actions'

// A statement upload clears up to 30 s of checks on confirm.
export const maxDuration = 60
export const dynamic = 'force-dynamic'

const ACTION_WORDS: Record<string, string> = {
  recon_period_started: 'Month started from the beginning balance',
  recon_period_carried_forward: 'Month opened, carried forward',
  recon_beginning_recarried: 'Beginning balances re-carried',
  recon_opening_corrected: 'Beginning balance corrected',
  recon_statement_balances_set: 'Statement balances set',
  recon_statement_uploaded: 'Statement uploaded',
  recon_statement_upload_removed: 'Statement file removed',
  recon_line_matched: 'Line matched by hand',
  recon_line_classified: 'Line classified by hand',
  recon_item_resolved: 'Item resolved',
  recon_book_entry_added: 'Book entry added',
  recon_book_entry_removed: 'Book entry removed',
  recon_adjustment_added: 'Adjustment added',
  recon_adjustment_removed: 'Adjustment removed',
  recon_submitted: 'Submitted for review',
  recon_reviewed: 'Reviewed — sent for approval',
  recon_returned: 'Returned to draft',
  recon_approved: 'APPROVED — reconciled and locked',
  recon_closed: 'Month closed',
  recon_reopen_requested: 'Re-open requested',
  recon_reopen_approved: 'Re-open approved',
  recon_reopen_rejected: 'Re-open rejected',
}

export default async function PeriodPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  const { id } = await params
  const view = await loadPeriodView(prisma, id)
  if (!view) notFound()
  const { period, account, computation: c, frozen, liveDrift, carry } = view
  const f = c.figures
  const status = period.status as ReconStatus
  const draft = status === 'DRAFT'
  const isAdmin = user.role === 'FINANCE_ADMIN'
  const month = monthOf(period.periodStart)
  const cur = period.currency
  const m = (v: string | null) => (v === null ? '—' : formatMoney(v, cur))
  const when = (d: Date) => formatManila(d, { dateStyle: 'medium', timeStyle: 'short' })

  const [history, people, pendingReopen, openEntries, files, prev, next] = await Promise.all([
    loadPeriodHistory(prisma, id),
    prisma.user.findMany({ where: { id: { in: [period.submittedById, period.reviewedById, period.approvedById, period.closedById].filter((x): x is string => Boolean(x)) } }, select: { id: true, name: true } }),
    prisma.reconReopenRequest.findFirst({ where: { periodId: id, status: 'PENDING' }, include: { requestedBy: { select: { name: true } } } }),
    draft ? prisma.reconBookEntry.findMany({ where: { accountKey: period.accountKey, matchedLine: null }, orderBy: { entryDate: 'asc' } }) : Promise.resolve([]),
    prisma.reconStatementLine.groupBy({ by: ['sourceFile'], where: { periodId: id }, _count: true }),
    period.previousPeriodId ? prisma.reconPeriod.findUnique({ where: { id: period.previousPeriodId }, select: { id: true, periodStart: true } }) : Promise.resolve(null),
    prisma.reconPeriod.findUnique({ where: { previousPeriodId: id }, select: { id: true, periodStart: true } }),
  ])
  const name = (uid: string | null) => people.find((p) => p.id === uid)?.name ?? '—'
  const otherAdjustments = add(f.bankAdjustments, f.bookAdjustments)
  const noStatement = f.statementEndingBalance === null

  return (
    <main className="space-y-4 px-4 py-5">
      <AppHeader user={user} title={`RECONCILIATION · ${account.code}`} back={{ href: MONTHLY_PATH, label: '← RECONCILIATIONS' }} />
      <ReconTabs />

      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-slate-900">{monthLabel(month)}</h2>
        <ReconStatusPill status={status} />
        <span className="text-sm text-slate-600">{account.code} · {account.bankCode} · {cur} · begins from {period.beginningSource === 'OPENING' ? 'the established beginning balance' : 'the previous month, carried forward'}</span>
        <span className="ml-auto flex items-center gap-3 text-sm">
          {prev && <Link href={periodPath(prev.id)} className="underline underline-offset-2">← {monthLabel(monthOf(prev.periodStart))}</Link>}
          {next && <Link href={periodPath(next.id)} className="underline underline-offset-2">{monthLabel(monthOf(next.periodStart))} →</Link>}
          <a href={periodExportPath(id)} className={`${BUTTON} inline-flex items-center`}>EXPORT REPORT</a>
        </span>
      </div>

      {carry.mismatch && (
        <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-900 ring-1 ring-red-200">
          <strong>BEGINNING BALANCE DISCREPANCY.</strong> {carry.message}
          {draft && !carry.previousReopened && <ReconForm action={recarryAction} hidden={{ periodId: id }} label="RE-CARRY BEGINNING BALANCES" buttonClass={`${BUTTON_QUIET} ml-3`} className="inline" confirm="Replace this month's beginning balances with the ones they were carried from?" />}
        </div>
      )}
      {frozen && (
        <div className="rounded-xl bg-navy-bg px-4 py-3 text-sm text-navy ring-1 ring-navy/30">
          <strong>LOCKED.</strong> Approved by {name(period.approvedById)}{period.approvedAt ? `, ${when(period.approvedAt)}` : ''}. These are the figures as approved; nothing recorded since can change them.
          {liveDrift && (
            <span className="block pt-1 text-danger-ink">
              Recorded since approval (e.g. a back-dated clearing) would now give: adjusted bank {m(liveDrift.adjustedBank)}, adjusted book {m(liveDrift.adjustedBook)}, outstanding checks {m(liveDrift.totalOutstandingChecks)}. Re-open the month to take it in.
            </span>
          )}
        </div>
      )}

      {/* ── the twelve figures ── */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        {([
          ['BEGINNING BANK BALANCE', f.beginningBank],
          ['BEGINNING BOOK BALANCE', f.beginningBook],
          ['TOTAL BANK CREDITS', f.totalBankCredits],
          ['TOTAL BANK DEBITS', f.totalBankDebits],
          ['TOTAL BOOK DEPOSITS', f.totalBookDeposits],
          [`TOTAL CHECKS RELEASED · ${c.counts.checksReleased}`, f.totalChecksReleased],
          [`CLEARED CHECKS · ${c.counts.clearedChecks}`, f.totalClearedChecks],
          [`OUTSTANDING CHECKS · ${c.counts.outstandingChecks}`, f.totalOutstandingChecks],
          ['BANK CHARGES', add(f.bankCharges, f.unidentifiedDebits)],
          ['OTHER ADJUSTMENTS (NET)', otherAdjustments],
          ['ENDING BANK BALANCE', f.endingBank],
          ['ENDING BOOK BALANCE', f.endingBook],
        ] as const).map(([label, value]) => (
          <div key={label} className="rounded-2xl bg-white p-4 ring-1 ring-hairline">
            <p className="text-[11px] font-semibold tracking-widest text-slate-400">{label}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{m(value)}</p>
          </div>
        ))}
      </section>
      {view.otherCurrency > 0 && <p className="text-xs text-slate-500">{view.otherCurrency} released check(s) on this account are in another currency and are not in this {cur} reconciliation.</p>}

      {/* ── the two calculations ── */}
      <section className="grid gap-4 lg:grid-cols-2">
        <Formula title="BANK BALANCE RECONCILIATION" rows={[
          ['Bank statement ending balance', f.endingBank, f.statementEndingBalance === null ? 'computed from the lines — enter the statement balance' : null],
          ['Add: deposits in transit', f.depositsInTransit, `${c.counts.depositsInTransit} deposit(s)`],
          ['Less: outstanding checks', neg(f.totalOutstandingChecks), `${c.counts.outstandingChecks} check(s)`],
          ...(isZero(f.outstandingDisbursements) ? [] : [['Less: outstanding non-check disbursements', neg(f.outstandingDisbursements), null] as const]),
          ['Add / less: other bank adjustments', f.bankAdjustments, null],
        ]} total={['ADJUSTED BANK BALANCE', f.adjustedBank]} m={m} />
        <Formula title="BOOK BALANCE RECONCILIATION" rows={[
          ['Book ending balance (before adjustments)', f.bookBalanceBeforeAdjustments, 'beginning + deposits − checks released − other disbursements'],
          ['Add: bank credits not yet recorded', add(f.bankCreditsUnrecorded, f.unidentifiedCredits), isZero(f.unidentifiedCredits) ? null : `incl. ${m(f.unidentifiedCredits)} unidentified`],
          ['Less: bank charges and other unrecorded debits', neg(add(f.bankCharges, f.unidentifiedDebits)), isZero(f.unidentifiedDebits) ? null : `incl. ${m(f.unidentifiedDebits)} unidentified`],
          ['Add / less: other book adjustments', f.bookAdjustments, null],
        ]} total={['ADJUSTED BOOK BALANCE', f.adjustedBook]} m={m} />
      </section>
      <div className={`rounded-2xl p-4 ring-1 ${noStatement ? 'bg-amber-50 ring-amber-200' : isZero(f.difference) ? 'bg-emerald-50 ring-emerald-200' : 'bg-red-50 ring-red-200'}`}>
        <p className="text-sm font-semibold tracking-wide">
          DIFFERENCE (ADJUSTED BANK − ADJUSTED BOOK): <span className="tabular-nums">{m(f.difference)}</span>
          {noStatement
            ? ' — NO STATEMENT ENDING BALANCE YET: the bank side is computed from the uploaded lines only. Enter or upload the statement before relying on this.'
            : isZero(f.difference) ? ' — RECONCILED: both adjusted balances are equal.' : ' — NOT YET RECONCILED.'}
        </p>
        {c.variance.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
            {c.variance.map((v, i) => <li key={i}>{v.message}</li>)}
          </ul>
        )}
      </div>

      {/* ── workflow ── */}
      <Panel title="REVIEW AND APPROVAL" aside={<span className="text-xs text-slate-500">submitted {name(period.submittedById)} · reviewed {name(period.reviewedById)} · approved {name(period.approvedById)} · closed {name(period.closedById)}{period.reopenCount > 0 ? ` · re-opened ${period.reopenCount}×` : ''}</span>}>
        <div className="flex flex-wrap items-end gap-3 px-6 pb-6">
          {status === 'DRAFT' && <ReconForm action={transitionAction} hidden={{ periodId: id, action: 'SUBMIT' }} label="SUBMIT FOR REVIEW" />}
          {status === 'FOR_REVIEW' && period.submittedById !== user.id && <ReconForm action={transitionAction} hidden={{ periodId: id, action: 'REVIEW' }} label="MARK REVIEWED — SEND FOR APPROVAL" />}
          {status === 'FOR_APPROVAL' && isAdmin && <ReconForm action={transitionAction} hidden={{ periodId: id, action: 'APPROVE' }} label="APPROVE — RECONCILED" confirm="Approve this reconciliation? Its figures are frozen and the month is locked; the next month opens from its ending balances." />}
          {(status === 'FOR_REVIEW' || (status === 'FOR_APPROVAL' && isAdmin)) && (
            <ReconForm action={transitionAction} hidden={{ periodId: id, action: 'RETURN' }} label="RETURN TO DRAFT" buttonClass={BUTTON_QUIET} className="flex items-end gap-2">
              <input name="note" placeholder="Why (required)" required className={`${FIELD} w-64`} />
            </ReconForm>
          )}
          {status === 'RECONCILED' && isAdmin && <ReconForm action={transitionAction} hidden={{ periodId: id, action: 'CLOSE' }} label="CLOSE MONTH" confirm="Close this month?" />}
          {isApproved(status) && isAdmin && !pendingReopen && (
            <ReconForm action={requestReopenAction} hidden={{ periodId: id }} label="REQUEST RE-OPEN" buttonClass={BUTTON_QUIET} className="flex items-end gap-2">
              <input name="reason" placeholder="Why it must be re-opened (required)" required className={`${FIELD} w-80`} />
            </ReconForm>
          )}
          {pendingReopen && <p className="text-sm text-amber-900">Re-open requested by {pendingReopen.requestedBy.name}: “{pendingReopen.reason}”. Another Finance Admin decides it on the <Link href={MONTHLY_PATH} className="underline">dashboard</Link>.</p>}
          {status === 'FOR_REVIEW' && period.submittedById === user.id && <p className="text-sm text-slate-600">Waiting for someone other than you to review it.</p>}
          {status === 'FOR_APPROVAL' && !isAdmin && <p className="text-sm text-slate-600">Waiting for a Finance Admin&rsquo;s approval.</p>}
          <p className="basis-full text-xs text-slate-500">
            {STATUS_LABEL[status]}. The reviewer is not the person who submitted; the approver is a Finance Admin who did neither. A month is approved only when the difference is zero and the month before is approved.
          </p>
        </div>
      </Panel>

      {/* ── statement ── */}
      <Panel title="BANK STATEMENT">
        <div className="space-y-5 px-6 pb-6">
          <div className="flex flex-wrap items-end gap-6 text-sm">
            <span>STATEMENT BEGINNING <strong className="tabular-nums">{m(period.statementBeginningBalance?.toFixed(2) ?? null)}</strong>{f.statementBeginningDifference && !isZero(f.statementBeginningDifference) && <span className="ml-1 text-danger-ink">(differs from carried by {m(f.statementBeginningDifference)})</span>}</span>
            <span>STATEMENT ENDING <strong className="tabular-nums">{m(f.statementEndingBalance)}</strong></span>
            <span>LINES FOOT TO <strong className="tabular-nums">{m(f.computedEndingBank)}</strong>{f.statementFootingDifference && !isZero(f.statementFootingDifference) && <span className="ml-1 text-danger-ink">(off by {m(f.statementFootingDifference)})</span>}</span>
          </div>
          {draft && (
            <ReconForm action={statementBalancesAction} hidden={{ periodId: id }} label="SAVE STATEMENT BALANCES" className="flex flex-wrap items-end gap-3" resetOnSuccess={false}>
              <div><label className={LABEL}>STATEMENT BEGINNING BALANCE (OPTIONAL)</label><input name="statementBeginning" defaultValue={period.statementBeginningBalance?.toFixed(2) ?? ''} className={`${FIELD} mt-1 w-44`} /></div>
              <div><label className={LABEL}>STATEMENT ENDING BALANCE</label><input name="statementEnding" defaultValue={f.statementEndingBalance ?? ''} className={`${FIELD} mt-1 w-44`} /></div>
            </ReconForm>
          )}
          {draft && <StatementUpload periodId={id} currency={cur} />}
          {draft && files.length > 0 && (
            <div className="space-y-2">
              <p className={LABEL}>UPLOADED FILES</p>
              {files.map((x) => (
                <ReconForm key={x.sourceFile} action={removeUploadAction} hidden={{ periodId: id, sourceFile: x.sourceFile }} label="REMOVE FILE'S LINES" buttonClass={BUTTON_QUIET} className="flex flex-wrap items-center gap-2 text-sm" confirm="Remove this file's lines? Lines that cleared a check stay.">
                  <span>{x.sourceFile} · {x._count} line(s)</span>
                  <input name="reason" placeholder="Why (required)" required className={`${FIELD} h-9 w-56`} />
                </ReconForm>
              ))}
            </div>
          )}
        </div>
      </Panel>

      <Panel title={`STATEMENT LINES · ${c.lines.length}`} aside={<span className="text-xs text-slate-500">{c.counts.unidentified} unidentified · a manual match or classification needs a remark</span>}>
        {c.lines.length === 0 ? <p className="px-6 pb-6 text-sm text-slate-600">No statement lines this month.</p> : (
          <div className="overflow-x-auto px-2 pb-4">
            <table className="w-full min-w-[960px] text-sm">
              <thead className="text-left text-[11px] tracking-widest text-slate-500">
                <tr><th className="px-3 py-2">DATE</th><th className="px-3 py-2">DESCRIPTION</th><th className="px-3 py-2 text-right">DEBIT</th><th className="px-3 py-2 text-right">CREDIT</th><th className="px-3 py-2">AS</th><th className="px-3 py-2">REMARKS</th></tr>
              </thead>
              <tbody>
                {c.lines.map((l) => (
                  <tr key={l.id} className="border-t border-hairline align-top">
                    <td className="px-3 py-2 tabular-nums">{l.lineDay}</td>
                    <td className="px-3 py-2">{l.description}{l.checkNumber && <span className="ml-1 text-slate-500">#{l.checkNumber}</span>}{l.reference && <span className="block text-xs text-slate-500">ref. {l.reference}</span>}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.debit ? m(l.debit) : ''}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.credit ? m(l.credit) : ''}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`font-medium ${l.kind.startsWith('UNIDENTIFIED') ? 'text-danger-ink' : ''}`}>{LINE_KIND_LABEL[l.kind]}</span>
                      {l.matchMethod && <span className="ml-1 text-xs text-slate-500">{l.matchMethod}</span>}
                      {l.checkId && <Link href={`/checks/${l.checkId}`} className="block text-xs underline">the check</Link>}
                      {l.resolvedMonth && <span className="block text-xs text-success-ink">resolved {monthLabel(l.resolvedMonth)}</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {l.remarks}{l.resolution && <span className="block">Resolution: {l.resolution}</span>}
                      {draft && l.kind !== 'CHECK' && <LineActions line={l} periodId={id} entries={openEntries.filter((e) => (e.kind === 'DEPOSIT') === Boolean(l.credit)).map((e) => ({ id: e.id, label: `${e.reference} · ${e.entryDate.toISOString().slice(0, 10)} · ${e.amount.toFixed(2)}` }))} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ── book side ── */}
      <Panel title={`BOOK ENTRIES THIS MONTH · ${c.bookEntries.length}`} aside={<span className="text-xs text-slate-500">deposits and non-check disbursements recorded in the books; checks come from the check records</span>}>
        <div className="space-y-4 px-6 pb-6">
          {c.bookEntries.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] tracking-widest text-slate-500"><tr><th className="py-1">DATE</th><th>KIND</th><th>REFERENCE</th><th>DESCRIPTION</th><th className="text-right">AMOUNT</th><th>BANK LINE</th><th></th></tr></thead>
              <tbody>
                {c.bookEntries.map((e) => (
                  <tr key={e.id} className="border-t border-hairline">
                    <td className="py-1.5 tabular-nums">{e.entryDay}{e.entryDay < `${month}-01` && <span className="ml-1 text-xs text-slate-500">(opening item)</span>}</td>
                    <td>{e.kind}</td><td>{e.reference}</td><td className="text-slate-600">{e.description}</td>
                    <td className="text-right tabular-nums">{m(e.amount)}</td>
                    <td className="text-xs">{e.matchedLineDay ?? <span className="text-amber-800">{e.kind === 'DEPOSIT' ? 'IN TRANSIT' : 'OUTSTANDING'}</span>}</td>
                    <td>{draft && !e.matchedLineId && (
                      <ReconForm action={removeBookEntryAction} hidden={{ entryId: e.id }} label="REMOVE" buttonClass={BUTTON_QUIET} className="flex items-center gap-2">
                        <input name="reason" placeholder="Why" required className={`${FIELD} h-9 w-40`} />
                      </ReconForm>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {draft && (
            <ReconForm action={addBookEntryAction} hidden={{ periodId: id }} label="ADD BOOK ENTRY" className="flex flex-wrap items-end gap-3">
              <div><label className={LABEL}>KIND</label><select name="kind" className={`${FIELD} mt-1`}><option value="DEPOSIT">DEPOSIT</option><option value="DISBURSEMENT">DISBURSEMENT (NOT A CHECK)</option></select></div>
              <div><label className={LABEL}>DATE</label><input name="entryDate" type="date" required className={`${FIELD} mt-1`} /></div>
              <div><label className={LABEL}>AMOUNT</label><input name="amount" required inputMode="decimal" className={`${FIELD} mt-1 w-36`} /></div>
              <div><label className={LABEL}>REFERENCE</label><input name="reference" required placeholder="deposit slip / JV no." className={`${FIELD} mt-1 w-44`} /></div>
              <div><label className={LABEL}>DESCRIPTION</label><input name="description" className={`${FIELD} mt-1 w-56`} /></div>
            </ReconForm>
          )}
          {draft && period.beginningSource === 'OPENING' && <p className="text-xs text-slate-500">This is the first month: a deposit or disbursement open at the beginning balance date may be dated before {monthLabel(month)}; it counts as in transit, not as this month&rsquo;s.</p>}
          {c.depositsInTransit.length > 0 && (
            <p className="text-sm text-slate-700">DEPOSITS IN TRANSIT AT {month}-END: {c.depositsInTransit.map((e) => `${e.reference} (${e.entryDay}, ${m(e.amount)})`).join(' · ')}</p>
          )}
        </div>
      </Panel>

      <Panel title="OTHER ADJUSTMENTS AND OPEN ITEMS">
        <div className="space-y-4 px-6 pb-6 text-sm">
          {[...c.bankAdjustments, ...c.bookAdjustments].length === 0 && c.carriedBankErrors.length === 0 && c.carriedUnidentified.length === 0 && <p className="text-slate-600">None.</p>}
          {[...c.bankAdjustments.map((a) => ({ ...a, carried: a.carried })), ...c.bookAdjustments.map((a) => ({ ...a, carried: false }))].map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-3 border-t border-hairline pt-2">
              <span className="font-medium">{a.side} · {a.direction === 'ADD' ? 'ADD' : 'LESS'} {m(a.amount)}</span>
              <span className="text-slate-600">{a.description}{a.reference ? ` · ${a.reference}` : ''}{a.carried ? ` · carried from ${monthLabel(a.month)}` : ''}</span>
              {draft && a.side === 'BANK' && (
                <ReconForm action={resolveItemAction} hidden={{ periodId: id, adjustmentId: a.id }} label="RESOLVED THIS MONTH" buttonClass={BUTTON_QUIET} className="flex items-center gap-2">
                  <input name="resolution" placeholder="How (required)" required className={`${FIELD} h-9 w-52`} />
                </ReconForm>
              )}
              {draft && a.month === month && (
                <ReconForm action={removeAdjustmentAction} hidden={{ adjustmentId: a.id }} label="REMOVE" buttonClass={BUTTON_QUIET} className="flex items-center gap-2">
                  <input name="reason" placeholder="Why" required className={`${FIELD} h-9 w-40`} />
                </ReconForm>
              )}
            </div>
          ))}
          {[...c.carriedBankErrors, ...c.carriedUnidentified].map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-3 border-t border-hairline pt-2">
              <span className="font-medium">{LINE_KIND_LABEL[l.kind]} from {monthLabel(l.month)} · {m(l.debit ?? l.credit)}</span>
              <span className="text-slate-600">{l.lineDay} {l.description}{l.kind === 'BANK_ERROR' ? ' — still reversed out of the bank balance' : ' — counted in its own month; to be explained'}</span>
              {draft && (
                <ReconForm action={resolveItemAction} hidden={{ periodId: id, lineId: l.id }} label="RESOLVED THIS MONTH" buttonClass={BUTTON_QUIET} className="flex items-center gap-2">
                  <input name="resolution" placeholder="How (required)" required className={`${FIELD} h-9 w-52`} />
                </ReconForm>
              )}
            </div>
          ))}
          {draft && (
            <ReconForm action={addAdjustmentAction} hidden={{ periodId: id }} label="ADD ADJUSTMENT" className="flex flex-wrap items-end gap-3 border-t border-hairline pt-3">
              <div><label className={LABEL}>SIDE</label><select name="side" className={`${FIELD} mt-1`}><option value="BANK">BANK (carries until resolved)</option><option value="BOOK">BOOK (this month)</option></select></div>
              <div><label className={LABEL}>ADD / LESS</label><select name="direction" className={`${FIELD} mt-1`}><option value="ADD">ADD</option><option value="LESS">LESS</option></select></div>
              <div><label className={LABEL}>AMOUNT</label><input name="amount" required inputMode="decimal" className={`${FIELD} mt-1 w-36`} /></div>
              <div><label className={LABEL}>DESCRIPTION</label><input name="description" required className={`${FIELD} mt-1 w-64`} /></div>
              <div><label className={LABEL}>REFERENCE</label><input name="reference" className={`${FIELD} mt-1 w-40`} /></div>
            </ReconForm>
          )}
        </div>
      </Panel>

      {/* ── the cheques ── */}
      <Panel title={`OUTSTANDING CHECKS AT ${monthLabel(month)}-END · ${c.counts.outstandingChecks} · ${m(f.totalOutstandingChecks)}`} aside={c.counts.outstandingBeforeOpening > 0 ? <span className="text-xs text-amber-800">{c.counts.outstandingBeforeOpening} released before the beginning balance date</span> : undefined} bodyClassName="p-0">
        <CheckList id="recon-period-oc" items={c.outstanding} m={m} />
      </Panel>
      <Panel title={`CLEARED THIS MONTH · ${c.counts.clearedChecks} · ${m(f.totalClearedChecks)}`} bodyClassName="p-0"><CheckList id="recon-period-cleared" items={c.cleared} m={m} /></Panel>
      <Panel title={`RELEASED THIS MONTH · ${c.counts.checksReleased} · ${m(f.totalChecksReleased)}`} bodyClassName="p-0"><CheckList id="recon-period-released" items={c.released} m={m} /></Panel>

      <Panel title="APPROVAL HISTORY AND AUDIT TRAIL">
        <ol className="space-y-1 px-6 pb-6 text-sm">
          {history.map((h) => (
            <li key={h.id} className="flex flex-wrap gap-x-3">
              <span className="tabular-nums text-slate-500">{when(h.createdAt)}</span>
              <span className="font-medium">{ACTION_WORDS[h.action] ?? h.action}</span>
              <span className="text-slate-600">{h.user?.name ?? 'SYSTEM'}</span>
              {h.remarks && <span className="text-slate-600">— “{h.remarks}”</span>}
            </li>
          ))}
          {history.length === 0 && <li className="text-slate-600">Nothing yet.</li>}
        </ol>
      </Panel>
    </main>
  )
}

function Formula({ title, rows, total, m }: { title: string; rows: readonly (readonly [string, string, string | null])[]; total: readonly [string, string]; m: (v: string) => string }) {
  return (
    <div className="rounded-2xl bg-white p-5 ring-1 ring-hairline">
      <p className="text-[11px] font-semibold tracking-widest text-slate-400">{title}</p>
      <table className="mt-2 w-full text-sm">
        <tbody>
          {rows.map(([label, value, note]) => (
            <tr key={label}><td className="py-1">{label}{note && <span className="block text-xs text-slate-500">{note}</span>}</td><td className="py-1 text-right tabular-nums">{m(value)}</td></tr>
          ))}
          <tr className="border-t-2 border-slate-800 font-semibold"><td className="pt-2">{total[0]}</td><td className="pt-2 text-right tabular-nums">{m(total[1])}</td></tr>
        </tbody>
      </table>
    </div>
  )
}

function CheckList({ id, items, m }: { id: string; items: CheckItem[]; m: (v: string) => string }) {
  if (items.length === 0) return <p className="px-6 pb-6 text-sm text-slate-600">None.</p>
  const columns: KitColumn[] = [
    { key: 'checkNumber', label: 'CHECK NUMBER', kind: 'text', locked: true, className: 'tabular-nums' },
    { key: 'payee', label: 'PAYEE', kind: 'text' },
    { key: 'issued', label: 'RELEASED / DATED', kind: 'date' },
    { key: 'cleared', label: 'CLEARED', kind: 'date' },
    { key: 'days', label: 'DAYS OUT', kind: 'amount', align: 'right' },
    { key: 'amount', label: 'AMOUNT', kind: 'amount', align: 'right', className: 'tabular-nums' },
  ]
  const rows: KitRow[] = items.map((c) => ({
    key: c.id,
    values: { checkNumber: c.checkNumber, payee: c.payee, issued: c.issuedDay, cleared: c.clearedDay, days: c.daysOutstanding === null ? null : String(c.daysOutstanding), amount: c.amount },
    cells: {
      checkNumber: <Link prefetch={false} href={`/checks/${c.id}`} className="underline underline-offset-2">{c.checkNumber}</Link>,
      payee: c.payee ?? '—',
      issued: <>{c.issuedDay ?? '—'}{c.basis === 'CHECK DATE' && <span className="ml-1 text-xs text-slate-500">check date</span>}{c.beforeOpening && <span className="ml-1 text-xs text-amber-800">before beginning</span>}</>,
      cleared: c.clearedDay ?? '—',
      days: c.daysOutstanding ?? '—',
      amount: m(c.amount),
    },
  }))
  return <KitTable tableId={id} columns={columns} rows={rows} />
}

function LineActions({ line, periodId, entries }: { line: ComputeLine; periodId: string; entries: { id: string; label: string }[] }) {
  const kinds = classificationsFor(line.debit ? 'DEBIT' : 'CREDIT')
  return (
    <details className="mt-1">
      <summary className="cursor-pointer font-semibold tracking-wide text-navy">MATCH / CLASSIFY</summary>
      <div className="mt-2 space-y-2">
        {line.debit && (
          <ReconForm action={matchCheckAction} hidden={{ lineId: line.id }} label="MATCH CHECK" buttonClass={BUTTON_QUIET} className="flex flex-wrap items-center gap-2">
            <input name="checkNumber" placeholder="check number" required className={`${FIELD} h-9 w-36`} />
            <input name="remarks" placeholder="remarks (required)" required className={`${FIELD} h-9 w-56`} />
          </ReconForm>
        )}
        {entries.length > 0 && (
          <ReconForm action={matchEntryAction} hidden={{ lineId: line.id }} label="MATCH BOOK ENTRY" buttonClass={BUTTON_QUIET} className="flex flex-wrap items-center gap-2">
            <select name="bookEntryId" className={`${FIELD} h-9`}>{entries.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select>
            <input name="remarks" placeholder="remarks (required)" required className={`${FIELD} h-9 w-56`} />
          </ReconForm>
        )}
        <ReconForm action={classifyLineAction} hidden={{ lineId: line.id }} label="CLASSIFY" buttonClass={BUTTON_QUIET} className="flex flex-wrap items-center gap-2">
          <select name="kind" defaultValue={line.kind} className={`${FIELD} h-9`}>{kinds.map((k) => <option key={k} value={k}>{LINE_KIND_LABEL[k]}</option>)}</select>
          <input name="remarks" placeholder="remarks (required)" required className={`${FIELD} h-9 w-56`} />
        </ReconForm>
      </div>
    </details>
  )
}
