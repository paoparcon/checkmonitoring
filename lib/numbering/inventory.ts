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
 * padded to the book's width finds the note recorded on the bare number. A
 * note is on ONE NUMBER (`runTo` null) or on a RUN (`runTo` the run's last
 * number); the two never share a row.
 *
 * A long run OPENS on a click (second pass, 2026-11-03): the run line carries
 * the notes recorded on numbers inside it, and the browser lists its numbers
 * INVENTORY_EXPAND_PAGE at a time, each with its own tick and remark, until
 * it is closed again. The run's own tick and remark stay on the run line.
 */
export const INVENTORY_LIST_MAX = 100
/** Numbers an opened run shows per click of SHOW MORE. */
export const INVENTORY_EXPAND_PAGE = 200
/** The SAVE INVENTORY loop stops here and reports what it did not reach; pressing it again finishes the rest. */
export const INVENTORY_SAVE_BUDGET_MS = 25_000
/** More rows than this in one save is refused outright: the page never sends them, and a time budget is not a size limit. */
export const INVENTORY_SAVE_MAX = 5_000

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
  /** `noBook`: a check with no check book shown here because its number falls inside this sequence (spec §I). */
  | { kind: 'CHECK'; cheque: Extract<SeriesEntry, { kind: 'CHECK' }>['cheque']; duplicate: boolean; noBook: boolean; note: InventoryNote | null }
  | { kind: 'STAGED'; staged: Extract<SeriesEntry, { kind: 'STAGED' }>['staged']; number: string }
  /** One MISSING number, with its own tick and remark. */
  | { kind: 'MISSING_NUMBER'; number: string; note: InventoryNote | null }
  /**
   * A run longer than INVENTORY_LIST_MAX: one line, one note for the run (keyed to `from` with
   * `runTo`), plus the single-number notes inside it, for when the run is opened.
   */
  | { kind: 'MISSING'; from: string; to: string; count: string; note: InventoryNote | null; notes: InventoryNote[] }

const NUMERIC = /^\d+$/
const ZERO = BigInt(0)
const ONE = BigInt(1)

/** The key a note is stored under: the number as a canonical decimal. Null for anything not all digits. */
export function inventoryKey(number: string): string | null {
  const text = number.trim()
  return NUMERIC.test(text) ? BigInt(text).toString() : null
}

/**
 * `limit` numbers of a run from `from`, in order, each padded to `width` —
 * the run's own width on the server, the run line's in the browser.
 */
export function listRun(from: string, to: string, limit: number = Number.MAX_SAFE_INTEGER, width: number = from.length): string[] {
  const out: string[] = []
  const end = BigInt(to)
  for (let n = BigInt(from); n <= end && out.length < limit; n += ONE) out.push(n.toString().padStart(width, '0'))
  return out
}

/**
 * The run note for a run starting at `from`: the one recorded on exactly this
 * run, else the newest recorded on a run from the same number (the screen
 * then says the run has changed). Null when none.
 */
function runNoteFor(runs: readonly InventoryNote[], from: string, to: string): InventoryNote | null {
  const key = inventoryKey(from)
  const toKey = inventoryKey(to)
  const same = runs.filter((n) => n.checkNumber === key)
  if (same.length === 0) return null
  return same.find((n) => n.runTo !== null && inventoryKey(n.runTo) === toKey)
    ?? [...same].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]
}

/**
 * The series as inventory lines: a run of at most `max` numbers becomes one
 * MISSING_NUMBER line each, a longer run stays one MISSING line carrying its
 * run note and the single-number notes inside it, and every line that can
 * carry a note gets the one recorded on its number — a CHECK too: the
 * inventory ticks every number, held or missing.
 */
export function toInventoryLines(
  entries: readonly SeriesEntry[], notes: readonly InventoryNote[], max: number = INVENTORY_LIST_MAX,
): InventoryLine[] {
  const single = new Map<string, InventoryNote>()
  const runs: InventoryNote[] = []
  for (const n of notes) (n.runTo === null ? single.set(n.checkNumber, n) : runs.push(n))
  const noteFor = (number: string) => {
    const key = inventoryKey(number)
    return key === null ? null : single.get(key) ?? null
  }
  const lines: InventoryLine[] = []
  for (const e of entries) {
    if (e.kind === 'CHECK') lines.push({ kind: 'CHECK', cheque: e.cheque, duplicate: e.duplicate, noBook: e.noBook, note: noteFor(e.cheque.checkNumber) })
    else if (e.kind === 'STAGED') lines.push({ kind: 'STAGED', staged: e.staged, number: e.number })
    else if (BigInt(e.count) <= BigInt(max)) {
      for (const number of listRun(e.from, e.to)) lines.push({ kind: 'MISSING_NUMBER', number, note: noteFor(number) })
    } else {
      const lo = BigInt(e.from)
      const hi = BigInt(e.to)
      const inside = [...single.values()]
        .filter((n) => { const v = BigInt(n.checkNumber); return v >= lo && v <= hi })
        .sort((a, b) => (BigInt(a.checkNumber) < BigInt(b.checkNumber) ? -1 : 1))
      lines.push({ kind: 'MISSING', from: e.from, to: e.to, count: e.count, note: runNoteFor(runs, e.from, e.to), notes: inside })
    }
  }
  return lines
}

export type InventoryCounts = {
  /** Numbers covered by a ticked note, held or MISSING — a ticked run counts every number it still spans, else its ticked numbers. */
  ticked: string
  /** Lines (held checks, MISSING numbers and runs) carrying a remark. */
  remarked: number
  /** MISSING lines (numbers and runs) on the page. */
  lines: number
}

/** What the inventory has recorded against a series. Decimal strings, never a JS number for a count that can be large. */
export function inventoryCounts(lines: readonly InventoryLine[]): InventoryCounts {
  let ticked = ZERO
  let remarked = 0
  let count = 0
  for (const l of lines) {
    if (l.kind === 'CHECK') {
      if (l.note?.ticked) ticked += ONE
      if (l.note?.remarks) remarked += 1
    } else if (l.kind === 'MISSING_NUMBER') {
      count += 1
      if (l.note?.ticked) ticked += ONE
      if (l.note?.remarks) remarked += 1
    } else if (l.kind === 'MISSING') {
      count += 1
      if (l.note?.ticked) ticked += BigInt(l.count)
      else ticked += BigInt(l.notes.filter((n) => n.ticked).length)
      if (l.note?.remarks) remarked += 1
      remarked += l.notes.filter((n) => n.remarks).length
    }
  }
  return { ticked: ticked.toString(), remarked, lines: count }
}

/** The run a note was recorded on, when it no longer matches the run shown — the screen says so. */
export function runNoteStale(line: Extract<InventoryLine, { kind: 'MISSING' }>): boolean {
  if (!line.note) return false
  return inventoryKey(line.to) !== (line.note.runTo === null ? null : inventoryKey(line.note.runTo))
}
