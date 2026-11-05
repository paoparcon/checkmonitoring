import type { CheckStatus } from '@prisma/client'
import { CONTESTED, ALL_CANCELLED, NOT_KEYED } from './export/voucher-index'

/**
 * What colour a status pill is.
 *
 * Pure, and separated from the component that draws it so the map can be tested
 * for gaps: `Record<CheckStatus, string>` fails to compile the moment a ninth
 * status joins the enum without a colour, and the runtime test pins that the map
 * holds exactly the statuses the ladder has and no others.
 *
 * ── THE PALETTE (client, 2026-09-06) ──────────────────────────────────────
 * "Avoid saturated colours — the current pastel style is good." Every tone here
 * is a pale ground carrying dark ink, which is also what keeps a pill legible;
 * a saturated ground under dark text is not.
 *
 * Colour is never the only signal. The pill always spells the status out, so a
 * reader who cannot separate the greens from the ambers loses nothing — the
 * colour is there to let the eye skip to the rows that matter, not to carry the
 * meaning on its own.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The groupings are the ones Finance acts on, not a spectrum:
 *
 *   waiting on a person   SIGNATURE_PENDING          warning
 *   act on this today     READY_FOR_RELEASE          success
 *   in flight             SIGNED, SCHEDULED          cool, distinct from both
 *   over                  RELEASED                   muted — nothing to do
 *   gone wrong            CANCELLED, VOIDED          danger
 *
 * RELEASED is deliberately the quietest tone on the screen even though it is
 * the largest number: 9,545 cheques nobody will touch again must not out-shout
 * the 80 somebody has to hand over today.
 */
export const STATUS_PILL_CLASS: Record<CheckStatus, string> = {
  GENERATED:         'bg-slate-100 text-slate-700',
  SIGNATURE_PENDING: 'bg-warning-bg text-warning-ink',
  SIGNED:            'bg-navy-bg text-navy',
  READY_FOR_RELEASE: 'bg-success-bg text-success-ink',
  SCHEDULED:         'bg-indigo-50 text-indigo-900',
  RELEASED:          'bg-slate-200 text-slate-600',
  CANCELLED:         'bg-danger-bg text-danger-ink',
  VOIDED:            'bg-danger-bg text-danger-ink',
}

/**
 * The class for a status that arrived as a plain string.
 *
 * A row's status is typed, but this is also reached from the check detail page
 * and from the audit trail, where a status can be read back out of a stored
 * string. An unrecognised one gets the neutral pill rather than no pill: an
 * unstyled span reads as a rendering fault, and the status text itself is still
 * the thing being shown.
 */
export function statusPillClass(status: string): string {
  // CLEARED is a display status, not a ladder rung (`lib/display-status.ts`),
  // so it stays out of the map above: the bank's tone, pale mint.
  if (status === 'CLEARED') return 'bg-mint-bg text-mint-ink'
  return STATUS_PILL_CLASS[status as CheckStatus] ?? STATUS_PILL_CLASS.GENERATED
}

/**
 * The three statuses the voucher screen shows that are not cheque statuses.
 *
 * Kept OUT of `STATUS_PILL_CLASS` deliberately: that map is `Record<CheckStatus,
 * string>` and tested to hold exactly the ladder, so a status that is a fact
 * about a voucher row rather than about a cheque has no business in it.
 *
 * CONTESTED and NOT KEYED are "waiting on a person" — the warning tone the
 * dashboard gives SIGNATURE PENDING. ALL CANCELLED is "gone wrong", the danger
 * tone CANCELLED and VOIDED carry, because every cheque behind it is one of
 * those. Pastel, like everything else: the client's standing note.
 */
export const VOUCHER_STATUS_PILL_CLASS: Record<
  typeof CONTESTED | typeof ALL_CANCELLED | typeof NOT_KEYED, string
> = {
  [CONTESTED]:     'bg-warning-bg text-warning-ink',
  [ALL_CANCELLED]: 'bg-danger-bg text-danger-ink',
  [NOT_KEYED]:     'bg-warning-bg text-warning-ink',
}

/**
 * The class for a status the voucher screen holds — AS WORDS, because
 * `VoucherRow.status` is already `statusWords` output. A synthetic status has
 * its own colour; a real one is turned back into the enum spelling and painted
 * exactly as the dashboard paints it, so `READY FOR RELEASE` is the same green
 * on both screens.
 */
export function voucherStatusPillClass(status: string): string {
  const synthetic = VOUCHER_STATUS_PILL_CLASS[status as keyof typeof VOUCHER_STATUS_PILL_CLASS]
  if (synthetic) return synthetic
  return statusPillClass(status.replace(/ /g, '_'))
}
