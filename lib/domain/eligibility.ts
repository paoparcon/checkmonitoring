export type Eligibility = 'SUPPLIER' | 'BROKER' | 'INTERNAL'

/**
 * Every eligibility, in the order the dashboard's dropdown offers them.
 *
 * Declared here rather than restated in the UI so a fourth classification
 * cannot appear in the domain while the filter bar goes on offering three — the
 * same drift `LIVE_STATUSES` exists to prevent for statuses. The `AssertNever`
 * below is the compile-time proof that the list is complete: adding a value to
 * the union without adding it here fails with TS2344.
 *
 * Type-only, erased at build, and costs nothing at runtime.
 */
export const ELIGIBILITIES = ['SUPPLIER', 'BROKER', 'INTERNAL'] as const satisfies readonly Eligibility[]

type AssertNever<T extends never> = T
export type _EveryEligibilityIsListed = AssertNever<
  Exclude<Eligibility, (typeof ELIGIBILITIES)[number]>
>

export type EligibilityInput = {
  // Nullable because `Check.payeeName` is: 153 register rows record no payee.
  // This is a widening of an existing safe path, not a new branch — `norm`
  // already collapses null, undefined and whitespace to '', which the first
  // guard in classifyEligibility answers INTERNAL. That answer is what stops a
  // cheque with an unknown payee reaching the supplier portal, since
  // portalRoute('INTERNAL') is null. Do not narrow this back to `string`.
  payeeName: string | null
  category: string | null
  sourceSheet?: string | null
  ownCompanyNames: readonly string[]
}

export type EligibilityResult = { eligibility: Eligibility; reason: string }

export type PortalDomain = 'LOCAL' | 'BROKER'

// The single decision of whether a check touches the Supplier Portal, and as
// what. Derived from eligibility alone — never from portalSyncStatus, which is
// mutable, defaults to NOT_APPLICABLE, and would silently route a check the
// wrong way. Every outbox write site must go through this.
export function portalRoute(eligibility: Eligibility): PortalDomain | null {
  if (eligibility === 'SUPPLIER') return 'LOCAL'
  if (eligibility === 'BROKER') return 'BROKER'
  return null // portalRoute never ROUTES an INTERNAL check; its quiet RELEASED / RELEASE_REVERSED events are queued by the actions in lib/domain/actions.ts (ruling 2026-10-19; CANCELLED no longer goes at all, ruling 2026-10-29)
}

export const INTERNAL_CATEGORIES: readonly string[] = [
  'PAYROLL', 'SALARIES', 'FTP', 'TAX', 'FUND TRANSFER',
]

export const BROKER_CATEGORIES: readonly string[] = ['BROKERS']

// Statutory and government payees. These are never suppliers and must never be
// pushed to a supplier-facing portal.
//
// LIMITATION, deliberate and load-bearing: this is a denylist, and a denylist is
// necessarily incomplete. A statutory payee whose name matches nothing here, and
// whose category column is blank, falls through to SUPPLIER. Category is the
// primary control; this list is the backstop for rows where category is missing —
// roughly 15-30% of the client's historical register. Every pattern below was
// derived from the 873 distinct payees in that register, not invented.
export const GOVERNMENT_PATTERNS: readonly RegExp[] = [
  /^SSS\b/,
  /SOCIAL SECURITY SYSTEM/,
  /BUREAU OF INTERNAL REVENUE/,
  /\bBIR\b/,
  /PAG-?IBIG/,
  /\bHDMF\b/,
  /PHILHEALTH/,
  /^BUREAU OF\b/,                       // Bureau Of Customs, Bureau of Fire Protection
  /^DEPARTMENT OF\b/,                   // Department of Labor and Employment
  /NATIONAL LABOR RELATIONS/,
  /\bNLRC\b/,
  /\bTREASURER\b/,                      // Mandaue / Quezon City Treasurer Office
  /^MUNICIPALITY OF\b/,
  /^CITY OF\b/,
  /^CITY GOVERNMENT OF\b/,
  /^PROVINCE OF\b/,
  /^PROVINCIAL (GOVERNMENT|TREASURER)/, // PROVINCIAL TREASURER' OFFICE CAVITE
  /^REPUBLIC OF THE PHILIPPINES/,
]

// Internal payees that are not government: payroll runs and petty-cash
// replenishments drawn in the group's own name, and bare fund transfers.
export const INTERNAL_PAYEE_PATTERNS: readonly RegExp[] = [
  /\bCASH[\s(]+PAYROLL\b/,              // CASH PAYROLL A1+, CASH PAYROLL STARKSON, CASH(PAYROLL)
  /\bPETTY CASH\b/,                     // SCM Petty Cash, SITIO PETTY CASH
  /^PCF\b/,                             // PCF PONDEROSA
  /\bCASH PCF\b/,                       // CASH PCF
  /^FUND TRANSFER$/,                    // anchored: the phrase is too generic unbounded
]

const norm = (s: string | null | undefined) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ')

// Real registers spell the same company several ways. The client's own data
// contains both "A1+ MULTINATIONAL PACKAGING INC." and "A1+ MULTINATIONAL
// PACKAGING INC" — exact string equality missed the second and would have
// classified an inter-company payment as a supplier payment. Compare on a key
// that ignores punctuation and the INC/INCORPORATED spelling.
const companyKey = (s: string | null | undefined) =>
  norm(s).replace(/[.,']/g, '').replace(/\bINCORPORATED\b/g, 'INC').replace(/\s+/g, ' ').trim()

// Fund transfers and manager's cheques are internal treasury movements. Their
// payees can look like ordinary third parties, so the source sheet is the only
// reliable signal.
const FT_MC_SHEETS = ['FT & MC']

export function classifyEligibility(input: EligibilityInput): EligibilityResult {
  const payee = norm(input.payeeName)
  const category = norm(input.category)
  const sheet = norm(input.sourceSheet)

  if (payee === '') {
    return { eligibility: 'INTERNAL', reason: 'UNKNOWN PAYEE' }
  }

  if (FT_MC_SHEETS.map(norm).includes(sheet)) {
    return { eligibility: 'INTERNAL', reason: 'FUND TRANSFER / MANAGER\u2019S CHECK' }
  }

  if (input.ownCompanyNames.map(companyKey).includes(companyKey(payee))) {
    return { eligibility: 'INTERNAL', reason: 'INTER-COMPANY' }
  }

  if (GOVERNMENT_PATTERNS.some((re) => re.test(payee))) {
    return { eligibility: 'INTERNAL', reason: 'GOVERNMENT / STATUTORY' }
  }

  if (INTERNAL_PAYEE_PATTERNS.some((re) => re.test(payee))) {
    return { eligibility: 'INTERNAL', reason: 'INTERNAL PAYEE' }
  }

  if (INTERNAL_CATEGORIES.includes(category)) {
    return { eligibility: 'INTERNAL', reason: `CATEGORY ${category}` }
  }

  if (BROKER_CATEGORIES.includes(category)) {
    return { eligibility: 'BROKER', reason: 'CATEGORY BROKERS' }
  }

  return { eligibility: 'SUPPLIER', reason: 'TRADE SUPPLIER' }
}
