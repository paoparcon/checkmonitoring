import { createHash } from 'node:crypto'
import { toCentavos, fromCentavos } from '@/lib/export/report'
import { canonicalCheckNumber } from '@/lib/import/normalise'
import { firstDay, lastDay, type Month } from './period'

/**
 * A BANK STATEMENT, READ INTO LINES. Pure: the sheets (or CSV text) in, dated
 * debit/credit lines out, plus everything that was not a line and why.
 *
 * A statement is a table with a header row. The header is found in the first
 * 20 rows of each sheet by its words — a DATE column and either DEBIT/CREDIT
 * columns (any of the usual names: WITHDRAWAL, DEPOSIT, DR, CR…) or one signed
 * AMOUNT column. Optional: DESCRIPTION/PARTICULARS, CHECK NO., REFERENCE,
 * BALANCE. A sheet with no such header is skipped and named.
 *
 * DATES. An Excel date cell; `YYYY-MM-DD`; a month spelled out (`03-Nov-2026`,
 * `Nov 3, 2026`); or a numeric `03/11/2026`. A numeric date is read in
 * whichever order puts it inside the reconciliation month — and refused when
 * both orders do and disagree, or neither does. Never a guess. A line dated
 * outside the month is reported and left out: statements often straddle months.
 *
 * AMOUNTS. Number cells, or text: `1,234.56`, `(1,234.56)` and `-1,234.56`
 * (negative), a trailing `DR`/`CR`. Rule 8: they become decimal strings
 * through centavo arithmetic, never a float sum.
 *
 * BALANCE ROWS. "BEGINNING/OPENING BALANCE", "BALANCE FORWARD" and
 * "ENDING/CLOSING BALANCE" rows are not lines; their figure is offered as the
 * statement's own beginning/ending balance. Failing an ending row, the last
 * line's running balance is.
 */

export type StatementSheet = { name: string; rows: unknown[][] }

export type ParsedLine = {
  place: string
  lineDay: string
  description: string
  reference: string | null
  checkNumber: string | null
  debit: string | null
  credit: string | null
  balance: string | null
  fingerprint: string
}

export type SkippedRow = { place: string; reason: string }

export type ParsedStatement = {
  lines: ParsedLine[]
  skipped: SkippedRow[]
  sheetsRead: string[]
  sheetsSkipped: string[]
  statementBeginning: string | null
  statementEnding: string | null
}

type Role = 'date' | 'description' | 'check' | 'reference' | 'debit' | 'credit' | 'amount' | 'balance'

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim()

/** Header words, most specific first; an exact match beats a containing one. */
const HEADERS: Record<Role, RegExp> = {
  date: /^(trans(action)? date|txn date|posting date|post date|date posted|date|value date|tran date)$/,
  description: /^(description|particulars|details|narrative|transaction( description| details)?|remarks|transaction particulars|memo)$/,
  check: /^(check|cheque|chk|chq)( ?(no|number|num|#))?$|^(check|cheque) ?#$/,
  reference: /^(ref|reference)( ?(no|number|num|#))?$|^(document|doc|trans(action)?) ?(no|number|ref)$|^branch ?ref$/,
  debit: /^(debit|debits|withdrawal|withdrawals|dr|debit amount|payments?|amount debited|withdrawal amount|debit amt)$/,
  credit: /^(credit|credits|deposit|deposits|cr|credit amount|receipts?|amount credited|deposit amount|credit amt)$/,
  amount: /^(amount|transaction amount|amt|net amount)$/,
  balance: /^(balance|running balance|ending balance|available balance|ledger balance|bal)$/,
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((t) => t.text ?? '').join('')
    if ('result' in o) return cellText(o.result)
    if ('text' in o) return cellText(o.text)
    return ''
  }
  return String(v).trim()
}

function cellValue(v: unknown): unknown {
  if (v && typeof v === 'object' && !(v instanceof Date) && 'result' in (v as object)) return (v as { result: unknown }).result
  return v
}

/** Column index per role, or null when the row is not a header. */
export function findHeader(row: unknown[]): Partial<Record<Role, number>> | null {
  const roles: Partial<Record<Role, number>> = {}
  row.forEach((cell, i) => {
    const t = norm(cellText(cell))
    if (t === '') return
    for (const role of Object.keys(HEADERS) as Role[]) {
      if (roles[role] === undefined && HEADERS[role].test(t)) { roles[role] = i; return }
    }
  })
  const hasDate = roles.date !== undefined
  const hasMoney = (roles.debit !== undefined && roles.credit !== undefined) || roles.amount !== undefined
  return hasDate && hasMoney ? roles : null
}

/**
 * An amount cell as a signed decimal string: negative for `(x)`, `-x` or a
 * trailing DR. Null for blank or not an amount.
 */
export function readAmount(v: unknown): string | null {
  const raw = cellValue(v)
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null
    return fromCentavos(toCentavos(raw.toFixed(3)))
  }
  let s = cellText(raw).toUpperCase().replace(/PHP|₱|\s/g, '')
  if (s === '' || s === '-') return null
  let negative = false
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1) }
  if (s.endsWith('DR')) { negative = true; s = s.slice(0, -2) }
  else if (s.endsWith('CR')) s = s.slice(0, -2)
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1) }
  s = s.replace(/,/g, '')
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const value = fromCentavos(toCentavos(s))
  return negative && value !== '0.00' ? `-${value}` : value
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad = (n: number) => String(n).padStart(2, '0')
function realDay(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return `${y}-${pad(m)}-${pad(d)}`
}
const fullYear = (s: string) => (s.length === 2 ? 2000 + Number(s) : Number(s))

/**
 * A date cell as `YYYY-MM-DD`, read inside `month` when the order is not
 * written down. `{ day }`, or `{ error }` saying why not.
 */
export function readDate(v: unknown, month: Month): { day: string } | { error: string } | null {
  const raw = cellValue(v)
  if (raw === null || raw === undefined || raw === '') return null
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? { error: 'not a date' } : { day: raw.toISOString().slice(0, 10) }
  }
  const s = cellText(raw)
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (m) {
    const d = realDay(Number(m[1]), Number(m[2]), Number(m[3]))
    return d ? { day: d } : { error: `${s} is not a real day` }
  }
  m = /^(\d{1,2})[\s/-]([a-z]{3,9})\.?[\s/-](\d{2}|\d{4})$/i.exec(s)
  if (m) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase())
    const d = mo < 0 ? null : realDay(fullYear(m[3]), mo + 1, Number(m[1]))
    return d ? { day: d } : { error: `${s} is not a date` }
  }
  m = /^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(s)
  if (m) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase())
    const d = mo < 0 ? null : realDay(Number(m[3]), mo + 1, Number(m[2]))
    return d ? { day: d } : { error: `${s} is not a date` }
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s)
  if (m) {
    const y = fullYear(m[3])
    const mdy = realDay(y, Number(m[1]), Number(m[2]))
    const dmy = realDay(y, Number(m[2]), Number(m[1]))
    const inside = (d: string | null) => d !== null && d >= firstDay(month) && d <= lastDay(month)
    if (mdy && dmy && mdy === dmy) return { day: mdy }
    if (inside(mdy) && !inside(dmy)) return { day: mdy! }
    if (inside(dmy) && !inside(mdy)) return { day: dmy! }
    if (inside(mdy) && inside(dmy)) return { error: `${s} could be ${mdy} or ${dmy}` }
    if (!mdy && !dmy) return { error: `${s} is not a real day` }
    // Outside the month either way: reported as such, by whichever reading is real.
    return { day: (mdy ?? dmy)! }
  }
  return { error: `${s} is not a date` }
}

const BEGIN_ROW = /\b(beginning|opening|previous|starting)\s+balance\b|\bbalance\s+(forward|brought forward|b\/f)\b|\bbal(ance)?\s*fwd\b/i
const END_ROW = /\b(ending|closing|ending ledger|current)\s+balance\b|\bbalance\s+carried forward\b/i

/** Plain CSV (RFC 4180 quotes, comma or tab) into rows of text cells. */
export function csvRows(text: string): unknown[][] {
  const delimiter = (text.split(/\r?\n/, 1)[0] ?? '').includes('\t') && !(text.split(/\r?\n/, 1)[0] ?? '').includes(',') ? '\t' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === delimiter) { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row) }
  return rows
}

/**
 * The line's identity for duplicate refusal: what the bank says about it, plus
 * how many identical lines came before it in the same file (two equal charges
 * on one day are two lines; the same file uploaded twice is not four).
 */
export function lineFingerprint(l: Omit<ParsedLine, 'fingerprint' | 'place'>, occurrence: number): string {
  const key = [l.lineDay, l.debit ?? '', l.credit ?? '', l.checkNumber ?? '', (l.reference ?? '').toUpperCase(),
    l.description.toUpperCase().replace(/\s+/g, ' '), l.balance ?? '', String(occurrence)].join('|')
  return createHash('sha256').update(key).digest('hex')
}

export function parseStatement(sheets: readonly StatementSheet[], month: Month): ParsedStatement {
  const out: ParsedStatement = { lines: [], skipped: [], sheetsRead: [], sheetsSkipped: [], statementBeginning: null, statementEnding: null }
  const seen = new Map<string, number>()
  let lastBalance: string | null = null

  for (const sheet of sheets) {
    let headerAt = -1
    let roles: Partial<Record<Role, number>> | null = null
    for (let i = 0; i < Math.min(20, sheet.rows.length); i++) {
      roles = findHeader(sheet.rows[i] ?? [])
      if (roles) { headerAt = i; break }
    }
    if (!roles) { out.sheetsSkipped.push(sheet.name); continue }
    out.sheetsRead.push(sheet.name)
    const at = (row: unknown[], role: Role) => (roles![role] === undefined ? undefined : row[roles![role]!])

    for (let i = headerAt + 1; i < sheet.rows.length; i++) {
      const row = sheet.rows[i] ?? []
      const place = sheets.length > 1 ? `${sheet.name} row ${i + 1}` : `row ${i + 1}`
      const texts = row.map(cellText)
      if (texts.every((t) => t === '')) continue
      const description = [at(row, 'description')].map(cellText).join('').trim()
      const whole = texts.join(' ')
      const balance = readAmount(at(row, 'balance'))

      let debit: string | null = null
      let credit: string | null = null
      if (roles.debit !== undefined && roles.credit !== undefined) {
        const d = readAmount(at(row, 'debit'))
        const c = readAmount(at(row, 'credit'))
        if (d && d !== '0.00') debit = d.replace(/^-/, '')
        if (c && c !== '0.00') credit = c.replace(/^-/, '')
      } else {
        const a = readAmount(at(row, 'amount'))
        if (a && a !== '0.00') { if (a.startsWith('-')) debit = a.slice(1); else credit = a }
      }

      if (BEGIN_ROW.test(whole) && !debit && !credit) {
        const figure = balance ?? readAmount(row.find((c, idx) => idx !== roles!.date && readAmount(c) !== null))
        if (figure && out.statementBeginning === null) out.statementBeginning = figure
        continue
      }
      if (END_ROW.test(whole) && !debit && !credit) {
        const figure = balance ?? readAmount(row.find((c, idx) => idx !== roles!.date && readAmount(c) !== null))
        if (figure) out.statementEnding = figure
        continue
      }

      const date = readDate(at(row, 'date'), month)
      if (!debit && !credit) {
        out.skipped.push({ place, reason: date === null ? 'no date and no amount' : 'no debit or credit amount' })
        continue
      }
      if (debit && credit) { out.skipped.push({ place, reason: 'both a debit and a credit on one row' }); continue }
      if (date === null) { out.skipped.push({ place, reason: 'no date' }); continue }
      if ('error' in date) { out.skipped.push({ place, reason: date.error }); continue }
      if (date.day < firstDay(month) || date.day > lastDay(month)) {
        out.skipped.push({ place, reason: `dated ${date.day}, outside this month` })
        continue
      }

      const checkRaw = cellText(at(row, 'check'))
      const checkNumber = checkRaw && /\d{4,}/.test(checkRaw) ? canonicalCheckNumber(checkRaw.replace(/\D/g, '')) : null
      const reference = cellText(at(row, 'reference')) || null
      const base = { lineDay: date.day, description: description || reference || checkRaw || '(no description)', reference, checkNumber, debit, credit, balance }
      const key = JSON.stringify(base)
      const occurrence = seen.get(key) ?? 0
      seen.set(key, occurrence + 1)
      out.lines.push({ ...base, place, fingerprint: lineFingerprint(base, occurrence) })
      if (balance) lastBalance = balance
    }
  }
  if (out.statementEnding === null && lastBalance !== null) out.statementEnding = lastBalance
  return out
}
