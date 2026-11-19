/**
 * A REVERT queued because a cheque the portal lists as AVAILABLE was cancelled
 * or voided (user ruling 2026-11-19, on 73 READY here against 78 CHECKS
 * AVAILABLE there).
 *
 * Every other event's body is built from the cheque as it stands at delivery.
 * This one cannot be: a cancel detaches the cheque from its AP bills
 * (`detachFromBills`, ruling 2026-10-29), so by delivery time the cheque names
 * no APV, and the portal matches on APV. The vouchers it was announced under
 * therefore ride in the payload, and the delivery client and the outbox read
 * them through this one function. Pure.
 */
export type CancelWithdrawal = { apvs: string[]; poNumbers: string[] }

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((s) => typeof s === 'string') ? (v as string[]) : null

/** The payload `voidCheck` / `cancelCheck` store on that REVERT. */
export function cancelWithdrawalPayload(checkNumber: string, w: CancelWithdrawal) {
  return { action: 'REVERT', checkNumber, withdrawnOnCancel: true, apvs: w.apvs, poNumbers: w.poNumbers }
}

/** The vouchers a cancel-withdrawal carries, or null for any other payload. */
export function cancelWithdrawal(payload: unknown): CancelWithdrawal | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  if (p.withdrawnOnCancel !== true) return null
  const apvs = strings(p.apvs)
  if (!apvs || apvs.length === 0) return null
  const pos = strings(p.poNumbers)
  return { apvs, poNumbers: apvs.map((_, i) => pos?.[i] ?? '') }
}
