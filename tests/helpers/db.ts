import { PrismaClient } from '@prisma/client'
import { testDatabaseUrl } from './test-db-url'

export const testDb = new PrismaClient({
  datasources: { db: { url: testDatabaseUrl() } },
})

/**
 * Prisma's interactive-transaction defaults are 5s to run and 2s to acquire a
 * connection. This function issues FIFTEEN statements to Neon in
 * ap-southeast-1, and it runs from `beforeEach` in every database test file —
 * so on a slow day the truncation itself outlives the budget and the whole file
 * fails, always in `resetDb`, never on an assertion.
 *
 * It surfaces as *"Transaction not found. Transaction ID is invalid, refers to
 * an old closed transaction"*, which reads as a connection fault and sends the
 * reader to look at Neon rather than at the default. Observed 2026-09-10 across
 * `tests/export`: eight failures on one run and six on the next, every one of
 * them inside this transaction and not one an assertion — the varying count is
 * the tell that it is a timeout rather than a regression.
 *
 * The same figures `TX_OPTIONS` in lib/import/upsert.ts uses, for the same
 * reason and on the advice CLAUDE.md already gives: any new long-running write
 * loop needs them. Raised, not removed — a truncation that cannot finish inside
 * half a minute is a defect worth failing on.
 */
const RESET_TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const

export async function resetDb() {
  // Order matters: children before parents.
  await testDb.$transaction(async (tx) => {
    // The AuditLog trigger blocks DELETE. Tests are the only legitimate reason
    // to purge audit history; SET LOCAL scopes this to the transaction.
    await tx.$executeRawUnsafe(`SET LOCAL app.allow_audit_purge = 'on'`)
    await tx.auditLog.deleteMany()
    await tx.portalEvent.deleteMany()
    await tx.notification.deleteMany()
    await tx.checkBill.deleteMany()
    await tx.checkReceiptFile.deleteMany()
    await tx.check.deleteMany()
    // PlannedOutflow's bankId/companyId/createdById FKs are ON DELETE RESTRICT
    // (migration 20260912000000), so a row surviving from an earlier test would
    // block the company/bank/user deletes below with a foreign-key violation —
    // not a broken assertion, a broken beforeEach. Truncated here for the same
    // reason stagedCheck and stagedBill are: one file's rows must not become
    // another file's leftovers.
    await tx.plannedOutflow.deleteMany()
    // Not a child of Check: a staged row exists precisely because it could not
    // become one. Truncated here all the same, so a test's staging count is its
    // own.
    await tx.stagedCheck.deleteMany()
    // Not a child of Check either: a staged bill exists precisely because it
    // attaches to no cheque. Truncated here so one file's refused rows are not
    // another file's staged count.
    await tx.stagedBill.deleteMany()
    // Not a child of anything: Acumatica's bill → PO reference table
    // (lib/sync/bill-refs.ts). Truncated so one file's bills cannot put a PO
    // on another file's cheques.
    await tx.acumaticaBill.deleteMany()
    await tx.cashAccount.deleteMany()
    await tx.checkBook.deleteMany()
    await tx.vendor.deleteMany()
    await tx.company.deleteMany()
    await tx.bank.deleteMany()
    await tx.user.deleteMany()
    // Not a child of User and deliberately so — the throttle counts attempts
    // against addresses no account exists under. It is truncated here all the
    // same: a failure count that leaked in from another file's fixtures would
    // lock a login test out of an account it just created.
    await tx.loginAttempt.deleteMany()
    // The registration throttle's counter, likewise no child of User and
    // likewise truncated so one file's submissions cannot lock another file's
    // sign-up test out of its own address bucket.
    await tx.registrationAttempt.deleteMany()
    await tx.syncRun.deleteMany()
    await tx.setting.deleteMany()
  }, RESET_TX_OPTIONS)
}
