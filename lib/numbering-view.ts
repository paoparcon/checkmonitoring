import { slugify } from './export/report'
import type { SeriesEntry } from './numbering/series'

/** The numbering screen's arithmetic — parameters, hrefs, labels, the filename. Pure. */
export const NUMBERING_PATH = '/numbering'
export const NUMBERING_EXPORT_PATH = '/api/export/numbering'

export type NumberingParams = { company?: string; account?: string; missing?: boolean; show?: NumberingShow }

/**
 * What a count on the SUMMARY opens when clicked (user request 2026-11-03:
 * "those numbers should be clickable"): the book's lines with the matching kit
 * filter already in force. MISSING uses `missing=1` (the server's MISSING
 * ONLY view) and HELD opens the book plain; NOT NUMERIC and OUT OF PATTERN are
 * their own tables, reached by anchor.
 */
export const NUMBERING_SHOWS = ['voided', 'cancelled', 'staged', 'ticked', 'noBook'] as const
export type NumberingShow = (typeof NUMBERING_SHOWS)[number]

export function parseShow(value: string | null | undefined): NumberingShow | undefined {
  const v = (value ?? '').trim()
  return (NUMBERING_SHOWS as readonly string[]).includes(v) ? (v as NumberingShow) : undefined
}

/** The kit filters a `show` opens with: STATUS is a text column ("contains"), INVENTORY an enum (`=` exact). */
export function showFilters(show: NumberingShow | undefined): Record<string, string> {
  switch (show) {
    case 'voided': return { status: 'VOIDED' }
    case 'cancelled': return { status: 'CANCELLED' }
    case 'staged': return { status: 'STAGED' }
    case 'ticked': return { inventory: '=TICKED' }
    case 'noBook': return { status: 'NO CHECK BOOK' }
    default: return {}
  }
}

export const SHOW_LABELS: Readonly<Record<NumberingShow, string>> = {
  voided: 'VOIDED', cancelled: 'CANCELLED', staged: 'STAGED', ticked: 'TICKED', noBook: 'NO CHECK BOOK',
}

export function numberingHref(p: NumberingParams, path: string = NUMBERING_PATH): string {
  const qs = new URLSearchParams()
  const company = p.company?.trim()
  const account = p.account?.trim()
  if (company) qs.set('company', company)
  if (account) qs.set('account', account)
  if (p.missing) qs.set('missing', '1')
  if (p.show) qs.set('show', p.show)
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

export function isMissingOnly(value: string | null | undefined): boolean {
  return (value ?? '').trim() === '1'
}

/** MISSING ONLY keeps the gaps: a run line and every number listed one by one (spec §H). */
export function visibleEntries<T extends { kind: string }>(entries: readonly T[], missingOnly: boolean): T[] {
  return missingOnly ? entries.filter((e) => e.kind === 'MISSING' || e.kind === 'MISSING_NUMBER') : [...entries]
}

export function describeNumberingFilters(
  f: { company?: string | null; account?: string | null; missingOnly?: boolean; show?: NumberingShow },
): string {
  const parts: string[] = []
  if (f.company) parts.push(`COMPANY: ${f.company}`)
  if (f.account) parts.push(`CHECK BOOK: ${f.account}`)
  if (f.missingOnly) parts.push('MISSING ONLY')
  if (f.show) parts.push(`SHOWING: ${SHOW_LABELS[f.show]}`)
  return parts.length ? parts.join('  ·  ') : 'No filters applied'
}

export function missingLabel(e: { from: string; to: string; count: string }): string {
  const range = e.from === e.to ? e.from : `${e.from} – ${e.to}`
  return `${range} · MISSING · ${e.count}`
}

export function numberingFilename(day: string): string {
  return `${slugify('check numbering')}-${day}.xlsx`
}

/**
 * Distinct checks with no check book shown somewhere in the given series
 * (spec §I) — one spanning two books' sequences is in both and counts once.
 */
export function unbookedShown(accounts: readonly { series: { entries: readonly SeriesEntry[] } }[]): number {
  const ids = new Set<string>()
  for (const a of accounts) for (const e of a.series.entries) if (e.kind === 'CHECK' && e.noBook) ids.add(e.cheque.id)
  return ids.size
}

export type NumberingTotals = {
  books: number; held: number; voided: number; cancelled: number; staged: number
  /** Decimal strings: a MISSING run can be billions, and ticks count every number a ticked run spans. */
  missingNumbers: string; missingRuns: number; ticked: string
  notNumeric: number; outOfPattern: number; noBook: number
}

/**
 * The SUMMARY's TOTAL row (user request 2026-11-03: "have a total number of
 * checks"): every count column summed over the books shown. HELD is the total
 * number of checks in the sequences — distinct numbers held, every status. Pure.
 */
export function numberingTotals(
  accounts: readonly { series: { summary: Omit<NumberingTotals, 'books' | 'ticked'> & { first?: unknown } }; inventory: { ticked: string } }[],
): NumberingTotals {
  const t: NumberingTotals = { books: accounts.length, held: 0, voided: 0, cancelled: 0, staged: 0, missingNumbers: '0', missingRuns: 0, ticked: '0', notNumeric: 0, outOfPattern: 0, noBook: 0 }
  let missing = BigInt(0)
  let ticked = BigInt(0)
  for (const a of accounts) {
    const s = a.series.summary
    t.held += s.held; t.voided += s.voided; t.cancelled += s.cancelled; t.staged += s.staged
    t.missingRuns += s.missingRuns; t.notNumeric += s.notNumeric; t.outOfPattern += s.outOfPattern; t.noBook += s.noBook
    missing += BigInt(s.missingNumbers)
    ticked += BigInt(a.inventory.ticked)
  }
  t.missingNumbers = missing.toString()
  t.ticked = ticked.toString()
  return t
}

/** The page's headline over the books shown: "TOTAL CHECKS: 11,043 HELD IN 9 CHECK BOOKS". */
export function totalChecksLine(t: Pick<NumberingTotals, 'books' | 'held'>): string {
  return `TOTAL CHECKS: ${t.held.toLocaleString('en-PH')} HELD IN ${t.books.toLocaleString('en-PH')} CHECK BOOK${t.books === 1 ? '' : 'S'}`
}

/** The no-book checks (spec §I): how many there are and how many a series shows, stated on the page and on SUMMARY. */
export function noBookLine(count: number, shown: number): string {
  const n = count.toLocaleString('en-PH')
  const s = shown.toLocaleString('en-PH')
  return `${n} CHECK${count === 1 ? '' : 'S'} WITH NO CHECK BOOK (ACUMATICA POSTED THEM ON A CASH ACCOUNT SUCH AS PAYROLL): ` +
    `${s} SHOWN IN THE SERIES ${shown === 1 ? 'ITS' : 'THEIR'} NUMBER FALLS IN, TAGGED NO CHECK BOOK; THE REST ARE OUTSIDE EVERY BOOK'S RANGE AND IN NO SERIES.`
}

/** The register-only cheques NUMBERING leaves out (spec §G2), stated on the page and on SUMMARY. */
export function registerOnlyLine(count: number): string {
  return count === 1
    ? '1 REGISTER-ONLY CHECK (NOT IN ACUMATICA) IS NOT SHOWN.'
    : `${count.toLocaleString('en-PH')} REGISTER-ONLY CHECKS (NOT IN ACUMATICA) ARE NOT SHOWN.`
}

/** Printed on the page and in the file (spec §B2): what MISSING cannot tell you. */
export const NUMBERING_SCOPE_NOTE =
  'MISSING means no check in this system holds the number. Each series is one check book, built from ' +
  'Acumatica\'s own check numbers and cash accounts (e.g. BPI-S-4636); checks that exist only in the old ' +
  'register are not shown. The Acumatica sync reads payments dated 2026 ' +
  'onward, so a check book\'s first number may sit partway through a booklet; numbers before the register\'s ' +
  'history and the sync\'s 2026 scope are not known here. A number Acumatica re-used with a trailing dot (a second payment on the same check number) counts as ' +
  'used and is listed as STAGED. A check Acumatica holds with a memo in place of its number is on /admin/staged, ' +
  'not here — its number may still be one of the MISSING. A number that does not match its book\'s usual length ' +
  'and first digits is listed as OUT OF PATTERN — usually a mistyped or misfiled check number in Acumatica — and ' +
  'left out of the gap count. A check Acumatica posted on a cash account that is not a check book (PAYROLL, the ' +
  'clearing account) carries no check book; it is shown, tagged NO CHECK BOOK, in every series whose numbers span ' +
  'it, so its leaf is not reported MISSING. ' +
  'INVENTORY: every number, held by a check or MISSING, has a tick box and a remarks field, so the physical ' +
  'count is recorded here; a run of more than 100 missing numbers is one line with one tick and one remark for ' +
  'the whole run, and opens on a click. SAVE INVENTORY records the changes; every tick and remark is on the audit trail.'
