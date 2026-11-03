import type { PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { CHECK_BOOK_ALIASES } from '@/lib/check-book-alias'

/**
 * Merging a check book into the one it is an alias of (user ruling 2026-11-03:
 * "this account MBT-S-9048 should be MBT-A-9048. Should be transferred to the
 * right account"). Only a pair in `CHECK_BOOK_ALIASES` can be merged, so the
 * script cannot be pointed at two unrelated books; after the move the sync
 * keeps new payments on the canonical book through the same table.
 *
 * Status is never touched. Each check gets one `check_book_merged` audit row;
 * an inventory note moves with its number unless the canonical book already
 * holds a note on that number and run (then it stays, counted, never deleted);
 * the alias book's row is deleted only once nothing refers to it, with one
 * `check_book_retired` row and no checkId.
 */
export const CHECK_BOOK_MERGE_ACTION = 'check_book_merged'
export const CHECK_BOOK_RETIRE_ACTION = 'check_book_retired'

export type MergeCheck = { checkId: string; checkNumber: string; status: string; acumaticaPaymentId: string | null; company: string }
export type MergeNote = { id: string; checkNumber: string; runTo: string; clash: boolean }
export type MergePlan = {
  from: { id: string; code: string }
  to: { id: string; code: string }
  checks: MergeCheck[]
  notes: MergeNote[]
}

/** A read: what the merge would move. Throws when the pair is not an alias or a book is missing. */
export async function planCheckBookMerge(db: PrismaClient, fromCode: string, toCode: string): Promise<MergePlan> {
  if (CHECK_BOOK_ALIASES[fromCode] !== toCode) {
    throw new Error(`${fromCode} is not an alias of ${toCode} in lib/check-book-alias.ts; nothing merged`)
  }
  const from = await db.checkBook.findUnique({ where: { code: fromCode }, select: { id: true, code: true } })
  const to = await db.checkBook.findUnique({ where: { code: toCode }, select: { id: true, code: true } })
  if (!from) throw new Error(`check book ${fromCode} is not on record`)
  if (!to) throw new Error(`check book ${toCode} is not on record`)

  const checks = await db.check.findMany({
    where: { checkBookId: from.id },
    select: { id: true, checkNumber: true, status: true, acumaticaPaymentId: true, company: { select: { code: true } } },
    orderBy: [{ checkNumber: 'asc' }, { id: 'asc' }],
  })
  const fromNotes = await db.checkInventoryNote.findMany({
    where: { checkBookId: from.id }, select: { id: true, checkNumber: true, runTo: true }, orderBy: { checkNumber: 'asc' },
  })
  const toNotes = await db.checkInventoryNote.findMany({ where: { checkBookId: to.id }, select: { checkNumber: true, runTo: true } })
  const taken = new Set(toNotes.map((n) => `${n.checkNumber}|${n.runTo}`))
  return {
    from, to,
    checks: checks.map((c) => ({ checkId: c.id, checkNumber: c.checkNumber, status: c.status, acumaticaPaymentId: c.acumaticaPaymentId, company: c.company.code })),
    notes: fromNotes.map((n) => ({ ...n, clash: taken.has(`${n.checkNumber}|${n.runTo}`) })),
  }
}

export function snapshotOf(plan: MergePlan, takenAt: Date) {
  return { takenAt: takenAt.toISOString(), from: plan.from, to: plan.to, checks: plan.checks, notes: plan.notes }
}

export type MergeResult = { moved: number; notesMoved: number; notesLeft: number; bookDeleted: boolean }

/** One transaction per check, conditional on it still being on the alias book. */
export async function applyCheckBookMerge(db: PrismaClient, plan: MergePlan): Promise<MergeResult> {
  const remarks = `Check book ${plan.from.code} merged into ${plan.to.code}: Acumatica's ${plan.from.code} is the same bank account as ${plan.to.code} (user ruling 2026-11-03). Status unchanged.`
  let moved = 0
  for (const c of plan.checks) {
    const done = await db.$transaction(async (tx) => {
      const r = await tx.check.updateMany({ where: { id: c.checkId, checkBookId: plan.from.id }, data: { checkBookId: plan.to.id } })
      if (!r.count) return false
      await writeAudit(tx, {
        checkId: c.checkId, actorType: 'SYSTEM', action: CHECK_BOOK_MERGE_ACTION,
        details: { from: plan.from, to: plan.to, acumaticaPaymentId: c.acumaticaPaymentId, status: c.status },
        remarks,
      })
      return true
    })
    if (done) moved++
  }
  let notesMoved = 0
  let notesLeft = 0
  for (const n of plan.notes) {
    if (n.clash) { notesLeft++; continue }
    const r = await db.checkInventoryNote.updateMany({ where: { id: n.id, checkBookId: plan.from.id }, data: { checkBookId: plan.to.id } })
    if (r.count) notesMoved++
    else notesLeft++
  }
  const left = await db.check.count({ where: { checkBookId: plan.from.id } }) + await db.checkInventoryNote.count({ where: { checkBookId: plan.from.id } })
  let bookDeleted = false
  if (left === 0) {
    // Conditional, so a plan applied twice (or after the book is already gone) is a no-op, not a throw.
    bookDeleted = await db.$transaction(async (tx) => {
      const r = await tx.checkBook.deleteMany({ where: { id: plan.from.id, code: plan.from.code } })
      if (!r.count) return false
      await writeAudit(tx, {
        actorType: 'SYSTEM', action: CHECK_BOOK_RETIRE_ACTION,
        details: { code: plan.from.code, id: plan.from.id, mergedInto: plan.to, checksMoved: moved, notesMoved },
        remarks: `Check book ${plan.from.code} retired: it is an alias of ${plan.to.code} and holds nothing.`,
      })
      return true
    })
  }
  return { moved, notesMoved, notesLeft, bookDeleted }
}
