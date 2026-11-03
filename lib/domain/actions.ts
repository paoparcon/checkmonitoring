import { createHash } from 'node:crypto'
import type {
  Check, Prisma, PrismaClient, PortalEventKind,
  ClearingStatus as PrismaClearing,
} from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { portalApvs } from '@/lib/integrations/portal/apvs'
import { loadSettings } from '@/lib/settings/read'
import { DomainError } from './errors'
import { portalRoute, type Eligibility } from './eligibility'
import { checkDeletable } from './incomplete'
import {
  checkReceipt, normaliseReceipt, hasReceipt, checkReceiptAmount, checkReceiptFile, portalAcceptsReceiptType,
  type Receipt, type ReceiptType, type ReceiptFileInput,
} from './receipt'
import { checkReleaseReversible } from './reversal'
import { normaliseDetails, diffDetails, dayToDate, isoDay, type DetailInput, type DetailValues } from './details'
import {
  assertTransition, assertClearing, assertReleasable, checkReadyForRelease, LIVE_STATUSES,
  type CheckStatus, type ClearingStatus,
} from './check-status'
import { autoSignRunDay, isDueForAutoSign, AUTO_SIGNED_ACTION, SIGNATURE_REVERTED_ACTION } from './auto-sign'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * Where a signature or a READY FOR RELEASE came from when it was not a button
 * on the cheque: an uploaded list (`lib/admin/ready-upload.ts`). Carried onto
 * the audit row's details and remarks, so the trail names the file, sheet and
 * row the admin acted on. Optional: a button leaves it unset.
 */
export type ActionSource = {
  file: string
  listRows: { sheet: string; row: number; voucher: string | null; checkNumber: string | null }[]
}

function sourceRemark(source: ActionSource | undefined): string {
  if (!source) return ''
  return ` From the uploaded list ${source.file} (${source.listRows.map((r) => `${r.sheet} row ${r.row}`).join(', ')}).`
}

// Every action runs in one transaction that updates the check AND appends its
// audit row. A caller can pass an existing transaction client; otherwise we
// open our own.
//
// `options` is for the three receipt actions only: a 3 MB BYTEA insert to
// ap-southeast-1 can outrun Prisma's 5 s interactive-transaction default (the
// same trap `TX_OPTIONS` in lib/import/upsert.ts avoids; spec 2026-10-02).
type TxOptions = { timeout?: number; maxWait?: number }
async function inTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: TxOptions): Promise<T> {
  if ('$transaction' in db && typeof db.$transaction === 'function') {
    return (db as PrismaClient).$transaction(fn, options)
  }
  return fn(db as Prisma.TransactionClient)
}

/**
 * The outbox's idempotency key: one instruction per (check, kind, acting
 * timestamp).
 *
 * The third segment is the action's own `now`, and that choice is the whole
 * design. A revert genuinely retracts what the portal was told, so marking the
 * cheque ready again afterwards is a NEW instruction the supplier has to hear
 * about — a fresh `now` gives it a fresh key, and the outbox queues it instead
 * of discarding it as already-sent. A repeat submit of the *same* action never
 * reaches here at all: `TRANSITIONS` in check-status.ts has no
 * READY_FOR_RELEASE -> READY_FOR_RELEASE edge, so it throws first. The unique
 * key is our own guarantee that the queue holds no duplicate work; it is not the
 * last line of defence against double-notifying a supplier, because the portal
 * holds a notify-exactly-once latch of its own (confirmed from its source,
 * 2026-09-04). Both exist; neither licenses relaxing the other.
 *
 * Do NOT take the timestamp from `check.readyAt`. `load()` snapshots the row
 * BEFORE the update, and `revertAvailability` sets `readyAt` back to null, so at
 * every call site it is null and a `check.readyAt ?? now` would be a branch that
 * can never be taken — exactly the kind a future reader "tidies" into something
 * that quietly changes the key.
 *
 * Deliberately not exported. The tests spell the format out as a literal, so
 * changing it fails a test rather than being mirrored by a shared helper that
 * would pin nothing.
 */
function portalEventKey(checkId: string, kind: PortalEventKind, now: Date): string {
  return `${checkId}:${kind}:${now.toISOString()}`
}

// CANCELLED is no longer queued by anything (user ruling 2026-10-29, see
// `detachFromBills`): a cancelled cheque is cut loose from its AP bills, and the
// portal matches on APV. The kind stays in the enum for the rows already written.

/** For the receipt actions, which may carry a 3 MB file into the transaction. */
const RECEIPT_TX_OPTIONS: TxOptions = { timeout: 30_000, maxWait: 10_000 }

/** Validates amount + file together; throws the first refusal. */
function receiptExtras(args: { receiptAmount?: string; receiptFile?: ReceiptFileInput }): { amount: string | null; file: ReceiptFileInput | null } {
  const a = checkReceiptAmount(args.receiptAmount)
  if (!a.ok) throw new DomainError(a.code, a.message)
  const f = checkReceiptFile(args.receiptFile)
  if (!f.ok) throw new DomainError(f.code, f.message)
  return { amount: a.amount ?? null, file: args.receiptFile ?? null }
}

/** What an audit row says about a stored file: never its bytes (rule 7). */
type ReceiptFileMeta = { fileName: string; contentType: string; sizeBytes: number; sha256: string }

async function storeReceiptFile(
  tx: Prisma.TransactionClient, checkId: string, userId: string, file: ReceiptFileInput, now: Date,
): Promise<ReceiptFileMeta> {
  const bytes = Buffer.from(file.bytes)
  const meta: ReceiptFileMeta = {
    fileName: file.fileName.slice(0, 200) || 'receipt',
    contentType: file.contentType,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
  await tx.checkReceiptFile.create({
    data: { checkId, ...meta, bytes, uploadedById: userId, uploadedAt: now },
  })
  return meta
}

/**
 * The sixth kind (user request 2026-10-01). The body is rebuilt from the
 * cheque at delivery, so the payload is a record only: never the file.
 */
async function queueReceipt(
  tx: Prisma.TransactionClient,
  check: { id: string; checkNumber: string; apvNumbers: string[] },
  args: { orNumber: string | null; receiptType: string | null; amount: string | null; hasFile: boolean; now: Date },
): Promise<void> {
  // A legacy receipt with no OR/CR type would only park (the portal requires
  // the type; final review 2026-10-02), and so would an AR, PR or SI, which
  // the portal does not accept yet: those stay recorded here only.
  if (!args.orNumber || !portalAcceptsReceiptType(args.receiptType)) return
  // Same guard as CANCELLED (review 2026-10-02): the portal matches on APV, so
  // a cheque with none could only ever park; the receipt stays recorded here.
  if (!(await portalCanMatch(tx, check))) return
  await tx.portalEvent.create({
    data: {
      checkId: check.id, direction: 'OUT', kind: 'RECEIPT', status: 'PENDING',
      idempotencyKey: portalEventKey(check.id, 'RECEIPT', args.now),
      payload: { action: 'RECEIPT', checkNumber: check.checkNumber, orNumber: args.orNumber, amount: args.amount, hasFile: args.hasFile },
    },
  })
}

/**
 * Whether the portal could match an event for this cheque at all. The portal
 * matches on APV and the client refuses an event with none, so an event queued
 * for a cheque with no APV parks on its first attempt and RETRY parks it again
 * (spec 2026-10-01-cheque-numbering-and-cancel-guard-design §A1). Bills are
 * read only when `apvNumbers` is empty — the same fallback as the client,
 * through the same function. Asked by the RECEIPT queue and by the quiet
 * INTERNAL events; CANCELLED no longer asks (ruling 2026-10-29).
 */
async function portalCanMatch(tx: Prisma.TransactionClient, check: { id: string; apvNumbers: string[] }): Promise<boolean> {
  const bills = check.apvNumbers.length
    ? []
    : await tx.checkBill.findMany({ where: { checkId: check.id }, select: { apvNumber: true } })
  return portalApvs({ apvNumbers: check.apvNumbers, bills }).length > 0
}

/**
 * User ruling 2026-10-19 (Supplier Portal spec 2026-10-19-cm-internal-release-quiet):
 * an INTERNAL check's release and reversal are sent so the portal stops aging
 * its bill. Only those kinds, only with an APV to match, and the check's own
 * portal columns stay untouched (check_internal_never_routes_to_portal):
 * delivery state lives on the PortalEvent row. Its cancellation was sent the
 * same way until 2026-10-29; a cancelled cheque now has no APV to send it on.
 */
async function queuesQuietStatus(tx: Prisma.TransactionClient, check: { id: string; eligibility: string; apvNumbers: string[] }): Promise<boolean> {
  return check.eligibility === 'INTERNAL' && portalCanMatch(tx, check)
}

/**
 * Recorded on the `cancelled` / `voided` audit row of a portal-routed cheque:
 * nothing was sent, because a cancelled cheque is no longer connected to the AP
 * bills it was applied to, and the portal matches on APV.
 */
export const DETACHED_SKIP_REASON = 'detached from its AP bills on cancel'

/** The audit action the one-off repair writes for a cheque cancelled or voided before this rule. */
export const APV_DETACHED_ACTION = 'apv_detached_on_cancel'

export type DetachedBills = {
  apvNumbersDetached: string[]
  /** The `CheckBill` rows deleted, whole, so the append-only trail keeps what the workbook stated. */
  billsDetached: Array<{
    apvNumber: string; poNumber: string | null; rrNumber: string | null; statusRr: string | null
    description: string | null; glAccount: string | null; dueDate: string | null; termsCode: string | null
    amount: string; createdByName: string | null
  }>
}

/**
 * USER RULING 2026-10-29: "Once the check is cancelled, it should not be
 * connected to the AP it was applied to."
 *
 * The Supplier Portal keeps one release row per BILL, keyed by APV; this system
 * keeps events per CHEQUE. A void and re-issue is two cheques on one bill, and
 * the voided cheque's CANCELLED event — matched on that APV — cancelled the
 * bill's row in the portal, so the replacement's RELEASED arrived at a
 * cancelled row and was refused ("cancelled in the portal; a super must
 * resolve": 6000354974..77 on AP-ST039900/07/10/12, 26 October). The bill was
 * never cancelled; it moved to a new cheque.
 *
 * So a cancel or void cuts the cheque loose from its bills: `apvNumbers` is
 * emptied and its `CheckBill` rows are deleted, and NO portal event is queued
 * — there is no APV left to match it on, and the bill now belongs to whichever
 * live cheque pays it. What was detached is written, whole, onto the audit row
 * that records the cancellation. The BILLS read (`lib/sync/bills.ts`), the
 * payment sync's voucher merge (`lib/import/upsert.ts`) and the
 * approval-workbook importer (`lib/import/bills.ts`) all refuse to re-link a
 * CANCELLED or VOIDED cheque, so the detachment holds.
 *
 * Consequence, accepted with the ruling: the portal is no longer told about a
 * cancellation at all, re-issue or not. A bill whose cheque was cancelled with
 * no replacement keeps whatever state the portal had for it until somebody
 * there changes it — which is how the portal worked before the integration.
 */
export async function detachFromBills(
  tx: Prisma.TransactionClient, check: { id: string; apvNumbers: readonly string[] },
): Promise<DetachedBills> {
  const bills = await tx.checkBill.findMany({
    where: { checkId: check.id },
    orderBy: { apvNumber: 'asc' },
    select: {
      apvNumber: true, poNumber: true, rrNumber: true, statusRr: true, description: true,
      glAccount: true, dueDate: true, termsCode: true, amount: true, createdByName: true,
    },
  })
  if (bills.length) await tx.checkBill.deleteMany({ where: { checkId: check.id } })
  if (check.apvNumbers.length) await tx.check.update({ where: { id: check.id }, data: { apvNumbers: [] } })
  return {
    apvNumbersDetached: [...check.apvNumbers],
    billsDetached: bills.map((b) => ({
      ...b, dueDate: b.dueDate?.toISOString() ?? null, amount: b.amount.toString(),
    })),
  }
}

/** The audit keys for a cancellation: the portal decision (routed cheques only) and what was detached. */
function cancelAuditDetails(routed: boolean, detached: DetachedBills): Prisma.InputJsonObject {
  const anyDetached = detached.apvNumbersDetached.length > 0 || detached.billsDetached.length > 0
  return {
    ...(routed ? { portalNotified: false, portalSkipReason: DETACHED_SKIP_REASON } : {}),
    ...(anyDetached ? detached : {}),
  }
}

/** One sentence naming what a cancellation detached, for the remark a reader sees on the trail. */
function detachedRemark(detached: DetachedBills): string {
  const apvs = [...new Set([...detached.apvNumbersDetached, ...detached.billsDetached.map((b) => b.apvNumber)])].sort()
  return apvs.length ? ` Detached from ${apvs.join(', ')} (user ruling 2026-10-29).` : ''
}

async function load(tx: Prisma.TransactionClient, checkId: string) {
  const check = await tx.check.findUnique({
    where: { id: checkId },
    include: { cashAccount: true, checkBook: true },
  })
  if (!check) throw new DomainError('NOT_FOUND', 'Check not found.')
  return check
}

export async function markSigned(
  db: Db, args: { checkId: string; userId: string; now: Date; source?: ActionSource },
): Promise<Check> {
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertReleasable({ isCheque: check.isCheque })
    assertTransition(check.status as CheckStatus, 'SIGNED')
    const updated = await tx.check.update({
      where: { id: check.id },
      data: { status: 'SIGNED', signedById: args.userId, signedAt: args.now },
    })
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: 'marked_signed',
      ...(args.source ? { details: { source: args.source }, remarks: sourceRemark(args.source).trim() } : {}),
    })
    return updated
  })
}

/**
 * The Monday-and-Tuesday rule's write (lib/domain/auto-sign.ts). No user: `signedById`
 * stays null, because a name on a signature nobody gave is worse than none.
 * Reached only when the setting is on — the run decides that. Re-judged on
 * the row as loaded, so a check someone signed, reverted or cancelled after
 * the candidates were listed is skipped (null), never overwritten. No portal
 * event — `markSigned` queues none either.
 */
export async function autoSign(
  db: Db, args: { checkId: string; now: Date },
): Promise<Check | null> {
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    const reverted = (await tx.auditLog.count({ where: { checkId: check.id, action: SIGNATURE_REVERTED_ACTION } })) > 0
    const runDay = autoSignRunDay(args.now)
    if (runDay === null || !isDueForAutoSign({ ...check, reverted }, args.now, true)) return null
    const day = runDay === 'MONDAY' ? 'Monday' : 'Tuesday'
    assertTransition(check.status as CheckStatus, 'SIGNED')
    const { count } = await tx.check.updateMany({
      where: { id: check.id, status: 'SIGNATURE_PENDING' },
      data: { status: 'SIGNED', signedAt: args.now },
    })
    if (count === 0) return null
    await writeAudit(tx, {
      checkId: check.id,
      actorType: 'SYSTEM',
      action: AUTO_SIGNED_ACTION,
      details: { from: 'SIGNATURE_PENDING', to: 'SIGNED', rule: 'WEEKLY', runDay, inAppSince: check.createdAt.toISOString() },
      remarks:
        `Signed automatically at ${day}'s run: this Acumatica check first reached the app on ` +
        `${check.createdAt.toISOString()}, before that ${day}. No one signed it here, so no signing user is recorded.`,
    })
    return tx.check.findUniqueOrThrow({ where: { id: check.id } })
  })
}

/**
 * A signature, undone (client, 2026-10-01). Any Finance user; the reason is
 * optional. SIGNED only — the ladder refuses anything else, and a cheque on
 * the release list must come back to SIGNED through `revertAvailability`
 * first. The previous signer goes on the audit row (null for an auto-signed
 * cheque), because clearing `signedById` would otherwise erase who it was.
 * No portal event: signing never produces one. A cheque carrying this row is
 * never auto-signed again (`isDueForAutoSign`).
 */
export async function revertSignature(
  db: Db, args: { checkId: string; userId: string; reason?: string; now: Date },
): Promise<Check> {
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertTransition(check.status as CheckStatus, 'SIGNATURE_PENDING')
    // Guarded on SIGNED, as `autoSign` guards on SIGNATURE_PENDING: a change
    // between the read above and this write (a second revert, a mark-ready)
    // must refuse with the ladder's own error rather than overwrite it.
    const { count } = await tx.check.updateMany({
      where: { id: check.id, status: 'SIGNED' },
      data: { status: 'SIGNATURE_PENDING', signedById: null, signedAt: null },
    })
    if (count === 0) {
      const current = await tx.check.findUnique({ where: { id: check.id }, select: { status: true } })
      throw new DomainError(
        'ILLEGAL_TRANSITION',
        `Cannot move a check from ${current?.status ?? 'a changed status'} to SIGNATURE_PENDING.`,
      )
    }
    const reason = args.reason?.trim() || null
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: SIGNATURE_REVERTED_ACTION,
      details: {
        from: 'SIGNED', to: 'SIGNATURE_PENDING',
        previousSignerId: check.signedById, previousSignedAt: check.signedAt?.toISOString() ?? null,
      },
      ...(reason ? { remarks: reason } : {}),
    })
    return tx.check.findUniqueOrThrow({ where: { id: check.id } })
  })
}

export async function markReadyForRelease(
  db: Db,
  args: { checkId: string; userId: string; availablePickupDate: Date | null; now: Date; source?: ActionSource },
): Promise<Check> {
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)

    // Blocking guards. A failure aborts before anything is written.
    const guard = checkReadyForRelease({
      status: check.status as CheckStatus,
      checkNumber: check.checkNumber,
      payeeName: check.payeeName,
      amount: check.amount?.toString() ?? null,
      checkDate: check.checkDate,
      // The account: the cheque book, else the register label (full check
      // 2026-10-06: the label alone blocked 930 of 1,370 live cheques).
      cashAccountCode: check.checkBook?.code ?? check.cashAccount?.code ?? null,
      availablePickupDate: args.availablePickupDate,
      isCheque: check.isCheque,
    })
    if (!guard.ok) throw new DomainError(guard.code, guard.message)

    assertTransition(check.status as CheckStatus, 'READY_FOR_RELEASE')

    // Routing condition, NOT a guard: an INTERNAL check still changes status,
    // it simply never produces a portal event.
    const route = portalRoute(check.eligibility as Eligibility)
    const pushes = route !== null

    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'READY_FOR_RELEASE',
        readyById: args.userId,
        readyAt: args.now,
        availablePickupDate: args.availablePickupDate,
        portalSyncStatus: pushes ? 'PENDING' : 'NOT_APPLICABLE',
        portalDomain: route,
      },
    })

    if (pushes) {
      // Both fields are in REQUIRED_FIELDS, so the guard 30 lines above has
      // already proved them non-blank and this cannot fire. It is asserted
      // rather than defaulted because the alternative — `?? null`, as used at
      // the guard call site where a null is a legitimate input — would make a
      // portal event announcing a cheque with no amount, payable to nobody,
      // *representable*. If that guard were ever weakened, such a payload
      // would be published to a supplier instead of stopping here.
      //
      // Do not "simplify" this to `??`. This payload leaves the system, and a
      // financial figure on its way to an outside party is the wrong place to
      // be forgiving. Failing loudly here costs one blocked release; the
      // permissive version costs a supplier being told a cheque is ready and
      // being shown nothing where the amount should be.
      if (check.amount === null || check.payeeName === null) {
        throw new DomainError(
          'INCOMPLETE_PORTAL_PAYLOAD',
          'This check cannot be published to the supplier portal because its amount or payee is missing.',
        )
      }
      await tx.portalEvent.create({
        data: {
          checkId: check.id,
          direction: 'OUT',
          kind: 'MARK_AVAILABLE',
          status: 'PENDING',
          idempotencyKey: portalEventKey(check.id, 'MARK_AVAILABLE', args.now),
          payload: {
            action: 'MARK_AVAILABLE',
            checkNumber: check.checkNumber,
            payeeName: check.payeeName,
            amount: check.amount.toString(),
            availablePickupDate: args.availablePickupDate?.toISOString() ?? null,
          },
        },
      })
    }

    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: 'ready_for_release',
      details: {
        availablePickupDate: args.availablePickupDate?.toISOString() ?? null, portalPush: pushes,
        ...(args.source ? { source: args.source } : {}),
      },
      remarks: `Pickup ${args.availablePickupDate?.toISOString().slice(0, 10) ?? 'unset'}.${sourceRemark(args.source)}`,
    })

    return updated
  })
}

export async function revertAvailability(
  db: Db, args: { checkId: string; userId: string; reason: string; now: Date },
): Promise<Check> {
  if (!args.reason || args.reason.trim() === '') {
    throw new DomainError('REASON_REQUIRED', 'A reason is required to revert availability.')
  }
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertTransition(check.status as CheckStatus, 'SIGNED')

    // A release reversal the portal has not received yet (2026-10-23): this
    // REVERT would supersede it unsent (latest wins), the portal ignores a REVERT
    // on a row it still holds as RELEASED, and the supplier's AP would stay
    // paid there. Refused until RELEASE_REVERSED is delivered.
    const reversalWaiting = await tx.portalEvent.findFirst({
      where: { checkId: check.id, kind: 'RELEASE_REVERSED', status: { in: ['PENDING', 'IN_FLIGHT', 'FAILED', 'PARKED'] } },
      select: { status: true },
    })
    if (reversalWaiting) {
      throw new DomainError(
        'PORTAL_REVERSAL_PENDING',
        reversalWaiting.status === 'PARKED'
          ? 'The supplier portal refused the release reversal (see Administration → Portal). Resolve it there before reverting to SIGNED.'
          : 'The supplier portal has not received the release reversal yet. Try again in a few seconds.',
      )
    }

    const route = portalRoute(check.eligibility as Eligibility)
    const pushes = route !== null

    // Clearing the confirmation matters: a stale pickup date on a check that is
    // no longer available shows up as a phantom schedule on the dashboard.
    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'SIGNED',
        availablePickupDate: null,
        scheduledPickupDate: null,
        scheduledPickupTime: null,
        pickupRep: null,
        portalConfirmedAt: null,
        readyById: null,
        readyAt: null,
        portalSyncStatus: pushes ? 'PENDING' : 'NOT_APPLICABLE',
        portalDomain: route,
      },
    })

    if (pushes) {
      await tx.portalEvent.create({
        data: {
          checkId: check.id, direction: 'OUT', kind: 'REVERT', status: 'PENDING',
          idempotencyKey: portalEventKey(check.id, 'REVERT', args.now),
          payload: { action: 'REVERT', checkNumber: check.checkNumber },
        },
      })
    }

    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId,
      action: 'reverted_availability', remarks: args.reason,
    })

    return updated
  })
}

/**
 * A release, undone. FINANCE_ADMIN only — enforced by the server action, as
 * `revertAvailability`'s is — with a mandatory reason.
 *
 * Client design 2026-09-10, one point settled 2026-09-11: the cheque goes back
 * ONE rung, to READY_FOR_RELEASE, and stays available to the supplier. The
 * portal is therefore told the cheque is available again — `RELEASE_REVERSED`,
 * delivered through the same status endpoint RELEASED uses — and NOT `REVERT`,
 * which the portal reads as withdrawn for re-upload. Two systems disagreeing
 * about whether a supplier may collect is the failure this distinction avoids.
 *
 * What is cleared: the release itself (`releasedAt`, `releasedById`) and the
 * collection that did not happen (the scheduled pickup and its confirmation).
 * What is kept: the availability (`availablePickupDate`, `readyById`,
 * `readyAt`) and Finance's `remarks`. The reason goes on the audit row, whose
 * `details` record what was undone, so the trail says more than "reversed".
 *
 * Refused — before anything is written — when a receipt is on record or the
 * bank has cleared the cheque. See `checkReleaseReversible`.
 */
export async function reverseRelease(
  db: Db, args: { checkId: string; userId: string; reason: string; now: Date },
): Promise<Check> {
  if (!args.reason || args.reason.trim() === '') {
    throw new DomainError('REASON_REQUIRED', 'A reason is required to reverse a release.')
  }
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    // Same guard `markSigned` and `markReleased` apply: an import-derived row
    // can carry `isCheque: false` with status RELEASED, and reversing one
    // would land a DEBIT ADV or TT payment at READY_FOR_RELEASE — a state
    // `markReadyForRelease` itself refuses for a non-cheque.
    assertReleasable({ isCheque: check.isCheque })
    // `assertTransition` alone cannot tell this reversal apart from the
    // forward edge `markReadyForRelease` uses: READY_FOR_RELEASE is reachable
    // from SIGNED just as it is from RELEASED (`check-status.ts`'s ladder).
    // This action IS the RELEASED -> READY_FOR_RELEASE edge specifically, so
    // the starting status is checked directly before falling through to the
    // same ladder check every other action uses.
    if (check.status !== 'RELEASED') {
      throw new DomainError('ILLEGAL_TRANSITION', `Cannot move a check from ${check.status} to READY_FOR_RELEASE.`)
    }
    assertTransition(check.status as CheckStatus, 'READY_FOR_RELEASE')
    const guard = checkReleaseReversible(check)
    if (!guard.ok) throw new DomainError(guard.code, guard.message)

    const route = portalRoute(check.eligibility as Eligibility)
    const pushes = route !== null
    const quiet = !pushes && await queuesQuietStatus(tx, check)

    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'READY_FOR_RELEASE',
        releasedAt: null,
        releasedById: null,
        scheduledPickupDate: null,
        scheduledPickupTime: null,
        pickupRep: null,
        portalConfirmedAt: null,
        portalSyncStatus: pushes ? 'PENDING' : 'NOT_APPLICABLE',
        portalDomain: route,
      },
    })

    if (pushes || quiet) {
      await tx.portalEvent.create({
        data: {
          checkId: check.id, direction: 'OUT', kind: 'RELEASE_REVERSED', status: 'PENDING',
          idempotencyKey: portalEventKey(check.id, 'RELEASE_REVERSED', args.now),
          payload: { action: 'RELEASE_REVERSED', checkNumber: check.checkNumber },
        },
      })
    }

    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId,
      action: 'release_reversed', remarks: args.reason,
      // What was undone, as it stood: the trail must say more than "reversed".
      details: { releasedAt: check.releasedAt?.toISOString() ?? null, releasedById: check.releasedById },
    })

    return updated
  })
}

export async function applyPickupConfirmation(
  db: Db,
  args: { checkId: string; pickupDate: Date; pickupTime?: string; pickupRep?: string; confirmedAt: Date },
): Promise<Check> {
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    // A portal message may only move READY_FOR_RELEASE -> SCHEDULED. It can
    // never release a check: physical release is Finance-only.
    assertTransition(check.status as CheckStatus, 'SCHEDULED')
    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'SCHEDULED',
        scheduledPickupDate: args.pickupDate,
        scheduledPickupTime: args.pickupTime ?? null,
        pickupRep: args.pickupRep ?? null,
        portalConfirmedAt: args.confirmedAt,
      },
    })
    await writeAudit(tx, {
      checkId: check.id, actorType: 'SYSTEM', action: 'supplier_pickup_confirmed',
      details: { pickupDate: args.pickupDate.toISOString(), pickupTime: args.pickupTime ?? null },
      remarks: args.pickupDate.toISOString().slice(0, 10),
    })
    return updated
  })
}

/**
 * The audit row a receipt gets, wherever it was entered.
 *
 * Written for every receipt and only for a receipt, so "who recorded this OR,
 * and when" is one query rather than a reading of two different actions'
 * details. `withRelease` is the whole reason it is a shared helper: a receipt
 * handed over at the counter and a receipt typed in the next morning are
 * different events, and the difference has to be recorded at the time — it
 * cannot be reconstructed afterwards from timestamps, because a release and a
 * late entry on the same afternoon look identical.
 *
 * The receipt's own amount and file (user request 2026-10-01) ride along as
 * `extras` when they were given: the amount as the decimal string written, the
 * file as metadata only — name, type, size, sha256, never its bytes (rule 7).
 */
const RECEIPT_REMARK_LABELS: Record<ReceiptType | 'UNSTATED', string> = {
  OR: 'Official Receipt',
  CR: 'Collection Receipt',
  AR: 'Acknowledgement Receipt',
  PR: 'Provisional Receipt',
  SI: 'Sales Invoice',
  OTHERS: 'Other receipt',
  UNSTATED: 'Receipt of unstated kind',
}

async function writeReceiptAudit(
  tx: Prisma.TransactionClient,
  args: {
    checkId: string; userId: string; receipt: Receipt; withRelease: boolean; now: Date
    extras?: { amount: string | null; file: ReceiptFileMeta | null }
  },
): Promise<void> {
  await writeAudit(tx, {
    checkId: args.checkId,
    actorType: 'USER',
    userId: args.userId,
    action: 'receipt_recorded',
    details: {
      orNumber: args.receipt.orNumber,
      // The receipt's OWN date — the day the supplier wrote it — which is not
      // the day it was typed in. `recordedAt` below is that.
      orDate: args.receipt.orDate?.toISOString() ?? null,
      receiptType: args.receipt.receiptType,
      withRelease: args.withRelease,
      recordedAt: args.now.toISOString(),
      ...(args.extras ? { amount: args.extras.amount, file: args.extras.file } : {}),
    },
    // The null arm cannot be reached — `checkReceipt` refuses a reference with
    // no type — and is written out anyway rather than folded into the OR
    // branch. A ternary whose else-arm says "Official Receipt" would label an
    // unanswered question as an answer if the guard were ever weakened, which
    // is the one failure this whole feature is arranged to prevent.
    remarks:
      `${RECEIPT_REMARK_LABELS[args.receipt.receiptType ?? 'UNSTATED']} ` +
      `${args.receipt.orNumber}${args.withRelease ? ' (recorded at release)' : ' (added after release)'}`,
  })
}

export async function markReleased(
  db: Db,
  args: {
    checkId: string; userId: string
    /**
     * The supplier's receipt, all three optional together. The client's ruling:
     * a cheque may be released with the box empty and the receipt added later,
     * which is what RELEASE ALL at the counter depends on.
     */
    orNumber?: string; orDate?: Date; receiptType?: ReceiptType | null
    /** The receipt's amount and scanned file (user request 2026-10-01); both
     * belong to the reference above and are refused without it. */
    receiptAmount?: string; receiptFile?: ReceiptFileInput
    remarks?: string; now: Date
  },
): Promise<Check> {
  // Before the transaction opens, and before anything is written: a reference
  // with no type refuses the whole release rather than releasing the cheque and
  // dropping the reference on the floor.
  const guard = checkReceipt(args)
  if (!guard.ok) throw new DomainError(guard.code, guard.message)
  const receipt = normaliseReceipt(args)
  const extras = receiptExtras(args)
  const hasExtras = extras.amount !== null || extras.file !== null
  if (hasExtras && !hasReceipt(receipt)) throw receiptExtrasOrphaned()

  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertReleasable({ isCheque: check.isCheque })
    assertTransition(check.status as CheckStatus, 'RELEASED')

    /**
     * A receipt already on record must never be wiped or replaced by a
     * release. Before this guard, an empty box on a cheque that already
     * carried a receipt (possible via `recordReceipt` on a re-release path,
     * or any future caller) would write `orNumber: undefined`-normalised-to-
     * `null` over it — WIPING it — and a typed one would REPLACE it. Both are
     * the exact hazard rule 11 exists to prevent, just arriving through
     * `markReleased` instead of `recordReceipt`. The fix mirrors
     * `recordReceipt`'s own refusal: a typed receipt against an already-
     * recorded one is refused outright, naming what is there, rather than
     * silently discarded; an empty box against one already recorded simply
     * leaves the three receipt columns untouched.
     */
    const alreadyHasReceipt = check.orNumber !== null
    if (alreadyHasReceipt && hasReceipt(receipt)) {
      throw new DomainError(
        'RECEIPT_ALREADY_RECORDED',
        `This check already records receipt ${check.orNumber}. A recorded receipt is not ` +
        'overwritten from here — if it is wrong, raise it with a Finance Admin.',
      )
    }
    // Unreachable today (an amount or file without a typed reference is refused
    // above, and a typed reference against a recorded one just now), and kept
    // so the amount/file can never land on a receipt this release did not write.
    if (hasExtras && alreadyHasReceipt) throw receiptExtrasOrphaned()

    const route = portalRoute(check.eligibility as Eligibility)
    const pushes = route !== null
    const quiet = !pushes && await queuesQuietStatus(tx, check)
    // The receipt columns are written by this release: it carries a reference
    // and the cheque had none. Only then do the amount and file go with them.
    const writesReceipt = !alreadyHasReceipt && hasReceipt(receipt)

    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'RELEASED',
        releasedById: args.userId,
        releasedAt: args.now,
        // Only written when this release actually carries a receipt, or the
        // cheque has none yet. Never written when the cheque already has one
        // and this release's box was empty — see the guard above.
        ...(alreadyHasReceipt
          ? {}
          : { orNumber: receipt.orNumber, orDate: receipt.orDate, receiptType: receipt.receiptType }),
        ...(writesReceipt && extras.amount !== null ? { receiptAmount: extras.amount } : {}),
        remarks: args.remarks ?? check.remarks,
        portalSyncStatus: pushes ? 'PENDING' : 'NOT_APPLICABLE',
      },
    })

    if (pushes || quiet) {
      await tx.portalEvent.create({
        data: {
          checkId: check.id,
          direction: 'OUT',
          // The third kind. This call site pre-dates Plan 3 and its plan was
          // drafted without it; the portal accepts it at POST /api/checks/:id,
          // which takes `status`, `orNumber` and `orDate` at encoder tier.
          kind: 'RELEASED',
          status: 'PENDING',
          idempotencyKey: portalEventKey(check.id, 'RELEASED', args.now),
          // `receiptType` is deliberately NOT in the payload. The portal's
          // POST /api/checks/:id takes `status`, `orNumber` and `orDate` at
          // encoder tier (evidence in docs/superpowers/specs/) and nothing
          // more; a field it does not accept is a field that can fail a
          // delivery nobody is watching. Which kind of receipt it is stays a
          // Finance fact until the portal asks for it.
          payload: {
            action: 'RELEASED',
            checkNumber: check.checkNumber,
            releasedAt: args.now.toISOString(),
            // The RECORDED reference, not necessarily this release's own
            // typed one: when the cheque already carried a receipt and this
            // release's box was empty, `receipt.orNumber` is null even though
            // the database keeps the original. Sending null there would tell
            // a future portal delivery (Plan 3) to wipe its own copy of a
            // receipt this release never touched.
            orNumber: alreadyHasReceipt ? check.orNumber : receipt.orNumber,
          },
        },
      })
    }

    const fileMeta = writesReceipt && extras.file
      ? await storeReceiptFile(tx, check.id, args.userId, extras.file, args.now)
      : null
    // RELEASED and RECEIPT share `now` and still never collide: the kind is
    // part of the key (user request 2026-10-01).
    if (pushes && writesReceipt) {
      await queueReceipt(tx, check, { orNumber: receipt.orNumber, receiptType: receipt.receiptType, amount: extras.amount, hasFile: fileMeta !== null, now: args.now })
    }

    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: 'released',
      remarks: args.remarks,
    })
    // In the same transaction as the release it accompanied, so a receipt can
    // never be recorded against a release that rolled back.
    if (hasReceipt(receipt)) {
      await writeReceiptAudit(tx, {
        checkId: check.id, userId: args.userId, receipt, withRelease: true, now: args.now,
        extras: hasExtras ? { amount: extras.amount, file: fileMeta } : undefined,
      })
    }
    return updated
  }, RECEIPT_TX_OPTIONS)
}

/** The statuses `releaseDirectly` walks up the ladder before releasing. */
export const DIRECT_RELEASE_FROM = ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED'] as const satisfies readonly CheckStatus[]

/**
 * MARK RELEASED from any rung below READY FOR RELEASE (client, 2026-10-09 for
 * SIGNED; 2026-10-16 for GENERATED and SIGNATURE PENDING: "all checks from
 * generated to signed can be directly released").
 *
 * The ladder keeps its shape: the check is signed, readied and released, each
 * through its own domain action, so every guard still runs — the READY guards
 * (payee, amount, check book, …), the portal's MARK_AVAILABLE, the receipt
 * rules. All three share ONE transaction, so a refusal at any step leaves the
 * check exactly where it was rather than stranded halfway up. A READY FOR
 * RELEASE or SCHEDULED check is simply released.
 */
export async function releaseDirectly(
  db: Db,
  args: Parameters<typeof markReleased>[1],
): Promise<Check> {
  // The receipt is refused before anything is written, as in `markReleased`.
  const guard = checkReceipt(args)
  if (!guard.ok) throw new DomainError(guard.code, guard.message)

  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    const from = check.status as CheckStatus
    if (!(DIRECT_RELEASE_FROM as readonly CheckStatus[]).includes(from)) return markReleased(tx, args)

    assertReleasable({ isCheque: check.isCheque })
    const step = { checkId: check.id, userId: args.userId, now: args.now }
    if (from !== 'SIGNED') await markSigned(tx, step)
    await markReadyForRelease(tx, { ...step, availablePickupDate: args.now })
    return markReleased(tx, { ...args, remarks: args.remarks ?? `Released directly from ${from}` })
  }, RECEIPT_TX_OPTIONS)
}

/** An amount or file with no receipt reference of this action's own to belong to. */
function receiptExtrasOrphaned(): DomainError {
  return new DomainError('RECEIPT_REQUIRED', 'An amount or file needs the receipt reference it belongs to.')
}

/**
 * The add-it-later path, and the reason the box is allowed to be empty at all.
 *
 * The client made the receipt optional — "A cheque can be released with the box
 * empty and the receipt added later" — and an optional field with no way to
 * fill it in afterwards is not optional, it is skipped.
 *
 * **Only for a cheque that has actually been handed over.** A receipt is the
 * paper the supplier gives back when they collect, so there is nothing to
 * record before that happens. `releasedAt` is tested alongside the status, not
 * as a proxy for it: `voidCheck` leaves the release facts standing on a cheque
 * voided after release, deliberately, as the evidence it was handed over — and
 * the receipt for that hand-over is part of the same evidence.
 *
 * **It adds; it does not amend.** A cheque that already records a receipt is
 * refused, and the refusal names what is there. Overwriting would replace a
 * fact somebody entered against money that has already moved, and this path
 * exists to fill a gap rather than to correct one. If Finance ever needs a
 * correction, it should be its own action with its own reason, not this one
 * quietly widened.
 *
 * **It queues RECEIPT** (user request 2026-10-01) for a routed cheque, so the
 * late receipt reaches the portal's Payments page; amount and file are add-only
 * like the reference.
 */
export async function recordReceipt(
  db: Db,
  args: {
    checkId: string; userId: string
    orNumber: string; orDate?: Date; receiptType: ReceiptType | null
    receiptAmount?: string; receiptFile?: ReceiptFileInput
    now: Date
  },
): Promise<Check> {
  const guard = checkReceipt(args)
  if (!guard.ok) throw new DomainError(guard.code, guard.message)
  const receipt = normaliseReceipt(args)
  const extras = receiptExtras(args)

  // Distinct from the guard above: this endpoint exists to ADD a receipt, so an
  // empty box is nothing to do rather than a silent clearing of one.
  if (!hasReceipt(receipt)) {
    throw new DomainError(
      'RECEIPT_REQUIRED',
      'Enter the receipt reference the supplier gave you. Leaving it blank records nothing.',
    )
  }

  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)

    if (check.status !== 'RELEASED' && check.releasedAt === null) {
      throw new DomainError(
        'NOT_RELEASED',
        'A supplier’s receipt can only be recorded against a check that has been RELEASED. ' +
        'Release the check first; the receipt can be entered at the same time.',
      )
    }

    if (check.orNumber !== null) {
      throw new DomainError(
        'RECEIPT_ALREADY_RECORDED',
        `This check already records receipt ${check.orNumber}. A recorded receipt is not ` +
        'overwritten from here — if it is wrong, raise it with a Finance Admin.',
      )
    }

    const updated = await tx.check.update({
      where: { id: check.id },
      // Only the receipt columns. Not `status`, which is already RELEASED and
      // is not this action's to move; and emphatically not `crNumber` or
      // `clearingStatus`, which are the BANK's clearing facts.
      data: {
        orNumber: receipt.orNumber,
        orDate: receipt.orDate,
        receiptType: receipt.receiptType,
        ...(extras.amount !== null ? { receiptAmount: extras.amount } : {}),
      },
    })

    const fileMeta = extras.file ? await storeReceiptFile(tx, check.id, args.userId, extras.file, args.now) : null
    if (portalRoute(check.eligibility as Eligibility) !== null) {
      await queueReceipt(tx, check, { orNumber: receipt.orNumber, receiptType: receipt.receiptType, amount: extras.amount, hasFile: fileMeta !== null, now: args.now })
    }

    await writeReceiptAudit(tx, {
      checkId: check.id, userId: args.userId, receipt, withRelease: false, now: args.now,
      extras: extras.amount !== null || fileMeta !== null ? { amount: extras.amount, file: fileMeta } : undefined,
    })

    return updated
  }, RECEIPT_TX_OPTIONS)
}

/**
 * Adds the amount and/or scanned file to a receipt recorded without them
 * (user request 2026-10-01: "allow the OR/CR to be uploaded after payment").
 * Add-only, like the reference: an amount or file already on record is
 * refused, never replaced. Queues RECEIPT for a routed cheque.
 */
export async function attachReceiptFile(
  db: Db,
  args: { checkId: string; userId: string; receiptAmount?: string; receiptFile?: ReceiptFileInput; now: Date },
): Promise<Check> {
  const extras = receiptExtras(args)
  if (extras.amount === null && !extras.file) {
    throw new DomainError('RECEIPT_NOTHING_TO_ATTACH', 'Choose the receipt file or enter its amount.')
  }
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    if (check.orNumber === null) {
      throw new DomainError('RECEIPT_REQUIRED', 'Record the receipt reference first; the file and amount belong to it.')
    }
    if (extras.amount !== null && check.receiptAmount !== null) {
      throw new DomainError(
        'RECEIPT_AMOUNT_ALREADY_RECORDED',
        `This receipt already records ${check.receiptAmount.toFixed(2)}. A recorded amount is not overwritten ` +
        'from here — if it is wrong, raise it with a Finance Admin.',
      )
    }
    const existingFile = await tx.checkReceiptFile.findUnique({ where: { checkId: check.id }, select: { checkId: true } })
    if (extras.file && existingFile) {
      throw new DomainError(
        'RECEIPT_FILE_ALREADY_ATTACHED',
        'This receipt already has its file. A recorded file is not replaced from here — if it is wrong, raise it with a Finance Admin.',
      )
    }
    const updated = extras.amount !== null
      ? await tx.check.update({ where: { id: check.id }, data: { receiptAmount: extras.amount } })
      : check
    const fileMeta = extras.file ? await storeReceiptFile(tx, check.id, args.userId, extras.file, args.now) : null
    if (portalRoute(check.eligibility as Eligibility) !== null) {
      await queueReceipt(tx, check, {
        orNumber: check.orNumber,
        receiptType: check.receiptType,
        amount: extras.amount ?? check.receiptAmount?.toFixed(2) ?? null,
        hasFile: fileMeta !== null || existingFile !== null,
        now: args.now,
      })
    }
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: 'receipt_attached',
      // Metadata only — never the bytes (rule 7).
      details: { orNumber: check.orNumber, amount: extras.amount, file: fileMeta },
      remarks: `Receipt ${check.orNumber}: ${[extras.amount !== null ? 'amount' : null, fileMeta ? 'file' : null].filter(Boolean).join(' and ')} added`,
    })
    return updated as Check
  }, RECEIPT_TX_OPTIONS)
}

export const RECEIPT_REMOVED_ACTION = 'receipt_removed'

/**
 * A receipt recorded by mistake, removed (user request 2026-10-23: 6000354897,
 * AR 4852, typed with a release that never happened). FINANCE_ADMIN only —
 * enforced by the server action — with a mandatory reason. It is what makes
 * REVERSE RELEASE possible again, since `checkReleaseReversible` refuses while a
 * receipt is on record; nothing else about the check changes.
 *
 * Clears rule 11's three receipt columns, the amount and the scanned file, and
 * records all of it (file metadata, never the bytes - rule 7) on one
 * `receipt_removed` audit row. Refused when the check is not RELEASED, when the
 * bank has cleared it, and when a RECEIPT event for it was DELIVERED to the
 * portal: the portal has no "remove receipt" message, so the two systems would
 * disagree. RECEIPT events still waiting are closed unsent.
 */
export async function removeReceipt(
  db: Db, args: { checkId: string; userId: string; reason: string; now: Date },
): Promise<Check> {
  const reason = args.reason?.trim() ?? ''
  if (!reason) throw new DomainError('REASON_REQUIRED', 'A reason is required to remove a receipt.')
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    const file = await tx.checkReceiptFile.findUnique({
      where: { checkId: check.id }, select: { fileName: true, contentType: true, sizeBytes: true, sha256: true },
    })
    if (check.orNumber === null && check.receiptType === null && check.receiptAmount === null && !file) {
      throw new DomainError('RECEIPT_REQUIRED', 'This check has no receipt to remove.')
    }
    if (check.status !== 'RELEASED') {
      throw new DomainError('ILLEGAL_TRANSITION', `A receipt is removed only from a RELEASED check; this one is ${check.status}.`)
    }
    if (check.clearingStatus !== 'NONE' || check.crNumber !== null || check.clearedDate !== null) {
      throw new DomainError('CLEARED', 'The bank has cleared this check; its receipt is not removed.')
    }
    const receiptEvents = await tx.portalEvent.findMany({ where: { checkId: check.id, kind: 'RECEIPT' } })
    const delivered = receiptEvents.filter((e) =>
      e.status === 'SYNCED' && !(e.lastError ?? '').startsWith('superseded by') && !(e.lastError ?? '').startsWith('stale:'))
    if (delivered.length > 0) {
      throw new DomainError(
        'RECEIPT_DELIVERED',
        'This receipt was already sent to the supplier portal, which cannot be told to remove it. Settle it there first.',
      )
    }
    const waiting = receiptEvents.filter((e) => e.status !== 'SYNCED').map((e) => e.id)
    if (waiting.length > 0) {
      await tx.portalEvent.updateMany({
        where: { id: { in: waiting } }, data: { status: 'SYNCED', lastError: 'closed: receipt removed' },
      })
    }

    const updated = await tx.check.update({
      where: { id: check.id }, data: { orNumber: null, orDate: null, receiptType: null, receiptAmount: null },
    })
    if (file) await tx.checkReceiptFile.delete({ where: { checkId: check.id } })
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: RECEIPT_REMOVED_ACTION, remarks: reason,
      details: {
        orNumber: check.orNumber, orDate: check.orDate?.toISOString() ?? null, receiptType: check.receiptType,
        receiptAmount: check.receiptAmount?.toFixed(2) ?? null, file, closedPortalEvents: waiting,
      },
    })
    return updated
  })
}

/**
 * The four register fields — remarks, point person, who is holding the
 * cheque, category. No status guard: a note can be added to a cancelled
 * cheque. Writes only the fields that changed, and nothing at all — no row,
 * no audit — when nothing did, so the trail records edits and not visits.
 * The audit row's `details` is `{ field: { from, to } }` for each change.
 */
export async function updateDetails(
  db: Db,
  args: { checkId: string; userId: string; fields: DetailInput; now: Date },
): Promise<Check> {
  return inTx(db, async (tx) => {
    const { values } = await loadSettings(tx)
    const check = await load(tx, args.checkId)
    const before: DetailValues = {
      remarks: check.remarks, pointPerson: check.pointPerson,
      checksPossession: check.checksPossession, category: check.category,
      expectedOutflowDate: isoDay(check.expectedOutflowDate),
    }
    const after = normaliseDetails(args.fields, before, { categories: values.categories })
    const changes = diffDetails(before, after)
    const changed = Object.keys(changes) as (keyof typeof changes)[]
    if (changed.length === 0) return check

    // The day string becomes the column's instant here and nowhere else.
    const data: Prisma.CheckUncheckedUpdateInput = {}
    for (const field of changed) {
      switch (field) {
        case 'expectedOutflowDate':
          data.expectedOutflowDate = after.expectedOutflowDate === null ? null : dayToDate(after.expectedOutflowDate)
          break
        default:
          data[field] = after[field]
      }
    }
    const updated = await tx.check.update({ where: { id: check.id }, data })
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId,
      action: 'details_updated', details: changes,
    })
    return updated
  })
}

export async function recordClearing(
  db: Db,
  args: {
    checkId: string; userId: string; clearingStatus: ClearingStatus
    crNumber?: string; clearedDate?: Date; now: Date
  },
): Promise<Check> {
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertClearing(
      check.status as CheckStatus,
      check.clearingStatus as ClearingStatus,
      args.clearingStatus,
    )
    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        clearingStatus: args.clearingStatus as PrismaClearing,
        crNumber: args.crNumber ?? check.crNumber,
        clearedDate: args.clearedDate ?? check.clearedDate,
      },
    })
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: 'clearing_recorded',
      details: { clearingStatus: args.clearingStatus, crNumber: args.crNumber ?? null },
    })
    return updated
  })
}

/**
 * The wording that makes a void after release impossible to miss in the audit
 * trail. Exported so the test asserts the shipped string rather than a copy of
 * it: this is the sentence a Finance user reads when deciding whether to ring
 * the bank, and a paraphrase that drifts is worse than no warning.
 */
export const VOID_AFTER_RELEASE_WARNING =
  'MONEY MAY ALREADY HAVE MOVED: this check had already been RELEASED to the payee when ' +
  'Acumatica voided it, so it may have been presented or cleared. Confirm with the bank before ' +
  'treating it as unpaid.'

/**
 * A void is an Acumatica FACT, not a Finance decision — which is the whole of
 * the difference between this and `cancelCheck`. The ERP has cancelled the
 * payment document; this system does not get a say, it only has to stop showing
 * a cheque the source of truth says no longer exists. Hence `actorType: 'SYSTEM'`
 * and no `userId`: there is no Finance user to attribute it to, and inventing
 * one would put a person's name against a decision they did not make.
 *
 * The plan said a void applies "from any non-RELEASED status". That is
 * superseded. `check-status.ts` permits RELEASED -> VOIDED deliberately: a
 * stop-payment on a cheque already handed over is a real event, and this system
 * disagreeing with the ERP is the worse failure. CANCELLED remains terminal, so
 * a void arriving for a cancelled cheque throws rather than overwriting a
 * Finance decision that carries a recorded reason.
 *
 * Queues NOTHING for the portal and detaches the cheque from its AP bills
 * (`detachFromBills`, user ruling 2026-10-29) — the same as `cancelCheck`. Until
 * that day a CANCELLED event went to the portal, which cancelled the BILL's row
 * there and refused the re-issued cheque's RELEASED. The audit row says what
 * was detached and that the portal was not told.
 */
export async function voidCheck(
  db: Db, args: { checkId: string; reason: string; now: Date },
): Promise<Check> {
  if (!args.reason || args.reason.trim() === '') {
    throw new DomainError('REASON_REQUIRED', 'A reason is required to void a check.')
  }
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    const from = check.status as CheckStatus
    assertTransition(from, 'VOIDED')

    const route = portalRoute(check.eligibility as Eligibility)
    const detached = await detachFromBills(tx, check)

    const updated = await tx.check.update({
      where: { id: check.id },
      // The release facts are left standing. They are what makes this void
      // alarming, and clearing them would erase the evidence that the cheque
      // was ever handed over.
      data: {
        status: 'VOIDED',
        voidedAt: args.now,
        portalSyncStatus: 'NOT_APPLICABLE',
        portalDomain: route,
      },
    })

    // A distinct action, not just distinct remarks: every audit query, filter
    // and screen that groups by action then separates this case for free,
    // whereas a warning buried in free text is one a list view never shows.
    const afterRelease = from === 'RELEASED'
    await writeAudit(tx, {
      checkId: check.id,
      actorType: 'SYSTEM',
      action: afterRelease ? 'voided_after_release' : 'voided',
      details: {
        fromStatus: from, releasedAt: check.releasedAt?.toISOString() ?? null,
        ...cancelAuditDetails(route !== null, detached),
      },
      remarks: (afterRelease ? `${VOID_AFTER_RELEASE_WARNING} ${args.reason}` : args.reason) + detachedRemark(detached),
    })

    return updated
  })
}

/**
 * The one path that removes a `Check` row, added at Finance's request so the
 * incomplete records can be cleared out. **Everything about it is narrow on
 * purpose.**
 *
 * Measured against production on 2026-09-04: 129 of the 9,247 register-derived
 * cheques carry no amount. 98 of them pass this guard. The other 31 — 25
 * RELEASED and 6 READY_FOR_RELEASE — do not, and that is the answer, not a gap
 * to be closed. See `UNDELETABLE_STATUSES`.
 *
 * **The audit trail survives.** `AuditLog.checkId` is ON DELETE SET NULL, so
 * every row this cheque accumulated goes on existing, detached but otherwise
 * byte-identical: action, details, remarks, actor and timestamp. Cascade would
 * destroy the record of who touched money, which is the thing the append-only
 * trigger exists to protect — and the trigger refuses it anyway. The detaching
 * UPDATE is the trigger's one exemption, granted only when the cheque is
 * genuinely gone; migration 20260905000100 is the record of that decision.
 *
 * **A final audit row is written first, in the same transaction.** Without it
 * the surviving rows point at nothing and nobody can say what was deleted, so
 * it carries the cheque's identity in `details` — number, company, payee,
 * status, source sheet and row. It is written with NO `checkId`: the column
 * would be set to null by the very delete two lines below it, and the identity
 * has to live somewhere that survives. `lib/admin/users.ts` writes its
 * user-administration rows the same way.
 *
 * There is deliberately no bulk version. 98 rows is a morning's work for one
 * person who is looking at each one, and a loop over a filter is how 98 becomes
 * 9,247 after somebody edits the filter.
 */
export async function deleteIncompleteCheck(
  db: Db,
  args: {
    checkId: string
    userId: string
    /**
     * The actor's role, passed in rather than read here: `lib/domain/` does not
     * reach for a session, and the server action has already resolved one. It
     * is still checked HERE as well as in the action, because a server action
     * is an HTTP endpoint and the domain rule must hold whoever calls it.
     */
    actorRole: 'FINANCE_USER' | 'FINANCE_ADMIN'
    reason: string
    now: Date
  },
): Promise<void> {
  // Required, like every other destructive act in this module. A deletion with
  // no stated reason would be the only unexplained one, and the reason is the
  // single thing a future reader of the surviving audit row cannot reconstruct
  // from the data.
  if (!args.reason || args.reason.trim() === '') {
    throw new DomainError('REASON_REQUIRED', 'A reason is required to delete a check record.')
  }

  return inTx(db, async (tx) => {
    const check = await tx.check.findUnique({
      where: { id: args.checkId },
      include: { company: true },
    })
    if (!check) throw new DomainError('NOT_FOUND', 'Check not found.')

    const guard = checkDeletable({
      actorRole: args.actorRole,
      // The amount itself, never `isIncomplete`. The flag is a stored
      // derivation the importer maintains and a stored derivation can drift.
      amount: check.amount?.toString() ?? null,
      status: check.status as CheckStatus,
      releasedAt: check.releasedAt,
    })
    if (!guard.ok) throw new DomainError(guard.code, guard.message)

    // `PortalEvent.checkId` is NOT NULL, so an event cannot be detached the way
    // an audit row can, and the FK is ON DELETE RESTRICT — the database would
    // refuse this anyway, with a foreign-key violation a Finance Admin cannot
    // act on. Refused here, first, with a sentence they can. Every event
    // counts, not only PENDING ones: a SYNCED event is the record that a
    // supplier was told something about this cheque.
    const events = await tx.portalEvent.count({ where: { checkId: check.id } })
    if (events > 0) {
      throw new DomainError(
        'PORTAL_EVENT_QUEUED',
        'The supplier portal outbox still holds an instruction about this check, so it cannot ' +
        'be deleted. A queued event cannot be detached the way an audit row can.',
      )
    }

    // `StagedCheck.promotedCheckId` is a plain column with no foreign key, so
    // nothing in the database would stop this: the pointer would simply dangle
    // and the staged queue would go on reporting the row as promoted into a
    // cheque that no longer exists. Measured: 0 of the 129 were promoted from a
    // staged row, so this refuses nothing today — it is here so it stays true.
    //
    // Deliberately NOT resolved by clearing `promotedCheckId`: that would make
    // the staged row eligible for promotion again and the next sync would
    // recreate the cheque, undoing the deletion with nobody told.
    const promoted = await tx.stagedCheck.count({ where: { promotedCheckId: check.id } })
    if (promoted > 0) {
      throw new DomainError(
        'PROMOTED_FROM_STAGED',
        'A staged register row was promoted into this check, and deleting it would leave the ' +
        'staging queue pointing at nothing. Settle the staged row first.',
      )
    }

    // Counted before the delete, for the record. `CheckBill` is ON DELETE
    // CASCADE and stays that way: a bill is a line OF the cheque and means
    // nothing without it, unlike an audit row, which is a record of what a
    // person did. Measured: 0 of the 129 carry a bill. `Notification.checkId`
    // is nullable and SET NULL, so any notification detaches quietly, as it
    // does for every other reference.
    const [bills, auditRows] = await Promise.all([
      tx.checkBill.count({ where: { checkId: check.id } }),
      tx.auditLog.count({ where: { checkId: check.id } }),
    ])

    await writeAudit(tx, {
      // No `checkId` — see the note above. The row is about a cheque that is
      // about to stop existing, and the pointer would be nulled by the delete
      // below before anyone could read it.
      actorType: 'USER',
      userId: args.userId,
      action: 'incomplete_check_deleted',
      details: {
        checkId: check.id,
        checkNumber: check.checkNumber,
        cvNumber: check.cvNumber,
        companyId: check.companyId,
        companyCode: check.company.code,
        payeeName: check.payeeName,
        status: check.status,
        checkDate: check.checkDate?.toISOString() ?? null,
        currency: check.currency,
        // Stated as null rather than omitted: "the amount was not recorded" is
        // the fact that made this deletable, and a missing key would read as an
        // oversight.
        amount: null,
        eligibility: check.eligibility,
        sourceSheet: check.sourceSheet,
        sourceRow: check.sourceRow,
        deletedAt: args.now.toISOString(),
        detachedAuditRows: auditRows,
        deletedBills: bills,
      },
      remarks:
        `Deleted incomplete check ${check.company.code} ${check.checkNumber} — ` +
        `${check.payeeName ?? 'no payee recorded'} (${check.status}, no amount recorded). ` +
        args.reason,
    })

    // The delete itself. The FK actions do the rest: audit rows detach, bills
    // cascade, notifications detach, and a portal event would have refused
    // above.
    await tx.check.delete({ where: { id: check.id } })
  })
}

export async function cancelCheck(
  db: Db, args: { checkId: string; userId: string; reason: string; now: Date },
): Promise<Check> {
  if (!args.reason || args.reason.trim() === '') {
    throw new DomainError('REASON_REQUIRED', 'A reason is required to cancel a check.')
  }
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertTransition(check.status as CheckStatus, 'CANCELLED')

    const route = portalRoute(check.eligibility as Eligibility)
    // Detached BEFORE the status is written, so a concurrent BILLS append that
    // read the cheque live still finds its lock after the detach and sees the
    // status (lib/sync/bills.ts re-reads both under FOR UPDATE).
    const detached = await detachFromBills(tx, check)

    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'CANCELLED',
        cancelledById: args.userId,
        cancelledAt: args.now,
        cancelReason: args.reason,
        portalSyncStatus: 'NOT_APPLICABLE',
        portalDomain: route,
      },
    })
    const details = cancelAuditDetails(route !== null, detached)
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId,
      action: 'cancelled', remarks: args.reason + detachedRemark(detached),
      ...(Object.keys(details).length ? { details } : {}),
    })
    return updated
  })
}

/**
 * A cancellation, undone (client, 2026-10-06): CANCELLED back to SIGNED. A reason
 * is required. Refused once the portal has been told — a CANCELLED event that is
 * SYNCED or IN_FLIGHT — because nothing reads the portal back (rule 12) and a
 * supplier-facing record would then say cancelled for a live cheque. An event
 * still waiting is closed unsent by the outbox, since it no longer matches the
 * cheque's status. The cancel fields are cleared; the audit row keeps them.
 *
 * The vouchers the cancellation detached (`apvNumbersDetached` on its audit
 * row, ruling 2026-10-29) are put back, so the restored cheque pays what it
 * paid; the deleted `CheckBill` rows are not rebuilt — the row keeps them, and
 * the approval workbook and the BILLS read are the live sources. A voucher
 * another live or RELEASED cheque of the company has taken since is left with
 * that cheque: the bill moved, and two live cheques on one bill is the conflict
 * the voucher screen refuses.
 */
export async function restoreCancelled(
  db: Db, args: { checkId: string; userId: string; reason: string; now: Date },
): Promise<Check> {
  if (!args.reason || args.reason.trim() === '') {
    throw new DomainError('REASON_REQUIRED', 'A reason is required to restore a cancelled check.')
  }
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertTransition(check.status as CheckStatus, 'SIGNED')
    const told = await tx.portalEvent.count({
      where: { checkId: check.id, kind: 'CANCELLED', status: { in: ['SYNCED', 'IN_FLIGHT'] } },
    })
    if (told > 0) {
      throw new DomainError(
        'PORTAL_ALREADY_NOTIFIED',
        'The portal has already been told this check is cancelled, so it cannot be restored here.',
      )
    }
    const reattach = await vouchersToReattach(tx, check)
    const { count } = await tx.check.updateMany({
      where: { id: check.id, status: 'CANCELLED' },
      data: {
        status: 'SIGNED', cancelledById: null, cancelledAt: null, cancelReason: null,
        signedById: null, signedAt: null, portalSyncStatus: 'NOT_APPLICABLE',
        ...(reattach.length ? { apvNumbers: [...new Set([...check.apvNumbers, ...reattach])].sort() } : {}),
      },
    })
    if (count === 0) {
      const current = await tx.check.findUnique({ where: { id: check.id }, select: { status: true } })
      throw new DomainError(
        'ILLEGAL_TRANSITION',
        `Cannot move a check from ${current?.status ?? 'a changed status'} to SIGNED.`,
      )
    }
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: 'cancellation_restored',
      details: {
        from: 'CANCELLED', to: 'SIGNED',
        previousCancelledById: check.cancelledById,
        previousCancelledAt: check.cancelledAt?.toISOString() ?? null,
        previousCancelReason: check.cancelReason,
        ...(reattach.length ? { apvNumbersReattached: reattach } : {}),
      },
      remarks: args.reason + (reattach.length ? ` Re-attached to ${reattach.join(', ')}.` : ''),
    })
    return tx.check.findUniqueOrThrow({ where: { id: check.id } })
  })
}

/**
 * The vouchers the latest `cancelled` audit row of this cheque says were
 * detached, minus any a live or RELEASED cheque of the same company carries
 * now, minus any the cheque already has. Sorted.
 */
async function vouchersToReattach(
  tx: Prisma.TransactionClient, check: { id: string; companyId: string; apvNumbers: string[] },
): Promise<string[]> {
  const row = await tx.auditLog.findFirst({
    where: { checkId: check.id, action: 'cancelled' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { details: true },
  })
  const details = row?.details
  const detached = details && typeof details === 'object' && !Array.isArray(details)
    ? (details as { apvNumbersDetached?: unknown }).apvNumbersDetached
    : undefined
  if (!Array.isArray(detached)) return []
  const wanted = [...new Set(detached.filter((v): v is string => typeof v === 'string' && v.length > 0))]
    .filter((v) => !check.apvNumbers.includes(v))
  if (wanted.length === 0) return []
  const taken = await tx.check.findMany({
    where: {
      companyId: check.companyId, id: { not: check.id },
      status: { in: [...LIVE_STATUSES, 'RELEASED'] },
      apvNumbers: { hasSome: wanted },
    },
    select: { apvNumbers: true },
  })
  const held = new Set(taken.flatMap((c) => c.apvNumbers))
  return wanted.filter((v) => !held.has(v)).sort()
}
