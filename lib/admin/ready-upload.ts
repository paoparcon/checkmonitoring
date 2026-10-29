import type { CheckStatus, Prisma, PrismaClient } from '@prisma/client'
import ExcelJS from 'exceljs'
import { markReadyForRelease, markSigned } from '@/lib/domain/actions'
import { checkReadyForRelease } from '@/lib/domain/check-status'
import { DomainError } from '@/lib/domain/errors'
import { canonicalCheckNumber, cleanCell } from '@/lib/import/normalise'

/**
 * READY FOR RELEASE from an uploaded list (user request 2026-10-29).
 *
 * WHAT IT IS. A Finance Admin uploads a workbook whose rows each name a CHECK
 * NUMBER and the AP BILL it pays. Every row that names exactly one live cheque
 * here, carrying that bill, is moved to READY_FOR_RELEASE — through
 * `markReadyForRelease`, the same write the MARK READY button makes, so the
 * portal is told (MARK_AVAILABLE in the outbox), `readyAt` / `readyById` /
 * the pickup date are recorded and the audit row names the file, sheet and
 * row. That is the automation this system exists for: Finance ticks ready and
 * the Supplier Portal updates without anyone re-encoding the cheque.
 *
 * WHY NOT `release-list.ts`. That module reads the FOR RELEASE workbook, keyed
 * on the voucher alone, and sets the status directly with no approving user,
 * no pickup date and no portal event — a one-off catch-up for a list nobody
 * approved in this system. This is the routine: the admin IS the approver, so
 * the domain action is the right write and the trigger is BOTH columns.
 *
 * THE TRIGGER IS THE AP BILL, WITH THE CHECK NUMBER WHEN THE LIST HAS ONE.
 * The bill must be one the cheque pays (`Check.apvNumbers`, which the BILLS
 * read fills from Acumatica, or a `CheckBill` from the approval workbook).
 * A sheet with both columns is keyed on the NUMBER: it finds the cheque, and a
 * row whose bill is not on that cheque is REFUSED and reported with where the
 * bill is held — a mis-keyed number or a wrong row, and either way not
 * something to guess about with money. A sheet with ONLY a bill column — what
 * Acumatica's AP bill export looks like (`Reference Nbr.`, the file Finance
 * actually uploads, 2026-10-29) — is keyed on the BILL: the row names the one
 * live cheque that pays it, and none or two leave it alone. That is the rule
 * `voucher-links.ts` and `/vouchers` already hold, and the preview is what
 * makes it safe here: the 428 cheques promoted by voucher alone on 2026-09-24
 * came from a sheet nobody had looked at (`Detail1`), not from a bill-keyed
 * list an admin read and confirmed.
 *
 * EXACTLY ONE LIVE CHEQUE or nothing — the rule `bills.ts`, `release-list.ts`
 * and `voucher-links.ts` all hold. A number held by two live cheques is
 * refused; a cancelled or voided twin beside one live cheque is a re-issue and
 * the live one is taken.
 *
 * WHAT IT WILL NOT TOUCH. RELEASED, CANCELLED, VOIDED; READY_FOR_RELEASE and
 * SCHEDULED (already there — reported, no second event); a non-cheque payment
 * (DEBIT ADV, CASH); anything Acumatica reports Voided; GENERATED (not yet in
 * the signing queue). A SIGNATURE_PENDING cheque is SIGNED first, by
 * `markSigned` under the same admin, and the preview says so: a list of
 * cheques ready for release is Finance saying they are signed.
 *
 * NOTHING IS DEMOTED. A ready cheque off the list stays ready; the user has
 * ruled both ways on what "dropped off a list" means (2026-09-10, 2026-10-06)
 * and a routine upload must not decide it.
 *
 * NOTHING IS WRITTEN WITHOUT A PREVIEW. The action plans, shows the plan, and
 * writes only on a second submission of the same file.
 */

/** The header labels accepted for each column, normalised by `label()`. The check column is optional. */
const CHECK_HEADERS = new Set([
  'CHECK NUMBER', 'CHECK NO', 'CHECK #', 'CHECK', 'CHECKS', 'CHECK NUM',
  'CHEQUE NUMBER', 'CHEQUE NO', 'CHEQUE', 'PAYMENT REF', 'PAYMENT REF NBR',
])
const BILL_HEADERS = new Set([
  'AP BILL', 'AP BILL NUMBER', 'AP BILL NO', 'AP BILLS', 'BILL', 'BILL NUMBER', 'BILL NO', 'BILLS',
  'AP VOUCHER', 'APV', 'APV NUMBER', 'VOUCHER', 'VOUCHER NUMBER', 'VOUCHER NO',
  'REFERENCE NBR', 'REFERENCE NO', 'AP NUMBER', 'AP NO', 'AP REFERENCE',
])
/** Every export seen so far puts its header within the first rows. */
const HEADER_SEARCH_ROWS = 5
/** `AP-ST043681`, `STPP-AP-000021`, `A1PP-AP-000014`, `AP-A1-02663`. */
const VOUCHER = /^([A-Z0-9]+-)?AP-[A-Z0-9-]+$/

/** The statuses a listed cheque may be moved from. */
const PROMOTABLE: readonly CheckStatus[] = ['SIGNATURE_PENDING', 'SIGNED']
const DEAD: readonly CheckStatus[] = ['CANCELLED', 'VOIDED']

export type UploadRow = {
  sheet: string
  row: number
  /**
   * What finds the cheque: the NUMBER on a sheet that has a check column (the
   * bill must then be on that cheque), the BILL on a sheet that has none.
   */
  keyedBy: 'NUMBER' | 'BILL'
  /** Canonical (bank prefix stripped), or null when the cell is blank or the sheet has no check column. */
  checkNumber: string | null
  /** Upper-cased and shape-checked, or null when the cell is blank or not a voucher. */
  voucher: string | null
  /** The cells as typed, for the report. */
  rawCheckNumber: string | null
  rawVoucher: string | null
}

export type SheetReport = {
  sheet: string
  read: boolean
  rows: number
  /** How the sheet's rows find their cheque; absent when the sheet was not read. */
  keyedBy?: 'NUMBER' | 'BILL'
  /** Why the sheet was not read. */
  reason?: string
}

function text(v: unknown): string | null {
  if (v && typeof v === 'object') {
    if ('richText' in v) return cleanCell((v as { richText: { text: string }[] }).richText.map((t) => t.text).join(''))
    if ('result' in v) return cleanCell((v as { result: unknown }).result)
    if ('text' in v) return cleanCell((v as { text: unknown }).text)
    if (v instanceof Date) return v.toISOString().slice(0, 10)
    return null
  }
  // A cheque number typed into a numeric cell. ExcelJS hands it over as a
  // JS number; `String` of an integer below 2^53 is its digits, no exponent.
  if (typeof v === 'number' && Number.isInteger(v)) return String(v)
  return cleanCell(v)
}

function label(v: unknown): string {
  return (text(v) ?? '').toUpperCase().replace(/[.:]+$/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Pure over a grid. A sheet is read when one of its first rows carries an
 * AP-bill header; a cheque-number header on the same row makes the sheet
 * NUMBER-keyed, its absence BILL-keyed. A sheet with no bill header (a pivot,
 * a cover sheet, a list of numbers alone) is skipped and reported by name
 * with the reason. Every row below the header with anything in either column
 * is a row.
 */
export function readReadyUpload(sheets: { name: string; rows: unknown[][] }[]): { rows: UploadRow[]; sheets: SheetReport[] } {
  const out: UploadRow[] = []
  const reports: SheetReport[] = []
  for (const { name, rows } of sheets) {
    let headerRow = -1
    let cCol = -1
    let vCol = -1
    let sawCheck = false
    for (let r = 0; r < Math.min(HEADER_SEARCH_ROWS, rows.length) && headerRow < 0; r++) {
      const labels = (rows[r] ?? []).map(label)
      const c = labels.findIndex((l) => CHECK_HEADERS.has(l))
      const v = labels.findIndex((l) => BILL_HEADERS.has(l))
      if (c >= 0) sawCheck = true
      if (v >= 0) { headerRow = r; cCol = c; vCol = v }
    }
    if (headerRow < 0) {
      const reason = sawCheck
        ? 'has a CHECK NUMBER column but no AP BILL column'
        : `no AP BILL header in its first ${HEADER_SEARCH_ROWS} rows`
      reports.push({ sheet: name, read: false, rows: 0, reason })
      continue
    }
    const keyedBy = cCol >= 0 ? 'NUMBER' : 'BILL'

    let n = 0
    for (let r = headerRow + 1; r < rows.length; r++) {
      const rawCheckNumber = cCol >= 0 ? text(rows[r]?.[cCol]) : null
      const rawVoucher = text(rows[r]?.[vCol])
      if (!rawCheckNumber && !rawVoucher) continue
      const v = rawVoucher?.toUpperCase() ?? null
      out.push({
        sheet: name,
        row: r + 1,
        keyedBy,
        checkNumber: canonicalCheckNumber(rawCheckNumber),
        voucher: v && VOUCHER.test(v) ? v : null,
        rawCheckNumber,
        rawVoucher,
      })
      n++
    }
    reports.push({ sheet: name, read: true, rows: n, keyedBy })
  }
  return { rows: out, sheets: reports }
}

/** I/O only: every sheet of an .xlsx, every cell, as the grid `readReadyUpload` reads. */
export async function sheetsFromWorkbook(buffer: Buffer): Promise<{ name: string; rows: unknown[][] }[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  const sheets: { name: string; rows: unknown[][] }[] = []
  wb.eachSheet((ws) => {
    const rows: unknown[][] = []
    for (let r = 1; r <= ws.rowCount; r++) {
      const cells: unknown[] = []
      ws.getRow(r).eachCell({ includeEmpty: true }, (c, i) => { cells[i - 1] = c.value })
      rows.push(cells)
    }
    sheets.push({ name: ws.name, rows })
  })
  return sheets
}

/** A cheque as the plan carries it: plain values only, so the preview can cross to the browser. */
export type UploadCheck = {
  id: string
  checkNumber: string
  companyCode: string
  payeeName: string | null
  amount: string | null
  currency: string
  checkDate: string | null
  accountCode: string | null
  status: CheckStatus
  acumaticaStatus: string | null
  isCheque: boolean
  /** `apvNumbers` ∪ the approval workbook's bills. */
  vouchers: string[]
}

export type UploadVerdict =
  | { kind: 'READY'; check: UploadCheck; signFirst: boolean }
  | { kind: 'ALREADY_READY'; check: UploadCheck }
  | { kind: 'RELEASED'; check: UploadCheck }
  | { kind: 'NO_CHECK' }
  | { kind: 'ONLY_CANCELLED_OR_VOIDED' }
  | { kind: 'AMBIGUOUS'; count: number }
  | { kind: 'BILL_NOT_ON_CHECK'; check: UploadCheck }
  | { kind: 'NOT_PROMOTABLE'; check: UploadCheck; reason: string }
  | { kind: 'INVALID_ROW'; reason: string }

export const VERDICT_KINDS = [
  'READY', 'ALREADY_READY', 'RELEASED', 'NO_CHECK', 'ONLY_CANCELLED_OR_VOIDED', 'AMBIGUOUS',
  'BILL_NOT_ON_CHECK', 'NOT_PROMOTABLE', 'INVALID_ROW',
] as const satisfies readonly UploadVerdict['kind'][]

/**
 * Pure. `candidates` are every cheque held under the row's key — its canonical
 * number, any company, on a NUMBER-keyed row; every cheque carrying its bill
 * on a BILL-keyed one. `pickupDate` is the batch's, needed because the ready
 * guard lists it as required. The order of the tests is the order a reader
 * would want to hear them: is the row readable, is there a cheque, is it the
 * one, does it pay this bill, can it be made ready.
 */
export function judgeUploadRow(row: UploadRow, candidates: readonly UploadCheck[], pickupDate: Date): UploadVerdict {
  if (!row.checkNumber && !row.rawVoucher) return { kind: 'INVALID_ROW', reason: 'blank' }
  if (row.keyedBy === 'NUMBER' && !row.checkNumber) return { kind: 'INVALID_ROW', reason: 'no check number on the row' }
  if (!row.rawVoucher) return { kind: 'INVALID_ROW', reason: 'no AP bill on the row' }
  if (!row.voucher) return { kind: 'INVALID_ROW', reason: `"${row.rawVoucher}" is not an AP bill number` }

  if (candidates.length === 0) return { kind: 'NO_CHECK' }
  const live = candidates.filter((c) => !DEAD.includes(c.status))
  if (live.length === 0) return { kind: 'ONLY_CANCELLED_OR_VOIDED' }
  if (live.length > 1) return { kind: 'AMBIGUOUS', count: live.length }
  const check = live[0]

  // Trivially true on a BILL-keyed row: the candidates were found by the bill.
  if (!check.vouchers.includes(row.voucher)) return { kind: 'BILL_NOT_ON_CHECK', check }

  if (check.status === 'READY_FOR_RELEASE' || check.status === 'SCHEDULED') return { kind: 'ALREADY_READY', check }
  if (check.status === 'RELEASED') return { kind: 'RELEASED', check }
  if (!check.isCheque) return { kind: 'NOT_PROMOTABLE', check, reason: 'not a check (DEBIT ADV / CASH)' }
  if (check.acumaticaStatus === 'Voided') return { kind: 'NOT_PROMOTABLE', check, reason: 'Voided in Acumatica' }
  if (!PROMOTABLE.includes(check.status)) return { kind: 'NOT_PROMOTABLE', check, reason: `${check.status} is not in the signing queue` }

  // The guard the MARK READY button runs, with the status it will hold by
  // then: a SIGNATURE_PENDING cheque is signed first.
  const guard = checkReadyForRelease({
    status: 'SIGNED',
    checkNumber: check.checkNumber,
    payeeName: check.payeeName,
    amount: check.amount,
    checkDate: check.checkDate ? new Date(check.checkDate) : null,
    cashAccountCode: check.accountCode,
    availablePickupDate: pickupDate,
    isCheque: check.isCheque,
  })
  if (!guard.ok) return { kind: 'NOT_PROMOTABLE', check, reason: guard.message }

  return { kind: 'READY', check, signFirst: check.status === 'SIGNATURE_PENDING' }
}

export type LeftAlone = {
  row: UploadRow
  kind: Exclude<UploadVerdict['kind'], 'READY'>
  /** One sentence for the report. */
  message: string
  checkNumber: string | null
  status: CheckStatus | null
  acumaticaStatus: string | null
}

export type ReadyUploadPlan = {
  file: string
  sheets: SheetReport[]
  /** Data rows read across every sheet. */
  rows: number
  /** One entry per cheque, however many rows name it. */
  toReady: { check: UploadCheck; signFirst: boolean; rows: UploadRow[] }[]
  leftAlone: LeftAlone[]
  counts: Record<UploadVerdict['kind'], number>
}

const SELECT = {
  id: true, checkNumber: true, status: true, acumaticaStatus: true, isCheque: true,
  payeeName: true, amount: true, currency: true, checkDate: true, apvNumbers: true,
  company: { select: { code: true } },
  cashAccount: { select: { code: true } },
  checkBook: { select: { code: true } },
  bills: { select: { apvNumber: true } },
} satisfies Prisma.CheckSelect

type Loaded = Prisma.CheckGetPayload<{ select: typeof SELECT }>

function toUploadCheck(c: Loaded): UploadCheck {
  return {
    id: c.id,
    checkNumber: c.checkNumber,
    companyCode: c.company.code,
    payeeName: c.payeeName,
    amount: c.amount?.toString() ?? null,
    currency: c.currency,
    checkDate: c.checkDate?.toISOString() ?? null,
    // The account: the cheque book, else the register label — the one rule
    // (`accountWhere`, 2026-10-06), and what `markReadyForRelease` reads.
    accountCode: c.checkBook?.code ?? c.cashAccount?.code ?? null,
    status: c.status,
    acumaticaStatus: c.acumaticaStatus,
    isCheque: c.isCheque,
    vouchers: [...new Set([...c.apvNumbers, ...c.bills.map((b) => b.apvNumber)])],
  }
}

function emptyCounts(): Record<UploadVerdict['kind'], number> {
  return Object.fromEntries(VERDICT_KINDS.map((k) => [k, 0])) as Record<UploadVerdict['kind'], number>
}

/** Every cheque carrying any of `vouchers`, in `apvNumbers` or as an approval-workbook bill. */
async function holdersOf(db: PrismaClient, vouchers: string[]): Promise<Loaded[]> {
  if (vouchers.length === 0) return []
  return db.check.findMany({
    where: { OR: [{ apvNumbers: { hasSome: vouchers } }, { bills: { some: { apvNumber: { in: vouchers } } } }] },
    select: SELECT,
  })
}

/**
 * Three queries at most, however long the list: every cheque under every
 * number named; every cheque carrying a bill the BILL-keyed rows name; then —
 * for the NUMBER-keyed rows whose bill is not on the cheque their number
 * names — every cheque that does carry that bill, so the report can say where
 * it is.
 */
export async function planReadyUpload(
  db: PrismaClient,
  args: { file: string; list: { rows: UploadRow[]; sheets: SheetReport[] }; pickupDate: Date },
): Promise<ReadyUploadPlan> {
  const { file, list, pickupDate } = args
  const numbers = [...new Set(list.rows.map((r) => r.checkNumber).filter((n): n is string => n !== null))]
  const held = numbers.length === 0 ? [] : await db.check.findMany({ where: { checkNumber: { in: numbers } }, select: SELECT })
  const byNumber = new Map<string, UploadCheck[]>()
  for (const c of held) byNumber.set(c.checkNumber, [...(byNumber.get(c.checkNumber) ?? []), toUploadCheck(c)])

  const billKeyed = [...new Set(list.rows.filter((r) => r.keyedBy === 'BILL').map((r) => r.voucher).filter((v): v is string => v !== null))]
  const byBill = new Map<string, UploadCheck[]>()
  for (const c of await holdersOf(db, billKeyed)) {
    const u = toUploadCheck(c)
    for (const v of u.vouchers) if (billKeyed.includes(v)) byBill.set(v, [...(byBill.get(v) ?? []), u])
  }

  const plan: ReadyUploadPlan = { file, sheets: list.sheets, rows: list.rows.length, toReady: [], leftAlone: [], counts: emptyCounts() }
  const ready = new Map<string, { check: UploadCheck; signFirst: boolean; rows: UploadRow[] }>()
  const strays: { row: UploadRow; check: UploadCheck }[] = []

  for (const row of list.rows) {
    const candidates = row.keyedBy === 'BILL'
      ? (row.voucher ? byBill.get(row.voucher) ?? [] : [])
      : (row.checkNumber ? byNumber.get(row.checkNumber) ?? [] : [])
    const v = judgeUploadRow(row, candidates, pickupDate)
    plan.counts[v.kind]++
    if (v.kind === 'READY') {
      const prev = ready.get(v.check.id)
      ready.set(v.check.id, { check: v.check, signFirst: v.signFirst, rows: [...(prev?.rows ?? []), row] })
      continue
    }
    if (v.kind === 'BILL_NOT_ON_CHECK') { strays.push({ row, check: v.check }); continue }
    plan.leftAlone.push(describe(row, v))
  }
  plan.toReady = [...ready.values()]

  if (strays.length > 0) {
    const vouchers = [...new Set(strays.map((s) => s.row.voucher).filter((x): x is string => x !== null))]
    const holders = await holdersOf(db, vouchers)
    for (const { row, check } of strays) {
      const where = holders
        .filter((h) => h.apvNumbers.includes(row.voucher!) || h.bills.some((b) => b.apvNumber === row.voucher))
        .map((h) => `${h.checkNumber} (${h.status})`)
      const held = check.vouchers.length > 0 ? `this check pays ${check.vouchers.join(', ')}` : 'this check carries no AP bill here'
      const elsewhere = where.length > 0 ? `; ${row.voucher} is on ${where.join(', ')}` : `; ${row.voucher} is on no check here`
      plan.leftAlone.push({
        row, kind: 'BILL_NOT_ON_CHECK', checkNumber: check.checkNumber, status: check.status, acumaticaStatus: check.acumaticaStatus,
        message: `AP bill is not on this check — ${held}${elsewhere}`,
      })
    }
  }
  return plan
}

function describe(row: UploadRow, v: Exclude<UploadVerdict, { kind: 'READY' | 'BILL_NOT_ON_CHECK' }>): LeftAlone {
  const check = 'check' in v ? v.check : null
  const base = {
    row, kind: v.kind,
    checkNumber: check?.checkNumber ?? row.checkNumber,
    status: check?.status ?? null,
    acumaticaStatus: check?.acumaticaStatus ?? null,
  }
  switch (v.kind) {
    case 'ALREADY_READY': return { ...base, message: `already ${v.check.status.replace(/_/g, ' ')} — nothing to do` }
    case 'RELEASED': return { ...base, message: 'already RELEASED — a release is never pulled back by a list' }
    case 'NO_CHECK': return {
      ...base,
      message: row.keyedBy === 'BILL'
        ? 'no check here pays this AP bill — has the sync read the check, and the BILLS read linked it?'
        : 'no check with this number here — has the sync read it?',
    }
    case 'ONLY_CANCELLED_OR_VOIDED': return {
      ...base,
      message: row.keyedBy === 'BILL' ? 'every check paying this AP bill is CANCELLED or VOIDED' : 'every check with this number is CANCELLED or VOIDED',
    }
    case 'AMBIGUOUS': return {
      ...base,
      message: row.keyedBy === 'BILL'
        ? `${v.count} live checks pay this AP bill — settle which one on /vouchers or in Acumatica first`
        : `${v.count} live checks hold this number — settle it on the staged queue or in Acumatica first`,
    }
    case 'NOT_PROMOTABLE': return { ...base, message: v.reason }
    case 'INVALID_ROW': return { ...base, message: v.reason }
  }
}

export type ReadyUploadSummary = {
  readied: number
  /** Of the readied, how many were SIGNATURE_PENDING and were signed first. */
  signed: number
  /** Changed under us between preview and confirm, or refused by the domain. */
  failed: { checkNumber: string; message: string }[]
  /** Left for a second upload because the time budget ran out. The upload is idempotent. */
  notReached: number
}

/**
 * One transaction per cheque: sign if needed, then ready. Both are the
 * domain's own writes, so the audit rows, the portal event and the ladder's
 * refusals are theirs; this adds only the `source` (file, sheet, row, bill)
 * to each row. A cheque whose status moved since the preview is refused by
 * `assertTransition` and reported, not overwritten. `deadline` stops the loop
 * short of the request's own limit; what is left is counted, and a second
 * upload of the same file picks it up (the readied rows read ALREADY_READY).
 */
export async function applyReadyUpload(
  db: PrismaClient,
  plan: ReadyUploadPlan,
  args: { userId: string; pickupDate: Date; now: Date; deadline?: Date },
): Promise<ReadyUploadSummary> {
  const summary: ReadyUploadSummary = { readied: 0, signed: 0, failed: [], notReached: 0 }
  for (const [i, { check, signFirst, rows }] of plan.toReady.entries()) {
    if (args.deadline && Date.now() > args.deadline.getTime()) { summary.notReached = plan.toReady.length - i; break }
    const source = {
      file: plan.file,
      listRows: rows.map((r) => ({ sheet: r.sheet, row: r.row, voucher: r.voucher, checkNumber: r.rawCheckNumber })),
    }
    try {
      await db.$transaction(async (tx) => {
        // Re-read before writing: a cheque that moved since the preview is
        // reported in those terms, not in the ladder's ("not yet SIGNED" for
        // a cheque somebody cancelled in between reads as a different problem).
        const live = await tx.check.findUnique({ where: { id: check.id }, select: { status: true } })
        if (!live) throw new DomainError('NOT_FOUND', 'Check not found.')
        if (live.status !== check.status) {
          throw new DomainError('MOVED_SINCE_PREVIEW', `was ${check.status} at the preview and is now ${live.status}; not changed — preview the list again`)
        }
        if (signFirst) await markSigned(tx, { checkId: check.id, userId: args.userId, now: args.now, source })
        await markReadyForRelease(tx, {
          checkId: check.id, userId: args.userId, availablePickupDate: args.pickupDate, now: args.now, source,
        })
      }, { timeout: 30_000, maxWait: 15_000 })
      summary.readied++
      if (signFirst) summary.signed++
    } catch (e) {
      if (!(e instanceof DomainError)) throw e
      summary.failed.push({ checkNumber: check.checkNumber, message: e.message })
    }
  }
  return summary
}
