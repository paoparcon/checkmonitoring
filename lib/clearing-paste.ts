import { DEFAULT_MAX_BULK_SELECTION } from '@/lib/settings/defaults'
import { canonicalCheckNumber } from '@/lib/import/normalise'

/**
 * A bank statement's cheque lines, pasted.
 *
 * One cheque per line: `number`, or `number, date, bank reference`, split on
 * comma or tab — the two shapes a copy out of a statement export or a
 * spreadsheet column produces. Pure: it says what each line means or why it
 * cannot be read, and nothing else. `/clearing` previews the result against
 * the database before anything is written.
 *
 * Refuses rather than guesses. A date it cannot read is an error on that
 * line, not "today"; a first field that is not a number is an error, not a
 * search. The same cheque twice is refused on the later line, because the
 * second write would be a refused transition reported as a failure on a
 * cheque that did in fact clear.
 *
 * The cap is the `caps.bulkSelection` setting, for its own reason: each confirm is one
 * sequential transaction per cheque against Neon, and fifty is a screenful a
 * person can read back before pressing CONFIRM.
 */

export const MAX_CLEARING_LINES = DEFAULT_MAX_BULK_SELECTION

export type PastedLine = {
  line: number
  checkNumber: string
  clearedDate: Date | null
  crNumber: string | null
}

export type PasteError = { line: number; raw: string; message: string }

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/
const DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

/** `YYYY-MM-DD` or `DD/MM/YYYY` as a UTC-midnight instant, as the forms store a date. */
function readDate(s: string): Date | null {
  let y: number, m: number, d: number
  const iso = ISO.exec(s)
  const dmy = DMY.exec(s)
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  else if (dmy) [y, m, d] = [Number(dmy[3]), Number(dmy[2]), Number(dmy[1])]
  else return null
  const date = new Date(Date.UTC(y, m - 1, d))
  // Rejects 2026-02-31 and the like: the constructor rolls them forward.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return date
}

export function parseClearingPaste(text: string): { lines: PastedLine[]; errors: PasteError[] } {
  const lines: PastedLine[] = []
  const errors: PasteError[] = []
  const seen = new Map<string, number>()

  text.split(/\r?\n/).forEach((rawLine, idx) => {
    const raw = rawLine.trim()
    if (raw === '') return
    const line = idx + 1
    const fields = raw.split(/\t|,/).map((f) => f.trim())

    if (fields.length > 3) {
      errors.push({ line, raw, message: 'Too many fields: number, date, bank reference.' })
      return
    }

    const checkNumber = canonicalCheckNumber(fields[0])
    if (checkNumber === null || !/^\d+$/.test(checkNumber)) {
      errors.push({ line, raw, message: 'Not a check number.' })
      return
    }

    let clearedDate: Date | null = null
    if (fields[1]) {
      clearedDate = readDate(fields[1])
      if (clearedDate === null) {
        errors.push({ line, raw, message: 'Date must be YYYY-MM-DD or DD/MM/YYYY.' })
        return
      }
    }

    const first = seen.get(checkNumber)
    if (first !== undefined) {
      errors.push({ line, raw, message: `Repeats line ${first}.` })
      return
    }
    seen.set(checkNumber, line)

    lines.push({ line, checkNumber, clearedDate, crNumber: fields[2] ? fields[2] : null })
  })

  return { lines, errors }
}
