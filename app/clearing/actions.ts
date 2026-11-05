'use server'

import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { recordClearing } from '@/lib/domain/actions'
import { parseClearingPaste, type PastedLine, type PasteError } from '@/lib/clearing-paste'
import { previewClearing, type PreviewRow } from '@/lib/clearing-preview'
import { runEach, type BulkActionResult } from '@/lib/bulk-run'
import { loadSettings } from '@/lib/settings/read'
import { revalidatePath } from 'next/cache'
import { isNextControlFlowError } from '@/lib/next-errors'
import { isIsoDay, dayToDate } from '@/lib/domain/details'
import {
  readClearingFile, planClearingUpload, applyClearingUpload,
  MAX_CLEARING_FILE_BYTES, CLEARING_UPLOAD_BUDGET_MS, UNREADABLE_FILE,
  type ClearingUploadPlan, type ClearingUploadSummary,
} from '@/lib/clearing-upload'

/**
 * Bulk mark-cleared from pasted statement lines. Any Finance user.
 *
 * PREVIEW reads; CONFIRM re-runs the same preview and writes only the lines
 * that would clear — through `recordClearing`, one transaction per cheque,
 * so every clearing carries its audit row and the domain's own guards.
 * Re-running the preview at confirm time rather than trusting ids from the
 * form is deliberate: a server action is an HTTP endpoint, and the only
 * input it takes is the text.
 */

export type ClearingPreviewResult =
  | { ok: true; rows: PreviewRow[]; errors: PasteError[] }
  | { ok: false; message: string }

type Parsed = { ok: true; lines: PastedLine[]; errors: PasteError[] } | { ok: false; message: string }

function parse(formData: FormData, cap: number): Parsed {
  const text = String(formData.get('lines') ?? '')
  const { lines, errors } = parseClearingPaste(text)
  const total = lines.length + errors.length
  if (total === 0) return { ok: false, message: 'Paste at least one check number, one per line.' }
  if (total > cap) {
    return {
      ok: false,
      message: `Up to ${cap} lines at a time; ${total} were pasted. Split the list and try again.`,
    }
  }
  return { ok: true, lines, errors }
}

export async function previewClearingAction(formData: FormData): Promise<ClearingPreviewResult> {
  await requireUser()
  const settings = await loadSettings(prisma)
  const parsed = parse(formData, settings.values['caps.bulkSelection'])
  if (!parsed.ok) return parsed
  const rows = await previewClearing(prisma, parsed.lines)
  return { ok: true, rows, errors: parsed.errors }
}

export async function confirmClearingAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  const settings = await loadSettings(prisma)
  const parsed = parse(formData, settings.values['caps.bulkSelection'])
  if (!parsed.ok) return parsed
  const rows = await previewClearing(prisma, parsed.lines)
  const willClear = rows.filter((r) => r.verdict === 'WILL_CLEAR' && r.checkId !== null)
  if (willClear.length === 0) {
    return { ok: false, message: 'None of these lines names a released check that is not yet cleared.' }
  }
  const byId = new Map(willClear.map((r) => [r.checkId as string, r]))
  const now = new Date()
  return runEach(prisma, [...byId.keys()], (checkId) => {
    const r = byId.get(checkId)!
    return recordClearing(prisma, {
      checkId, userId: user.id, clearingStatus: 'CLEARED',
      crNumber: r.crNumber ?? undefined, clearedDate: r.clearedDate ?? undefined, now,
    })
  })
}

export type ClearingUploadResult =
  | { ok: true; stage: 'PREVIEW'; plan: ClearingUploadPlan }
  | { ok: true; stage: 'APPLIED'; plan: ClearingUploadPlan; summary: ClearingUploadSummary }
  | { ok: false; message: string }

/**
 * MARK CLEARED FROM A FILE (user request 2026-11-05; `lib/clearing-upload.ts`).
 * Any Finance user, as the paste box. The first submission plans and writes
 * nothing; the second carries `confirm` and the SAME file, re-planned here, so
 * a confirmation can only apply to the file that was previewed and only to
 * checks still released and uncleared — the domain refuses the rest per check.
 */
export async function uploadClearingFileAction(formData: FormData): Promise<ClearingUploadResult> {
  const user = await requireUser()
  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Choose the bank file to upload.' }
  if (file.size > MAX_CLEARING_FILE_BYTES) {
    return { ok: false, message: `That file is larger than ${MAX_CLEARING_FILE_BYTES / 1024 / 1024} MB. Split it, or save only the cleared checks.` }
  }
  const day = String(formData.get('clearedDate') ?? '').trim()
  if (day !== '' && !isIsoDay(day)) return { ok: false, message: 'The cleared date is not a real day.' }
  const batchDate = day === '' ? null : dayToDate(day)
  const confirmed = String(formData.get('confirm') ?? '') === 'true'

  try {
    const read = await readClearingFile(file.name, Buffer.from(await file.arrayBuffer()))
    if (!read.ok) return read
    const now = new Date()
    const plan = await planClearingUpload(prisma, { fileName: file.name, kind: read.kind, units: read.units, batchDate, now })
    if (!confirmed) return { ok: true, stage: 'PREVIEW', plan }
    if (plan.willClear === 0) {
      return { ok: false, message: 'Nothing on this file names a released check that is not yet cleared.' }
    }
    const summary = await applyClearingUpload(prisma, plan, {
      userId: user.id, now, deadline: new Date(now.getTime() + CLEARING_UPLOAD_BUDGET_MS),
    })
    revalidatePath('/')
    revalidatePath('/clearing')
    return { ok: true, stage: 'APPLIED', plan, summary }
  } catch (e) {
    if (isNextControlFlowError(e)) throw e
    console.error('clearing upload failed:', e instanceof Error ? e.message : e)
    return { ok: false, message: `The file could not be read. ${UNREADABLE_FILE}` }
  }
}
