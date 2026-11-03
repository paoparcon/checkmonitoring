import type { PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { PAYMENTS_FEED, type AcumaticaClient } from '@/lib/integrations/acumatica/client'
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'
import { paymentsInScopeFilter } from '@/lib/sync/run'

/**
 * Acumatica accounts that were missing from reference data (user ruling
 * 2026-10-16). Their checks had no account here, so READY FOR RELEASE and
 * MARK RELEASED refused them ("missing CASH ACCOUNT / CHECK BOOK") and RECON
 * held them in no account.
 *
 * PAYROLL is the clearing account, at BPI. It is a CASH ACCOUNT, not a check
 * book: it is shared by every company and is not one numbered series, so
 * NUMBERING must not read it as one. Its `companyId` decides nothing (a
 * reference row must name one; cash accounts, like books, are read by code).
 * MBT-S-9048 is an MBTC check book, separate from MBT-A-9048, and takes that
 * book's company for the same reason.
 */
export const CLEARING_CASH_ACCOUNT = { code: 'PAYROLL', bankCode: 'BPI', companyCode: 'STK' } as const
export const EXTRA_CHECK_BOOK = { code: 'MBT-S-9048', bankCode: 'MBTC', sameCompanyAs: 'MBT-A-9048' } as const

export const CASH_ACCOUNT_LINK_ACTION = 'cash_account_linked_from_acumatica'

export type CashAccountLink = { checkId: string; checkNumber: string; acumaticaPaymentId: string; status: string }

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim())

/** Creates the two reference rows if absent. Idempotent; returns the codes it created. */
export async function ensureClearingReferenceRows(db: PrismaClient): Promise<string[]> {
  const created: string[] = []
  if (!(await db.cashAccount.findUnique({ where: { code: CLEARING_CASH_ACCOUNT.code } }))) {
    const bank = await db.bank.findUniqueOrThrow({ where: { code: CLEARING_CASH_ACCOUNT.bankCode } })
    const company = await db.company.findUniqueOrThrow({ where: { code: CLEARING_CASH_ACCOUNT.companyCode } })
    await db.cashAccount.create({ data: { code: CLEARING_CASH_ACCOUNT.code, bankId: bank.id, companyId: company.id } })
    created.push(CLEARING_CASH_ACCOUNT.code)
  }
  if (!(await db.checkBook.findUnique({ where: { code: EXTRA_CHECK_BOOK.code } }))) {
    const bank = await db.bank.findUniqueOrThrow({ where: { code: EXTRA_CHECK_BOOK.bankCode } })
    const sibling = await db.checkBook.findUniqueOrThrow({ where: { code: EXTRA_CHECK_BOOK.sameCompanyAs } })
    await db.checkBook.create({ data: { code: EXTRA_CHECK_BOOK.code, bankId: bank.id, companyId: sibling.companyId } })
    created.push(EXTRA_CHECK_BOOK.code)
  }
  return created
}

/**
 * The tenant's Acumatica checks with no cash account and no check book whose
 * payment names `code` in Acumatica. A read: writes nothing.
 */
export async function planCashAccountLink(
  db: PrismaClient, client: AcumaticaClient, tenant: AcumaticaTenant, code: string,
): Promise<CashAccountLink[]> {
  const rows = await client.fetchAll(PAYMENTS_FEED, {
    select: ['Type', 'ReferenceNbr', 'CashAccount'],
    filter: paymentsInScopeFilter(),
    orderby: 'LastModifiedOn asc',
    pageSize: 2000,
  })
  // A voided check is two rows under one reference; the original Payment row wins.
  const codeByRef = new Map<string, string>()
  for (const r of rows) {
    const ref = text(r.ReferenceNbr)
    const c = text(r.CashAccount)
    if (!ref || !c) continue
    if (!codeByRef.has(ref) || text(r.Type) === 'Payment') codeByRef.set(ref, c)
  }
  const checks = await db.check.findMany({
    where: { acumaticaTenant: tenant, acumaticaPaymentId: { not: null }, cashAccountId: null, checkBookId: null },
    select: { id: true, checkNumber: true, acumaticaPaymentId: true, status: true },
    orderBy: [{ checkNumber: 'asc' }, { id: 'asc' }],
  })
  return checks
    .filter((c) => codeByRef.get(c.acumaticaPaymentId!) === code)
    .map((c) => ({ checkId: c.id, checkNumber: c.checkNumber, acumaticaPaymentId: c.acumaticaPaymentId!, status: c.status }))
}

/** One transaction per check, conditional on it still having no account. Writes cashAccountId only, never status. */
export async function applyCashAccountLink(db: PrismaClient, code: string, links: readonly CashAccountLink[]): Promise<number> {
  const account = await db.cashAccount.findUniqueOrThrow({ where: { code } })
  let set = 0
  for (const l of links) {
    const done = await db.$transaction(async (tx) => {
      const r = await tx.check.updateMany({
        where: { id: l.checkId, cashAccountId: null, checkBookId: null },
        data: { cashAccountId: account.id },
      })
      if (!r.count) return false
      await writeAudit(tx, {
        checkId: l.checkId, actorType: 'SYSTEM', action: CASH_ACCOUNT_LINK_ACTION,
        details: { cashAccountCode: code, acumaticaPaymentId: l.acumaticaPaymentId },
        remarks: `Cash account ${code} recorded from Acumatica's CashAccount for payment ${l.acumaticaPaymentId}. Status unchanged.`,
      })
      return true
    }, { timeout: 30_000, maxWait: 15_000 })
    if (done) set++
  }
  return set
}
