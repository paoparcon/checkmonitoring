'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import { recordInventoryNote } from '@/lib/numbering/inventory-notes'
import { INVENTORY_SAVE_BUDGET_MS, INVENTORY_SAVE_MAX } from '@/lib/numbering/inventory'
import { NUMBERING_PATH } from '@/lib/numbering-view'

/** One row's change as the page sends it; `key` is echoed back so the row finds its answer. */
export type InventoryChange = { key: string; checkNumber: string; runTo?: string; ticked: boolean; remarks: string }
type SavedNote = { ticked: boolean; remarks: string | null; updatedBy: string; updatedAt: string }
export type InventorySaveResult =
  | { ok: true; saved: { key: string; note: SavedNote }[]; failed: { key: string; message: string }[]; unreached: number }
  | { ok: false; message: string }

const changesSchema = z.array(z.object({
  key: z.string().min(1).max(64),
  checkNumber: z.string().min(1).max(32),
  runTo: z.string().max(32).optional(),
  ticked: z.boolean(),
  remarks: z.string().max(2_000),
})).max(INVENTORY_SAVE_MAX)

/**
 * SAVE INVENTORY (spec §H, user 2026-11-03): every unsaved tick and remark on
 * the page, written one by one through `recordInventoryNote` — each its own
 * row, transaction and audit entry — and answered per row. A domain refusal
 * fails that row in its own words and the rest go on; anything else thrown is
 * a bug whose message must not reach a Finance user. Every Finance user.
 */
export async function saveInventoryAction(formData: FormData): Promise<InventorySaveResult> {
  const user = await requireUser()
  const checkBookId = String(formData.get('checkBookId') ?? '').trim()
  let changes: InventoryChange[]
  try {
    changes = changesSchema.parse(JSON.parse(String(formData.get('changes') ?? '[]')))
  } catch {
    return { ok: false, message: 'The page sent changes this server could not read. Reload and try again.' }
  }
  if (!checkBookId) return { ok: false, message: 'No check book named.' }

  const started = Date.now()
  const saved: { key: string; note: SavedNote }[] = []
  const failed: { key: string; message: string }[] = []
  let unreached = 0
  for (const [i, c] of changes.entries()) {
    if (Date.now() - started > INVENTORY_SAVE_BUDGET_MS) {
      unreached = changes.length - i
      break
    }
    try {
      const note = await recordInventoryNote(prisma, {
        checkBookId, checkNumber: c.checkNumber, runTo: c.runTo || null, ticked: c.ticked, remarks: c.remarks, userId: user.id,
      })
      saved.push({ key: c.key, note: { ticked: note.ticked, remarks: note.remarks, updatedBy: note.updatedBy, updatedAt: note.updatedAt.toISOString() } })
    } catch (e) {
      if (e instanceof DomainError) { failed.push({ key: c.key, message: e.message }); continue }
      if (isNextControlFlowError(e)) throw e
      console.error(e)
      failed.push({ key: c.key, message: 'Something went wrong. Please try again.' })
    }
  }
  if (saved.length) revalidatePath(NUMBERING_PATH)
  return { ok: true, saved, failed, unreached }
}
