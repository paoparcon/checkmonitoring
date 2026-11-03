import { slugify } from './export/report'

/** The numbering screen's arithmetic — parameters, hrefs, labels, the filename. Pure. */
export const NUMBERING_PATH = '/numbering'
export const NUMBERING_EXPORT_PATH = '/api/export/numbering'

export type NumberingParams = { company?: string; account?: string; missing?: boolean }

export function numberingHref(p: NumberingParams, path: string = NUMBERING_PATH): string {
  const qs = new URLSearchParams()
  const company = p.company?.trim()
  const account = p.account?.trim()
  if (company) qs.set('company', company)
  if (account) qs.set('account', account)
  if (p.missing) qs.set('missing', '1')
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
  f: { company?: string | null; account?: string | null; missingOnly?: boolean },
): string {
  const parts: string[] = []
  if (f.company) parts.push(`COMPANY: ${f.company}`)
  if (f.account) parts.push(`CHECK BOOK: ${f.account}`)
  if (f.missingOnly) parts.push('MISSING ONLY')
  return parts.length ? parts.join('  ·  ') : 'No filters applied'
}

export function missingLabel(e: { from: string; to: string; count: string }): string {
  const range = e.from === e.to ? e.from : `${e.from} – ${e.to}`
  return `${range} · MISSING · ${e.count}`
}

export function numberingFilename(day: string): string {
  return `${slugify('check numbering')}-${day}.xlsx`
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
  'left out of the gap count. ' +
  'INVENTORY: every number, held by a check or MISSING, has a tick box and a remarks field, so the physical ' +
  'count is recorded here; a run of more than 100 missing numbers is one line with one tick and one remark for ' +
  'the whole run, and opens on a click. SAVE INVENTORY records the changes; every tick and remark is on the audit trail.'
