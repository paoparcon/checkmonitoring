import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { formatMoney } from '@/lib/money'
import { AppHeader } from '@/components/AppHeader'
import { StatusPill } from '@/components/StatusPill'
import { CheckProgress } from '@/components/CheckProgress'
import { Panel, Field } from '@/components/Panel'
import { AuditTrail } from '@/components/AuditTrail'
import { ReadyForReleaseForm } from '@/components/ReadyForReleaseForm'
import { ActionForm } from '@/components/ActionForm'
import { DeleteIncompleteCheckForm } from '@/components/DeleteIncompleteCheckForm'
import { DetailsForm } from '@/components/DetailsForm'
import { ClearingForm } from '@/components/ClearingForm'
import { checkDeletable } from '@/lib/domain/incomplete'
import { checkReleaseReversible } from '@/lib/domain/reversal'
import { clearingTargets, isLiveStatus, type ClearingStatus, type CheckStatus } from '@/lib/domain/check-status'
import { RECEIPT_TYPE_LABELS } from '@/lib/domain/receipt'
import { isoDay } from '@/lib/domain/details'
import { loadSettings } from '@/lib/settings/read'
import { signAction, releaseAction, revertAction, reverseReleaseAction, removeReceiptAction, revertSignatureAction, restoreCancelledAction } from '../actions'

/**
 * ONE CHEQUE.
 *
 * The most-used screen after the dashboard, and until 2026-09-10 the one that
 * looked least like it: white cards on white, three primary buttons in three
 * unrelated hues, and the audit trail — the part a reader actually comes here
 * for — rendered as a four-column table of em dashes.
 *
 * It is now the dashboard's own vocabulary: the tinted ground, `Panel` cards
 * with hairline rings, the `StatusPill` map, and the release ladder drawn as a
 * spine at the top so the first thing the screen answers is "where is this
 * cheque". Nothing about what it queries, guards or permits changed.
 */

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
const fmtDateTime = (d: Date | null) =>
  d ? d.toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'

// The spine's own marks: a bare date under the rung it belongs to, and nothing
// at all where there is no date. `fmtDate`'s em dash would read as "this rung
// has no date" rather than "the cheque has not reached it".
const mark = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: '2-digit' }) : null

/** A page-level notice. Pastel ground, dark ink, the palette's three tones. */
function Notice({
  tone, title, children,
}: {
  tone: 'warning' | 'info' | 'danger'
  title: string
  children: React.ReactNode
}) {
  const skin = {
    warning: 'bg-warning-bg text-warning-ink',
    info: 'bg-navy-bg text-navy',
    danger: 'bg-danger-bg text-danger-ink',
  }[tone]

  return (
    <div className={`rounded-2xl px-5 py-4 text-sm leading-relaxed ${skin}`}>
      <p className="text-[11px] font-semibold tracking-widest">{title}</p>
      <p className="mt-1">{children}</p>
    </div>
  )
}

// The receipt actions on this page kick portal delivery with a 25 s budget
// after the response (review 2026-10-02); give the function room for it.
export const maxDuration = 60

export default async function CheckDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  const { id } = await params

  const settings = await loadSettings(prisma)

  const check = await prisma.check.findUnique({
    where: { id },
    include: {
      company: true, cashAccount: true, checkBook: true,
      bills: { orderBy: { apvNumber: 'asc' } },
      signedBy: true, readyBy: true, releasedBy: true,
      auditLogs: { include: { user: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  })
  if (!check) notFound()

  const today = new Date().toISOString().slice(0, 10)

  // The same guard the server action and the domain both apply, called here
  // only to decide what to render. It is NOT the control — `deleteIncomplete
  // Check` re-runs it on every call, because a server action is an HTTP
  // endpoint and not rendering a button hides nothing from anybody.
  const deletable = checkDeletable({
    actorRole: user.role,
    amount: check.amount?.toString() ?? null,
    status: check.status,
    releasedAt: check.releasedAt,
  })

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <AppHeader
        user={user}
        title="CHECK"
        back={{ href: '/', label: '← BACK TO DASHBOARD' }}
      />

      {/* ── THE IDENTITY CARD ──────────────────────────────────────────────
          What cheque this is, who it is for, what it is worth and where it
          stands, in one card and in that order. The amount is the largest
          figure on the screen and is right-aligned and tabular-figured, the
          same treatment the dashboard table gives the same column: a reader
          comparing this page against the list should not have to re-read the
          number in a different shape. */}
      <section className="rounded-2xl bg-white p-6 ring-1 ring-hairline">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-widest text-slate-400">CHECK NUMBER</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-navy">
              {check.checkNumber}
            </h1>
            {/* An em dash rather than the empty string React renders for null:
                the register does not always record a payee, and a blank line
                under the cheque number reads as a rendering fault, not as a
                fact. */}
            <p className="mt-1 break-words text-sm font-medium text-slate-700">
              {check.payeeName ?? '—'}
            </p>
            <p className="mt-1 text-xs tracking-wide text-slate-500">
              {check.company.code}
              {check.cashAccount && ` · ${check.cashAccount.code}`}
              {` · ${fmtDate(check.checkDate)}`}
            </p>
          </div>

          <div className="ml-auto text-right">
            <p className="text-[11px] font-semibold tracking-widest text-slate-400">AMOUNT</p>
            {/* A Decimal, formatted on the server. It never crosses to a client
                component — see lib/money.ts and toTableRow. */}
            <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums text-navy">
              {formatMoney(check.amount, check.currency)}
            </p>
            <div className="mt-2 flex justify-end">
              <StatusPill status={check.status} />
              {check.isStale && <span className="ml-2 self-center text-xs font-semibold tracking-widest text-amber-700">STALED</span>}
            </div>
          </div>
        </div>

        {/* The ladder, drawn. Same five rungs as the dashboard's timeline, from
            the same pure module — see lib/release-timeline.ts. */}
        <div className="mt-6 border-t border-hairline pt-5">
          <p className="text-[11px] font-semibold tracking-widest text-slate-400">RELEASE WORKFLOW</p>
          <div className="mt-3 overflow-x-auto">
            <CheckProgress
              status={check.status}
              marks={{
                SIGNED: mark(check.signedAt),
                READY_FOR_RELEASE: mark(check.availablePickupDate ?? check.readyAt),
                RELEASED: mark(check.releasedAt),
              }}
            />
          </div>
        </div>
      </section>

      {/* CANCELLED carries a reason and it is the most important sentence on
          the page for a cheque that has one. It was a grey line at the bottom
          of the ACTIONS card; it is a notice at the top now. */}
      {check.status === 'CANCELLED' && (
        <Notice tone="danger" title="CANCELLED">
          {check.cancelReason ?? 'No reason was recorded.'}
        </Notice>
      )}

      {check.isIncomplete && (
        <Notice tone="warning" title="NO AMOUNT RECORDED">
          The register never recorded an amount for this check. It is left out of every currency
          total — there is no figure of its to add — and out of the dashboard&rsquo;s counts and
          table entirely, and it cannot be marked ready for release until somebody supplies one.
          Nothing about it has been deleted.
        </Notice>
      )}

      {check.eligibility === 'INTERNAL' && (
        <Notice tone="info" title="NOT PORTAL-ELIGIBLE">
          This is an internal payment (payroll, tax, fund transfer or inter-company). It is tracked
          here but is never sent to the Supplier Portal.
        </Notice>
      )}

      <Panel title="CHECK INFORMATION">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3">
          <Field label="CHECK NUMBER" value={check.checkNumber} />
          <Field label="CV NUMBER" value={check.cvNumber ?? '—'} />
          {/* Every bill, matching the dashboard table: a multi-bill check must not
              display one arbitrary APV as though it were the only one. */}
          <Field label="APV NUMBER" value={check.bills.length ? check.bills.map((b) => b.apvNumber).join(', ') : '—'} />
          <Field label="PAYEE" value={check.payeeName ?? '—'} />
          <Field label="COMPANY" value={check.company.code} />
          <Field label="CHECK DATE" value={fmtDate(check.checkDate)} />
          <Field label="EXPECTED OUT" value={fmtDate(check.expectedOutflowDate)} />
          <Field label="AMOUNT" value={formatMoney(check.amount, check.currency)} tabular />
          <Field label="CASH ACCOUNT" value={check.cashAccount?.code ?? '—'} />
          <Field label="CHECK BOOK" value={check.checkBook?.code ?? '—'} />
          <Field label="CURRENCY" value={check.currency} />
          <Field label="CATEGORY" value={check.category ?? '—'} />
          <Field label="ELIGIBILITY" value={check.eligibility} />
        </dl>
      </Panel>

      <Panel title="RELEASE MONITORING">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3">
          <Field
            label="SIGNED BY"
            value={check.signedBy?.name ?? (check.signedAt ? 'AUTOMATIC' : '—')}
          />
          <Field label="SIGNED DATE/TIME" value={fmtDateTime(check.signedAt)} />
          <Field label="READY BY" value={check.readyBy?.name ?? '—'} />
          <Field label="READY DATE/TIME" value={fmtDateTime(check.readyAt)} />
          <Field label="AVAILABLE PICKUP DATE" value={fmtDate(check.availablePickupDate)} />
          <Field label="SUPPLIER PICKUP SCHEDULE" value={fmtDate(check.scheduledPickupDate)} />
          <Field label="RELEASED BY" value={check.releasedBy?.name ?? '—'} />
          <Field label="RELEASED DATE/TIME" value={fmtDateTime(check.releasedAt)} />
          {/* The supplier's paper and the bank's reference, deliberately two
              rows with two names. They abbreviate alike and mean nothing like
              each other — rule 11 — and 2,727 cheques had the one in the
              other's column until 2026-09-11. */}
          <Field
            label="SUPPLIER RECEIPT"
            value={
              <Link href={`/receipts/${check.id}`} className="underline underline-offset-2">
                {check.orNumber
                  ? `${check.orNumber}${check.receiptType ? ` · ${RECEIPT_TYPE_LABELS[check.receiptType]}` : ''}`
                  : 'None recorded'}
              </Link>
            }
          />
          <Field label="CLEARING STATUS" value={check.clearingStatus} />
          <Field label="BANK CLEARING REF" value={check.crNumber ?? '—'} />
          <Field label="CLEARED DATE" value={fmtDate(check.clearedDate)} />
          <Field label="POINT PERSON" value={check.pointPerson ?? '—'} />
          <Field label="WHO IS HOLDING IT" value={check.checksPossession ?? '—'} />
          <Field label="REMARKS" value={check.remarks ?? '—'} wide />
        </dl>
      </Panel>

      {/* The register's four free-text fields, typeable here since 2026-09-11.
          Any status: the columns were 0-populated on every cheque because no
          screen could write them, and a note belongs on a cancelled cheque as
          much as on a live one. */}
      <Panel title="FINANCE NOTES">
        <DetailsForm
          checkId={check.id}
          values={{
            remarks: check.remarks, pointPerson: check.pointPerson,
            checksPossession: check.checksPossession, category: check.category,
            expectedOutflowDate: isoDay(check.expectedOutflowDate),
          }}
          categories={settings.values.categories}
        />
      </Panel>

      {/* The conditionals here are untouched: which action a cheque offers is
          the domain's ladder, not a matter of styling. Only the buttons'
          appearance changed — navy for the ordinary step, the success tone for
          the one that hands money over, both from the client's palette rather
          than from three unrelated Tailwind hues. */}
      <Panel title="ACTIONS">
        {/* `isCheque` gates this, as it gates the dashboard table's checkbox.
            A DEBIT ADV or a wire (TT) payment is not a check and nobody signs one —
            CLAUDE.md states that outright. This page offered the button anyway
            until 2026-09-10; `assertReleasable` refused the action server-side,
            so nothing unsafe ever happened, but a button that exists only to be
            rejected teaches people to distrust the screen. */}
        {check.status === 'SIGNATURE_PENDING' && check.isCheque && (
          <ActionForm
            action={signAction}
            checkId={check.id}
            label="MARK SIGNED"
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90 disabled:opacity-50"
          />
        )}

        {check.status === 'SIGNED' && (
          <ReadyForReleaseForm checkId={check.id} defaultDate={today} />
        )}

        {/* SIGNED back to SIGNATURE PENDING (client, 2026-10-01). Every
            Finance user; the reason is optional. Never auto-signed again. */}
        {check.status === 'SIGNED' && (
          <ActionForm
            action={revertSignatureAction}
            checkId={check.id}
            label="REVERT TO SIGNATURE PENDING"
            className="block rounded-lg border border-hairline bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy transition hover:bg-ground disabled:opacity-50"
          >
            <label className="block text-[11px] font-semibold tracking-widest text-slate-400">REASON (OPTIONAL)</label>
            <input name="reason" placeholder="Signed in error"
              className="h-10 w-full max-w-md rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy" />
          </ActionForm>
        )}

        {/* From any live rung: below READY FOR RELEASE the check is signed and
            readied on the way, in one transaction (`releaseDirectly`, client
            2026-10-16). */}
        {isLiveStatus(check.status as CheckStatus) && check.isCheque && (
          <ActionForm
            action={releaseAction}
            checkId={check.id}
            label="MARK RELEASED"
            className="block rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90 disabled:opacity-50"
          >
            <label className="block text-[11px] font-semibold tracking-widest text-slate-400">REMARKS</label>
            <input name="remarks" placeholder="Picked up by supplier"
              className="h-10 w-full max-w-md rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy" />
          </ActionForm>
        )}

        {/* Back down a rung: READY FOR RELEASE -> SIGNED.
            `revertAvailability` has existed since Plan 1 — guarded, audited, and
            clearing any pickup the portal had booked — with nothing rendering it,
            so a cheque approved by mistake could only be corrected in the
            database. Client asked for it on 2026-09-10.

            Every Finance user since 2026-09-26 (client ruling), the same as the
            list's bulk REVERT TO SIGNED. The reason is required —
            the domain refuses a blank one — because a cheque that moved down a
            rung with no explanation is indistinguishable from one that was never
            approved. */}
        {(check.status === 'READY_FOR_RELEASE' || check.status === 'SCHEDULED') && (
          <ActionForm
            action={revertAction}
            checkId={check.id}
            label="REVERT TO SIGNED"
            className="block rounded-lg border border-hairline bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy transition hover:bg-ground disabled:opacity-50"
          >
            <label className="block text-[11px] font-semibold tracking-widest text-slate-400">
              REASON <span className="text-danger-ink">— REQUIRED</span>
            </label>
            <input name="reason" required placeholder="Approved in error"
              className="h-10 w-full max-w-md rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy" />
            <p className="text-[11px] text-slate-500">
              Returns this check to SIGNED and clears any pickup the supplier had booked.
            </p>
          </ActionForm>
        )}

        {check.status === 'RELEASED' && (
          <div className="space-y-4">
            <p className="rounded-xl bg-success-bg px-4 py-3 text-sm text-success-ink">
              This check has been released
              {check.releasedBy?.name ? ` by ${check.releasedBy.name}` : ''}
              {check.releasedAt ? ` on ${fmtDateTime(check.releasedAt)}` : ''}.
            </p>

            {/* The bank's side. Offered while a forward move exists; a CLEARED
                cheque states its clearing as facts in the panel above. */}
            {(() => {
              const targets = clearingTargets(check.clearingStatus as ClearingStatus)
              return targets.length > 0 ? (
                <ClearingForm
                  checkId={check.id}
                  targets={targets}
                  current={{
                    crNumber: check.crNumber,
                    clearedDate: check.clearedDate ? check.clearedDate.toISOString().slice(0, 10) : null,
                  }}
                />
              ) : (
                <p className="text-sm text-slate-600">
                  <span className="font-semibold text-navy">Cleared by the bank</span>
                  {check.clearedDate ? ` on ${fmtDate(check.clearedDate)}` : ''}
                  {check.crNumber ? `, reference ${check.crNumber}` : ''}. A clearing is not moved back.
                </p>
              )
            })()}

            {/* The undo for the one action that hands money over. Client design
                2026-09-10, built 2026-09-11. FINANCE_ADMIN only, matching
                `reverseReleaseAction`'s own guard: hidden for everyone else,
                enforced on the server. The same guard the action applies is run
                here first, so an admin is TOLD why a reversal is refused —
                a receipt on record, or a cleared cheque — rather than shown a
                button that would refuse them. */}
            {user.role === 'FINANCE_ADMIN' && (() => {
              const reversible = checkReleaseReversible(check)
              return reversible.ok ? (
                <ActionForm
                  action={reverseReleaseAction}
                  checkId={check.id}
                  label="REVERSE RELEASE"
                  className="block rounded-lg border border-hairline bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy transition hover:bg-ground disabled:opacity-50"
                >
                  <label className="block text-[11px] font-semibold tracking-widest text-slate-400">
                    REASON <span className="text-danger-ink">— REQUIRED</span>
                  </label>
                  <input name="reason" required placeholder="Ticked the wrong row"
                    className="h-10 w-full max-w-md rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy" />
                  <p className="text-[11px] text-slate-500">
                    Returns this check to READY FOR RELEASE, clears any pickup that was booked
                    {/* Rule 2: an INTERNAL cheque never produces a portal call, and this reversal
                        is no exception — `reverseRelease` queues nothing for it. Stating the portal
                        clause anyway would tell Finance something false about a payroll, tax or
                        inter-company cheque, which does reach RELEASED and does render this form. */}
                    {check.eligibility !== 'INTERNAL' && ', and tells the supplier portal it is available again'}.
                    The release stays on the audit trail with your reason.
                  </p>
                </ActionForm>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-slate-600">
                    <span className="font-semibold text-navy">This release cannot be reversed.</span>{' '}
                    {reversible.message}
                  </p>
                  {/* A receipt typed with a release that never happened (2026-10-23):
                      removing it is what unblocks REVERSE RELEASE. Offered only when
                      the receipt IS the blocker; `removeReceipt` refuses the rest. */}
                  {reversible.code === 'RECEIPT_ON_RECORD' && (
                    <ActionForm
                      action={removeReceiptAction}
                      checkId={check.id}
                      label="REMOVE RECEIPT"
                      className="block rounded-lg border border-hairline bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy transition hover:bg-ground disabled:opacity-50"
                    >
                      <label className="block text-[11px] font-semibold tracking-widest text-slate-400">
                        REASON <span className="text-danger-ink">— REQUIRED</span>
                      </label>
                      <input name="reason" required placeholder="Released by mistake, not collected"
                        className="h-10 w-full max-w-md rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy" />
                      <p className="text-[11px] text-slate-500">
                        Only when the receipt was recorded by mistake. Removes receipt {check.orNumber ?? ''}
                        {check.receiptType ? ` (${check.receiptType})` : ''}, its amount and its scanned file;
                        the check stays RELEASED and REVERSE RELEASE becomes available. What was removed stays
                        on the audit trail with your reason.
                      </p>
                    </ActionForm>
                  )}
                </div>
              )
            })()}

            {user.role !== 'FINANCE_ADMIN' && (
              <p className="text-sm text-slate-500">There is nothing further to do here.</p>
            )}
          </div>
        )}

        {/* A cancellation undone (client, 2026-10-06): back to SIGNED. The reason
            is required; the domain refuses once the portal has been told. */}
        {check.status === 'CANCELLED' && (
          <ActionForm
            action={restoreCancelledAction}
            checkId={check.id}
            label="RESTORE TO SIGNED"
            className="block rounded-lg border border-hairline bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy transition hover:bg-ground disabled:opacity-50"
          >
            <label className="block text-[11px] font-semibold tracking-widest text-slate-400">REASON</label>
            <input name="reason" required placeholder="Cancelled in error"
              className="h-10 w-full max-w-md rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy" />
          </ActionForm>
        )}

        {check.status === 'VOIDED' && (
          <p className="text-sm text-slate-500">
            This check is VOIDED in Acumatica. Acumatica is the source of that fact and this system
            never writes it back.
          </p>
        )}

        {check.status === 'GENERATED' && (
          <p className="text-sm text-slate-500">
            This check has not been sent for signature yet, so there is nothing to do here.
          </p>
        )}
      </Panel>

      {/* Offered only for an incomplete record, and only to a Finance Admin the
          guard actually permits. A FINANCE_USER, or an admin looking at one of
          the 25 RELEASED or 6 READY_FOR_RELEASE incomplete cheques, is told why
          instead of being shown a button that would refuse them. */}
      {check.isIncomplete && user.role === 'FINANCE_ADMIN' && (
        <Panel title="INCOMPLETE RECORD">
          {deletable.ok
            ? <DeleteIncompleteCheckForm checkId={check.id} checkNumber={check.checkNumber} />
            : <p className="text-sm text-slate-600">{deletable.message}</p>}
        </Panel>
      )}

      <AuditTrail rows={check.auditLogs} />
    </main>
  )
}
