import { z } from 'zod'
import { RECEIPT_TYPES, type ReceiptType, type ReceiptFileInput } from '@/lib/domain/receipt'
import { ROW_OR_NUMBER, ROW_RECEIPT_TYPE } from './row-receipts'

/**
 * The OR/CR box, off the wire.
 *
 * Shared by the single release form, the tick-box release and the add-it-later
 * receipt page, and it lives here rather than in `app/checks/actions.ts`
 * because a `'use server'` module may only export async functions — a helper
 * exported from one would become a server action of its own.
 *
 * **An empty toggle is `null`, never OR.** "Nobody chose" is a state the domain
 * has to see, because `checkReceipt` refuses a reference with no type. A
 * default here would answer the question on the user's behalf at the one point
 * where the whole feature depends on it having been asked.
 *
 * **Anything that is not OR or CR is rejected, not coerced.** A server action is
 * an HTTP endpoint and this field arrives from a form nobody has to use; the
 * same treatment `clearingAction` gives a bogus clearing status.
 */
const receiptTypeSchema = z.enum(RECEIPT_TYPES)

export type ReceiptFormFields = {
  orNumber: string | undefined
  orDate: Date | undefined
  receiptType: ReceiptType | null
  receiptAmount: string | undefined
  receiptFile: ReceiptFileInput | undefined
}

export type ReceiptFormResult =
  | ({ ok: true } & ReceiptFormFields)
  | { ok: false; message: string }

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

const date = (f: FormData, k: string) => {
  const v = str(f, k)
  if (!v) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}

// An empty file input still posts a zero-byte File; that is "no file" (user request 2026-10-01).
async function file(f: FormData, k: string): Promise<ReceiptFileInput | undefined> {
  const v = f.get(k)
  if (!(v instanceof File) || v.size === 0) return undefined
  return { fileName: v.name, contentType: v.type, bytes: new Uint8Array(await v.arrayBuffer()) }
}

export async function readReceiptFields(formData: FormData): Promise<ReceiptFormResult> {
  const raw = str(formData, 'receiptType')
  let receiptType: ReceiptType | null = null
  if (raw !== '') {
    const parsed = receiptTypeSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid receipt type.' }
    receiptType = parsed.data
  }
  return {
    ok: true,
    orNumber: str(formData, 'orNumber') || undefined,
    orDate: date(formData, 'orDate'),
    receiptType,
    receiptAmount: str(formData, 'receiptAmount') || undefined,
    receiptFile: await file(formData, 'receiptFile'),
  }
}

export type RowReceipt = { orNumber: string; receiptType: ReceiptType }

export type RowReceiptsResult =
  | { ok: true; receipts: Map<string, RowReceipt> }
  | { ok: false; message: string }

/**
 * One receipt per ticked row, keyed `orNumber:<checkId>` / `receiptType:<checkId>`
 * (lib/row-receipts.ts). Refused whole, before anything is written, if any row
 * is malformed. A batch half-saved over a typo is worse than none saved and the
 * box still showing what was typed.
 *
 * A key for a cheque that is not in the ticked selection is refused rather
 * than ignored. So are the old single-box fields, which a page loaded before
 * this change would still send: dropping them silently would lose a receipt
 * somebody typed.
 */
export function readRowReceipts(formData: FormData, checkIds: readonly string[]): RowReceiptsResult {
  if (str(formData, 'orNumber') !== '' || str(formData, 'receiptType') !== '') {
    return { ok: false, message: 'This page is out of date. Reload it and type the receipt in the row.' }
  }
  const ticked = new Set(checkIds)
  for (const key of formData.keys()) {
    for (const prefix of [ROW_OR_NUMBER, ROW_RECEIPT_TYPE]) {
      if (key.startsWith(prefix) && !ticked.has(key.slice(prefix.length))) {
        return { ok: false, message: 'A receipt was sent for a check that is not ticked. Nothing was saved.' }
      }
    }
  }
  const receipts = new Map<string, RowReceipt>()
  for (const id of checkIds) {
    const orNumber = str(formData, ROW_OR_NUMBER + id)
    if (orNumber === '') continue
    const raw = str(formData, ROW_RECEIPT_TYPE + id)
    if (raw === '') {
      return { ok: false, message: 'Choose the receipt type (OR, CR, AR, PR, SI or OTHERS) for every reference you typed. Nothing was saved.' }
    }
    const parsed = receiptTypeSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid receipt type.' }
    receipts.set(id, { orNumber, receiptType: parsed.data })
  }
  return { ok: true, receipts }
}
