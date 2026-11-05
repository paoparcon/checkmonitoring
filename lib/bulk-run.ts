import type { PrismaClient } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import { afterResponse, kickPortalDelivery } from '@/lib/sync/portal-kick'

export type BulkOutcome =
  /** `requested`: a request was written for the approver and the check did NOT move (2026-11-05). */
  | { ok: true; checkId: string; checkNumber: string | null; requested?: boolean }
  | { ok: false; checkId: string; checkNumber: string | null; message: string }

export type BulkActionResult =
  /** `succeeded` counts the checks that moved; `requested` those now waiting for `approverName`. */
  | { ok: true; succeeded: number; failed: number; requested?: number; approverName?: string; outcomes: BulkOutcome[] }
  /** The whole batch was refused before anything was written. */
  | { ok: false; message: string }

// Moved out of app/checks/bulk-actions.ts on 2026-09-11 so /clearing can use it: a 'use server' module may only export async server actions, and this is a helper.
/**
 * Runs one domain action over the selection, one cheque at a time.
 *
 * Sequential on purpose. Each call opens its own transaction against Neon, and
 * fifty concurrent interactive transactions is how this project's test suite
 * learned about `40P01` deadlocks. Fifty round trips is a second or two; a
 * deadlocked release is a cheque whose state nobody can explain.
 */
export async function runEach(
  db: PrismaClient,
  checkIds: string[],
  /** Resolves to `{ requested: true }` when the check did not move and a request was written instead. */
  fn: (checkId: string) => Promise<unknown>,
): Promise<BulkActionResult> {
  // Read once, for display only. A cheque number the user can recognise is the
  // difference between a readable refusal and a list of opaque ids. An id that
  // matches no row simply has none, and the domain call below reports NOT_FOUND
  // for it like any other refusal.
  const rows = await db.check.findMany({
    where: { id: { in: checkIds } },
    select: { id: true, checkNumber: true },
  })
  const numbers = new Map(rows.map((r) => [r.id, r.checkNumber]))

  const outcomes: BulkOutcome[] = []
  for (const checkId of checkIds) {
    const checkNumber = numbers.get(checkId) ?? null
    try {
      const r = await fn(checkId)
      const requested = typeof r === 'object' && r !== null && (r as { requested?: unknown }).requested === true
      outcomes.push(requested ? { ok: true, checkId, checkNumber, requested: true } : { ok: true, checkId, checkNumber })
      revalidatePath(`/checks/${checkId}`)
    } catch (e) {
      // Next implements redirect()/notFound() by throwing; these must propagate
      // rather than be reported as a per-cheque refusal.
      if (isNextControlFlowError(e)) throw e
      if (e instanceof DomainError) {
        outcomes.push({ ok: false, checkId, checkNumber, message: e.message })
        continue
      }
      // Anything else is a bug, and its text could name a connection string or
      // a constraint. It goes to the server log; the user gets a fixed
      // sentence, and — because this is a loop — the rest of the batch still
      // runs.
      console.error(e)
      outcomes.push({
        ok: false, checkId, checkNumber,
        message: 'Something went wrong with this check. Please try again.',
      })
    }
  }

  // Deliver the outbox rows this batch just wrote, after the response is
  // sent so the Finance user never waits on the portal (spec 2026-09-26-
  // check-monitoring-integration-design §2.4). Best-effort: a portal outage
  // is the worker's problem, never this action's. Its own try/catch (final
  // review 2026-09-26): the batch has committed, so nothing thrown while
  // scheduling the kick may fail the whole result.
  try {
    afterResponse(() => kickPortalDelivery(db, { budgetMs: 8_000 }))
  } catch (e) {
    console.error('portal delivery could not be scheduled:', e instanceof Error ? e.message : e)
  }
  revalidatePath('/')
  const requested = outcomes.filter((o) => o.ok && o.requested).length
  const succeeded = outcomes.filter((o) => o.ok).length - requested
  return { ok: true, succeeded, failed: outcomes.filter((o) => !o.ok).length, ...(requested > 0 ? { requested } : {}), outcomes }
}
