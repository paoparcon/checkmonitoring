import { toCentavos, fromCentavos } from '@/lib/export/report'

/**
 * FINANCE'S CASH SCHEDULE, READ (2026-11-09).
 *
 * The monthly `Cash <MONTH> <YEAR>.xlsx` workbook has a sheet named `CASH`:
 * one line per bank account or cash fund, and one column per month-end with
 * the BANK balance in pesos — user ruling 2026-11-09, "those are bank
 * balance" — (the foreign-currency accounts are already at
 * their peso equivalent). Measured over the eleven workbooks of December 2025
 * to October 2026: 30 to 33 lines, 18 to 28 month columns back to July 2024,
 * and where two files state the same account and month they agree in every
 * cell. The newest file carries the whole history.
 *
 * Pure: a grid in, lines out. What is not read is said, never guessed:
 *
 * - THE SHEET is the one named CASH. The other sheets (bank loans, other
 *   income, petty cash) are not this.
 * - THE COLUMNS are found by their headers — BANK ACCOUNT, DESCRIPTION, and
 *   every header cell that is a DATE is a balance column. Not by position.
 * - THE ACCOUNT is keyed by the digits of the account number its line states
 *   (the BANK ACCOUNT cell, else the description). The GL account is not a
 *   key: 11120010 sits on two lines. A fund with no number is keyed by its
 *   company and name. Two lines sharing a key are BOTH left out, by name.
 * - A BLANK cell is no balance; a 0 is a balance of zero. A cell holding
 *   anything that is not a number is named and skipped.
 * - THE SHEET'S OWN TOTAL row is compared with the lines read, per day, and
 *   a difference is stated — it means a line was skipped or the total's range
 *   stops short, and either way the reader should know before confirming.
 */
export type SheetGrid = { name: string; rows: unknown[][] }

export type CashSheetBalance = { day: string; amount: string; cell: string }
export type CashSheetAccount = {
  key: string
  label: string
  companyLabel: string | null
  glAccount: string | null
  description: string | null
  accountNumber: string | null
  currency: string
  /** 1-based row on the sheet. */
  row: number
  balances: CashSheetBalance[]
}
export type CashSheetTotal = { day: string; sheetTotal: string | null; linesTotal: string; agrees: boolean }
export type CashSheetRead =
  | { ok: true; sheet: string; days: string[]; accounts: CashSheetAccount[]; problems: string[]; totals: CashSheetTotal[] }
  | { ok: false; message: string }

export const CASH_SHEET_NAME = 'CASH'

/** A cell's plain value: a formula's result, rich text joined, else the value. */
function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((t) => t.text ?? '').join('')
    if ('result' in o) return plain(o.result)
    if ('text' in o) return plain(o.text)
    return null
  }
  return v
}

/** Text as one line: Excel's `_x000D_` carriage returns and every run of whitespace become one space. */
export function cleanLabel(v: unknown): string {
  const p = plain(v)
  if (p === null || p instanceof Date) return ''
  return String(p).replace(/_x000D_/gi, ' ').replace(/\s+/g, ' ').trim()
}

/** The account number a label states — its digits only — or null. At least eight digits, hyphens allowed inside. */
export function accountNumberOf(label: string): string | null {
  const runs = label.match(/\d[\d-]{5,}\d/g) ?? []
  const digits = runs.map((r) => r.replace(/-/g, '')).filter((d) => d.length >= 8)
  return digits.length > 0 ? digits[digits.length - 1]! : null
}

const CURRENCY = /\b(PHP|USD|EUR|CNY|RMB|JPY)\b/i

/** A double from a cell as money text with two decimals (rule 8 starts here). Null when it is not a finite amount the column can hold. */
export function numberToMoney(n: number): string | null {
  if (!Number.isFinite(n) || Math.abs(n) >= 1e16) return null
  const s = n.toFixed(2)
  return s === '-0.00' ? '0.00' : s
}

const MONEY_TEXT = /^-?\d{1,16}(\.\d+)?$/

function cellAmount(v: unknown): { amount: string; raw: number } | 'BLANK' | 'UNREADABLE' {
  const p = plain(v)
  if (p === null || p === '') return 'BLANK'
  if (typeof p === 'number') {
    const amount = numberToMoney(p)
    return amount === null ? 'UNREADABLE' : { amount, raw: p }
  }
  if (typeof p === 'string') {
    const t = p.replace(/,/g, '').trim()
    if (t === '') return 'BLANK'
    if (!MONEY_TEXT.test(t)) return 'UNREADABLE'
    return { amount: fromCentavos(toCentavos(t)), raw: Number(t) }
  }
  return 'UNREADABLE'
}

/** `A`, `B`, … `AH` for a 0-based column index. */
export function columnLetter(index: number): string {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

export function readCashSheet(sheets: readonly SheetGrid[]): CashSheetRead {
  const sheet = sheets.find((s) => s.name.trim().toUpperCase() === CASH_SHEET_NAME)
  if (!sheet) {
    const names = sheets.map((s) => s.name).join(', ') || 'none'
    return { ok: false, message: `This workbook has no sheet named CASH (its sheets: ${names}). Upload the monthly Cash workbook.` }
  }

  // The header: the first of the top five rows that names BANK ACCOUNT and DESCRIPTION and carries a date.
  let headerAt = -1
  let bankCol = -1
  let descCol = -1
  let companyCol = -1
  let glCol = -1
  let dayCols: { col: number; day: string }[] = []
  for (let r = 0; r < Math.min(5, sheet.rows.length); r++) {
    const row = sheet.rows[r] ?? []
    const text = row.map((c) => cleanLabel(c).toUpperCase())
    const bank = text.indexOf('BANK ACCOUNT')
    const desc = text.indexOf('DESCRIPTION')
    const days = row.flatMap((c, col) => {
      const p = plain(c)
      return p instanceof Date && !Number.isNaN(p.getTime()) ? [{ col, day: isoDay(p) }] : []
    })
    if (bank >= 0 && desc >= 0 && days.length > 0) {
      headerAt = r; bankCol = bank; descCol = desc; dayCols = days
      companyCol = text.indexOf('COMPANY'); glCol = text.indexOf('ACCOUNT')
      break
    }
  }
  if (headerAt < 0) {
    return { ok: false, message: 'The CASH sheet has no header row naming BANK ACCOUNT and DESCRIPTION with a date column beside them. Nothing was read.' }
  }
  const seenDays = new Set<string>()
  for (const d of dayCols) {
    if (seenDays.has(d.day)) {
      return { ok: false, message: `The CASH sheet has two columns dated ${d.day}. Nothing was read — one day cannot have two balances.` }
    }
    seenDays.add(d.day)
  }

  const problems: string[] = []
  const lines: (CashSheetAccount & { raw: Map<string, number> })[] = []
  let totalRow: unknown[] | null = null
  for (let r = headerAt + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? []
    const bankLabel = cleanLabel(row[bankCol])
    const description = cleanLabel(row[descCol])
    const label = bankLabel || description
    if (label === '') {
      // No name: the sheet's own total, when it is the first such row after the lines and holds a figure.
      if (totalRow === null && lines.length > 0 && dayCols.some((d) => typeof plain(row[d.col]) === 'number')) totalRow = row
      continue
    }
    const company = companyCol >= 0 ? cleanLabel(row[companyCol]) : ''
    const gl = glCol >= 0 ? cleanLabel(row[glCol]) : ''
    const accountNumber = accountNumberOf(bankLabel || description)
    const key = accountNumber ? `ACCT:${accountNumber}` : `FUND:${company.toUpperCase() || '-'}:${label.toUpperCase()}`
    const balances: CashSheetBalance[] = []
    const raw = new Map<string, number>()
    for (const d of dayCols) {
      const cell = `${columnLetter(d.col)}${r + 1}`
      const got = cellAmount(row[d.col])
      if (got === 'BLANK') continue
      if (got === 'UNREADABLE') {
        problems.push(`${sheet.name}!${cell} (${label}, ${d.day}) does not hold a number — skipped.`)
        continue
      }
      balances.push({ day: d.day, amount: got.amount, cell })
      raw.set(d.day, got.raw)
    }
    lines.push({
      key, label, companyLabel: company || null, glAccount: gl || null, description: description || null,
      accountNumber, currency: (CURRENCY.exec(description)?.[1] ?? 'PHP').toUpperCase().replace('RMB', 'CNY'),
      row: r + 1, balances, raw,
    })
  }

  // Two lines under one key: neither is read. Folding them would add two accounts into one balance.
  const byKey = new Map<string, number[]>()
  for (const l of lines) byKey.set(l.key, [...(byKey.get(l.key) ?? []), l.row])
  const kept = lines.filter((l) => {
    const rows = byKey.get(l.key)!
    if (rows.length === 1) return true
    if (rows[0] === l.row) problems.push(`Rows ${rows.join(' and ')} name the same account (${l.label}) — neither was read.`)
    return false
  })

  const days = dayCols.map((d) => d.day).sort().reverse()
  const totals: CashSheetTotal[] = dayCols.map((d) => {
    let cents = 0n
    let float = 0
    for (const l of kept) {
      const b = l.balances.find((x) => x.day === d.day)
      if (b) { cents += toCentavos(b.amount); float += l.raw.get(d.day) ?? 0 }
    }
    const stated = totalRow ? plain(totalRow[d.col]) : null
    const sheetTotal = typeof stated === 'number' ? numberToMoney(stated) : null
    return {
      day: d.day, sheetTotal, linesTotal: fromCentavos(cents),
      // Judged on the cells as typed, to the centavo: thirty rounded lines can differ from a rounded total by more.
      agrees: typeof stated === 'number' ? Math.abs(stated - float) < 0.01 : true,
    }
  }).sort((a, b) => b.day.localeCompare(a.day))

  return {
    ok: true, sheet: sheet.name, days,
    accounts: kept.map(({ raw: _raw, ...account }) => account),
    problems, totals,
  }
}
