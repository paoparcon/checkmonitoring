// lib/admin/check-books.ts
import type { PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { PAYMENTS_FEED, type AcumaticaClient } from '@/lib/integrations/acumatica/client'
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'
import { paymentsInScopeFilter } from '@/lib/sync/run'
import { canonicalCheckBookCode } from '@/lib/check-book-alias'

/**
 * The cheque book of every Acumatica cheque that has none (spec
 * 2026-10-01-cheque-numbering-and-cancel-guard-design §D2). Acumatica's
 * `CashAccount` column states the cheque-book code (`BPI-S-4636`), but until
 * 2026-10-02 the sync dropped it, so 3,844 cheques carry no book. This reads
 * the payments feed (read-only), maps each cheque's payment to a CheckBook by
 * code, and sets `checkBookId` — whichever company the book is filed under: a
 * cheque book is a bank account shared across companies (spec §E, measured
 * 2026-10-05), so there is no company check. Nothing else is written; status
 * never (rule 4).
 */
export const CHECK_BOOK_BACKFILL_ACTION = 'check_book_backfilled_from_acumatica'
export const CHECK_BOOK_REALIGN_ACTION = 'check_book_realigned_to_acumatica'
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export type CheckBookCandidate = { checkId: string; checkNumber: string; acumaticaPaymentId: string; checkBookId: string; checkBookCode: string }
/**
 * A cheque whose book (a leftover of the register) differs from the one
 * Acumatica's CashAccount names (spec §G1). `toCheckBookId` is null when
 * `code` is not a cheque book — per Acumatica the cheque is in no book.
 */
export type CheckBookRealign = {
  checkId: string
  checkNumber: string
  acumaticaPaymentId: string
  fromCheckBookId: string
  fromCode: string
  toCheckBookId: string | null
  code: string
}
export type CheckBookPlan = {
  /** Cheques with no book (the fill). */
  scanned: number
  candidates: CheckBookCandidate[]
  notInFeed: number
  notABook: Record<string, number>
  /** Booked cheques whose book differs from Acumatica's, and Acumatica's code is a book. */
  realign: CheckBookRealign[]
  /** Booked cheques whose Acumatica code is not a cheque book. */
  clear: CheckBookRealign[]
}

export async function planCheckBookBackfill(db: PrismaClient, client: AcumaticaClient, tenant: AcumaticaTenant): Promise<CheckBookPlan> {
  const rows = await client.fetchAll(PAYMENTS_FEED, {
    select: ['Type', 'ReferenceNbr', 'CashAccount'],
    filter: paymentsInScopeFilter(),
    orderby: 'LastModifiedOn asc',
    pageSize: 2000,
  })
  // A voided cheque is two rows under one reference; the original Payment row wins.
  const codeByRef = new Map<string, string>()
  for (const r of rows) {
    const ref = text(r.ReferenceNbr)
    const code = text(r.CashAccount)
    if (!ref || !code) continue
    if (!codeByRef.has(ref) || text(r.Type) === 'Payment') codeByRef.set(ref, code)
  }

  const books = await db.checkBook.findMany({ select: { id: true, code: true } })
  const bookByCode = new Map(books.map((b) => [b.code, b]))
  const cheques = await db.check.findMany({
    where: { acumaticaTenant: tenant, acumaticaPaymentId: { not: null }, checkBookId: null },
    select: { id: true, checkNumber: true, acumaticaPaymentId: true },
    orderBy: [{ checkNumber: 'asc' }, { id: 'asc' }],
  })

  const plan: CheckBookPlan = { scanned: cheques.length, candidates: [], notInFeed: 0, notABook: {}, realign: [], clear: [] }
  for (const c of cheques) {
    const raw = codeByRef.get(c.acumaticaPaymentId!)
    if (!raw) { plan.notInFeed++; continue }
    const code = canonicalCheckBookCode(raw)
    const book = bookByCode.get(code)
    if (!book) { plan.notABook[code] = (plan.notABook[code] ?? 0) + 1; continue }
    plan.candidates.push({ checkId: c.id, checkNumber: c.checkNumber, acumaticaPaymentId: c.acumaticaPaymentId!, checkBookId: book.id, checkBookCode: code })
  }

  // Spec §G1: a booked Acumatica cheque follows the book Acumatica names. A
  // payment not in the feed, or a row with no CashAccount, leaves it alone.
  const booked = await db.check.findMany({
    where: { acumaticaTenant: tenant, acumaticaPaymentId: { not: null }, checkBookId: { not: null } },
    select: { id: true, checkNumber: true, acumaticaPaymentId: true, checkBookId: true, checkBook: { select: { code: true } } },
    orderBy: [{ checkNumber: 'asc' }, { id: 'asc' }],
  })
  for (const c of booked) {
    // The alias is applied before the comparison, so a cheque held on the
    // canonical book is never realigned onto the alias Acumatica names.
    const raw = codeByRef.get(c.acumaticaPaymentId!)
    const code = raw ? canonicalCheckBookCode(raw) : undefined
    if (!code || !c.checkBook || c.checkBook.code === code) continue
    const book = bookByCode.get(code)
    const row: CheckBookRealign = {
      checkId: c.id, checkNumber: c.checkNumber, acumaticaPaymentId: c.acumaticaPaymentId!,
      fromCheckBookId: c.checkBookId!, fromCode: c.checkBook.code, toCheckBookId: book?.id ?? null, code,
    }
    ;(book ? plan.realign : plan.clear).push(row)
  }
  return plan
}

/** One transaction per cheque, conditional on it still having no book. Returns how many were set. */
export async function applyCheckBookBackfill(db: PrismaClient, candidates: readonly CheckBookCandidate[]): Promise<number> {
  let set = 0
  for (const c of candidates) {
    const done = await db.$transaction(async (tx) => {
      const r = await tx.check.updateMany({ where: { id: c.checkId, checkBookId: null }, data: { checkBookId: c.checkBookId } })
      if (!r.count) return false
      await writeAudit(tx, {
        checkId: c.checkId, actorType: 'SYSTEM', action: CHECK_BOOK_BACKFILL_ACTION,
        details: { checkBookCode: c.checkBookCode, acumaticaPaymentId: c.acumaticaPaymentId },
        remarks: `Check book ${c.checkBookCode} recorded from Acumatica's CashAccount for payment ${c.acumaticaPaymentId}. Status unchanged.`,
      })
      return true
    }, TX_OPTIONS)
    if (done) set++
  }
  return set
}

/**
 * Realign (or clear) booked cheques to Acumatica's book (spec §G1). One
 * transaction per cheque, conditional on its book still being the planned
 * `from`. Writes checkBookId only, never status. Returns how many changed.
 */
export async function applyCheckBookRealign(db: PrismaClient, rows: readonly CheckBookRealign[]): Promise<number> {
  let changed = 0
  for (const c of rows) {
    const done = await db.$transaction(async (tx) => {
      const r = await tx.check.updateMany({ where: { id: c.checkId, checkBookId: c.fromCheckBookId }, data: { checkBookId: c.toCheckBookId } })
      if (!r.count) return false
      const to = c.toCheckBookId ? c.code : null
      await writeAudit(tx, {
        checkId: c.checkId, actorType: 'SYSTEM', action: CHECK_BOOK_REALIGN_ACTION,
        details: { from: c.fromCode, to, code: c.code, acumaticaPaymentId: c.acumaticaPaymentId },
        remarks: to
          ? `Check book moved from ${c.fromCode} to ${to}, as Acumatica's CashAccount states for payment ${c.acumaticaPaymentId}. Status unchanged.`
          : `Check book ${c.fromCode} cleared: Acumatica's CashAccount for payment ${c.acumaticaPaymentId} is ${c.code}, which is not a check book. Status unchanged.`,
      })
      return true
    }, TX_OPTIONS)
    if (done) changed++
  }
  return changed
}
