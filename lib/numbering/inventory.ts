import type { SeriesEntry } from './series'

/**
 * The check inventory on NUMBERING (spec
 * 2026-10-01-cheque-numbering-and-cancel-guard-design §H, 2026-11-03): the
 * series shown number by number, so Finance records the status of a check
 * Acumatica does not hold — a tick (accounted for) and a remark on each
 * MISSING number — instead of reaching for a spreadsheet.
 *
 * Pure. `buildSeries` still reports a gap as one MISSING run; this layer
 * turns each run of at most INVENTORY_LIST_MAX numbers into one line per
 * number and leaves a longer run as one line, because a jump between
 * booklets can be billions. Measured 2026-11-03 on production: 687 runs in 9
 * books; at 100, 579 runs (84%) are listed number by number — 5,014 rows in
 * all, at most 1,915 on one book — and the 108 longer ones (the largest
 * 11,913,041,270) stay one line each with one note for the whole run.
 *
 * A note is keyed by its canonical number (`inventoryKey`): BigInt order is
 * the series' order, so `007` and `7` are the same key, and a MISSING bound
 * padded to the book's width finds the note recorded on the bare number.
 */
export const INVENTORY_LIST_MAX = 100

export type InventoryNote = {
  /** The stored key — canonical, no leading zeros. */
  checkNumber: string
  /** The last number of the run the note was recorded on; null for one number. */
  runTo: string | null
  ticked: boolean
  remarks: string | null
  updatedAt: Date
  updatedBy: string
}

export type InventoryLine =
  | { kind: 'CHECK'; cheque: Extract<SeriesEntry, { kind: 'CHECK' }>['cheque']; duplicate: boolean; note: InventoryNote | null }
  | { kind: 'STAGED'; staged: Extract<SeriesEntry, { kind: 'STAGED' }>['staged']; number: string }
  /** One MISSING number, with its own tick and remark. */
  | { kind: 'MISSING_NUMBER'; number: string; note: InventoryNote | null }
  /** A run longer than INVENTORY_LIST_MAX: one line, one note for the run, keyed to `from`. */
  | { kind: 'MISSING'; from: string; to: string; count: string; note: InventoryNote | null }

const NUMERIC = /^\d+$/
const ZERO = BigInt(0)
const ONE = BigInt(1)

/** The key a note is stored under: the number as a canonical decimal. Null for anything not all digits. */
export function inventoryKey(number: string): string | null {
  const text = number.trim()
  return NUMERIC.test(text) ? BigInt(text).toString() : null
}

/** Every number of a run, in order, each padded to the run's width. Only for a run of at most `max`. */
function listRun(from: string, to: string): string[] {
  const out: string[] = []
  const end = BigInt(to)
  for (let n = BigInt(from); n <= end; n += ONE) out.push(n.toString().padStart(from.length, '0'))
  return out
}

/**
 * The series as inventory lines: a run of at most `max` numbers becomes one
 * MISSING_NUMBER line each, a longer run stays one MISSING line, and every
 * line that can carry a note gets the one recorded on its number — a CHECK
 * too, so a note made while the number was missing is not lost when Acumatica
 * later sends the check.
 */
export function toInventoryLines(
  entries: readonly SeriesEntry[], notes: ReadonlyMap<string, InventoryNote>, max: number = INVENTORY_LIST_MAX,
): InventoryLine[] {
  const noteFor = (number: string) => {
    const key = inventoryKey(number)
    return key === null ? null : notes.get(key) ?? null
  }
  const lines: InventoryLine[] = []
  for (const e of entries) {
    if (e.kind === 'CHECK') lines.push({ kind: 'CHECK', cheque: e.cheque, duplicate: e.duplicate, note: noteFor(e.cheque.checkNumber) })
    else if (e.kind === 'STAGED') lines.push({ kind: 'STAGED', staged: e.staged, number: e.number })
    else if (BigInt(e.count) <= BigInt(max)) {
      for (const number of listRun(e.from, e.to)) lines.push({ kind: 'MISSING_NUMBER', number, note: noteFor(number) })
    } else lines.push({ kind: 'MISSING', from: e.from, to: e.to, count: e.count, note: noteFor(e.from) })
  }
  return lines
}

export type InventoryCounts = {
  /** MISSING numbers covered by a ticked note — a ticked run counts every number it still spans. */
  ticked: string
  /** MISSING lines (numbers and runs) carrying a remark. */
  remarked: number
  /** MISSING lines (numbers and runs) on the page. */
  lines: number
}

/** What the inventory has recorded against the MISSING part of a series. Decimal strings, never a JS number for a count that can be large. */
export function inventoryCounts(lines: readonly InventoryLine[]): InventoryCounts {
  let ticked = ZERO
  let remarked = 0
  let count = 0
  for (const l of lines) {
    if (l.kind === 'MISSING_NUMBER') {
      count += 1
      if (l.note?.ticked) ticked += ONE
      if (l.note?.remarks) remarked += 1
    } else if (l.kind === 'MISSING') {
      count += 1
      if (l.note?.ticked) ticked += BigInt(l.count)
      if (l.note?.remarks) remarked += 1
    }
  }
  return { ticked: ticked.toString(), remarked, lines: count }
}

/** The run a note was recorded on, when it no longer matches the run shown — the screen says so. */
export function runNoteStale(line: Extract<InventoryLine, { kind: 'MISSING' }>): boolean {
  if (!line.note) return false
  return inventoryKey(line.to) !== (line.note.runTo === null ? null : inventoryKey(line.note.runTo))
}
