import type { Check, Prisma, PrismaClient, StagedReason } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { voidCheck } from '@/lib/domain/actions'
import { canTransition, type CheckStatus } from '@/lib/domain/check-status'
import { classifyEligibility, portalRoute } from '@/lib/domain/eligibility'
import { DomainError } from '@/lib/domain/errors'
import { isCheckIncomplete } from '@/lib/domain/incomplete'
import type { NormalisedRow } from '@/lib/normalised-row'
import { classifyImportOutcome } from './classify'
import { resolveImpliedStatus } from './implied-status'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * Prisma's interactive-transaction defaults are 5s to run and 2s to acquire a
 * connection. Both are too tight for this workload.
 *
 * One row here is several round trips to Neon in ap-southeast-1 - the duplicate
 * lookup, the company fallback, the upsert, the audit write - and a single slow
 * row kills the ENTIRE import, because it surfaces as "Transaction not found
 * ... refers to an old closed transaction" rather than as a slow row. That is
 * how the 9 September register load died, after about 5,000 cheques.
 *
 * Raised, not removed: a transaction that cannot finish inside half a minute is
 * a defect worth failing on, not something to wait indefinitely for.
 */
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const

// The same shape `lib/domain/actions.ts` uses. A caller can pass an existing
// transaction client; otherwise we open our own, so a check and its audit row
// are never written apart.
async function inTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if ('$transaction' in db && typeof db.$transaction === 'function') {
    return (db as PrismaClient).$transaction(fn, TX_OPTIONS)
  }
  return fn(db as Prisma.TransactionClient)
}

/**
 * Import brings in what the source knows: amounts, dates, vendor, cash account.
 * It must never touch what Finance knows — whether the cheque has been signed,
 * made available, scheduled, released, cleared or cancelled. Neither Acumatica
 * nor the register has any notion of those, so an import that wrote them would
 * silently undo a Finance user's work, at the scale of 12,000 rows and with no
 * error to notice.
 *
 * Exported so the list is reviewable in one place, and so
 * `tests/import/upsert.test.ts` can drive its assertions off it: adding a field
 * here extends the test automatically, and adding a column to `Check` without
 * classifying it fails a test outright.
 */
export const IMMUTABLE_ON_UPDATE = [
  'status', 'signedById', 'signedAt', 'readyById', 'readyAt',
  'availablePickupDate', 'scheduledPickupDate', 'scheduledPickupTime', 'pickupRep',
  'portalConfirmedAt', 'releasedById', 'releasedAt',
  // The supplier's receipt, all three together.
  //
  // `receiptType` is here rather than in IMPORT_WRITABLE, and the test above
  // forces the question, so here is the reasoning rather than the pattern
  // match. The line rule 4 draws is between what the SOURCE states and what
  // FINANCE knows — `apvNumbers` is import-writable precisely because a voucher
  // is a fact the register prints and nobody here can edit. A receipt type is
  // the opposite on both counts. Neither source states it: the register has no
  // receipt column at all, and Acumatica's payments inquiry knows nothing about
  // a piece of paper a supplier hands over at our counter. And it is entered by
  // a Finance user, on the release form or afterwards on the receipt page, so
  // an import that wrote it would be overwriting somebody's answer with a
  // guess — the exact failure rule 4 exists for, at the scale of 12,000 rows
  // and with no error to notice.
  //
  // It also has to travel with `orNumber` and `orDate`, which have been
  // immutable since Plan 1. A type left writable while its reference is
  // protected could drift apart from it: an import could re-answer "which kind
  // of receipt" for a number it cannot see.
  'orNumber', 'orDate', 'receiptType',
  'receiptAmount', // Finance-owned (user request 2026-10-01)
  'clearingStatus', 'crNumber', 'clearedDate', 'cancelledById', 'cancelledAt', 'cancelReason',
  // Since 2026-09-11 Finance types the category on the cheque page, which
  // makes it something FINANCE knows rather than something the source states
  // — the line rule 4 draws. A create still writes the register's category
  // (the register is the only source that ever carried one; Acumatica's
  // mapper sends null); an update never touches it, so a reseed cannot
  // overwrite what somebody typed. No live path changes: the sync's null was
  // already skipped by `keep()`.
  'category',
] as const satisfies readonly (keyof Check)[]

/**
 * The other half of the same decision: the columns an import owns. `companyId`
 * and `checkNumber` are here because a create writes them. `checkNumber` an
 * update never writes — it is the identity the row was found by. `companyId` an
 * update writes in exactly one case, and only since 2026-09-06: when the
 * fallback lookup found the cheque filed under another company. See
 * COMPANY_RULING_BASIS.
 *
 * Note what is NOT here. `voidedAt` is written only through `voidCheck`, never
 * by a bare update. `vendorId` is left alone because vendor merges are reported
 * and never applied. `remarks`, `pointPerson` and `checksPossession` are free
 * text Finance maintains.
 */
export const IMPORT_WRITABLE = [
  // `apvNumbers` is here and NOT in the immutable list, and the distinction is
  // the one rule 4 draws: the immutable list protects what FINANCE knows —
  // whether a cheque has been signed, made available, released, cancelled. A
  // voucher is not that. It is a fact the SOURCE states, the same kind of thing
  // as `cvNumber` and `poNumbers` beside it, and nothing in this application
  // lets a user edit it, so an import cannot be running over anybody's work.
  //
  // It is written by UNION rather than by replacement, which is what makes that
  // safe in the direction that matters: the only way to lose a voucher here is
  // for something to remove one, and nothing does.
  'apvNumbers',
  'acumaticaPaymentId', 'checkNumber', 'cvNumber', 'checkDate', 'amount', 'currency',
  'isCheque', 'companyId', 'cashAccountId', 'checkBookId', 'payeeName',
  'eligibility', 'portalDomain', 'portalSyncStatus', 'sourceSheet', 'sourceRow',
  'acumaticaDocType', 'acumaticaStatus', 'acumaticaBranch', 'acumaticaTenant', 'lastModifiedOn',
  // Not a fact the source states — a derivation of `amount`, which is why it is
  // here rather than in the immutable list. It belongs to whoever writes
  // `amount`, and that is only ever this module. `isStale` stays outside both
  // lists: it is a different question (see the schema) and nothing writes it.
  'isIncomplete',
] as const satisfies readonly (keyof Check)[]

/**
 * Cited as the basis of every automatic status resolution, so each of the 102
 * cheques whose sheets contradict each other is traceable to the decision that
 * settled it rather than to "the importer chose". Recorded in
 * `.superpowers/sdd/progress.md`.
 */
export const FINANCE_RULING_BASIS = 'Finance ruling of 2026-09-03 on register contradictions'

/**
 * Cited on every company correction the fallback lookup makes, so a cheque that
 * changed hands between two of our companies is traceable to the ruling that
 * moved it rather than to "the importer decided".
 *
 * The register resolves a cheque's company from its cheque book
 * (`prisma/reference-data.ts`); Acumatica resolves it from the payment's
 * `Branch`. They disagreed on 1,865 cheques, in no consistent pattern, and the
 * client settled it on 2026-09-06: **FOLLOW ACUMATICA SINCE IT IS ALREADY
 * DEPOSITED.** The cheque-book table is wrong somewhere, but nobody has said
 * where, so it is left alone and each cheque is corrected as the ERP asserts it.
 */
export const COMPANY_RULING_BASIS =
  'Client ruling of 2026-09-06: Acumatica\'s Branch is authoritative for which company owns a check'

export type UpsertArgs = {
  row: NormalisedRow
  /** `Company.legalNames`, for classifyEligibility's inter-company check. */
  ownCompanyNames: readonly string[]
  now: Date
  /**
   * Every sheet this cheque number appears on across the whole import, not just
   * this row's. Defaults to this row's sheet. When two of them imply different
   * statuses, `resolveImpliedStatus` applies the Finance ruling — and throws on
   * a combination nobody has ruled on, which this function deliberately does
   * not catch.
   */
  sheets?: readonly string[]
  /**
   * Every company code this cheque number resolves to across the whole import.
   * More than one and the row is staged rather than written. Defaults to this
   * row's own company, which is the honest answer when the caller is looking at
   * one row in isolation (the Acumatica sync) rather than at a whole register.
   */
  companies?: readonly string[]
}

export type UpsertResult =
  | { outcome: 'CREATED'; checkId: string }
  | { outcome: 'UPDATED'; checkId: string }
  | { outcome: 'STAGED'; stagedCheckId: string; reason: StagedReason }

// On an update, a null from the incoming row means "this source does not carry
// this field", never "clear what you have". The payments generic inquiry
// publishes no category and no bill references, and its CashAccount (the
// cheque book, spec §D) can be blank or name no book; a workbook row carries
// no Acumatica provenance. Writing those nulls through would make every
// sync erase what the register established and every import erase what the sync
// established, one field at a time.
const keep = <T>(value: T | null): T | undefined => value ?? undefined

/**
 * The array counterpart of `keep`, for `apvNumbers`.
 *
 * UNION, deduplicated and sorted — not replacement, and not append. Three
 * things follow from that, each of them the behaviour this column needs:
 *
 * An empty incoming array cannot clear a recorded voucher. Every Acumatica row
 * arrives with one (the payments generic inquiry publishes no bill references
 * at all), so replacement would mean the first sync after an import wiping the
 * register's 10,973 vouchers with nothing to show it had happened.
 *
 * A cheque recorded on two register sheets keeps both rows' vouchers. Measured
 * 2026-09-07: 360 cheque numbers appear on more than one parsed row and 11 of
 * them state a different voucher on each. Last-writer-wins loses one of the two.
 *
 * A re-import changes nothing, because sorting and deduplication make the
 * result a function of the SET rather than of the order the rows arrived in.
 *
 * The cost, stated plainly: a voucher mis-keyed into the register once stays on
 * the cheque until somebody removes it, because nothing here can tell a
 * correction from a second voucher. That is the right way round — a spurious
 * reference is visible on screen, whereas a lost one is the defect that started
 * this — but it does mean this is not a repair mechanism.
 */
export function mergeVouchers(existing: readonly string[], incoming: readonly string[]): string[] {
  return [...new Set([...existing, ...incoming])].sort()
}

/**
 * The single write path for both the workbook importer and the Acumatica sync.
 * Duplicate prevention lives here and nowhere else: a `(companyId,
 * checkNumber)` lookup, a fallback on the cheque number alone when that misses,
 * one create-or-update, and no second place for the two ingestion paths to
 * disagree about what counts as the same cheque. See the fallback block for
 * why the composite key on its own was not enough.
 *
 * Writes no `PortalEvent`, ever. Publishing a cheque to the supplier portal is
 * a Finance action; an import is not a reason to tell a supplier anything.
 */
export async function upsertCheck(db: Db, args: UpsertArgs): Promise<UpsertResult> {
  const { row, now } = args

  const sheets = args.sheets ?? (row.sourceSheet ? [row.sourceSheet] : [])
  // Throws on a clash Finance has not ruled on. Deliberately not caught: a new
  // combination is a fact about money that a human has to decide, and quietly
  // picking one of the candidates is exactly the invention this importer exists
  // to avoid.
  const implied = resolveImpliedStatus(sheets)

  // The staging decision itself lives in `classifyImportOutcome`, which the
  // import PREVIEW also calls. Keeping it there rather than here is what makes
  // the preview's "2,766 of these will not import" a promise instead of an
  // estimate. See that module for why the three tests are in the order they are.
  const outcome = classifyImportOutcome(row, args.companies)
  if (!outcome.write) {
    return stageRow(db, row, implied.status, outcome.reason, outcome.conflictingCompanies)
  }
  const { checkNumber, companyCode } = outcome

  const company = await db.company.findUnique({ where: { code: companyCode } })
  if (!company) {
    // A code the row states but no Company row carries is a seeding fault, not
    // a fact about the cheque. Staging it would bury a configuration error
    // under thousands of "unknown company" rows that a human would then try to
    // correct one at a time.
    throw new DomainError(
      'UNKNOWN_COMPANY',
      `No company is registered under the code ${row.companyCode}, which ` +
        `${row.sourceSheet ?? row.source} row ${row.sourceRow ?? '?'} claims. ` +
        'Seed the company before importing.',
    )
  }

  // Codes are looked up, never created. An unrecognised code leaves the link
  // unmade: seven cash accounts in the live Acumatica feed (PAYROLL and
  // PCF-SITIO among them) are absent from reference data, and inventing rows
  // for them would put a cheque in a bank account that does not exist.
  const cashAccount = row.cashAccountCode
    ? await db.cashAccount.findUnique({ where: { code: row.cashAccountCode } })
    : null
  const foundBook = row.checkBookCode
    ? await db.checkBook.findUnique({ where: { code: row.checkBookCode } })
    : null
  // NO COMPANY CHECK (spec §E, measured 2026-10-05; user ruling the same day).
  // A cheque book is a bank account shared across companies — the register
  // itself filed STK, A1+, HAMFI and IND cheques under one book — so
  // `CheckBook.companyId` decides nothing. Acumatica's CashAccount is the
  // fact: whatever book it names is the cheque's book, whichever company the
  // book's reference row happens to name.
  const checkBook = foundBook

  return inTx(db, async (tx) => {
    const exact = await tx.check.findUnique({
      where: { companyId_checkNumber: { companyId: company.id, checkNumber } },
    })

    // ANOTHER PAYMENT ON A NUMBER WE HOLD (full check, 2026-10-06). Acumatica
    // re-uses a cheque number under a new payment reference — a void and its
    // re-issue (`1791361374`: CV-A1009705 voided, CV-A1009798 live), or two
    // live payments (`6000338856`). Both rows key to one `(company, number)`
    // cheque here, so each sync wrote one payment's facts over the other's,
    // and the voided original's row VOIDED the live re-issue. The number is
    // held by the payment already here; the other is staged for a human.
    if (exact?.acumaticaPaymentId && row.acumaticaPaymentId && exact.acumaticaPaymentId !== row.acumaticaPaymentId) {
      return stageRow(tx, row, implied.status, 'SHARED_NUMBER', [companyCode])
    }

    // THE FALLBACK, and the whole of defect 1,865-duplicates.
    //
    // `@@unique([companyId, checkNumber])` is the primary identity and stays
    // the primary identity — it is what the lookup above uses and what a
    // create writes. But it is not the only thing that makes two rows the same
    // cheque. A BPI cheque number belongs to exactly one cheque book, so two of
    // our companies cannot both own it; when the composite key misses and the
    // number alone hits exactly once, the row we have IS this cheque, filed
    // under the company the register's cheque-book table named. Before this
    // block that miss created a second row, and 1,865 physical cheques were
    // stored twice — one register row saying RELEASED, one Acumatica row saying
    // SIGNATURE_PENDING, neither knowing about the other.
    //
    // Reached only on a miss, so the ordinary path is still one indexed lookup.
    // Two matches is not a tie to break: it is the state this fallback exists
    // to stop being created, and the row is staged for a human.
    let existing: Check | null = exact
    let misfiled: { companyId: string; companyCode: string } | null = null
    /** The number this cheque used to carry, when Acumatica has re-keyed it. */
    let renumberedFrom: string | null = null

    if (!exact) {
      /**
       * THE PAYMENT WE ALREADY HOLD, RENUMBERED IN THE ERP.
       *
       * Measured 2026-09-10. The 04:39 sync failed one row with "Unique
       * constraint failed on the fields: (acumaticaPaymentId)". Payment
       * CV-A1013045 was here as cheque 17913405552 — eleven digits, where every
       * other cheque in that book has ten — and the feed now said 1791405552.
       * Somebody had removed a mis-keyed 3 in Acumatica.
       *
       * Both lookups miss when the number changes, so the row fell through to
       * `create`, and the create collided with the unique index because the payment
       * was already here under its old number. One error per sync, for ever: the
       * number never converges on its own.
       *
       * `ReferenceNbr` is the ERP's own key for the document and does not change;
       * a cheque number is a fact a human keys and can therefore re-key. So on a
       * miss it is the better identity.
       *
       * DELIBERATELY AFTER THE EXACT MATCH, never before it. If
       * `(company, number)` hits while a DIFFERENT row holds this payment id, that
       * is two rows for one cheque — the condition that stored 1,865 physical
       * cheques twice — and it wants a human, not whichever lookup ran first.
       * Ordering it second means this branch can only ever resolve a row the
       * primary key could not find at all.
       */
      const renumbered = row.acumaticaPaymentId
        ? await tx.check.findUnique({ where: { acumaticaPaymentId: row.acumaticaPaymentId } })
        : null
      if (renumbered) {
        existing = renumbered
        renumberedFrom = renumbered.checkNumber
      }
      // `isCheque` on BOTH sides, and it is not decoration.
      //
      // The whole fallback rests on one fact: a bank issues a cheque number to
      // exactly one cheque book, so two companies cannot hold the same one and
      // a match on the number alone is therefore the same cheque.
      //
      // That guarantee covers cheques and nothing else. A non-cheque payment
      // carries an AP document reference in `checkNumber` — the China branches
      // pay by transfer and their `PaymentRef` is `AP-DG001931` — and nothing
      // stops two companies sharing one of those. Matching on it would rewrite
      // a different company's payment, silently and with an audit row asserting
      // the correction was right.
      //
      // The sync filters by payment method (CHK or CASH), so such a row should
      // not arrive at all. This is the second lock on that door: the first one
      // is a query filter somebody could widen without ever reading this file.
      const sameNumber = !renumbered && row.isCheque
        ? await tx.check.findMany({
            where: { checkNumber, isCheque: true },
            include: { company: { select: { code: true } } },
          })
        : []

      if (sameNumber.length > 1) {
        // Every company the number is claimed by, this row's included, so the
        // human settling it can see the whole disagreement in the staged row.
        const claimed = [...new Set([...sameNumber.map((c) => c.company.code), companyCode])]
        return stageRow(tx, row, implied.status, 'AMBIGUOUS_COMPANY', claimed)
      }

      const only = sameNumber[0]
      // The same SHARED_NUMBER rule on the number-only path: cheque books are
      // shared across companies, so a re-issue can arrive under another company
      // and would otherwise refile — and later void — the payment held here.
      if (only?.acumaticaPaymentId && row.acumaticaPaymentId && only.acumaticaPaymentId !== row.acumaticaPaymentId) {
        return stageRow(tx, row, implied.status, 'SHARED_NUMBER', [only.company.code, companyCode])
      }
      if (only) {
        existing = only
        misfiled = { companyId: only.companyId, companyCode: only.company.code }
      }
    }

    const classified = classifyEligibility({
      payeeName: row.payeeName,
      category: row.category,
      sourceSheet: row.sourceSheet,
      ownCompanyNames: args.ownCompanyNames,
    })
    const route = portalRoute(classified.eligibility)

    if (!existing) {
      const created = await tx.check.create({
        data: {
          companyId: company.id,
          checkNumber,
          acumaticaPaymentId: row.acumaticaPaymentId,
          cvNumber: row.cvNumber,
          // Through the same merge an update uses, so a create and a re-import
          // produce the identical array rather than two orderings of it.
          apvNumbers: mergeVouchers([], row.apvNumbers),
          checkDate: row.checkDate,
          amount: row.amount,
          // Kept in step with `amount` at the only place `amount` is written.
          // A stored derivation whose writer forgets it is worse than no
          // derivation: the dashboard would report a count that is confidently
          // wrong. `backfillIncompleteFlags` repairs drift; this prevents it.
          isIncomplete: isCheckIncomplete({ amount: row.amount }),
          // The only place a currency is not stated outright. The workbook
          // mapper has already applied the register's PHP default, so this is
          // reachable only for an Acumatica row whose feed omitted Currency —
          // a surprise — and it falls to the column default rather than being
          // relabelled here, where it would look like a decision.
          currency: keep(row.currency),
          isCheque: row.isCheque,
          cashAccountId: cashAccount?.id ?? null,
          checkBookId: checkBook?.id ?? null,
          payeeName: row.payeeName,
          category: row.category,
          eligibility: classified.eligibility,
          portalDomain: route,
          // Routing is decided at import; publishing is not. PENDING means "a
          // portal push is queued", and nothing in Plan 2 queues one — writing
          // it here would leave a promise to a supplier that no outbox keeps.
          portalSyncStatus: 'NOT_APPLICABLE',
          status: implied.status,
          // The register's REMARKS "CR 1234" is the supplier's Collection
          // Receipt (client ruling 2026-09-11), so it lands in the RECEIPT
          // columns — on create only; both are immutable on update, so a
          // re-run never overwrites a receipt Finance recorded. `crNumber` is
          // the BANK's and no import writes it (rule 11). `orDate` stays null:
          // the register never recorded one.
          orNumber: row.receiptRef,
          receiptType: row.receiptRef === null ? null : 'CR',
          sourceSheet: row.sourceSheet,
          sourceRow: row.sourceRow,
          acumaticaDocType: row.acumaticaDocType,
          acumaticaStatus: row.acumaticaStatus,
          acumaticaBranch: row.acumaticaBranch,
          acumaticaTenant: row.acumaticaTenant,
          lastModifiedOn: row.lastModifiedOn,
        },
      })

      await writeAudit(tx, {
        checkId: created.id,
        actorType: 'SYSTEM',
        action: 'imported',
        details: {
          source: row.source,
          status: implied.status,
          eligibility: classified.eligibility,
          eligibilityReason: classified.reason,
          sourceSheet: row.sourceSheet,
          sourceRow: row.sourceRow,
        },
        remarks: `Imported from ${row.source} at ${implied.status}.`,
      })

      // Recorded on the create and only on the create: the ruling justifies a
      // status decision, and a re-import never makes one.
      if (implied.implied.length > 1) {
        await writeAudit(tx, {
          checkId: created.id,
          actorType: 'SYSTEM',
          action: 'implied_status_resolved',
          details: {
            sheets: implied.sheets,
            implied: implied.implied,
            chosen: implied.resolvedFrom,
            status: implied.status,
            basis: FINANCE_RULING_BASIS,
          },
          remarks:
            `The register implies ${implied.implied.join(' and ')} for this check, on ` +
            `${implied.sheets.join(', ')}. Resolved to ${implied.resolvedFrom} ` +
            `(${implied.status}) under the ${FINANCE_RULING_BASIS}.`,
        })
      }

      await applyVoid(tx, created.id, implied.status, row, now)
      return { outcome: 'CREATED', checkId: created.id }
    }

    // A Finance user who has overridden the classification has said something
    // the payee and category columns cannot say. Recomputing over the top of it
    // would make the override last exactly until the next sync.
    const overridden = existing.eligibilityOverriddenById !== null

    // A cheque changing company is a material fact — which of our companies'
    // money left the bank — so it is never allowed to happen silently. Written
    // before the update rather than after, so the row that explains the move
    // reads ahead of the move in the trail.
    if (misfiled) {
      await writeAudit(tx, {
        checkId: existing.id,
        actorType: 'SYSTEM',
        action: 'check_company_corrected',
        details: {
          source: row.source,
          checkNumber,
          previousCompanyId: misfiled.companyId,
          previousCompanyCode: misfiled.companyCode,
          companyId: company.id,
          companyCode: company.code,
          acumaticaBranch: row.acumaticaBranch,
          acumaticaTenant: row.acumaticaTenant,
          sourceSheet: row.sourceSheet,
          sourceRow: row.sourceRow,
          basis: COMPANY_RULING_BASIS,
        },
        remarks:
          `Check ${checkNumber} was filed under ${misfiled.companyCode} and is refiled under ` +
          `${company.code}, asserted by ${row.source}` +
          (row.acumaticaBranch ? ` (Branch ${row.acumaticaBranch.trim()})` : '') +
          '. Matched on the check number alone, because a check number belongs to one check ' +
          `book. Status left at ${existing.status}. ${COMPANY_RULING_BASIS}.`,
      })
    }

    // THE RACE THIS CLOSES. The BILLS voucher read (lib/sync/bills.ts) appends
    // to `apvNumbers` under a row lock with an SQL-side `||`, concurrently with
    // this payment sync. `existing` above was read without a lock, so an
    // unconditional whole-array write computed here from that stale read erases
    // a voucher BILLS committed in between, while its audit row claims the
    // link. Every Acumatica row carries `apvNumbers: []`, so the merge is a
    // no-op for all of them; skipping the write unless the merge ADDS a voucher
    // means the payment sync can no longer clobber an append.
    //
    // Membership, never position: BILLS appends at the END, so a stored array
    // need not be sorted, and comparing it positionally to the sorted merge
    // would call ['AP-Z','AP-A'] + [] an addition. `mergeVouchers` applies no
    // normalisation beyond dedupe and sort, so the raw strings compare like
    // with like.
    // Acumatica wins the book, whichever company it is filed under (spec §E):
    // a different one replaces what is recorded, and the move goes into
    // `import_updated` so the trail shows which book the cheque left. A code
    // that names no book is `checkBook === null` here and changes nothing.
    const checkBookChanged = checkBook && checkBook.id !== existing.checkBookId
      ? { from: existing.checkBookId, to: checkBook.id, code: checkBook.code }
      : undefined

    // A CANCELLED or VOIDED cheque stays detached from its AP bills (user
    // ruling 2026-10-29, `detachFromBills` in lib/domain/actions.ts): the bill
    // belongs to whichever live cheque pays it now, and re-linking the dead one
    // would put two cheques on one bill again. Nothing to merge, nothing written.
    const detached = existing.status === 'CANCELLED' || existing.status === 'VOIDED'
    const mergedVouchers = detached ? existing.apvNumbers : mergeVouchers(existing.apvNumbers, row.apvNumbers)
    const addsVoucher = !detached && row.apvNumbers.some((v) => !existing.apvNumbers.includes(v))

    await tx.check.update({
      where: { id: existing.id },
      data: {
        // Written on an update in exactly one case: the fallback above found
        // this cheque under another company. `undefined` otherwise, so the
        // ordinary re-import still never touches the half of the key it looked
        // the row up by.
        companyId: misfiled ? company.id : undefined,
        // The other half of the identity, written on an update in exactly one case
        // and for the same reason: Acumatica corrected the number, so the row was
        // found by its payment reference instead. `undefined` otherwise, so an
        // ordinary re-import still never rewrites the key it looked the row up by.
        checkNumber: renumberedFrom ? checkNumber : undefined,
        acumaticaPaymentId: keep(row.acumaticaPaymentId),
        cvNumber: keep(row.cvNumber),
        // `keep()` cannot express this: an empty array is not null, so it would
        // be written straight through and would clear what the register
        // recorded. See `mergeVouchers`, and the race note above: written only
        // when the merge adds a voucher.
        apvNumbers: addsVoucher ? mergedVouchers : undefined,
        checkDate: keep(row.checkDate),
        amount: keep(row.amount),
        // Derived from the amount the row will END UP with, not from the
        // incoming one. `keep()` means a null here is "this source does not
        // carry an amount", never "clear the one you have" — so an Acumatica
        // sync that publishes no amount must not flag a cheque whose amount the
        // register recorded perfectly well. Pinned by test.
        isIncomplete: isCheckIncomplete({
          amount: (row.amount ?? existing.amount)?.toString() ?? null,
        }),
        currency: keep(row.currency),
        isCheque: row.isCheque,
        cashAccountId: cashAccount?.id,
        checkBookId: checkBook?.id,
        payeeName: keep(row.payeeName),
        eligibility: overridden ? undefined : classified.eligibility,
        portalDomain: overridden ? undefined : route,
        // Only when the cheque has just become INTERNAL, because the CHECK
        // constraint forbids an INTERNAL check holding portal routing state.
        // Leaving it alone otherwise is what preserves a PENDING push a Finance
        // user queued. Clearing it in the INTERNAL case does undo that push —
        // deliberately: a cheque that is now INTERNAL must not be published.
        portalSyncStatus: overridden || route !== null ? undefined : 'NOT_APPLICABLE',
        sourceSheet: keep(row.sourceSheet),
        sourceRow: keep(row.sourceRow),
        acumaticaDocType: keep(row.acumaticaDocType),
        acumaticaStatus: keep(row.acumaticaStatus),
        acumaticaBranch: keep(row.acumaticaBranch),
        acumaticaTenant: keep(row.acumaticaTenant),
        lastModifiedOn: keep(row.lastModifiedOn),
      },
    })

    await writeAudit(tx, {
      checkId: existing.id,
      actorType: 'SYSTEM',
      action: 'import_updated',
      details: {
        source: row.source,
        eligibility: overridden ? existing.eligibility : classified.eligibility,
        eligibilityOverridden: overridden,
        sourceSheet: row.sourceSheet,
        sourceRow: row.sourceRow,
        ...(checkBookChanged ? { checkBookChanged } : {}),
      },
      remarks: `Updated from ${row.source}; status left at ${existing.status}.`,
    })

    // A cheque number changing is not an ordinary field update. It is what people
    // search by, quote to a supplier and write on a voucher, so it gets its own
    // row rather than being folded silently into `import_updated`.
    if (renumberedFrom !== null && renumberedFrom !== checkNumber) {
      await writeAudit(tx, {
        checkId: existing.id,
        actorType: 'SYSTEM',
        action: 'renumbered_by_acumatica',
        details: {
          from: renumberedFrom,
          to: checkNumber,
          acumaticaPaymentId: row.acumaticaPaymentId,
        },
        remarks:
          `Acumatica now states check number ${checkNumber} for payment ` +
          `${row.acumaticaPaymentId}, which this system held as ${renumberedFrom}. ` +
          'Matched on the payment reference, which the ERP does not re-key, and the ' +
          'number corrected to follow Acumatica. Nothing else about the identity moved.',
      })
    }

    await applyVoid(tx, existing.id, existing.status as CheckStatus, row, now)
    return { outcome: 'UPDATED', checkId: existing.id }
  })
}

/**
 * The one status change an import may make, because Acumatica *does* know a
 * cheque was voided. Routed through `voidCheck` rather than a bare update so
 * the transition, the timestamp and the audit row — including the conspicuous
 * one for a void after release — are written in exactly one place.
 */
async function applyVoid(
  tx: Prisma.TransactionClient,
  checkId: string,
  current: CheckStatus,
  row: NormalisedRow,
  now: Date,
): Promise<void> {
  if (!row.voided) return

  // Already recorded. Returning silently is what keeps a re-run idempotent —
  // `VOIDED` is terminal, so asserting the transition again would abort the
  // import on every cheque it had already voided.
  if (current === 'VOIDED') return

  if (!canTransition(current, 'VOIDED')) {
    // CANCELLED is the only case left: a terminal Finance decision carrying a
    // recorded reason, which an ERP fact does not get to overwrite. The
    // disagreement between this system and the source of truth is still
    // something somebody has to see, so it is recorded rather than thrown —
    // throwing would abort a 12,000-row import over one contested cheque.
    await writeAudit(tx, {
      checkId,
      actorType: 'SYSTEM',
      action: 'void_not_applied',
      details: {
        currentStatus: current,
        acumaticaDocType: row.acumaticaDocType,
        acumaticaStatus: row.acumaticaStatus,
      },
      remarks:
        `Acumatica reports this check voided, but it is ${current} here — a terminal Finance ` +
        'decision with a recorded reason. The status is unchanged and the disagreement needs a human.',
    })
    return
  }

  await voidCheck(tx, {
    checkId,
    reason:
      `Voided in Acumatica (${row.acumaticaDocType ?? 'document type not stated'}, ` +
      `status ${row.acumaticaStatus ?? 'not stated'}).`,
    now,
  })
}

/**
 * A row kept whole rather than written or dropped.
 *
 * Keyed on whichever identity its source actually has, so re-running either
 * ingestion path updates a staged row instead of producing a second one: the
 * register's `(sourceSheet, sourceRow)` — the cell a human can be pointed at —
 * and Acumatica's `(acumaticaTenant, acumaticaRef)`, the payment document's own
 * ReferenceNbr. The tenant is part of the second key because both tenants
 * number their vouchers `CV-ST…` while `ST` is a different company in each.
 *
 * **Neither key is faked to accommodate the other.** Writing a sheet name of
 * 'ACUMATICA' would squeeze a feed row into the register's key at the cost of
 * putting a non-sheet into a column the reconciliation report reads as a sheet.
 * A row with no identity of either kind still throws, because silently
 * returning would lose a payment.
 *
 * No audit row: `AuditLog` is check-scoped, a staged row is not a check, and
 * 2,700 rows with a null `checkId` would bury the trail that matters. The
 * `StagedCheck` row is itself the record.
 */
async function stageRow(
  db: Db,
  row: NormalisedRow,
  impliedStatus: CheckStatus,
  reason: StagedReason,
  conflictingCompanies: readonly string[],
): Promise<UpsertResult> {
  const cannotStage = (missing: string): DomainError =>
    new DomainError(
      'CANNOT_STAGE',
      `A ${row.source} row cannot be staged because it carries no ${missing} to key it on. ` +
        `Check number: ${row.checkNumber ?? 'none'}; reason: ${reason}.`,
    )

  const data = {
    source: row.source,
    reason,
    checkNumber: row.checkNumber,
    // The memo an unkeyable Acumatica cheque carried where its number belongs,
    // or the register cell as typed. This is what a human replaces with the
    // real number; it must never be promoted into `checkNumber`.
    statedCheckRef: row.statedCheckRef,
    cvNumber: row.cvNumber,
    apvNumbers: row.apvNumbers,
    poNumbers: row.poNumbers,
    checkBookCode: row.checkBookCode,
    cashAccountCode: row.cashAccountCode,
    companyCode: row.companyCode,
    conflictingCompanies: [...conflictingCompanies],
    category: row.category,
    receiptRef: row.receiptRef,
    checkDate: row.checkDate,
    amount: row.amount,
    currency: row.currency,
    payeeName: row.payeeName,
    // Kept so promoting the row later does not have to re-derive a status from
    // a sheet name nobody has any more.
    impliedStatus,
  }

  // Exactly one identity is filled, which is also what the
  // `staged_check_one_source_identity` CHECK constraint enforces in the
  // database. Postgres treats NULLs in a unique index as distinct, so a row
  // that filled neither would slip past both keys and duplicate on every run —
  // hence the throws rather than a best effort.
  const staged = await (async () => {
    if (row.source === 'WORKBOOK') {
      const { sourceSheet, sourceRow } = row
      if (sourceSheet === null || sourceRow === null) throw cannotStage('source sheet or row number')
      return db.stagedCheck.upsert({
        where: { sourceSheet_sourceRow: { sourceSheet, sourceRow } },
        create: { sourceSheet, sourceRow, ...data },
        update: data,
      })
    }

    // `acumaticaPaymentId` is the ReferenceNbr — the payment document's unique
    // key in this feed, and the natural identity of a staged Acumatica row.
    const acumaticaRef = row.acumaticaPaymentId
    const acumaticaTenant = row.acumaticaTenant
    if (acumaticaRef === null) throw cannotStage('payment reference')
    if (acumaticaTenant === null) throw cannotStage('tenant')
    return db.stagedCheck.upsert({
      where: { acumaticaTenant_acumaticaRef: { acumaticaTenant, acumaticaRef } },
      create: { acumaticaRef, acumaticaTenant, ...data },
      update: data,
    })
  })()

  return { outcome: 'STAGED', stagedCheckId: staged.id, reason }
}

export type CheckNumberGroup = { sheets: string[]; companies: string[] }

/**
 * Every sheet and every company a cheque number is claimed by, across the whole
 * batch. Pure.
 *
 * Both facts are properties of the cheque number rather than of a row, and
 * neither can be decided as rows stream past: the contradiction ruling needs
 * every sheet a cheque appears on, and the ambiguity ruling needs every company
 * it resolves to, before any row for it is written. Group first, write second.
 */
export function groupByCheckNumber(
  rows: readonly NormalisedRow[],
): Map<string, CheckNumberGroup> {
  const sheets = new Map<string, Set<string>>()
  const companies = new Map<string, Set<string>>()

  for (const row of rows) {
    if (row.checkNumber === null) continue
    if (row.sourceSheet !== null) {
      const s = sheets.get(row.checkNumber) ?? new Set<string>()
      s.add(row.sourceSheet)
      sheets.set(row.checkNumber, s)
    }
    if (row.companyCode !== null) {
      const c = companies.get(row.checkNumber) ?? new Set<string>()
      c.add(row.companyCode)
      companies.set(row.checkNumber, c)
    }
  }

  const out = new Map<string, CheckNumberGroup>()
  for (const number of new Set([...sheets.keys(), ...companies.keys()])) {
    out.set(number, {
      sheets: [...(sheets.get(number) ?? [])],
      companies: [...(companies.get(number) ?? [])],
    })
  }
  return out
}

export type ImportSummary = {
  rows: number
  created: number
  updated: number
  staged: number
  stagedByReason: Record<StagedReason, number>
}

/**
 * The batch entry point: group the rows, then write them one at a time.
 *
 * `rows` must be the WHOLE import, not a page of it. Both rulings this applies
 * are properties of a cheque number across every row that mentions it, and a
 * batch that saw only half the register would resolve a contradiction from half
 * the sheets and miss a company conflict entirely.
 *
 * Rows are written sequentially rather than in parallel because two rows of one
 * cheque number are routine — 102 cheques appear on more than one sheet — and
 * two concurrent transactions creating the same `(companyId, checkNumber)` is a
 * unique-violation, not a merge.
 *
 * `rows === created + updated + staged` is the invariant that makes "nothing is
 * dropped" checkable rather than asserted.
 */
export async function importRows(
  db: Db,
  args: { rows: readonly NormalisedRow[]; ownCompanyNames: readonly string[]; now: Date },
): Promise<ImportSummary> {
  const groups = groupByCheckNumber(args.rows)

  const summary: ImportSummary = {
    rows: args.rows.length,
    created: 0,
    updated: 0,
    staged: 0,
    stagedByReason: { NO_COMPANY: 0, NO_CHECK_NUMBER: 0, AMBIGUOUS_COMPANY: 0, SHARED_NUMBER: 0 },
  }

  for (const row of args.rows) {
    const group = row.checkNumber !== null ? groups.get(row.checkNumber) : undefined
    const result = await upsertCheck(db, {
      row,
      ownCompanyNames: args.ownCompanyNames,
      now: args.now,
      sheets: group?.sheets,
      companies: group?.companies,
    })

    if (result.outcome === 'CREATED') summary.created++
    else if (result.outcome === 'UPDATED') summary.updated++
    else {
      summary.staged++
      summary.stagedByReason[result.reason]++
    }
  }

  return summary
}
