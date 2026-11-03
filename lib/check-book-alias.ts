/**
 * Acumatica cash-account codes that name a check book this system holds under
 * another code. A check book is the physical booklet — one bank account, shared
 * across companies (spec 2026-10-01 §E) — and Acumatica keeps one cash account
 * per company over the same bank account: `MBT-S-9048` (Starkson's ledger) and
 * `MBT-A-9048` (A1+'s) are both Metrobank account 9048 and tear leaves from the
 * same booklet. User ruling 2026-11-03: "this account MBT-S-9048 should be
 * MBT-A-9048. Should be transferred to the right account." Two books would put
 * 13 of the booklet's numbers in a second series and report them MISSING from
 * the first.
 *
 * The sync (`upsertCheck`) and the backfill (`planCheckBookBackfill`) look a
 * code up through here, so a payment Acumatica posts on the alias lands on the
 * canonical book and is never realigned back. Pure.
 */
export const CHECK_BOOK_ALIASES: Readonly<Record<string, string>> = {
  'MBT-S-9048': 'MBT-A-9048',
}

/** The code the check book is held under here; a code with no alias is its own. */
export function canonicalCheckBookCode(code: string): string {
  return CHECK_BOOK_ALIASES[code] ?? code
}
