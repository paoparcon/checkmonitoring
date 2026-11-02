'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import { recordInventoryNote } from '@/lib/numbering/inventory-notes'
import { NUMBERING_PATH } from '@/lib/numbering-view'

/** What a saved tick or remark sends back: enough to show who recorded it and when, with no re-read of a 7,000-row page. */
export type InventoryNoteResult =
  | { ok: true; note: { ticked: boolean; remarks: string | null; updatedBy: string; updatedAt: string } }
  | { ok: false; message: string }

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

/**
 * One MISSING number's (or run's) tick and remark, saved as it is changed
 * (spec §H). Every Finance user. The domain refuses a number a check holds
 * and a run end that is not a number; anything else thrown is a bug and its
 * message must not reach a Finance user.
 */
export async function recordInventoryNoteAction(formData: FormData): Promise<InventoryNoteResult> {
  const user = await requireUser()
  try {
    const runTo = str(formData, 'runTo')
    const note = await recordInventoryNote(prisma, {
      checkBookId: str(formData, 'checkBookId'),
      checkNumber: str(formData, 'checkNumber'),
      runTo: runTo || null,
      ticked: str(formData, 'ticked') === '1',
      remarks: String(formData.get('remarks') ?? ''),
      userId: user.id,
    })
    revalidatePath(NUMBERING_PATH)
    return { ok: true, note: { ticked: note.ticked, remarks: note.remarks, updatedBy: note.updatedBy, updatedAt: note.updatedAt.toISOString() } }
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message }
    if (isNextControlFlowError(e)) throw e
    console.error(e)
    return { ok: false, message: 'Something went wrong. Please try again.' }
  }
}
