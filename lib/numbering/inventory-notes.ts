import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { DomainError } from '@/lib/domain/errors'
import { inventoryKey, type InventoryNote } from './inventory'

type Db = PrismaClient | Prisma.TransactionClient

/** The audit action every inventory write carries. No checkId: a MISSING number has no check. */
export const INVENTORY_NOTE_ACTION = 'inventory_note_recorded'
/** A remark is a line, not a memo. */
export const INVENTORY_REMARKS_MAX = 500

const noteSelect = {
  checkBookId: true, checkNumber: true, runTo: true, ticked: true, remarks: true, updatedAt: true,
  updatedBy: { select: { name: true } },
} as const
type NoteRow = Prisma.CheckInventoryNoteGetPayload<{ select: typeof noteSelect }>

// The column holds '' for a single number (part of the unique key); the pure layer reads null.
const toNote = (r: NoteRow): InventoryNote =>
  ({ checkNumber: r.checkNumber, runTo: r.runTo || null, ticked: r.ticked, remarks: r.remarks, updatedAt: r.updatedAt, updatedBy: r.updatedBy.name })

/**
 * Every inventory note of the given check books (all books when undefined),
 * grouped by book, numbers canonical — what `toInventoryLines` takes. One
 * query per request.
 */
export async function loadInventoryNotes(db: Db, bookIds: readonly string[] | undefined): Promise<Map<string, InventoryNote[]>> {
  const rows = await db.checkInventoryNote.findMany({
    where: bookIds ? { checkBookId: { in: [...bookIds] } } : {},
    orderBy: [{ checkNumber: 'asc' }, { runTo: 'asc' }],
    select: noteSelect,
  })
  const out = new Map<string, InventoryNote[]>()
  for (const r of rows) {
    const book = out.get(r.checkBookId) ?? []
    if (book.length === 0) out.set(r.checkBookId, book)
    book.push(toNote(r))
  }
  return out
}

export type RecordInventoryNoteArgs = {
  checkBookId: string
  /** The number as the screen shows it, or canonical; it is stored canonical. */
  checkNumber: string
  /** The last number of the run the note is for, when it is for a run; null or absent for one number. */
  runTo?: string | null
  ticked: boolean
  remarks: string
  userId: string
}

async function inTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if ('$transaction' in db) return db.$transaction(fn)
  return fn(db)
}

/**
 * Record Finance's tick and remark against a number of a check book — MISSING
 * or held by a check (user, 2026-11-03: "why the released and other checks
 * doesnt have check box?" — an inventory ticks every number) — or against a
 * MISSING run (spec §H). Every Finance user. One row per (book, number, run
 * end) — a run's note and its first number's note are two rows — written in
 * place; one `inventory_note_recorded` audit row per write, carrying what it
 * replaced, and carrying the check's id when a check holds the number so the
 * tick shows on that check's own trail. The tick never touches the check: its
 * status and FINANCE NOTES stay the check's own.
 *
 * Refused for a number that is not all digits, which no series lists. The run
 * bound is stored as given (canonical) so the screen can say when the run it
 * described has since changed shape; it decides nothing.
 */
export async function recordInventoryNote(db: Db, args: RecordInventoryNoteArgs): Promise<InventoryNote> {
  const key = inventoryKey(args.checkNumber)
  if (key === null) throw new DomainError('INVENTORY_NOT_NUMERIC', 'Only an all-digit check number can carry an inventory note.')
  const runTo = args.runTo ? inventoryKey(args.runTo) : null
  if (args.runTo && runTo === null) throw new DomainError('INVENTORY_NOT_NUMERIC', 'The end of a run must be an all-digit check number.')
  if (runTo !== null && BigInt(runTo) <= BigInt(key)) throw new DomainError('INVENTORY_RUN_INVERTED', 'A run ends after the number it starts on.')
  const runKey = runTo ?? ''
  const remarks = args.remarks.trim()
  if (remarks.length > INVENTORY_REMARKS_MAX) {
    throw new DomainError('INVENTORY_REMARKS_TOO_LONG', `Remarks are at most ${INVENTORY_REMARKS_MAX} characters.`)
  }

  return inTx(db, async (tx) => {
    const book = await tx.checkBook.findUnique({ where: { id: args.checkBookId }, select: { id: true, code: true } })
    if (!book) throw new DomainError('INVENTORY_NO_SUCH_BOOK', 'That check book is not on record.')
    // The check holding this number, if one does (both spellings the series
    // could hold: as typed on the screen, and canonical) — for the audit row only.
    const held = runKey === '' ? await tx.check.findFirst({
      where: { checkBookId: book.id, checkNumber: { in: [...new Set([args.checkNumber.trim(), key])] } },
      select: { id: true },
    }) : null
    const before = await tx.checkInventoryNote.findUnique({
      where: { checkBookId_checkNumber_runTo: { checkBookId: book.id, checkNumber: key, runTo: runKey } },
      select: { ticked: true, remarks: true },
    })
    const row = await tx.checkInventoryNote.upsert({
      where: { checkBookId_checkNumber_runTo: { checkBookId: book.id, checkNumber: key, runTo: runKey } },
      create: { checkBookId: book.id, checkNumber: key, runTo: runKey, ticked: args.ticked, remarks: remarks || null, updatedById: args.userId },
      update: { ticked: args.ticked, remarks: remarks || null, updatedById: args.userId },
      select: noteSelect,
    })
    await writeAudit(tx, {
      checkId: held?.id, actorType: 'USER', userId: args.userId, action: INVENTORY_NOTE_ACTION,
      details: {
        checkBook: book.code, checkBookId: book.id, checkNumber: key, runTo,
        ticked: args.ticked, remarks: remarks || null,
        before: before ? { ticked: before.ticked, remarks: before.remarks } : null,
      },
      remarks: remarks || undefined,
    })
    return toNote(row)
  })
}
