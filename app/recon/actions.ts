'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import { manilaDay } from '@/lib/forecast/buckets'
import {
  establishBeginningBalance, correctBeginningBalance, openNextPeriod, recarryBeginning, setStatementBalances,
  addBookEntry, removeBookEntry, addAdjustment, removeAdjustment, resolveItem, readStatementFile,
  planStatementUpload, applyStatementUpload, removeStatementUpload, matchLineToCheck, matchLineToEntry, classifyLine,
  transitionPeriod, requestReopen, decideReopen, MAX_STATEMENT_BYTES, STATEMENT_APPLY_BUDGET_MS,
  type StatementPlan, type StatementApplied,
} from '@/lib/recon/monthly/actions'
import type { WorkflowAction } from '@/lib/recon/monthly/period'
import type { LineKind } from '@/lib/recon/monthly/compute'

/**
 * The monthly reconciliation's server actions (spec 2026-11-09). Each one is
 * an HTTP endpoint: it authenticates, reads its own fields, and hands them to
 * `lib/recon/monthly/actions.ts`, which holds every rule. A DomainError's copy
 * goes back to the form; anything else is logged and said generically.
 */
export type ReconActionResult = { ok: true; message?: string } | { ok: false; message: string }

const s = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

async function run(fn: (actor: { id: string; role: 'FINANCE_USER' | 'FINANCE_ADMIN' }) => Promise<string | void>): Promise<ReconActionResult> {
  const user = await requireUser()
  try {
    const message = await fn({ id: user.id, role: user.role })
    revalidatePath('/recon', 'layout')
    return { ok: true, message: message || undefined }
  } catch (e) {
    if (isNextControlFlowError(e)) throw e
    if (e instanceof DomainError) return { ok: false, message: e.message }
    console.error('reconciliation action failed:', e instanceof Error ? e.message : e)
    return { ok: false, message: 'That could not be saved. Nothing was changed; try again, and tell an admin if it repeats.' }
  }
}

const today = () => manilaDay(new Date())

export async function establishBeginningAction(f: FormData) {
  return run((actor) => establishBeginningBalance(prisma, {
    accountKey: s(f, 'accountKey'), effectiveDate: s(f, 'effectiveDate'), bankBalance: s(f, 'bankBalance'), bookBalance: s(f, 'bookBalance'),
    currency: s(f, 'currency'), reference: s(f, 'reference'), supportingDocument: s(f, 'supportingDocument'), actor,
  }).then(() => 'Beginning balance established.'))
}

export async function correctBeginningAction(f: FormData) {
  return run((actor) => correctBeginningBalance(prisma, {
    accountKey: s(f, 'accountKey'), bankBalance: s(f, 'bankBalance'), bookBalance: s(f, 'bookBalance'),
    reference: s(f, 'reference'), supportingDocument: s(f, 'supportingDocument'), reason: s(f, 'reason'), actor,
  }).then(() => 'Beginning balance corrected. The change is on the audit trail.'))
}

export async function openPeriodAction(f: FormData) {
  return run((actor) => openNextPeriod(prisma, { accountKey: s(f, 'accountKey'), actor, todayManila: today() }).then(() => 'Month opened.'))
}

export async function recarryAction(f: FormData) {
  return run((actor) => recarryBeginning(prisma, { periodId: s(f, 'periodId'), actor }).then(() => 'Beginning balances re-carried.'))
}

export async function statementBalancesAction(f: FormData) {
  return run((actor) => setStatementBalances(prisma, {
    periodId: s(f, 'periodId'), statementEnding: s(f, 'statementEnding'), statementBeginning: s(f, 'statementBeginning'), actor,
  }).then(() => 'Statement balances saved.'))
}

export async function addBookEntryAction(f: FormData) {
  return run((actor) => addBookEntry(prisma, {
    periodId: s(f, 'periodId'), kind: s(f, 'kind') as 'DEPOSIT' | 'DISBURSEMENT', entryDate: s(f, 'entryDate'),
    amount: s(f, 'amount'), reference: s(f, 'reference'), description: s(f, 'description'), actor,
  }).then(() => 'Book entry added.'))
}

export async function removeBookEntryAction(f: FormData) {
  return run((actor) => removeBookEntry(prisma, { entryId: s(f, 'entryId'), reason: s(f, 'reason'), actor }).then(() => 'Book entry removed.'))
}

export async function addAdjustmentAction(f: FormData) {
  return run((actor) => addAdjustment(prisma, {
    periodId: s(f, 'periodId'), side: s(f, 'side') as 'BANK' | 'BOOK', direction: s(f, 'direction') as 'ADD' | 'LESS',
    amount: s(f, 'amount'), description: s(f, 'description'), reference: s(f, 'reference'), actor,
  }).then(() => 'Adjustment added.'))
}

export async function removeAdjustmentAction(f: FormData) {
  return run((actor) => removeAdjustment(prisma, { adjustmentId: s(f, 'adjustmentId'), reason: s(f, 'reason'), actor }).then(() => 'Adjustment removed.'))
}

export async function resolveItemAction(f: FormData) {
  return run((actor) => resolveItem(prisma, {
    periodId: s(f, 'periodId'), lineId: s(f, 'lineId') || undefined, adjustmentId: s(f, 'adjustmentId') || undefined,
    resolution: s(f, 'resolution'), actor, now: new Date(),
  }).then(() => 'Marked resolved in this month.'))
}

export async function matchCheckAction(f: FormData) {
  return run((actor) => matchLineToCheck(prisma, { lineId: s(f, 'lineId'), checkNumber: s(f, 'checkNumber'), remarks: s(f, 'remarks'), actor, now: new Date() })
    .then(() => 'Matched; the check is marked CLEARED on the line\'s date.'))
}

export async function matchEntryAction(f: FormData) {
  return run((actor) => matchLineToEntry(prisma, { lineId: s(f, 'lineId'), bookEntryId: s(f, 'bookEntryId'), remarks: s(f, 'remarks'), actor }).then(() => 'Matched to the book entry.'))
}

export async function classifyLineAction(f: FormData) {
  return run((actor) => classifyLine(prisma, { lineId: s(f, 'lineId'), kind: s(f, 'kind') as LineKind, remarks: s(f, 'remarks'), actor }).then(() => 'Line classified.'))
}

export async function removeUploadAction(f: FormData) {
  return run((actor) => removeStatementUpload(prisma, { periodId: s(f, 'periodId'), sourceFile: s(f, 'sourceFile'), reason: s(f, 'reason'), actor })
    .then((r) => `Removed ${r.removed} line(s).${r.kept > 0 ? ` ${r.kept} cleared-check line(s) kept — a clearing cannot be undone.` : ''}`))
}

export async function transitionAction(f: FormData) {
  return run((actor) => transitionPeriod(prisma, {
    periodId: s(f, 'periodId'), action: s(f, 'action') as WorkflowAction, note: s(f, 'note'), actor, now: new Date(), todayManila: today(),
  }).then((to) => `Now ${to.replace('_', ' ')}.`))
}

export async function requestReopenAction(f: FormData) {
  return run((actor) => requestReopen(prisma, { periodId: s(f, 'periodId'), reason: s(f, 'reason'), actor, now: new Date() })
    .then(() => 'Re-open requested. Another Finance Admin must approve it.'))
}

export async function decideReopenAction(f: FormData) {
  return run((actor) => decideReopen(prisma, {
    requestId: s(f, 'requestId'), decision: s(f, 'decision') === 'APPROVE' ? 'APPROVE' : 'REJECT', note: s(f, 'note'), actor, now: new Date(),
  }).then(() => (s(f, 'decision') === 'APPROVE' ? 'Re-opened: the month is DRAFT again.' : 'Request rejected.')))
}

export type StatementUploadResult =
  | { ok: true; stage: 'PREVIEW'; plan: StatementPlan }
  | { ok: true; stage: 'APPLIED'; plan: StatementPlan; applied: StatementApplied }
  | { ok: false; message: string }

/** Preview, then CONFIRM with the same file — re-read and re-matched here, never trusted from the browser. */
export async function uploadStatementAction(f: FormData): Promise<StatementUploadResult> {
  const user = await requireUser()
  const file = f.get('file')
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Choose the bank statement file.' }
  if (file.size > MAX_STATEMENT_BYTES) return { ok: false, message: 'That file is larger than 4 MB. Split it by month.' }
  const periodId = s(f, 'periodId')
  try {
    const read = await readStatementFile(file.name, Buffer.from(await file.arrayBuffer()))
    if (!read.ok) return read
    if (s(f, 'confirm') !== 'true') {
      return { ok: true, stage: 'PREVIEW', plan: await planStatementUpload(prisma, { periodId, fileName: file.name, sheets: read.sheets }) }
    }
    const now = new Date()
    const plan = await planStatementUpload(prisma, { periodId, fileName: file.name, sheets: read.sheets })
    const applied = await applyStatementUpload(prisma, {
      periodId, fileName: file.name, sheets: read.sheets, setBalances: s(f, 'setBalances') === 'true',
      actor: { id: user.id, role: user.role }, now, deadline: new Date(now.getTime() + STATEMENT_APPLY_BUDGET_MS),
    })
    revalidatePath('/recon', 'layout')
    return { ok: true, stage: 'APPLIED', plan, applied }
  } catch (e) {
    if (isNextControlFlowError(e)) throw e
    if (e instanceof DomainError) return { ok: false, message: e.message }
    console.error('statement upload failed:', e instanceof Error ? e.message : e)
    return { ok: false, message: 'The statement could not be read. Upload the Excel (.xlsx) or CSV export of the statement.' }
  }
}
