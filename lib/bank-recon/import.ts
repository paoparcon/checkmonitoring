import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { dayToDate } from '@/lib/domain/details'
import type { CashSheetAccount, CashSheetTotal } from './cash-sheet'

/**
 * THE CASH WORKBOOK, STORED (2026-11-09).
 *
 * `planCashImport` reads and writes nothing: it says, cell by cell, what an
 * upload would do — NEW (no bank balance held for that account and day),
 * SAME, or CHANGED (a different figure is held; both are shown). The
 * confirmation re-reads the same file and `applyCashImport` plans it again
 * inside the transaction, so it can only apply what the file says now.
 *
 * It writes the BANK side only — `bankBalance`, its source cell, who and when.
 * The book balance and deposits in transit Finance typed on the same row are
 * never touched. An
 * account's wording follows the newest upload. Nothing is deleted: an account
 * or a month absent from a file is simply not in it. One
 * `cash_balances_imported` audit row per upload, carrying every changed
 * figure with its before and after.
 */
type Db = PrismaClient | Prisma.TransactionClient

export type BalanceChange = { key: string; label: string; day: string; cell: string; before: string; after: string }
export type CashImportPlan = {
  fileName: string
  sheet: string
  days: string[]
  accounts: number
  newAccounts: string[]
  created: number
  changed: BalanceChange[]
  same: number
  /** New figures per day, newest first — where an upload's weight is. */
  createdByDay: { day: string; count: number }[]
  problems: string[]
  totals: CashSheetTotal[]
}
export type CashImportSummary = { accountsCreated: number; created: number; updated: number; unchanged: number }

/** The same budget the register import needs (CLAUDE.md, "Prisma's interactive-transaction defaults"). */
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const
const MAX_AUDITED_CHANGES = 500

type Read = { sheet: string; days: string[]; accounts: CashSheetAccount[]; problems: string[]; totals: CashSheetTotal[] }
type Held = { id: string; accountId: string; day: string; bankBalance: string | null }

async function holdings(db: Db, keys: string[]) {
  const accounts = await db.cashLedgerAccount.findMany({ where: { key: { in: keys } } })
  const balances = accounts.length === 0 ? [] : await db.cashBalance.findMany({
    where: { accountId: { in: accounts.map((a) => a.id) } },
    select: { id: true, accountId: true, asOf: true, bankBalance: true },
  })
  const held = new Map<string, Held>()
  for (const b of balances) {
    const day = b.asOf.toISOString().slice(0, 10)
    held.set(`${b.accountId}|${day}`, { id: b.id, accountId: b.accountId, day, bankBalance: b.bankBalance?.toFixed(2) ?? null })
  }
  return { accounts: new Map(accounts.map((a) => [a.key, a])), held }
}

export async function planCashImport(db: Db, read: Read, fileName: string): Promise<CashImportPlan> {
  const { accounts, held } = await holdings(db, read.accounts.map((a) => a.key))
  const changed: BalanceChange[] = []
  const perDay = new Map<string, number>()
  let created = 0
  let same = 0
  for (const a of read.accounts) {
    const existing = accounts.get(a.key)
    for (const b of a.balances) {
      const prior = existing ? held.get(`${existing.id}|${b.day}`)?.bankBalance ?? null : null
      if (prior === null) { created += 1; perDay.set(b.day, (perDay.get(b.day) ?? 0) + 1) }
      else if (prior === b.amount) same += 1
      else changed.push({ key: a.key, label: a.label, day: b.day, cell: b.cell, before: prior, after: b.amount })
    }
  }
  return {
    fileName, sheet: read.sheet, days: read.days, accounts: read.accounts.length,
    newAccounts: read.accounts.filter((a) => !accounts.has(a.key)).map((a) => a.label),
    created, changed, same,
    createdByDay: [...perDay.entries()].map(([day, count]) => ({ day, count })).sort((x, y) => y.day.localeCompare(x.day)),
    problems: read.problems, totals: read.totals,
  }
}

export async function applyCashImport(
  db: PrismaClient,
  read: Read,
  input: { fileName: string; userId: string; now: Date },
): Promise<CashImportSummary> {
  return db.$transaction(async (tx) => {
    const before = await holdings(tx, read.accounts.map((a) => a.key))
    const missing = read.accounts.filter((a) => !before.accounts.has(a.key))
    if (missing.length > 0) {
      await tx.cashLedgerAccount.createMany({
        data: missing.map((a) => ({
          key: a.key, label: a.label, companyLabel: a.companyLabel, glAccount: a.glAccount,
          description: a.description, accountNumber: a.accountNumber, currency: a.currency, position: a.row,
        })),
      })
    }
    // The wording and the order follow the newest upload; only a line that differs is written.
    for (const a of read.accounts) {
      const e = before.accounts.get(a.key)
      if (!e) continue
      if (e.label !== a.label || e.companyLabel !== a.companyLabel || e.glAccount !== a.glAccount
        || e.description !== a.description || e.currency !== a.currency || e.position !== a.row) {
        await tx.cashLedgerAccount.update({
          where: { id: e.id },
          data: { label: a.label, companyLabel: a.companyLabel, glAccount: a.glAccount, description: a.description, currency: a.currency, position: a.row },
        })
      }
    }
    const { accounts, held } = await holdings(tx, read.accounts.map((a) => a.key))

    const source = (cell: string) => `${input.fileName} › ${read.sheet}!${cell}`
    const toCreate: Prisma.CashBalanceCreateManyInput[] = []
    const changes: BalanceChange[] = []
    let updated = 0
    let unchanged = 0
    let created = 0
    for (const a of read.accounts) {
      const account = accounts.get(a.key)!
      for (const b of a.balances) {
        const row = held.get(`${account.id}|${b.day}`)
        const bank = { bankBalance: b.amount, bankSource: source(b.cell), bankRecordedById: input.userId, bankRecordedAt: input.now }
        if (!row) {
          toCreate.push({ accountId: account.id, asOf: dayToDate(b.day), ...bank })
          created += 1
        } else if (row.bankBalance === b.amount) {
          unchanged += 1
        } else {
          // A row Finance typed a book balance on, with no bank balance yet, is NEW to the bank side.
          await tx.cashBalance.update({ where: { id: row.id }, data: bank })
          if (row.bankBalance === null) created += 1
          else { updated += 1; changes.push({ key: a.key, label: a.label, day: b.day, cell: b.cell, before: row.bankBalance, after: b.amount }) }
        }
      }
    }
    if (toCreate.length > 0) await tx.cashBalance.createMany({ data: toCreate })

    await writeAudit(tx, {
      actorType: 'USER', userId: input.userId, action: 'cash_balances_imported',
      details: {
        file: input.fileName, sheet: read.sheet, days: read.days,
        accounts: read.accounts.length, accountsCreated: missing.length,
        created, updated, unchanged,
        changes: changes.slice(0, MAX_AUDITED_CHANGES),
        changesNotListed: Math.max(0, changes.length - MAX_AUDITED_CHANGES),
        problems: read.problems,
        totalsDisagreeing: read.totals.filter((t) => !t.agrees).map((t) => ({ day: t.day, sheetTotal: t.sheetTotal, linesTotal: t.linesTotal })),
      },
      remarks: `Bank balances from ${input.fileName}: ${created} new, ${updated} changed, ${unchanged} unchanged.`,
    })
    return { accountsCreated: missing.length, created, updated, unchanged }
  }, TX_OPTIONS)
}
