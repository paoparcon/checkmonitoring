'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  liveIds, releasedIds, revertableIds, signedIds, draftTypeMissing, receiptEntries, takesReceipt, EMPTY_DRAFT,
  type RowFacts, type ReceiptDraft,
} from '@/lib/row-receipts'
import {
  bulkSignAction, bulkReadyForReleaseAction, bulkReleaseAction, bulkRecordReceiptsAction,
  bulkRevertToSignedAction, bulkRevertToPendingAction,
  type BulkActionResult, type BulkOutcome,
} from '@/app/checks/bulk-actions'

/**
 * The spec's §13.1 minimum-click bar: tick several cheques, press one button.
 *
 * **It reports per cheque, never per batch.** The server processes each cheque
 * independently and returns a line for each, so a batch of twenty in which
 * three were refused shows those three by cheque number with the domain's own
 * sentence against each. "Some cheques could not be updated" would leave a
 * Finance user to find them by hand.
 *
 * **MARK RELEASED is every Finance user's** (client, 2026-10-16, replacing
 * design decision D11 for this button). `canRelease` still exists for callers
 * that hide it; the list passes true.
 *
 * **The cap is enforced here only as a courtesy.** `parseSelection` refuses an
 * oversized selection server-side; this disables the buttons so the user finds
 * out before pressing one rather than after.
 *
 * **Each action acts on its own subset of the ticked rows, and carries only
 * that subset's own receipts.** SIGN, READY FOR RELEASE and RELEASE act on the
 * live ones (`liveIds`); SAVE RECEIPTS acts on the RELEASED ones (`releasedIds`).
 * Ticking a released cheque alongside a live one no longer blocks anything —
 * each button reaches only the rows it applies to. The receipt itself is no
 * longer typed here: since 2026-09-25 every ticked row that can carry one has
 * its own OR/CR box in the table, and this bar only reads what was typed there
 * (`drafts`, keyed by check id) back onto the matching action.
 */
export function BulkActionBar({
  selectedRows, drafts, canRelease, cap, onDone,
}: {
  selectedRows: (RowFacts & { checkNumber: string })[]
  drafts: Readonly<Record<string, ReceiptDraft>>
  canRelease: boolean
  cap: number
  /** Called after a batch that changed something, so the table can clear itself. */
  onDone: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<BulkActionResult | null>(null)
  const [pickupDate, setPickupDate] = useState('')
  const [revertReason, setRevertReason] = useState('')
  const [pendingReason, setPendingReason] = useState('')
  // Set only by SAVE RECEIPTS, and only meaningful alongside its own result —
  // reset to null by every other action so a stale count never survives onto
  // a different button's outcome.
  const [skippedReceipts, setSkippedReceipts] = useState<number | null>(null)

  const live = liveIds(selectedRows)
  const released = releasedIds(selectedRows)
  const revertable = revertableIds(selectedRows)
  const signed = signedIds(selectedRows)
  const total = selectedRows.length
  const overCap = total > cap
  const disabled = pending || overCap
  // Only a row whose box is actually SHOWN can have a missing type disable a
  // button — a hidden draft (a live row when the viewer cannot release, or
  // any row not tickable) must never block anything. `CheckTable` opens the
  // box under exactly this condition (`lib/row-receipts.ts`'s `takesReceipt`,
  // gated the same way there).
  const boxShown = (r: RowFacts) => takesReceipt(r) && (r.status === 'RELEASED' || canRelease)
  const invalidRows = selectedRows.filter((r) => boxShown(r) && draftTypeMissing(drafts[r.id] ?? EMPTY_DRAFT))
  const missingType = invalidRows.length > 0
  const releasedTyped = receiptEntries(released, drafts).length > 0

  const submit = (
    action: (fd: FormData) => Promise<BulkActionResult>,
    ids: string[],
    extra: [string, string][] = [],
    skipped: number | null = null,
  ) => {
    const formData = new FormData()
    for (const id of ids) formData.append('checkId', id)
    for (const [k, v] of extra) formData.append(k, v)
    setSkippedReceipts(skipped)
    startTransition(async () => {
      const r = await action(formData)
      setResult(r)
      if (r.ok && r.succeeded > 0) {
        // Refresh before clearing: the rows the user is looking at have new
        // statuses, and the result panel below stays on screen to say which.
        router.refresh()
        onDone()
      }
    })
  }

  // A type predicate, not a bare `!o.ok`: TypeScript does not narrow a union
  // through Array.filter, and the refusal message lives only on the false arm.
  const failures = result?.ok
    ? result.outcomes.filter((o): o is Extract<BulkOutcome, { ok: false }> => !o.ok)
    : []

  return (
    <div className="sticky bottom-0 z-10 mt-4 rounded-2xl bg-white p-4 shadow-lg ring-1 ring-slate-300">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold tracking-wide text-slate-900">
          {total} SELECTED
        </span>

        <button
          type="button" disabled={disabled || live.length === 0}
          onClick={() => submit(bulkSignAction, live)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? 'WORKING…' : 'MARK SIGNED'}
        </button>

        <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 ring-1 ring-slate-300">
          <label htmlFor="bulk-pickup-date" className="text-xs font-medium tracking-wide text-slate-600">
            AVAILABLE PICKUP DATE
          </label>
          <input
            id="bulk-pickup-date" type="date" value={pickupDate}
            onChange={(e) => setPickupDate(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
          />
          <button
            type="button" disabled={disabled || live.length === 0 || pickupDate === ''}
            onClick={() => {
              if (!confirm(`Mark ${live.length} check(s) READY FOR RELEASE?`)) return
              submit(bulkReadyForReleaseAction, live, [['availablePickupDate', pickupDate]])
            }}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            MARK READY FOR RELEASE
          </button>
        </div>

        {/* Every Finance user (client ruling 2026-09-26). Only READY FOR
            RELEASE / SCHEDULED rows are sent; the reason is shared by the batch
            and lands on each cheque's audit row. */}
        {revertable.length > 0 && (
          <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 ring-1 ring-slate-300">
            <label htmlFor="bulk-revert-reason" className="text-xs font-medium tracking-wide text-slate-600">
              REASON
            </label>
            <input
              id="bulk-revert-reason" type="text" value={revertReason}
              onChange={(e) => setRevertReason(e.target.value)}
              placeholder="Pulled from the release list"
              className="w-56 rounded-lg border border-slate-300 px-2 py-1 text-sm"
            />
            <button
              type="button" disabled={disabled || revertReason.trim() === ''}
              onClick={() => {
                if (!confirm(`Revert ${revertable.length} check(s) to SIGNED? They come off the release list.`)) return
                submit(bulkRevertToSignedAction, revertable, [['reason', revertReason.trim()]])
                setRevertReason('')
              }}
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              REVERT TO SIGNED ({revertable.length})
            </button>
          </div>
        )}

        {/* SIGNED back to SIGNATURE PENDING (client, 2026-10-01). Every
            Finance user; the reason is optional and is this action's own
            (never REVERT TO SIGNED's). A cheque reverted here is never
            auto-signed again. */}
        {signed.length > 0 && (
          <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 ring-1 ring-slate-300">
            <label htmlFor="bulk-pending-reason" className="text-xs font-medium tracking-wide text-slate-600">
              REASON
            </label>
            <input
              id="bulk-pending-reason" type="text" value={pendingReason}
              onChange={(e) => setPendingReason(e.target.value)}
              placeholder="Signed in error"
              className="w-56 rounded-lg border border-slate-300 px-2 py-1 text-sm"
            />
            <button
              type="button" disabled={disabled}
              onClick={() => {
                if (!confirm(`Revert ${signed.length} check(s) to SIGNATURE PENDING?`)) return
                const reason = pendingReason.trim()
                submit(bulkRevertToPendingAction, signed, reason ? [['reason', reason]] : [])
                setPendingReason('')
              }}
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              REVERT TO PENDING ({signed.length})
            </button>
          </div>
        )}

        {canRelease && (
          <button
            type="button" disabled={disabled || live.length === 0 || missingType}
            onClick={() => {
              // The highest-risk action in the system: the cheque physically
              // leaves the building and RELEASED leads only to VOIDED.
              const entries = receiptEntries(live, drafts)
              const withReceipt = entries.length > 0 ? ` (${entries.length / 2} with a supplier receipt)` : ''
              // A SIGNED check is readied and released in one go (client, 2026-10-09).
              const direct = selectedRows.filter((r) => r.status === 'SIGNED').length
              const fromSigned = direct > 0 ? ` ${direct} SIGNED check(s) are marked ready and released together.` : ''
              if (!confirm(
                `Mark ${live.length} check(s) RELEASED${withReceipt}?${fromSigned} This records that the checks ` +
                'have been physically handed over and cannot be undone.',
              )) return
              submit(bulkReleaseAction, live, entries)
            }}
            className="rounded-lg bg-rose-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            MARK RELEASED
          </button>
        )}

        {released.length > 0 && (
          <button
            type="button" disabled={disabled || missingType || !releasedTyped}
            onClick={() => {
              // Skipped, not refused: a ticked RELEASED row with an empty box
              // is left alone by `bulkRecordReceiptsAction` rather than
              // failed, so the count has to be worked out here to be shown at
              // all.
              const typed = released.filter((id) => (drafts[id]?.orNumber ?? '').trim() !== '')
              submit(
                bulkRecordReceiptsAction, released, receiptEntries(released, drafts),
                released.length - typed.length,
              )
            }}
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            SAVE RECEIPTS
          </button>
        )}
      </div>

      {missingType && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          Choose the receipt type (OR, CR, AR, PR, SI or OTHERS) for {invalidRows.map((r) => r.checkNumber).join(', ')}.
        </p>
      )}

      {released.length > 0 && (
        // Said rather than left to be discovered by a refusal. The receipt
        // box lives in the row now, not here.
        <p className="mt-3 text-xs text-slate-500">
          A ticked RELEASED check takes its receipt in the OR / CR column. SAVE RECEIPTS records
          every one typed there.
        </p>
      )}

      {overCap && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {total} CHECKS ARE SELECTED. A bulk action is limited to {cap}
          {' '}at a time — untick some before continuing.
        </p>
      )}

      {result && !result.ok && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
      )}

      {result?.ok && (
        <div className="mt-3 space-y-2">
          {result.succeeded > 0 && (
            <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
              {result.succeeded} CHECK{result.succeeded === 1 ? '' : 'S'} UPDATED.
              {/* SAVE RECEIPTS skips a ticked RELEASED row with an empty box
                  rather than failing it, so the count would otherwise vanish
                  into `succeeded` with nothing to show for it. */}
              {skippedReceipts !== null && skippedReceipts > 0 && (
                <> {skippedReceipts} SKIPPED — NO REFERENCE TYPED.</>
              )}
            </p>
          )}
          {failures.length > 0 && (
            <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-medium">
                {failures.length} CHECK{failures.length === 1 ? ' WAS' : 'S WERE'} NOT UPDATED:
              </p>
              <ul className="mt-2 space-y-1">
                {failures.map((f) => (
                  <li key={f.checkId}>
                    <span className="font-medium">{f.checkNumber ?? f.checkId}</span>
                    {' — '}
                    {/* The domain's own sentence, passed through untouched. */}
                    {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
