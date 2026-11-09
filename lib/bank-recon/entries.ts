import type { PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { isIsoDay, dayToDate } from '@/lib/domain/details'
import { parseAmountBound } from '@/lib/column-filters'
import { toCentavos, fromCentavos } from '@/lib/export/report'

/**
 * THE BOOK SIDE, TYPED (2026-11-09): for an account and a day, the BOOK
 * balance per the ledger and the deposits in transit, with a note. Every
 * Finance user. A blank box is "not known", never zero — clearing a box clears
 * the figure. Only a row that differs from what is held is written, each with
 * its own `bank_recon_recorded` audit row carrying the before and the after.
 * The BANK balance on the same row belongs to the workbook upload and is never
 * written here. A day after today is refused: nothing has been booked for it.
 */
export type BookFigureInput = { accountId: string; bookBalance: string; depositsInTransit: string; note: string }
export type BookFigureResult =
  | { accountId: string; outcome: 'SAVED' | 'UNCHANGED' }
  | { accountId: string; outcome: 'REFUSED'; message: string }

export const MAX_NOTE = 500

/**
 * Money as typed → a two-decimal string, `null` for a blank box, or
 * `'INVALID'`. Thousands separators as the filter row takes them; a leading
 * minus only where the caller allows it (a book balance can be overdrawn by checks not yet presented).
 */
export function parseTypedMoney(raw: string, opts: { allowNegative: boolean }): string | null | 'INVALID' {
  const t = raw.trim()
  if (t === '') return null
  const negative = t.startsWith('-')
  if (negative && !opts.allowNegative) return 'INVALID'
  const v = parseAmountBound(negative ? t.slice(1) : t)
  if (v === null) return 'INVALID'
  const cents = toCentavos(v)
  return fromCentavos(negative ? -cents : cents)
}

export async function recordBookFigures(
  db: PrismaClient,
  input: { userId: string; asOfDay: string; todayDay: string; entries: readonly BookFigureInput[]; now: Date },
): Promise<{ ok: true; results: BookFigureResult[] } | { ok: false; message: string }> {
  if (!isIsoDay(input.asOfDay)) return { ok: false, message: 'The reconciliation day is not a real day.' }
  if (input.asOfDay > input.todayDay) return { ok: false, message: `${input.asOfDay} has not happened yet — there is nothing to reconcile.` }
  const asOf = dayToDate(input.asOfDay)

  // One read for the whole form: a row that already says what is held needs no
  // transaction. Twenty-one of them, one round trip each, made a save take 7.7 s.
  const ids = [...new Set(input.entries.map((e) => e.accountId))]
  const heldNow = ids.length === 0 ? [] : await db.cashBalance.findMany({
    where: { asOf, accountId: { in: ids } },
    select: { accountId: true, bookBalance: true, depositsInTransit: true, note: true },
  })
  const heldBy = new Map(heldNow.map((h) => [h.accountId, h]))
  const known = ids.length === 0 ? new Set<string>() : new Set(
    (await db.cashLedgerAccount.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((a) => a.id),
  )

  const results: BookFigureResult[] = []
  for (const e of input.entries) {
    const book = parseTypedMoney(e.bookBalance, { allowNegative: true })
    const dit = parseTypedMoney(e.depositsInTransit, { allowNegative: false })
    const note = e.note.trim() === '' ? null : e.note.trim()
    if (book === 'INVALID') { results.push({ accountId: e.accountId, outcome: 'REFUSED', message: `BOOK BALANCE "${e.bookBalance.trim()}" is not an amount.` }); continue }
    if (dit === 'INVALID') { results.push({ accountId: e.accountId, outcome: 'REFUSED', message: `DEPOSITS IN TRANSIT "${e.depositsInTransit.trim()}" is not an amount (it cannot be negative).` }); continue }
    if (note !== null && note.length > MAX_NOTE) { results.push({ accountId: e.accountId, outcome: 'REFUSED', message: `The note is longer than ${MAX_NOTE} characters.` }); continue }

    if (known.has(e.accountId)) {
      const h = heldBy.get(e.accountId)
      if ((h?.bookBalance?.toFixed(2) ?? null) === book && (h?.depositsInTransit?.toFixed(2) ?? null) === dit && (h?.note ?? null) === note) {
        results.push({ accountId: e.accountId, outcome: 'UNCHANGED' })
        continue
      }
    }

    // A row that differs is read again inside its transaction, so it is judged on what is held then.
    const outcome = await db.$transaction(async (tx): Promise<BookFigureResult> => {
      const account = await tx.cashLedgerAccount.findUnique({ where: { id: e.accountId } })
      if (!account) return { accountId: e.accountId, outcome: 'REFUSED', message: 'That account is not on the cash schedule.' }
      const held = await tx.cashBalance.findUnique({ where: { accountId_asOf: { accountId: account.id, asOf } } })
      const before = {
        bookBalance: held?.bookBalance?.toFixed(2) ?? null,
        depositsInTransit: held?.depositsInTransit?.toFixed(2) ?? null,
        note: held?.note ?? null,
      }
      const after = { bookBalance: book, depositsInTransit: dit, note }
      if (before.bookBalance === after.bookBalance && before.depositsInTransit === after.depositsInTransit && before.note === after.note) {
        return { accountId: e.accountId, outcome: 'UNCHANGED' }
      }
      const data = { ...after, bookRecordedById: input.userId, bookRecordedAt: input.now }
      if (held) await tx.cashBalance.update({ where: { id: held.id }, data })
      else await tx.cashBalance.create({ data: { accountId: account.id, asOf, ...data } })
      await writeAudit(tx, {
        actorType: 'USER', userId: input.userId, action: 'bank_recon_recorded',
        details: { accountId: account.id, account: account.label, asOf: input.asOfDay, before, after },
        remarks: `Book balance and deposits in transit for ${account.label} as of ${input.asOfDay}.`,
      })
      return { accountId: e.accountId, outcome: 'SAVED' }
    })
    results.push(outcome)
  }
  return { ok: true, results }
}
