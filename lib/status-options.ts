import { cardHref, isCardSelected, type CardId, type DashboardSelection } from './dashboard-view'

/** The counts the STATUS dropdown can print; absent on the list screen, which does not query them. */
export type StatusCounts = {
  generated: number; signaturePending: number; signed: number; readyForRelease: number; scheduled: number
  released: number; cleared: number; cancelled: number; stale: number; voided: number; total: number
}

export type StatusOption = { id: string; label: string; href: string; selected: boolean }

const OPTIONS: readonly (readonly [CardId, string, (c: StatusCounts) => number])[] = [
  ['GENERATED', 'GENERATED TODAY', (c) => c.generated],
  ['SIGNATURE_PENDING', 'PENDING SIGNATURE', (c) => c.signaturePending],
  ['SIGNED', 'SIGNED', (c) => c.signed],
  ['READY_FOR_RELEASE', 'READY FOR RELEASE', (c) => c.readyForRelease + c.scheduled],
  ['RELEASED', 'RELEASED', (c) => c.released],
  ['CLEARED', 'CLEARED', (c) => c.cleared],
  ['CANCELLED', 'CANCELLED', (c) => c.cancelled],
  ['STALED', 'STALED', (c) => c.stale],
  ['VOIDED', 'VOIDED', (c) => c.voided],
  ['TOTAL_CHECKS', 'ALL CHECKS', (c) => c.total],
]

/**
 * The STATUS dropdown's options (client, 2026-10-06). Each links through
 * `cardHref`, so choosing one carries the company / bank / eligibility filters
 * exactly as a card does. The first option, NEEDS ACTION, is the default view.
 * `cardHref` of a selected card links back to NEEDS ACTION, so the dropdown
 * links the selected option to itself instead.
 */
export function buildStatusOptions(selection: DashboardSelection, counts?: StatusCounts): StatusOption[] {
  const n = (v: number) => (counts ? ` (${v.toLocaleString('en-PH')})` : '')
  const needsAction = !selection.status && !selection.showAll
  const first: StatusOption = {
    id: 'NEEDS_ACTION', label: 'NEEDS ACTION',
    href: needsAction
      ? '' // already here; the component ignores a change to the current option
      : cardHref(OPTIONS.find(([id]) => isCardSelected(id, selection))?.[0] ?? 'TOTAL_CHECKS', selection),
    selected: needsAction,
  }
  return [
    first,
    ...OPTIONS.map(([id, label, count]) => {
      const selected = isCardSelected(id, selection)
      return {
        id, label: label + (counts ? n(count(counts)) : ''),
        href: selected ? '' : cardHref(id, selection), selected,
      }
    }),
  ]
}
