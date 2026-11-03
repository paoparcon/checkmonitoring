// The Supplier Portal client (spec 2026-09-26-check-monitoring-integration-
// design §2.2). One route, one bearer, one event per call. The body is built
// from the cheque AS IT STANDS at delivery time, not from the payload the
// outbox stored: the worker delivers the cheque's current truth (latest wins),
// so a stale MARK_AVAILABLE never announces a pickup date that has since moved.
//
// RULE 2 (amended, ruling 2026-10-19), asserted here independently of
// portalRoute() at the outbox write site: an INTERNAL cheque (payroll, tax,
// fund transfers) never tells a payee anything. Only its RELEASED,
// RELEASE_REVERSED and CANCELLED go to the portal, flagged internal, to be
// recorded silently; MARK_AVAILABLE, REVERT and RECEIPT never. Two checks on
// purpose.
import type { Check, PortalEventKind } from '@prisma/client'
import { portalRoute, type Eligibility } from '@/lib/domain/eligibility'
import { portalAcceptsReceiptType } from '@/lib/domain/receipt'
import { portalApvs } from './apvs'

export type PortalFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export type CheckForPortal = Pick<
  Check, 'id' | 'checkNumber' | 'apvNumbers' | 'eligibility' | 'availablePickupDate' | 'releasedAt' | 'orNumber' | 'orDate'
> & {
  // A register catch-up release has no releasedAt; its stated day is sent.
  statedReleaseDate?: Check['statedReleaseDate']
  cashAccount: { bank: { code: string } } | null
  checkBook: { bank: { code: string } } | null
  bills: { apvNumber: string; poNumber: string | null }[]
  // Who released it (portal "recorded by", user request 2026-10-01).
  releasedBy?: { name: string } | null
  // RECEIPT only (user request 2026-10-01); optional so other kinds' literals compile.
  receiptType?: Check['receiptType']
  receiptAmount?: Check['receiptAmount']
  receiptFile?: { fileName: string; contentType: string; bytes: Uint8Array } | null
}

export type PortalEventBody = {
  eventId: string
  kind: PortalEventKind
  apvs: string[]
  poNumbers: string[]
  checkNo: string
  bank: string
  availablePickupDate?: string
  releaseDate?: string
  orNumber?: string
  orDate?: string
  releasedBy?: string
  // spec 2026-10-19: an INTERNAL check's status event, recorded by the portal without telling anyone.
  internal?: true
  // RECEIPT (user request 2026-10-01): the amount is a two-decimal string,
  // never a JS number; the file is the scanned receipt, ≤ 3 MB raw (spec 2026-10-02).
  receiptType?: 'OR' | 'CR'
  amount?: string
  file?: { name: string; contentType: string; base64: string }
}

export type PortalOutcome = 'applied' | 'already' | 'noop' | 'refused'
export type PortalDeliveryResult = {
  status: number
  body: {
    eventId: string
    replay: boolean
    results: { ref: string; domain: string; releaseId: number | null; outcome: PortalOutcome; reason?: string }[]
    unmatched: string[]
  } | null
  /**
   * The portal's `error` text on a non-200 reply, when it sent one (its 400
   * body is `{ error }` naming the invalid field - it holds no secrets).
   */
  error?: string
}

export type PortalDeliverOptions = { timeoutMs?: number }
export type PortalClient = { deliver(body: PortalEventBody, opts?: PortalDeliverOptions): Promise<PortalDeliveryResult> }

/** The portal refuses more APVs than this in one event (spec §1.2 validation). */
export const MAX_APVS = 50

/**
 * A defect in the payload the worker was about to send — never a delivery
 * failure. The worker parks the outbox row on this error instead of
 * retrying: an INTERNAL cheque or a missing required date does not fix
 * itself on the next attempt (spec 2026-09-26-check-monitoring-integration
 * §2.3).
 */
export class PortalPayloadError extends Error {
  constructor(public readonly code: 'INTERNAL' | 'MISSING_DATE' | 'INVALID_PAYLOAD', message: string) {
    super(message)
    this.name = 'PortalPayloadError'
  }
}

/** The Manila calendar day, as the portal's date fields expect (YYYY-MM-DD). */
export function manilaDay(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/**
 * User ruling 2026-10-19 (Supplier Portal spec 2026-10-19-cm-internal-release-quiet):
 * an INTERNAL check's release, reversal and cancellation decide whether its bill
 * is paid, so the portal is told those three, flagged `internal`, and records
 * them without notifying anyone. Every kind that tells a payee something
 * (MARK_AVAILABLE, REVERT, RECEIPT) is still refused here - rule 2's second check.
 */
export const INTERNAL_PORTAL_KINDS: readonly PortalEventKind[] = ['RELEASED', 'RELEASE_REVERSED', 'CANCELLED']

export function buildPortalEventBody(event: { id: string; kind: PortalEventKind }, check: CheckForPortal): PortalEventBody {
  const internal = check.eligibility === 'INTERNAL'
  if (portalRoute(check.eligibility as Eligibility) === null && !(internal && INTERNAL_PORTAL_KINDS.includes(event.kind))) {
    throw new PortalPayloadError('INTERNAL', `INTERNAL check ${check.id} must never reach the portal as ${event.kind}.`)
  }
  // apvNumbers is the source's list; the bills are the same vouchers with
  // their PO numbers. A cheque imported before 2026-09-07 may carry only bills.
  const apvs = portalApvs(check)
  const poByApv = new Map(check.bills.map((b) => [b.apvNumber, b.poNumber ?? '']))
  const body: PortalEventBody = {
    eventId: event.id,
    kind: event.kind,
    apvs,
    poNumbers: apvs.map((a) => poByApv.get(a) ?? ''),
    checkNo: check.checkNumber,
    bank: check.cashAccount?.bank.code ?? check.checkBook?.bank.code ?? '',
  }
  if (internal) body.internal = true
  // Pre-checks mirroring the portal's own 400 validation (spec §1.2; final
  // review 2026-09-26): a request the portal is certain to refuse is a payload
  // defect, parked here without a round trip instead of sent to earn a 400.
  if (body.apvs.length === 0) {
    throw new PortalPayloadError('INVALID_PAYLOAD', `check ${check.id} has no APV numbers; the portal requires at least one`)
  }
  if (body.apvs.length > MAX_APVS) {
    throw new PortalPayloadError('INVALID_PAYLOAD', `check ${check.id} carries ${body.apvs.length} APV numbers; the portal accepts at most ${MAX_APVS}`)
  }
  if (!body.checkNo.trim() && !body.bank.trim()) {
    throw new PortalPayloadError('INVALID_PAYLOAD', `check ${check.id} has neither a check number nor a bank code`)
  }
  if (event.kind === 'MARK_AVAILABLE' || event.kind === 'RELEASE_REVERSED') {
    if (!check.availablePickupDate) {
      // An INTERNAL reversal needs no pickup date: nobody is told to collect (spec 2026-10-19).
      if (!(internal && event.kind === 'RELEASE_REVERSED')) {
        throw new PortalPayloadError('MISSING_DATE', `${event.kind} check ${check.id} has no availablePickupDate; the portal requires availablePickupDate`)
      }
    } else {
      body.availablePickupDate = manilaDay(check.availablePickupDate)
    }
  }
  if (event.kind === 'RELEASED') {
    // User report 2026-10-06: a cheque released by the register catch-up
    // (lib/admin/register-releases.ts) keeps releasedAt null by design and
    // carries the register's day in statedReleaseDate; that day is the
    // release date the portal is told.
    const released = check.releasedAt ?? check.statedReleaseDate ?? null
    if (!released) {
      throw new PortalPayloadError('MISSING_DATE', `RELEASED check ${check.id} has neither releasedAt nor statedReleaseDate; the portal requires releaseDate`)
    }
    body.releaseDate = manilaDay(released)
    if (check.orNumber) body.orNumber = check.orNumber
    if (check.orDate) body.orDate = manilaDay(check.orDate)
    if (check.releasedBy?.name) body.releasedBy = check.releasedBy.name
  }
  if (event.kind === 'RECEIPT') {
    if (!check.orNumber || !portalAcceptsReceiptType(check.receiptType)) {
      throw new PortalPayloadError('INVALID_PAYLOAD', `RECEIPT check ${check.id} has no receipt reference and type`)
    }
    // The portal files a receipt against the cheque number (review 2026-10-02).
    if (!check.checkNumber.trim()) {
      throw new PortalPayloadError('INVALID_PAYLOAD', `RECEIPT check ${check.id} has no check number; the portal requires checkNo`)
    }
    body.receiptType = check.receiptType as 'OR' | 'CR'
    body.orNumber = check.orNumber
    if (check.orDate) body.orDate = manilaDay(check.orDate)
    if (check.receiptAmount) body.amount = check.receiptAmount.toFixed(2)
    if (check.receiptFile) {
      body.file = {
        name: check.receiptFile.fileName, contentType: check.receiptFile.contentType,
        base64: Buffer.from(check.receiptFile.bytes).toString('base64'),
      }
    }
    if (check.releasedBy?.name) body.releasedBy = check.releasedBy.name
  }
  return body
}

export function createPortalClient(opts: { baseUrl: string; token: string; fetchImpl?: PortalFetch }): PortalClient {
  const fetchImpl: PortalFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/api/integrations/check-monitoring/events`
  return {
    async deliver(body, deliverOpts) {
      // A request timeout (final review 2026-09-26): a portal that accepts the
      // connection and never answers must not hold the run past its budget.
      // The abort rejects like any network error, so the worker backs off.
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(deliverOpts?.timeoutMs ? { signal: AbortSignal.timeout(deliverOpts.timeoutMs) } : {}),
      })
      const text = await res.text()
      let raw: unknown = null
      try { raw = JSON.parse(text) } catch { raw = null }
      if (res.status === 200) return { status: res.status, body: raw as PortalDeliveryResult['body'] }
      const error = raw !== null && typeof raw === 'object' && typeof (raw as { error?: unknown }).error === 'string'
        ? (raw as { error: string }).error : undefined
      return { status: res.status, body: null, ...(error ? { error } : {}) }
    },
  }
}
