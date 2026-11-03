import type { CheckStatus } from '@prisma/client'
import { canonicalCheckNumber, isBareCheckNumber } from '@/lib/import/normalise'

/**
 * One cash account's cheques in number order, with every unused number between
 * the lowest and the highest reported as MISSING — the user's rule, "every
 * number counts" (spec 2026-10-01-cheque-numbering-and-cancel-guard-design §B2).
 *
 * Pure. Numbers are compared as BigInt (they run to ten digits; text order puts
 * 999 after 1000). A gap is one line, never one row per number: the jump between
 * two booklets on one account can be billions. Every number and count leaves
 * this function as a decimal string.
 *
 * Staged re-uses (spec §C, 2026-10-02): Acumatica refuses a duplicate cheque
 * reference on a cash account, so a second payment document on the same cheque
 * number is entered with a dot appended. Such payments sit on the staged queue
 * (NO_CHECK_NUMBER); their number is USED, so it is a STAGED line, never MISSING.
 *
 * OUT OF PATTERN (spec §F, 2026-10-05): a book's numbers share one shape —
 * `numberShape`, the length without leading zeros and the first two digits. The
 * PATTERN is the shape held by the most numeric cheques (staged lines do not
 * vote; ties go to more digits, then the lower lead), and is decided only once a
 * book holds at least PATTERN_MIN_CHEQUES numeric cheques. A numeric cheque or
 * staged line of another shape — usually a mistyped or misfiled number in
 * Acumatica — is listed in `outOfPattern` and left out of the sequence: it bounds
 * no MISSING run and is not in `first` / `last`, `held`, `duplicates` or
 * `staged`. An out-of-pattern cheque is still a cheque in the book, so it still
 * counts in `voided` / `cancelled`. Nothing in the data changes.
 *
 * NO CHECK BOOK (spec §I, 2026-11-03): an Acumatica check posted on a cash
 * account that is not a check book (PAYROLL, the clearing account — 1,026 of
 * them measured that day) carries no book, so the booklet its leaf came from
 * showed a hole where it sits, labelled "no check in this system" for a check
 * that is in it. `unbooked` is every such check; one whose number matches the
 * pattern and lies STRICTLY INSIDE the book's own sequence is placed as a CHECK
 * entry flagged `noBook`, so the number is no longer MISSING. A lookup by
 * number, not a guess: it never bounds the series, never votes on the pattern,
 * and is not `held`, `voided` or `cancelled` (the book's own), but it is a
 * DUPLICATE when the book's own check shares its number, and it is counted in
 * `noBook`. Where several books' sequences span the number, it is shown in each.
 */
export type SeriesCheque = {
  id: string; checkNumber: string; checkDate: Date | null; payeeName: string | null
  amount: string | null; currency: string; status: CheckStatus
  /** Acumatica's payment reference (`Check.acumaticaPaymentId`) — the CV Finance corrects there (spec §G3). */
  cv: string | null
  /** The cash account the check is on (`CashAccount.code`, e.g. PAYROLL) — what a NO CHECK BOOK line names (spec §I). */
  cashAccount?: string | null
}
export type SeriesStaged = {
  acumaticaTenant: string; acumaticaRef: string; statedCheckRef: string; checkDate: Date | null; payeeName: string | null
  amount: string | null; currency: string | null
}
export type SeriesEntry =
  /** `noBook`: the check carries no check book and is shown here because its number falls inside this book's sequence (spec §I). */
  | { kind: 'CHECK'; cheque: SeriesCheque; duplicate: boolean; noBook: boolean }
  | { kind: 'STAGED'; staged: SeriesStaged; number: string }
  | { kind: 'MISSING'; from: string; to: string; count: string }
export type SeriesSummary = {
  first: string | null; last: string | null
  /** Distinct numbers held by CHEQUES — a duplicate counts once; staged lines do not count. */
  held: number
  voided: number; cancelled: number
  /** STAGED lines: numbers Acumatica re-used with a trailing dot. */
  staged: number
  missingNumbers: string; missingRuns: number
  notNumeric: number
  /** Cheques sharing a number with another cheque in the account. */
  duplicates: number
  /** Numeric cheques and staged lines whose shape breaks the book's pattern (spec §F). */
  outOfPattern: number
  /** Checks with no check book shown in this sequence because their number falls inside it (spec §I). */
  noBook: number
}
export type NumberShape = { digits: number; lead: string }
export type AccountSeries = {
  entries: SeriesEntry[]; notNumeric: SeriesCheque[]
  /** CHEQUE and STAGED entries, in number order, left out of the sequence. */
  outOfPattern: SeriesEntry[]
  /** The book's usual shape, or null below PATTERN_MIN_CHEQUES numeric cheques. */
  pattern: NumberShape | null
  summary: SeriesSummary
}

/** Below this many numeric cheques a book has no pattern and every number stays in. */
export const PATTERN_MIN_CHEQUES = 20

/** A number's shape: its length without leading zeros, and its first two digits after them. */
export function numberShape(n: string): NumberShape {
  const bare = n.replace(/^0+/, '')
  return { digits: bare.length, lead: bare.slice(0, 2) }
}

const sameShape = (a: NumberShape, b: NumberShape) => a.digits === b.digits && a.lead === b.lead

/** The shape held by the most numbers; ties to more digits, then the lower lead. Null below the minimum. */
function patternOf(numbers: readonly string[]): NumberShape | null {
  if (numbers.length < PATTERN_MIN_CHEQUES) return null
  const tally = new Map<string, { shape: NumberShape; count: number }>()
  for (const n of numbers) {
    const shape = numberShape(n)
    const key = `${shape.digits}|${shape.lead}`
    const t = tally.get(key)
    if (t) t.count += 1
    else tally.set(key, { shape, count: 1 })
  }
  let best: { shape: NumberShape; count: number } | null = null
  for (const t of tally.values()) {
    if (!best || t.count > best.count
      || (t.count === best.count && (t.shape.digits > best.shape.digits
        || (t.shape.digits === best.shape.digits && t.shape.lead < best.shape.lead)))) best = t
  }
  return best ? best.shape : null
}

const NUMERIC = /^\d+$/
// Not `0n` / `1n` literals: Next's file tracer (nft) evaluates BinaryExpressions
// statically and throws "Cannot mix BigInt and other types" on them, failing the build.
const ZERO = BigInt(0)
const ONE = BigInt(1)

/**
 * The cheque number a staged dotted re-use stands for, or null. The ONLY rule:
 * the trimmed reference must end with at least one dot, and with only those
 * trailing dots removed it must pass the import's own cheque-number rule. A
 * reference without a dot is not a re-use; a memo (`PCF26-00001.`) is not a
 * number. Nothing else is loosened.
 */
export function stagedSeriesNumber(statedCheckRef: string | null | undefined): string | null {
  const raw = (statedCheckRef ?? '').trim()
  if (!raw.endsWith('.')) return null
  const canonical = canonicalCheckNumber(raw.replace(/\.+$/, ''))
  return isBareCheckNumber(canonical) ? canonical : null
}

type Item =
  | { n: bigint; text: string; order: string; cheque: SeriesCheque; staged?: undefined; noBook?: boolean }
  | { n: bigint; text: string; order: string; staged: SeriesStaged; cheque?: undefined; noBook?: undefined }

export function buildSeries(
  cheques: readonly SeriesCheque[], staged: readonly SeriesStaged[] = [], unbooked: readonly SeriesCheque[] = [],
): AccountSeries {
  const all: Item[] = []
  const notNumeric: SeriesCheque[] = []
  for (const cheque of cheques) {
    const text = cheque.checkNumber.trim()
    // '0' sorts a cheque before any staged line on the same number.
    if (NUMERIC.test(text)) all.push({ n: BigInt(text), text, order: `0${cheque.id}`, cheque })
    else notNumeric.push(cheque)
  }
  // A check with no book is a candidate only; whether it is placed is decided
  // below, against the book's own pattern and bounds (spec §I).
  const candidates: Item[] = []
  for (const cheque of unbooked) {
    const text = cheque.checkNumber.trim()
    if (NUMERIC.test(text)) candidates.push({ n: BigInt(text), text, order: `0${cheque.id}`, cheque, noBook: true })
  }
  for (const s of staged) {
    const number = stagedSeriesNumber(s.statedCheckRef)
    if (number !== null) all.push({ n: BigInt(number), text: number, order: `1${s.acumaticaTenant}|${s.acumaticaRef}`, staged: s })
  }
  all.sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
  notNumeric.sort((a, b) => a.checkNumber.localeCompare(b.checkNumber) || a.id.localeCompare(b.id))

  // Only cheques vote; a staged line of another shape is judged, never counted.
  const pattern = patternOf(all.filter((x) => x.cheque).map((x) => x.text))
  const fits = (x: Item) => pattern === null || sameShape(numberShape(x.text), pattern)
  const own = all.filter(fits)
  const misfits = all.filter((x) => !fits(x))

  // A no-book check is placed only strictly inside the book's own sequence and
  // in its pattern: the book's first and last stay the book's own (spec §I2).
  const placed: Item[] = own.length < 2 ? [] : candidates.filter((x) => fits(x) && x.n > own[0].n && x.n < own[own.length - 1].n)
  const items = placed.length ? [...own, ...placed].sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : a.order < b.order ? -1 : a.order > b.order ? 1 : 0)) : own

  // Over every numeric cheque, placed no-book checks included: two cheques on
  // one number (7 and 007 alike) share a shape, so a duplicate always sits on
  // one side of the pattern.
  const perNumber = new Map<bigint, number>()
  for (const x of [...all, ...placed]) if (x.cheque) perNumber.set(x.n, (perNumber.get(x.n) ?? 0) + 1)
  const isDuplicate = (n: bigint) => (perNumber.get(n) ?? 0) > 1
  const toEntry = (x: Item): SeriesEntry => (x.cheque
    ? { kind: 'CHECK', cheque: x.cheque, duplicate: isDuplicate(x.n), noBook: x.noBook === true }
    : { kind: 'STAGED', staged: x.staged, number: x.text })

  const entries: SeriesEntry[] = []
  let missing = ZERO
  let runs = 0
  let prev: { n: bigint; text: string } | null = null
  for (const x of items) {
    if (prev && x.n > prev.n + ONE) {
      const from = prev.n + ONE
      const to = x.n - ONE
      const count = to - from + ONE
      // A leading-zero number keeps its width on the MISSING bounds.
      entries.push({
        kind: 'MISSING',
        from: from.toString().padStart(prev.text.length, '0'),
        to: to.toString().padStart(prev.text.length, '0'),
        count: count.toString(),
      })
      missing += count
      runs += 1
    }
    entries.push(toEntry(x))
    prev = { n: x.n, text: x.text }
  }

  // The book's own cheques in the sequence: `held`, `staged` and `first` / `last`
  // are the book's; a placed no-book check is counted in `noBook` only.
  const chequeItems = own.filter((x) => x.cheque)
  // Out-of-pattern cheques are still cheques in the book: they count as voided / cancelled.
  const every = [...all.filter((x) => x.cheque).map((x) => x.cheque!), ...notNumeric]
  return {
    entries,
    notNumeric,
    outOfPattern: misfits.map(toEntry),
    pattern,
    summary: {
      first: own.length ? own[0].text : null,
      last: own.length ? own[own.length - 1].text : null,
      held: new Set(chequeItems.map((x) => x.n)).size,
      voided: every.filter((x) => x.status === 'VOIDED').length,
      cancelled: every.filter((x) => x.status === 'CANCELLED').length,
      staged: own.length - chequeItems.length,
      missingNumbers: missing.toString(),
      missingRuns: runs,
      notNumeric: notNumeric.length,
      duplicates: [...chequeItems, ...placed].filter((x) => isDuplicate(x.n)).length,
      outOfPattern: misfits.length,
      noBook: placed.length,
    },
  }
}

/** A stray end is more than this far from the next number inward (spec §G3). */
export const STRAY_GAP = BigInt(10000)
/** At most this many stray numbers are named from each end. */
const STRAY_MAX_PER_END = 3

type HeldEntry = Exclude<SeriesEntry, { kind: 'MISSING' }>
export type StrayEnd = { cheque: SeriesCheque | null; staged: SeriesStaged | null; reason: string }

/**
 * A book's stray ends (spec §G3): the first in-pattern number when the next is
 * more than STRAY_GAP higher, the last when the previous is more than STRAY_GAP
 * lower — repeated inward while it holds, at most 3 numbers from each end, and
 * never one number from both ends. Only the sequence's CHEQUE and STAGED
 * entries are read, so an OUT OF PATTERN number is neither a stray end nor
 * makes one. Every entry on a stray number is named. A to-do list for
 * Acumatica: it changes no count. Pure.
 */
export function strayEnds(series: AccountSeries): StrayEnd[] {
  // Distinct numbers in order, each with every entry that holds it.
  const groups: { n: bigint; entries: HeldEntry[] }[] = []
  for (const e of series.entries) {
    if (e.kind === 'MISSING') continue
    const n = BigInt(e.kind === 'CHECK' ? e.cheque.checkNumber.trim() : e.number)
    const last = groups[groups.length - 1]
    if (last && last.n === n) last.entries.push(e)
    else groups.push({ n, entries: [e] })
  }
  const named = (g: { entries: HeldEntry[] }, reason: string): StrayEnd[] =>
    g.entries.map((e) => (e.kind === 'CHECK'
      ? { cheque: e.cheque, staged: null, reason }
      : { cheque: null, staged: e.staged, reason }))

  const out: StrayEnd[] = []
  let front = 0
  while (front < STRAY_MAX_PER_END && front + 1 < groups.length) {
    const gap = groups[front + 1].n - groups[front].n
    if (gap <= STRAY_GAP) break
    out.push(...named(groups[front], `STRAY FIRST NUMBER — next is ${gap.toString()} higher`))
    front += 1
  }
  let back = groups.length - 1
  while (groups.length - 1 - back < STRAY_MAX_PER_END && back - 1 >= 0 && back >= front) {
    const gap = groups[back].n - groups[back - 1].n
    if (gap <= STRAY_GAP) break
    out.push(...named(groups[back], `STRAY LAST NUMBER — previous is ${gap.toString()} lower`))
    back -= 1
  }
  return out
}
