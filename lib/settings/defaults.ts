/**
 * THE NUMBERS, AS A LEAF.
 *
 * Each threshold's reasoning lives beside the constant that uses it —
 * `STALE_AFTER_HOURS` in lib/sync/staleness.ts, `MAX_BULK_SELECTION` in
 * lib/bulk.ts, and so on — and each of those constants is now DEFINED from
 * the value here. The registry (lib/settings/registry.ts) reads only this
 * file, so it imports no server module: before this leaf existed it imported
 * lib/sync/run.ts for one number, and run.ts reaches the domain through the
 * importer, which closed a cycle in which the registry could read the number
 * before run.ts had initialised it (found in review, 2026-09-12, twice).
 *
 * This file imports nothing. Change a number here and the constant, the
 * registry's default and the screen's DEFAULT all move together.
 */
export const DEFAULT_STALE_AFTER_HOURS = 30
export const DEFAULT_ABANDONED_AFTER_MINUTES = 90
export const DEFAULT_SYNC_IN_PROGRESS_MINUTES = 10
export const DEFAULT_MAX_BULK_SELECTION = 50
export const DEFAULT_EXPORT_ROW_LIMIT = 10_000
export const DEFAULT_VOUCHER_SCREEN_ROW_LIMIT = 200
export const DEFAULT_WINDOW_MINUTES = 15
export const DEFAULT_EMAIL_FREE_FAILURES = 4
export const DEFAULT_IP_FREE_FAILURES = 20

/**
 * Registrations one client address may submit on /signup per rolling hour.
 * Five covers a Finance office behind one NAT signing up on the same morning
 * with room for a mistyped form; a bot exhausts it in seconds and waits.
 */
export const DEFAULT_SIGNUP_IP_PER_HOUR = 5
