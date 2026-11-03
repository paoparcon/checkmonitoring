import { isLiveStatus, type CheckStatus } from '@/lib/domain/check-status'
import type { ReceiptType } from '@/lib/domain/receipt'

/**
 * THE OR BOX ON A TICKED ROW (client, 2026-09-25: "Once the box was clicked the
 * box for the OR part will be fillable").
 *
 * Pure and client-safe: the table uses it to decide what to draw, and the
 * server's `readRowReceipts` shares the field names. Every box belongs to one
 * row, and that is what makes a receipt typed in a batch safe. The old rule
 * refusing one box for several cheques existed because a single box had no
 * owner; a box per row always has one.
 *
 * Presentation, not a control: `markReleased` and `recordReceipt` re-decide
 * everything on the server (rule 11, no overwrite, released only).
 */

export const ROW_OR_NUMBER = 'orNumber:'
export const ROW_RECEIPT_TYPE = 'receiptType:'

export type ReceiptDraft = { orNumber: string; receiptType: ReceiptType | '' }
export const EMPTY_DRAFT: ReceiptDraft = { orNumber: '', receiptType: '' }

export type RowFacts = { id: string; isCheque: boolean; status: CheckStatus; hasReceipt: boolean }

const releasedWithoutReceipt = (r: RowFacts) => r.status === 'RELEASED' && !r.hasReceipt

/** A live cheque, as before, or a released one still waiting for its receipt. */
export function isTickable(r: RowFacts): boolean {
  return r.isCheque && (isLiveStatus(r.status) || releasedWithoutReceipt(r))
}

/**
 * Only where a supplier's receipt can exist: at the counter, or after it —
 * and only where none is recorded yet. A row that already carries a receipt
 * (READY_FOR_RELEASE or SCHEDULED can, in principle, via `recordReceipt`'s own
 * rules; RELEASED always might) must never be offered a box that would
 * suggest one can still be typed and then be silently dropped or refused by
 * the server.
 */
export function takesReceipt(r: RowFacts): boolean {
  // Every live rung (client, 2026-10-09 for SIGNED, 2026-10-16 for GENERATED and
  // SIGNATURE PENDING: handed over without first being marked ready): MARK
  // RELEASED then signs, readies and releases it in one go (`releaseDirectly`).
  return !r.hasReceipt && (isLiveStatus(r.status) || r.status === 'RELEASED')
}

/** The ticked rows SIGN / READY / RELEASE act on: the live ones, as before. */
export function liveIds(rows: readonly RowFacts[]): string[] {
  return rows.filter((r) => isLiveStatus(r.status)).map((r) => r.id)
}

/** The ticked rows SAVE RECEIPTS acts on. */
export function releasedIds(rows: readonly RowFacts[]): string[] {
  return rows.filter((r) => r.status === 'RELEASED').map((r) => r.id)
}

/** The ticked rows REVERT TO SIGNED acts on: on the release list, not yet handed over. */
export function revertableIds(rows: readonly RowFacts[]): string[] {
  return rows.filter((r) => r.status === 'READY_FOR_RELEASE' || r.status === 'SCHEDULED').map((r) => r.id)
}

/** The ticked rows REVERT TO PENDING acts on: signed, not yet on the release list. */
export function signedIds(rows: readonly RowFacts[]): string[] {
  return rows.filter((r) => r.status === 'SIGNED').map((r) => r.id)
}

export function draftTypeMissing(d: ReceiptDraft): boolean {
  return d.orNumber.trim() !== '' && d.receiptType === ''
}

/** The keyed form fields for the given ids' typed receipts; a blank box sends nothing. */
export function receiptEntries(
  ids: readonly string[], drafts: Readonly<Record<string, ReceiptDraft>>,
): [string, string][] {
  const out: [string, string][] = []
  for (const id of ids) {
    const d = drafts[id]
    if (!d || d.orNumber.trim() === '') continue
    out.push([ROW_OR_NUMBER + id, d.orNumber.trim()], [ROW_RECEIPT_TYPE + id, d.receiptType])
  }
  return out
}
