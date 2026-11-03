import type { CheckStatus, PrismaClient } from '@prisma/client'
import ExcelJS from 'exceljs'
import { writeAudit } from '@/lib/audit'
import { canonicalCheckNumber, cleanCell } from '@/lib/import/normalise'

/**
 * Move to READY_FOR_RELEASE the cheques a FOR RELEASE workbook lists.
 *
 * WHY NOT `lib/import/bills.ts`. That importer reads the approval workbook by
 * its 24-column Acumatica header on ROW 1, and carries a `check No.` column.
 * `FOR RELEASE 9.25.2026.xlsx` (2026-09-24) has neither: `Detail1` is a pivot
 * drill-down with the header on row 3 and no cheque number; `LOCAL` puts a BANK
 * column first and its header on row 2; `BROKERS` is register-shaped. Pointed
 * at it, `isBillSheet` reads zero rows. Rather than widen a parser whose whole
 * safety rests on one exact header, this reads the one thing every sheet here
 * shares — an AP voucher under a recognisable header — and resolves the cheque
 * through `Check.apvNumbers`, the path `bills.ts` already uses when its
 * `check No.` cell is unusable.
 *
 * THE RULE is the client's of 2026-09-04: the for-release list IS the
 * ready-for-release set. On 2026-09-24 the user ruled that all three sheets are
 * the list; on 2026-09-25 they narrowed it to LOCAL + BROKERS — the two sheets
 * the workbook's own PIVOT sums. `Detail1` is the pivot's DRILL-DOWN ("Details
 * for Sum of Detail Total - FINANCE REMARKS: AVAILABLE"): every bill Acumatica
 * remarks AVAILABLE, 939 vouchers and 117.8M, not the release list. Reading it
 * promoted 428 cheques (57.2M) that `scripts/revert-detail1-ready.ts` put back.
 * A drill-down sheet is recognised by that title on row 1 and skipped.
 *
 * EXACTLY ONE LIVE CHEQUE or nothing. A voucher naming no cheque, or more than
 * one live one, is reported and left — the same "exactly one match or stage it"
 * rule `bills.ts` holds, not relaxed for scale.
 *
 * WHAT IT WILL NOT TOUCH.
 *   - RELEASED, CANCELLED or VOIDED here. A list that still says "available"
 *     about a cheque the register shows handed over is a stale list; nothing is
 *     pulled back from RELEASED on a spreadsheet's word.
 *   - Anything Acumatica reports `Voided`, and any non-cheque payment
 *     (`isCheque = false`): DEBIT ADV and TT never sit at READY_FOR_RELEASE.
 *   - Nothing is demoted. The user asked on 2026-09-24 to check first whether
 *     off-list cheques were released in an earlier file; that is a report
 *     (`offList` below), not a write.
 *   - `readyAt`, `readyById`, `availablePickupDate` stay null and no portal
 *     event is queued, as in `scripts/backfill-available.ts`: nobody approved
 *     these in this system, and the portal learns state when Plan 3 connects.
 *   - No `CheckBill` row. That table is the approval workbook's bill detail,
 *     and `scripts/backfill-available.ts` reads "has a bill" as "on the list" —
 *     so running that script after this one would demote these cheques. Do not.
 */

export const READY_FROM_LIST_ACTION = 'marked_ready_from_release_list'

const PROMOTABLE: readonly CheckStatus[] = ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED']
const DEAD: readonly CheckStatus[] = ['CANCELLED', 'VOIDED']
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const

/** Headers under which a sheet of this workbook states the AP voucher. */
const VOUCHER_HEADERS = ['REFERENCE NBR.', 'VOUCHER NUMBER']
const CHEQUE_HEADERS = ['CHECK NUMBER']
/** Every export so far puts its header within the first three rows. */
const HEADER_SEARCH_ROWS = 3
/** `AP-ST043681`, `STPP-AP-000021`, `A1PP-AP-000014`. */
const VOUCHER = /^([A-Z0-9]+-)?AP-[A-Z0-9-]+$/
/** Excel's title for a pivot drill-down sheet. Not the list — see the header. */
const DRILL_DOWN = /^DETAILS FOR /

export type ListEntry = {
  sheet: string
  row: number
  voucher: string | null
  checkNumber: string | null
}

export type SheetReport = { sheet: string; read: boolean; entries: number }

function text(v: unknown): string | null {
  if (v && typeof v === 'object') {
    if ('richText' in v) return cleanCell((v as { richText: { text: string }[] }).richText.map((t) => t.text).join(''))
    if ('result' in v) return cleanCell((v as { result: unknown }).result)
    if ('text' in v) return cleanCell((v as { text: unknown }).text)
    return null
  }
  return cleanCell(v)
}

/**
 * Pure over a grid. A sheet is read when one of its first rows carries a voucher
 * or cheque-number header; everything below that row is data. A pivot has
 * neither and is skipped — and reported as skipped, by name.
 */
export function readReleaseList(sheets: { name: string; rows: unknown[][] }[]): { entries: ListEntry[]; sheets: SheetReport[] } {
  const entries: ListEntry[] = []
  const reports: SheetReport[] = []
  for (const { name, rows } of sheets) {
    if (DRILL_DOWN.test(text(rows[0]?.[0])?.toUpperCase() ?? '')) { reports.push({ sheet: name, read: false, entries: 0 }); continue }
    let headerRow = -1
    let vCol = -1
    let cCol = -1
    for (let r = 0; r < Math.min(HEADER_SEARCH_ROWS, rows.length) && headerRow < 0; r++) {
      const labels = rows[r].map((c) => text(c)?.toUpperCase() ?? '')
      vCol = labels.findIndex((l) => VOUCHER_HEADERS.includes(l))
      cCol = labels.findIndex((l) => CHEQUE_HEADERS.includes(l))
      if (vCol >= 0 || cCol >= 0) headerRow = r
    }
    if (headerRow < 0) { reports.push({ sheet: name, read: false, entries: 0 }); continue }

    let n = 0
    for (let r = headerRow + 1; r < rows.length; r++) {
      const vRaw = vCol >= 0 ? text(rows[r][vCol])?.toUpperCase() ?? null : null
      const voucher = vRaw && VOUCHER.test(vRaw) ? vRaw : null
      const checkNumber = cCol >= 0 ? canonicalCheckNumber(text(rows[r][cCol])) : null
      if (!voucher && !checkNumber) continue
      entries.push({ sheet: name, row: r + 1, voucher, checkNumber })
      n++
    }
    reports.push({ sheet: name, read: true, entries: n })
  }
  return { entries, sheets: reports }
}

export async function readReleaseListFile(file: string) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
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
  return readReleaseList(sheets)
}

export type Candidate = {
  id: string
  checkNumber: string
  status: CheckStatus
  acumaticaStatus: string | null
  isCheque: boolean
}

export type Verdict =
  | { kind: 'PROMOTE'; check: Candidate }
  | { kind: 'ALREADY_READY' }
  | { kind: 'RELEASED_HERE'; check: Candidate }
  | { kind: 'NOT_PROMOTABLE'; check: Candidate }
  | { kind: 'NO_MATCH' }
  | { kind: 'ONLY_CANCELLED_OR_VOIDED' }
  | { kind: 'AMBIGUOUS'; count: number }

/** Pure. Exactly one live cheque, or nothing is written. */
export function judge(candidates: readonly Candidate[]): Verdict {
  if (candidates.length === 0) return { kind: 'NO_MATCH' }
  const live = candidates.filter((c) => !DEAD.includes(c.status))
  if (live.length === 0) return { kind: 'ONLY_CANCELLED_OR_VOIDED' }
  if (live.length > 1) return { kind: 'AMBIGUOUS', count: live.length }
  const check = live[0]
  if (check.status === 'READY_FOR_RELEASE' || check.status === 'SCHEDULED') return { kind: 'ALREADY_READY' }
  if (check.status === 'RELEASED') return { kind: 'RELEASED_HERE', check }
  if (!check.isCheque || check.acumaticaStatus === 'Voided' || !PROMOTABLE.includes(check.status)) {
    return { kind: 'NOT_PROMOTABLE', check }
  }
  return { kind: 'PROMOTE', check }
}

export type ReadyPlan = {
  file: string
  sheets: SheetReport[]
  /** Distinct list items: a voucher, or a cheque number where no voucher was read. */
  items: number
  toPromote: { check: Candidate; entries: ListEntry[] }[]
  counts: Record<Exclude<Verdict['kind'], 'PROMOTE'>, number>
  leftAlone: { item: string; kind: Verdict['kind']; status?: CheckStatus; acumaticaStatus?: string | null }[]
  /** Cheques at READY_FOR_RELEASE that nothing on this list names. Reported, never moved. */
  offList: { checkNumber: string; acumaticaStatus: string | null }[]
}

const SELECT = { id: true, checkNumber: true, status: true, acumaticaStatus: true, isCheque: true } as const

export async function planReady(
  db: PrismaClient, file: string, list: { entries: ListEntry[]; sheets: SheetReport[] },
): Promise<ReadyPlan> {
  // One item per voucher; a row with only a cheque number is its own item.
  const items = new Map<string, ListEntry[]>()
  for (const e of list.entries) {
    const key = e.voucher ? `V:${e.voucher}` : `C:${e.checkNumber}`
    items.set(key, [...(items.get(key) ?? []), e])
  }

  const plan: ReadyPlan = {
    file, sheets: list.sheets, items: items.size, toPromote: [], leftAlone: [], offList: [],
    counts: { ALREADY_READY: 0, RELEASED_HERE: 0, NOT_PROMOTABLE: 0, NO_MATCH: 0, ONLY_CANCELLED_OR_VOIDED: 0, AMBIGUOUS: 0 },
  }
  const promote = new Map<string, { check: Candidate; entries: ListEntry[] }>()
  const named = new Set<string>()

  for (const [key, entries] of items) {
    let candidates: Candidate[]
    if (key.startsWith('V:')) {
      const voucher = key.slice(2)
      candidates = await db.check.findMany({
        where: { OR: [{ apvNumbers: { has: voucher } }, { bills: { some: { apvNumber: voucher } } }] },
        select: SELECT,
      })
      // A broker row states the cheque too. When the voucher finds nothing, the
      // cheque number the same row states is the evidence that remains.
      const stated = entries.find((e) => e.checkNumber)?.checkNumber
      if (candidates.length === 0 && stated) {
        candidates = await db.check.findMany({ where: { checkNumber: stated }, select: SELECT })
      }
    } else {
      candidates = await db.check.findMany({ where: { checkNumber: key.slice(2) }, select: SELECT })
    }
    for (const c of candidates) named.add(c.id)

    const v = judge(candidates)
    if (v.kind === 'PROMOTE') {
      const prev = promote.get(v.check.id)
      promote.set(v.check.id, { check: v.check, entries: [...(prev?.entries ?? []), ...entries] })
      continue
    }
    plan.counts[v.kind]++
    if (v.kind !== 'ALREADY_READY') {
      plan.leftAlone.push({
        item: key.slice(2), kind: v.kind,
        ...('check' in v ? { status: v.check.status, acumaticaStatus: v.check.acumaticaStatus } : {}),
      })
    }
  }
  plan.toPromote = [...promote.values()]

  const ready = await db.check.findMany({
    where: { status: 'READY_FOR_RELEASE' },
    select: { id: true, checkNumber: true, acumaticaStatus: true },
  })
  plan.offList = ready.filter((r) => !named.has(r.id)).map(({ checkNumber, acumaticaStatus }) => ({ checkNumber, acumaticaStatus }))
  return plan
}

export function snapshotOf(plan: ReadyPlan, takenAt: Date) {
  return {
    takenAt: takenAt.toISOString(),
    file: plan.file,
    rows: plan.toPromote.map(({ check }) => ({ id: check.id, checkNumber: check.checkNumber, status: check.status })),
  }
}

export async function applyReady(db: PrismaClient, plan: ReadyPlan): Promise<{ promoted: number; raced: number }> {
  let promoted = 0
  let raced = 0
  for (const { check, entries } of plan.toPromote) {
    await db.$transaction(async (tx) => {
      const { count } = await tx.check.updateMany({
        where: { id: check.id, status: check.status },
        data: { status: 'READY_FOR_RELEASE' },
      })
      if (count === 0) { raced++; return }
      await writeAudit(tx, {
        checkId: check.id,
        actorType: 'SYSTEM',
        action: READY_FROM_LIST_ACTION,
        details: {
          from: check.status,
          to: 'READY_FOR_RELEASE',
          file: plan.file,
          listRows: entries.map((e) => ({ sheet: e.sheet, row: e.row, voucher: e.voucher, checkNumber: e.checkNumber })),
          acumaticaStatusAtTheTime: check.acumaticaStatus,
        },
        remarks:
          `${plan.file} lists this check for release (${entries.map((e) => `${e.sheet} row ${e.row}`).join(', ')}). ` +
          'The for-release list is the ready-for-release set (client, 2026-09-04). Set directly: no one ' +
          'approved it in this system, so no approving user, time or pickup date is recorded.',
      })
      promoted++
    }, TX_OPTIONS)
  }
  return { promoted, raced }
}
