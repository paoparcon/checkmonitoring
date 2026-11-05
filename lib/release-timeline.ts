import { cardHref, isCardSelected, type DashboardSelection, type ViewCardId } from './dashboard-view'

/**
 * The release workflow, as five nodes with live counts.
 *
 * GENERATED → PENDING → SIGNED → READY → RELEASED, each showing how many
 * cheques are sitting on that rung and each linking to that view. It answers a
 * question the cards alone do not: not "how many are ready" but "where is the
 * queue jammed".
 *
 * Pure. No database, no query of its own — every count is read off the summary
 * the page has already fetched, and every link is `cardHref`, so a node cannot
 * disagree with the card that means the same thing.
 *
 * ── WHY GENERATED IS ITS OWN NODE ─────────────────────────────────────────
 * The PENDING SIGNATURE *card* counts GENERATED + SIGNATURE_PENDING together:
 * to Finance a freshly generated cheque is a cheque waiting to be signed, and
 * that card is unchanged.
 *
 * The timeline cannot fold them, because a node's number has to be the number
 * of rows its link opens, and `viewStatusFilter` gives `?status=SIGNATURE_PENDING`
 * exactly the SIGNATURE_PENDING rows. A node reading 242 over a table of 230 is
 * the same class of defect the READY FOR RELEASE / SCHEDULED fold exists to
 * avoid, pointing the other way.
 *
 * READY does fold SCHEDULED in — there, the card, the view and this node all
 * agree, because `viewStatusFilter` widens `?status=READY_FOR_RELEASE` to both.
 * ──────────────────────────────────────────────────────────────────────────
 */

/** Exactly the counts a timeline needs, so a caller cannot pass a filtered one by habit. */
export type TimelineSummary = {
  generated: number
  signaturePending: number
  signed: number
  readyForRelease: number
  scheduled: number
  released: number
  /** Released and cleared by the bank (2026-11-05); `released` no longer counts these. */
  cleared: number
}

/** A rung of the ladder. `id` is the view card it opens, never a status string. */
export type TimelineNode = {
  id: Extract<ViewCardId, 'GENERATED' | 'SIGNATURE_PENDING' | 'SIGNED' | 'READY_FOR_RELEASE' | 'RELEASED' | 'CLEARED'>
  label: string
  count: number
  href: string
  selected: boolean
}

/**
 * THE LADDER, ONCE.
 *
 * Both the dashboard's counted timeline and a single cheque's progress spine
 * walk these five rungs in this order. Stated here rather than in each of them,
 * because two lists that agree today are two lists that disagree the first time
 * somebody adds a rung to one.
 */
const LADDER = [
  ['GENERATED', 'GENERATED'],
  ['SIGNATURE_PENDING', 'PENDING'],
  ['SIGNED', 'SIGNED'],
  ['READY_FOR_RELEASE', 'READY'],
  ['RELEASED', 'RELEASED'],
  // The bank's step after the release (2026-11-05, `lib/display-status.ts`).
  ['CLEARED', 'CLEARED'],
] as const satisfies readonly (readonly [TimelineNode['id'], string])[]

/** A rung of the ladder, as an id. */
export type LadderId = TimelineNode['id']

export function buildReleaseTimeline(
  summary: TimelineSummary,
  selection: DashboardSelection,
): TimelineNode[] {
  const count: Record<LadderId, number> = {
    GENERATED: summary.generated,
    SIGNATURE_PENDING: summary.signaturePending,
    SIGNED: summary.signed,
    // The pair, exactly as the card and the view read it.
    READY_FOR_RELEASE: summary.readyForRelease + summary.scheduled,
    RELEASED: summary.released,
    CLEARED: summary.cleared,
  }

  return LADDER.map(([id, label]) => ({
    id,
    label,
    count: count[id],
    // Both of these are the card's own functions, not a restatement: a lit node
    // links back to NEEDS ACTION so clicking it again turns it off, and the
    // narrowing filters are carried along, because that is what a card does.
    href: cardHref(id, selection),
    selected: isCardSelected(id, selection),
  }))
}

/**
 * ── ONE CHEQUE'S PROGRESS ALONG THAT SAME LADDER ──────────────────────────
 *
 * The dashboard timeline answers "where is the queue jammed". This answers
 * "where is THIS cheque", on the check detail page, using the same five rungs
 * in the same order — the reader who learned the shape on the dashboard should
 * not have to learn a second one here.
 *
 * Pure, like everything else in this file. No database, no clock, no links: a
 * cheque's own page is already the view, so a rung is not a place to navigate
 * to and none of these carry an href.
 *
 * SCHEDULED folds into READY, exactly as the card, the view and the counted
 * timeline fold it — a portal pickup booking is not a sixth rung, it is the
 * same rung with a date attached.
 *
 * CANCELLED and VOIDED are NOT rungs and are not drawn as one. A cancelled
 * cheque stopped somewhere, and this system does not record where: the status
 * column holds CANCELLED and nothing says which rung it was on when it did.
 * Rather than guess a position, `stopped` is set and every rung reads
 * UPCOMING, so the spine shows an unwalked ladder beside a stated fact instead
 * of a plausible-looking progress bar nobody can substantiate. The audit trail
 * beneath it is where the actual history is.
 * ──────────────────────────────────────────────────────────────────────────
 */
export type ProgressState =
  /** Behind the cheque: it has been through this rung. */
  | 'DONE'
  /** Where the cheque is sitting now. */
  | 'CURRENT'
  /** Ahead of it. */
  | 'UPCOMING'

export type ProgressStep = {
  id: LadderId
  label: string
  state: ProgressState
}

export type CheckProgress = {
  steps: ProgressStep[]
  /** The rung the cheque is on, or null when it has left the ladder. */
  current: LadderId | null
  /** CANCELLED or VOIDED — a cheque that stopped rather than progressed. */
  stopped: 'CANCELLED' | 'VOIDED' | null
}

/** Which rung a status sits on. Null for the two that are not on the ladder. */
function rungOf(status: string): LadderId | null {
  switch (status) {
    case 'GENERATED': return 'GENERATED'
    case 'SIGNATURE_PENDING': return 'SIGNATURE_PENDING'
    case 'SIGNED': return 'SIGNED'
    // The fold. See above.
    case 'READY_FOR_RELEASE':
    case 'SCHEDULED': return 'READY_FOR_RELEASE'
    case 'RELEASED': return 'RELEASED'
    // A display status (`displayStatus`): the detail page passes it for a cleared cheque.
    case 'CLEARED': return 'CLEARED'
    default: return null
  }
}

/**
 * Takes a plain string rather than a `CheckStatus`, like `statusPillClass`
 * does: a status reaches the detail page and the audit trail as a stored
 * string, and an unrecognised one has to render as *something*. It renders as
 * an unwalked ladder with no current rung — visibly nothing rather than a
 * confident wrong position.
 */
export function buildCheckProgress(status: string): CheckProgress {
  const current = rungOf(status)
  const stopped = status === 'CANCELLED' || status === 'VOIDED' ? status : null
  const at = current === null ? -1 : LADDER.findIndex(([id]) => id === current)

  return {
    steps: LADDER.map(([id, label], i) => ({
      id,
      label,
      state: at < 0 || i > at ? 'UPCOMING' : i === at ? 'CURRENT' : 'DONE',
    })),
    current,
    stopped,
  }
}
