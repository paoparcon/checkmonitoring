/**
 * THE CHECK LIST FEED (user ruling 2026-11-03: "make sure all the checks
 * including cancelled, void from the system are in the portal" — "Full check
 * list"). Every cheque this system holds, whatever its status, is mirrored into
 * the Supplier Portal's `cm_check` table as one row keyed by this system's own
 * check id, independent of the portal's per-bill release rows. The outbox
 * events (lib/sync/portal-outbox.ts) still drive what the portal DOES with a
 * bill; this feed only says what every cheque IS.
 *
 * Pure: the row is built from a loaded cheque and two things looked up beside
 * it (the APVs a cancelled cheque was detached from, and its PO numbers).
 *
 * Rule 2 (an INTERNAL cheque never tells a payee anything) holds because the
 * list is an ADMIN screen in the portal — the portal's own spec gates it to
 * admin tiers and notifies nobody from it. The row says `eligibility` so the
 * portal can tell. Rule 8: `amount` is a two-decimal string, never a number.
 */
import type { Check, CheckBill, CheckStatus, Eligibility } from '@prisma/client'
import { manilaDay } from './client'

/** Rows per request; the portal refuses more (its validation mirrors this). */
export const PORTAL_CHECK_BATCH = 500

export type PortalCheckSource = Pick<
  Check,
  | 'id' | 'checkNumber' | 'cvNumber' | 'apvNumbers' | 'checkDate' | 'amount' | 'currency' | 'isCheque'
  | 'payeeName' | 'eligibility' | 'status' | 'isStale' | 'signedAt' | 'readyAt' | 'availablePickupDate'
  | 'releasedAt' | 'statedReleaseDate' | 'orNumber' | 'orDate' | 'receiptType' | 'cancelledAt' | 'cancelReason'
  | 'voidedAt' | 'acumaticaStatus' | 'acumaticaTenant' | 'updatedAt'
> & {
  company: { code: string }
  cashAccount: { code: string; bank: { code: string } } | null
  checkBook: { code: string; bank: { code: string } } | null
  releasedBy: { name: string } | null
  bills: Pick<CheckBill, 'apvNumber' | 'poNumber'>[]
}

export type PortalCheckRow = {
  /** This system's check id — the portal's key. */
  id: string
  checkNumber: string
  cvNumber: string | null
  company: string
  /** The bank code, label first then check book — as the event bodies read it. */
  bank: string
  checkBook: string | null
  cashAccount: string | null
  payee: string | null
  /** Two decimals, or null for a cheque whose amount nobody recorded. */
  amount: string | null
  currency: string
  /** YYYY-MM-DD, the cheque's own date. */
  checkDate: string | null
  isCheque: boolean
  status: CheckStatus
  eligibility: Eligibility
  isStale: boolean
  /** The AP bills it pays now. Empty for a cancelled or voided cheque (ruling 2026-10-29). */
  apvs: string[]
  /** The AP bills a cancelled or voided cheque WAS applied to before it was cut loose. */
  detachedApvs: string[]
  poNumbers: string[]
  acumaticaStatus: string | null
  acumaticaTenant: string | null
  signedAt: string | null
  readyAt: string | null
  availablePickupDate: string | null
  releasedAt: string | null
  /** The release day: the app's own, else the retired register's stated day. */
  releaseDate: string | null
  releasedBy: string | null
  orNumber: string | null
  orDate: string | null
  receiptType: string | null
  cancelledAt: string | null
  cancelReason: string | null
  voidedAt: string | null
  /** When this system last changed the row — the feed's watermark. */
  updatedAt: string
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)
const day = (d: Date | null) => (d ? manilaDay(d) : null)

export function buildPortalCheckRow(
  c: PortalCheckSource,
  extras: { detachedApvs: readonly string[]; poNumbers: readonly string[] },
): PortalCheckRow {
  const released = c.releasedAt ?? c.statedReleaseDate ?? null
  return {
    id: c.id,
    checkNumber: c.checkNumber,
    cvNumber: c.cvNumber,
    company: c.company.code,
    bank: c.cashAccount?.bank.code ?? c.checkBook?.bank.code ?? '',
    checkBook: c.checkBook?.code ?? null,
    cashAccount: c.cashAccount?.code ?? null,
    payee: c.payeeName,
    amount: c.amount === null ? null : c.amount.toFixed(2),
    currency: c.currency,
    // The cheque's date is stored as a naive day (lib/integrations/acumatica/map.ts naiveDate),
    // so the UTC slice is that day; a Manila read would not move it either.
    checkDate: c.checkDate ? c.checkDate.toISOString().slice(0, 10) : null,
    isCheque: c.isCheque,
    status: c.status,
    eligibility: c.eligibility,
    isStale: c.isStale,
    apvs: [...new Set([...c.apvNumbers, ...c.bills.map((b) => b.apvNumber)])].sort(),
    detachedApvs: [...new Set(extras.detachedApvs)].sort(),
    poNumbers: [...extras.poNumbers],
    acumaticaStatus: c.acumaticaStatus,
    acumaticaTenant: c.acumaticaTenant,
    signedAt: iso(c.signedAt),
    readyAt: iso(c.readyAt),
    availablePickupDate: day(c.availablePickupDate),
    releasedAt: iso(c.releasedAt),
    releaseDate: day(released),
    releasedBy: c.releasedBy?.name ?? null,
    orNumber: c.orNumber,
    orDate: day(c.orDate),
    receiptType: c.receiptType,
    cancelledAt: iso(c.cancelledAt),
    cancelReason: c.cancelReason,
    voidedAt: iso(c.voidedAt),
    updatedAt: c.updatedAt.toISOString(),
  }
}
