/**
 * `SyncRun.mode` values written by reads that are NOT the payment feed.
 *
 * The payment sync (lib/sync/run.ts) owns FULL and INCREMENTAL; its watermark,
 * its one-run-at-a-time guard and the dashboard's ACUMATICA LAST READ
 * (lib/admin/sync-overview.ts) must look past every mode listed here, because
 * each is a different feed with its own watermark:
 *   BILLS      lib/sync/bills.ts      AP-PAYMENTS-WITH-BILLS -> Check.apvNumbers
 *   BILL_REFS  lib/sync/bill-refs.ts  AP-Bills and Adjustments -> AcumaticaBill
 *   PORTAL_CHECKS  lib/sync/portal-checks.ts  every Check -> the Supplier Portal's check list (a push, not a read; tenant null)
 * A new read adds its mode HERE, once, not in three where clauses. Leaf module.
 */
export const BILLS_MODE = 'BILLS'
export const BILL_REFS_MODE = 'BILL_REFS'
export const PORTAL_CHECKS_MODE = 'PORTAL_CHECKS'
export const NON_PAYMENT_MODES = [BILLS_MODE, BILL_REFS_MODE, PORTAL_CHECKS_MODE] as const
