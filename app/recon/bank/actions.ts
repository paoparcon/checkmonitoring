'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { isNextControlFlowError } from '@/lib/next-errors'
import { manilaDay } from '@/lib/forecast/buckets'
import { sheetsFromWorkbook } from '@/lib/admin/ready-upload'
import { readCashSheet } from '@/lib/bank-recon/cash-sheet'
import { planCashImport, applyCashImport, type CashImportPlan, type CashImportSummary } from '@/lib/bank-recon/import'
import { recordBookFigures, type BookFigureInput, type BookFigureResult } from '@/lib/bank-recon/entries'
import { BANK_RECON_PATH } from '@/lib/bank-recon-view'

/** The server action's body limit is 4 MB (`next.config.ts`); the largest Cash workbook measured is 3.3 MB. */
const MAX_CASH_FILE_BYTES = 4 * 1024 * 1024

export type CashUploadResult =
  | { ok: true; stage: 'PREVIEW'; plan: CashImportPlan }
  | { ok: true; stage: 'APPLIED'; plan: CashImportPlan; summary: CashImportSummary }
  | { ok: false; message: string }

/**
 * UPDATE CASH BALANCES FROM THE CASH WORKBOOK (`lib/bank-recon/import.ts`).
 * Every Finance user. The first submission plans and writes nothing; the
 * second carries `confirm` and the SAME file, read and planned again here, so
 * a confirmation applies only what that file says.
 */
export async function uploadCashWorkbookAction(formData: FormData): Promise<CashUploadResult> {
  const user = await requireUser()
  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Choose the Cash workbook to upload.' }
  if (!/\.(xlsx|xlsm)$/i.test(file.name)) return { ok: false, message: 'Upload the Cash workbook as .xlsx. An old .xls must be saved as .xlsx first.' }
  if (file.size > MAX_CASH_FILE_BYTES) {
    return { ok: false, message: `That file is larger than ${MAX_CASH_FILE_BYTES / 1024 / 1024} MB. Save a copy holding only the CASH sheet and upload that.` }
  }
  const confirmed = String(formData.get('confirm') ?? '') === 'true'
  try {
    const read = readCashSheet(await sheetsFromWorkbook(Buffer.from(await file.arrayBuffer())))
    if (!read.ok) return read
    if (read.accounts.length === 0) return { ok: false, message: 'The CASH sheet has a header and no account lines under it. Nothing was read.' }
    const plan = await planCashImport(prisma, read, file.name)
    if (!confirmed) return { ok: true, stage: 'PREVIEW', plan }
    if (plan.created === 0 && plan.changed.length === 0) {
      return { ok: false, message: 'Every balance on this file is already held, unchanged. Nothing to update.' }
    }
    const summary = await applyCashImport(prisma, read, { fileName: file.name, userId: user.id, now: new Date() })
    revalidatePath(BANK_RECON_PATH)
    return { ok: true, stage: 'APPLIED', plan, summary }
  } catch (e) {
    if (isNextControlFlowError(e)) throw e
    console.error('cash workbook upload failed:', e instanceof Error ? e.message : e)
    return { ok: false, message: 'The file could not be read as an Excel workbook. Nothing was written.' }
  }
}

export type BookFiguresResult =
  | { ok: true; saved: number; unchanged: number; refused: { account: string; message: string }[] }
  | { ok: false; message: string }

/**
 * SAVE THE BOOK BALANCES AND DEPOSITS IN TRANSIT (`lib/bank-recon/entries.ts`). Every Finance user.
 * The form sends every account row it drew; only the rows that differ from
 * what is held are written.
 */
export async function saveBookFiguresAction(formData: FormData): Promise<BookFiguresResult> {
  const user = await requireUser()
  const asOfDay = String(formData.get('asOf') ?? '').trim()
  const ids = formData.getAll('account').map(String)
  const field = (name: string, id: string) => String(formData.get(`${name}.${id}`) ?? '')
  const entries: BookFigureInput[] = [...new Set(ids)].map((id) => ({
    accountId: id, bookBalance: field('book', id), depositsInTransit: field('dit', id), note: field('note', id),
  }))
  if (entries.length === 0) return { ok: false, message: 'There is no account on this day to save figures for.' }
  try {
    const now = new Date()
    const done = await recordBookFigures(prisma, { userId: user.id, asOfDay, todayDay: manilaDay(now), entries, now })
    if (!done.ok) return done
    const labels = new Map((await prisma.cashLedgerAccount.findMany({
      where: { id: { in: entries.map((e) => e.accountId) } }, select: { id: true, label: true },
    })).map((a) => [a.id, a.label]))
    const count = (o: BookFigureResult['outcome']) => done.results.filter((r) => r.outcome === o).length
    revalidatePath(BANK_RECON_PATH)
    return {
      ok: true, saved: count('SAVED'), unchanged: count('UNCHANGED'),
      refused: done.results.flatMap((r) => r.outcome === 'REFUSED' ? [{ account: labels.get(r.accountId) ?? r.accountId, message: r.message }] : []),
    }
  } catch (e) {
    if (isNextControlFlowError(e)) throw e
    console.error('book figures save failed:', e instanceof Error ? e.message : e)
    return { ok: false, message: 'Saving stopped on an error. Some rows may not have been saved — reload the page and check.' }
  }
}
