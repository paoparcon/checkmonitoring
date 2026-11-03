'use server'

import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { markSigned, markReadyForRelease, markReleased, releaseDirectly, recordReceipt, revertAvailability, revertSignature } from '@/lib/domain/actions'
import { parseSelection, chunkSelection } from '@/lib/bulk'
import {
  listTodaysReleaseIds, listPendingSignatureIds, getFilterOptions, parseOptionId, parseEligibilityParam,
  type SummaryNarrowing, type ColumnFilters,
} from '@/lib/queries'
import { parseColumnFilters, F_PARAMS } from '@/lib/column-filters'
import { readRowReceipts } from '@/lib/receipt-form'
import { runEach, type BulkOutcome, type BulkActionResult } from '@/lib/bulk-run'
import { loadSettings } from '@/lib/settings/read'
import { notifyReady } from '@/lib/notifications/ready'

export type { BulkOutcome, BulkActionResult }

/**
 * The spec's §13.1 minimum-click workflow: tick several cheques, press one
 * button.
 *
 * **Every cheque is processed independently, in its own transaction.** A batch
 * is a convenience for the user, never a unit of work: one cheque that cannot
 * be signed must not stop the other forty-nine that can, and a single
 * transaction around the lot would roll back real, valid releases because of an
 * unrelated refusal. The price is that a batch can end half-applied — which is
 * why the result carries a line per cheque rather than a verdict for the batch.
 *
 * **The refusal wording is the domain's own.** `lib/domain/` returns sentences
 * written for a Finance user ("required information is missing: AMOUNT"), and
 * they are passed through untouched. A generic "some cheques failed" would tell
 * somebody holding a stack of paper nothing about which one to go and look at.
 *
 * **Nothing here changes a status.** These actions call `lib/domain/actions.ts`
 * once per cheque and it does the work: the guards, the status, the audit row
 * and the portal event, all in one transaction. A second write path would be
 * one that could forget the audit row.
 *
 * **Authorisation failures RETURN, they never redirect.** `requireAdmin`
 * redirects, Next implements a redirect by throwing, and `runEach`'s catch
 * would swallow it and report "Something went wrong" on an action the user is
 * not entitled to. Same pattern as `revertAction` in `./actions.ts`.
 */

const ids = (f: FormData) => f.getAll('checkId').map((v) => String(v))
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

/**
 * The narrowing on screen when RELEASE ALL (TOTALS screen) or SIGN ALL (the
 * SIGNATURE PENDING list) was pressed, read back off the form. `null` means a field was SENT and does not parse
 * to a recognised value — the caller refuses, because dropping it would
 * silently widen the set from one company to every company. A field that is
 * not on the request at all is no narrowing: the unfiltered screen, and the
 * behaviour before 2026-09-29.
 *
 * "Sent" is `formData.has`, not "non-empty after trimming": the form renders
 * a hidden field only when it holds a value, so any field that arrives is
 * meant as a narrowing, and `company=%20` must refuse rather than read as
 * absent (review, 2026-09-29).
 */
async function readNarrowing(formData: FormData): Promise<SummaryNarrowing | null> {
  const sentCompany = formData.has('company')
  const sentCashAccount = formData.has('cashAccount')
  const sentEligibility = formData.has('eligibility')
  if (!sentCompany && !sentCashAccount && !sentEligibility) return {}

  const company = str(formData, 'company')
  const cashAccount = str(formData, 'cashAccount')
  const eligibility = str(formData, 'eligibility')

  const options = await getFilterOptions(prisma)
  const companyId = parseOptionId(company || undefined, options.companies)
  const cashAccountId = parseOptionId(cashAccount || undefined, options.cashAccounts)
  const elig = parseEligibilityParam(eligibility || undefined)
  if ((sentCompany && !companyId) || (sentCashAccount && !cashAccountId) || (sentEligibility && !elig)) return null
  return { companyId, cashAccountId, eligibility: elig }
}

/**
 * The column filters SIGN ALL's confirm form wrote back (spec C2), parsed by
 * the SAME function the page used. One it cannot read → null → refuse: a
 * filter dropped here would sign every pending cheque instead of the few the
 * reader was looking at.
 */
function readColumnFilters(formData: FormData): ColumnFilters | null {
  const parsed = parseColumnFilters((name) => {
    const v = formData.get(name)
    return typeof v === 'string' ? v : undefined
  }, { statusApplies: false })
  return Object.keys(parsed.errors).length > 0 ? null : parsed.filters
}

const sentColumnFilter = (formData: FormData) =>
  F_PARAMS.some((p) => { const v = formData.get(p); return typeof v === 'string' && v.trim() !== '' })

export async function bulkSignAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  const settings = await loadSettings(prisma)
  const selection = parseSelection(ids(formData), settings.values['caps.bulkSelection'])
  if (!selection.ok) return { ok: false, message: selection.message }

  // One timestamp for the batch: these cheques were signed in one act, and the
  // audit trail should say so.
  const now = new Date()
  return runEach(prisma, selection.checkIds, (checkId) =>
    markSigned(prisma, { checkId, userId: user.id, now }))
}

export async function bulkReadyForReleaseAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  const settings = await loadSettings(prisma)
  const selection = parseSelection(ids(formData), settings.values['caps.bulkSelection'])
  if (!selection.ok) return { ok: false, message: selection.message }

  // The pickup date is one field shared by the whole batch, so a missing or
  // unparseable one is refused here, before anything is written, rather than
  // producing an identical MISSING_FIELDS refusal against every cheque. The
  // domain still requires it — `checkReadyForRelease` lists AVAILABLE PICKUP
  // DATE in REQUIRED_FIELDS — this only reports it once and in terms of the
  // control the user actually touched.
  const raw = str(formData, 'availablePickupDate')
  const availablePickupDate = raw ? new Date(raw) : null
  if (!availablePickupDate || Number.isNaN(availablePickupDate.getTime())) {
    return {
      ok: false,
      message: 'Enter the available pickup date before marking checks ready for release.',
    }
  }

  const now = new Date()
  const result = await runEach(prisma, selection.checkIds, (checkId) =>
    markReadyForRelease(prisma, { checkId, userId: user.id, availablePickupDate, now }))
  // One notification for the batch, over the checks that moved (spec 2026-10-16).
  if (result.ok) await notifyReady(prisma, user, result.outcomes.filter((o) => o.ok).map((o) => o.checkId))
  return result
}

/**
 * READY FOR RELEASE (or SCHEDULED) back to SIGNED, from the list. Open to every
 * Finance user (client ruling 2026-09-26), like the single-cheque button.
 * `revertAvailability` does the work per cheque: the transition check, the
 * cleared pickup, the portal REVERT event and the audit row carrying the reason.
 * The reason is one field for the batch, so a blank one is refused here once.
 */
export async function bulkRevertToSignedAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  const settings = await loadSettings(prisma)
  const selection = parseSelection(ids(formData), settings.values['caps.bulkSelection'])
  if (!selection.ok) return { ok: false, message: selection.message }

  const reason = str(formData, 'reason')
  if (!reason) return { ok: false, message: 'Enter a reason before reverting checks to SIGNED.' }

  const now = new Date()
  return runEach(prisma, selection.checkIds, (checkId) =>
    revertAvailability(prisma, { checkId, userId: user.id, reason, now }))
}

/**
 * SIGNED back to SIGNATURE_PENDING, from the list (client, 2026-10-01). Every
 * Finance user. The reason is optional and shared by the batch.
 */
export async function bulkRevertToPendingAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  const settings = await loadSettings(prisma)
  const selection = parseSelection(ids(formData), settings.values['caps.bulkSelection'])
  if (!selection.ok) return { ok: false, message: selection.message }
  const reason = str(formData, 'reason')
  const now = new Date()
  return runEach(prisma, selection.checkIds, (checkId) =>
    revertSignature(prisma, { checkId, userId: user.id, reason, now }))
}

/**
 * Every Finance user (client, 2026-10-16: "let every Finance user mark checks
 * RELEASED from the list, not just Finance Admins"), replacing design decision
 * D11 for this action. The check page's MARK RELEASED was never role-gated, so
 * the list now matches it. RELEASE ALL stays FINANCE_ADMIN only, and so does
 * undoing a release (`reverseRelease`).
 *
 * **THE RECEIPT BOX, ONE PER ROW.**
 * Since 2026-09-25 every ticked row carries its own OR/CR box
 * (`lib/row-receipts.ts`), so a typed receipt always has exactly one owner —
 * the cheque whose row it was typed in. The old refusal of one box shared by a
 * whole batch is REPLACED by this, not loosened: a receipt still cannot land
 * on a cheque its supplier never issued it for, it is just that "which cheque"
 * is now answered by the row rather than by the size of the selection.
 *
 * `readRowReceipts` refuses the whole release, before anything is written,
 * for a receipt keyed to a cheque that is not ticked, a reference typed with
 * no type chosen, an invalid type, or the old unkeyed `orNumber`/`receiptType`
 * fields a stale page would still send.
 *
 * A ticked cheque with an EMPTY box releases exactly as it always did. That is
 * what makes the receipt optional, and RELEASE ALL at the counter depends on
 * it.
 */
export async function bulkReleaseAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  const settings = await loadSettings(prisma)
  const selection = parseSelection(ids(formData), settings.values['caps.bulkSelection'])
  if (!selection.ok) return { ok: false, message: selection.message }

  const read = readRowReceipts(formData, selection.checkIds)
  if (!read.ok) return { ok: false, message: read.message }

  // GENERATED, SIGNATURE PENDING and SIGNED checks are handed over without first
  // being marked ready (client, 2026-10-09 and 2026-10-16). `releaseDirectly`
  // signs, readies and releases in one transaction, so a check any guard refuses
  // stays where it was and is named in the result.
  const now = new Date()
  return runEach(prisma, selection.checkIds, (checkId) => {
    const receipt = read.receipts.get(checkId)
    return releaseDirectly(prisma, {
      checkId, userId: user.id, now,
      orNumber: receipt?.orNumber, orDate: undefined, receiptType: receipt?.receiptType ?? null,
    })
  })
}

/**
 * SAVE RECEIPTS — the late receipts, typed in the rows of ticked RELEASED
 * cheques (client, 2026-09-25: "i dont need to click the checks").
 *
 * Open to any signed-in Finance user, like `recordReceiptAction`: it records a
 * reference against a hand-over that already happened, moves no status and
 * cannot overwrite a receipt (`recordReceipt` refuses). Rows left blank are not
 * sent to the domain at all. Each typed row is its own transaction, so one
 * refusal — released by nobody, receipt added a moment ago — names that cheque
 * and the rest still save.
 */
export async function bulkRecordReceiptsAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  const settings = await loadSettings(prisma)
  const selection = parseSelection(ids(formData), settings.values['caps.bulkSelection'])
  if (!selection.ok) return { ok: false, message: selection.message }

  const read = readRowReceipts(formData, selection.checkIds)
  if (!read.ok) return { ok: false, message: read.message }

  const typed = selection.checkIds.filter((id) => read.receipts.has(id))
  if (typed.length === 0) {
    return { ok: false, message: 'Type a receipt reference on at least one ticked check before saving.' }
  }

  const now = new Date()
  return runEach(prisma, typed, (checkId) => {
    const receipt = read.receipts.get(checkId)!
    return recordReceipt(prisma, {
      checkId, userId: user.id, orNumber: receipt.orNumber, receiptType: receipt.receiptType, now,
    })
  })
}

/**
 * What differs between the two server-confirmed "ALL" actions. Everything else
 * — the guards, the order they run in, the batching — is `runConfirmedAll`.
 */
type ConfirmedAll = {
  /** The value the confirmation form submits as `confirm`. */
  confirm: 'release' | 'sign'
  /** The set, read from the database for the narrowing (and column filters) on the form. */
  listIds: (narrow: SummaryNarrowing, columns: ColumnFilters) => Promise<string[]>
  /**
   * SIGN ALL's list can carry the filter row's boxes; RELEASE ALL's panel is
   * on TOTALS, which none can reach, so a box arriving there is refused.
   */
  acceptsColumnFilters: boolean
  /** One cheque, through `lib/domain/actions.ts`. */
  apply: (checkId: string, now: Date) => Promise<unknown>
  messages: {
    notConfirmed: string
    badCount: string
    badFilter: string
    empty: string
    moreThanConfirmed: (now: number, confirmed: number) => string
  }
}

/**
 * THE CONFIRMED "ALL" ACTIONS — RELEASE ALL and SIGN ALL — share this.
 * Not exported: a 'use server' module may export only server actions.
 *
 * Two things stand between a misclick and every cheque in the set moving at
 * once, and neither of them is the button being hard to reach (the role check,
 * where there is one, stays in the action that needs it):
 *
 *  1. **The confirmation is a field on the request**, not only a step in the
 *     page. The page links to `?confirm=release` (or `=sign`), which
 *     server-renders a second form naming the count and the total; that form
 *     is the only thing that submits the `confirm` field. A POST that never went
 *     through it writes nothing.
 *  2. **The count the user read is submitted back.** If MORE cheques are in the
 *     set now than were on screen — a colleague marked twenty more ready while
 *     the confirmation sat open — the figures agreed to were never the figures
 *     that would move, so the action refuses and asks for a fresh look. FEWER is
 *     fine: somebody acted on some, and doing the remainder is what was agreed
 *     to.
 *
 * The SET is read from the database, not from the form. The button names a
 * count, not a list, and a form carrying 81 ids is a form somebody can edit.
 *
 * Each cheque goes through the domain call once, through the same `runEach` as
 * every other bulk action: one transaction, one set of guards and one audit row
 * each — and for a release, an INTERNAL cheque still produces no portal event
 * because `markReleased` is where that decision lives.
 */
async function runConfirmedAll(formData: FormData, spec: ConfirmedAll): Promise<BulkActionResult> {
  const { messages } = spec
  if (str(formData, 'confirm') !== spec.confirm) {
    return { ok: false, message: messages.notConfirmed }
  }

  /**
   * The figure that was on screen.
   *
   * Matched against digits before `Number` sees it, because `Number('')` is 0
   * and `Number(' 12 ')` is 12: an ABSENT field would otherwise parse as a
   * confirmed count of zero, which is a different refusal with a misleading
   * sentence rather than the honest "this did not come from the confirmation
   * step". `\d+` also rules out `1e9`, `0x51` and `Infinity`, all of which
   * `Number` accepts.
   */
  const rawExpected = str(formData, 'expectedCount')
  const expectedCount = /^\d+$/.test(rawExpected) ? Number(rawExpected) : Number.NaN
  if (!Number.isInteger(expectedCount)) {
    return { ok: false, message: messages.badCount }
  }

  const settings = await loadSettings(prisma)
  const cap = settings.values['caps.bulkSelection']
  // A filter that is present but names nothing REFUSES — dropping it would
  // silently widen the set from one company to every company.
  const narrow = await readNarrowing(formData)
  if (narrow === null) {
    return { ok: false, message: messages.badFilter }
  }
  let columns: ColumnFilters = {}
  if (spec.acceptsColumnFilters) {
    const read = readColumnFilters(formData)
    if (read === null) return { ok: false, message: messages.badFilter }
    columns = read
  } else if (sentColumnFilter(formData)) {
    return { ok: false, message: messages.badFilter }
  }
  const checkIds = await spec.listIds(narrow, columns)

  if (checkIds.length === 0) {
    return { ok: false, message: messages.empty }
  }

  if (checkIds.length > expectedCount) {
    return { ok: false, message: messages.moreThanConfirmed(checkIds.length, expectedCount) }
  }

  /**
   * Sequential batches of `MAX_BULK_SELECTION`, not one oversized call.
   *
   * **Raising the cap would be the wrong fix.** It is not a limit on how much
   * this action may release — the set here is decided by a query, counted on
   * screen and confirmed. It is a limit on an UNBOUNDED, user-composed tick-box
   * selection, where a select-all over a filter is how "the twelve I meant"
   * becomes "every cheque in the company"; and it is what keeps the tick-box
   * path from opening fifty interactive transactions' worth of work that this
   * project's suite already learned deadlocks against Neon (`40P01`). Raising it
   * to fit 81 would loosen that path to solve a problem it does not have.
   *
   * Batching costs nothing in correctness: `runEach` already processes one
   * cheque at a time, so each cheque gets its own transaction, its own guards
   * and its own audit row whether it is in a batch of one or of fifty. What the
   * batches buy is that every id still passes through `parseSelection`, the
   * single gate every bulk write in this system goes through.
   */
  // One timestamp for the whole action: these cheques moved in one act.
  const now = new Date()
  const outcomes: BulkOutcome[] = []
  for (const batch of chunkSelection(checkIds, cap)) {
    const selection = parseSelection(batch, cap)
    // Unreachable: `chunkSelection` de-duplicates, drops blanks and splits at
    // the cap. Handled rather than asserted, because the alternative to a
    // returned refusal is a thrown one half way through a release.
    if (!selection.ok) return { ok: false, message: selection.message }

    const batchResult = await runEach(prisma, selection.checkIds, (checkId) => spec.apply(checkId, now))
    // `runEach` only reports `ok: false` for a refusal it was handed, which
    // cannot happen above; the narrowing is for the type, not for the case.
    if (!batchResult.ok) return batchResult
    outcomes.push(...batchResult.outcomes)
  }

  // Recomputed over every batch, so "73 of 81" counts the whole action rather
  // than the last batch of it.
  const succeeded = outcomes.filter((o) => o.ok).length
  return { ok: true, succeeded, failed: outcomes.length - succeeded, outcomes }
}

/**
 * TODAY'S RELEASE — release everything that is ready, in one confirmed action.
 *
 * The highest-risk action in the system (design decision D11) and effectively
 * terminal: only VOIDED follows RELEASED. **FINANCE_ADMIN only**, checked here
 * rather than by hiding a control — a server action is an HTTP endpoint. It
 * RETURNS the refusal: `requireAdmin` redirects, Next implements a redirect by
 * throwing, and `runEach`'s catch would swallow it and report "Something went
 * wrong" instead. The confirmation field, the count read back and the
 * server-side set are `runConfirmedAll`'s.
 *
 * **The `(previousState, formData)` signature is `useActionState`'s**, and it is
 * why the confirmation works with no JavaScript at all. Passed straight to
 * `useActionState`, Next renders the form with a real POST target, so the
 * confirm button submits and the release happens whether or not the bundle
 * loaded; a client-side wrapper closure would have been a button that does
 * nothing until React hydrates. The previous state is not read — the action's
 * answer depends on the request and on the database, never on what it said last
 * time.
 */
export async function releaseAllReadyAction(
  _previousState: BulkActionResult | null,
  formData: FormData,
): Promise<BulkActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') {
    return { ok: false, message: 'Only a Finance Admin can mark a check RELEASED.' }
  }

  return runConfirmedAll(formData, {
    confirm: 'release',
    acceptsColumnFilters: false,
    listIds: (narrow) => listTodaysReleaseIds(prisma, narrow),
    apply: (checkId, now) => markReleased(prisma, { checkId, userId: user.id, now }),
    messages: {
      notConfirmed: 'This release was not confirmed. Open TODAY’S RELEASE and confirm the figures first.',
      badCount: 'This release could not be confirmed. Open TODAY’S RELEASE again and re-read the figures.',
      badFilter: 'The filter on screen was not recognised. Open TODAY’S RELEASE again and re-read the figures.',
      empty: 'No checks are ready to release right now.',
      moreThanConfirmed: (n, expected) =>
        `${n} checks are ready now, but ${expected} were on screen when you ` +
        'confirmed. Re-read TODAY’S RELEASE and confirm the current figures.',
    },
  })
}

/**
 * SIGN ALL (client, 2026-10-01: "All checks on Tuesday to Friday will have a 1
 * click button"). The RELEASE ALL pattern, for a lower-risk act that can be
 * undone (`revertSignature`): open to every Finance user, but the confirmation
 * is still a field on the request, the count read is submitted back, and the
 * set is the server's, never ids from the form (`runConfirmedAll`).
 * `useActionState`'s signature, for the same no-JavaScript reason as
 * `releaseAllReadyAction`.
 */
export async function signAllPendingAction(
  _previousState: BulkActionResult | null,
  formData: FormData,
): Promise<BulkActionResult> {
  const user = await requireUser()

  return runConfirmedAll(formData, {
    confirm: 'sign',
    acceptsColumnFilters: true,
    listIds: (narrow, columns) => listPendingSignatureIds(prisma, narrow, columns),
    apply: (checkId, now) => markSigned(prisma, { checkId, userId: user.id, now }),
    messages: {
      notConfirmed: 'This was not confirmed. Press SIGN ALL and confirm the figures first.',
      badCount: 'This could not be confirmed. Press SIGN ALL again and re-read the figures.',
      badFilter: 'The filter on screen was not recognised. Press SIGN ALL again and re-read the figures.',
      empty: 'No checks are waiting for a signature.',
      moreThanConfirmed: (n, expected) =>
        `${n} checks are pending now, but ${expected} were on screen when you confirmed. Re-read and confirm the current figures.`,
    },
  })
}
