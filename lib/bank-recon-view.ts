import { isIsoDay } from './domain/details'

/** The bank recon screen's parameters and hrefs. Pure. */
export const BANK_RECON_PATH = '/recon/bank'

/**
 * The day to reconcile: the `asOf` parameter when it is a real day no later
 * than today, else the newest day a book balance is held for, else today.
 * Never a future day — there is no statement for one.
 */
export function parseReconDay(value: string | undefined, storedDays: readonly string[], todayDay: string): string {
  const s = (value ?? '').trim()
  if (isIsoDay(s) && s <= todayDay) return s
  return storedDays[0] ?? todayDay
}

export function bankReconHref(asOfDay?: string): string {
  return asOfDay ? `${BANK_RECON_PATH}?asOf=${asOfDay}` : BANK_RECON_PATH
}

/** `2026-10-30` → `30 Oct 2026`, with no clock and no zone to get wrong. */
export function dayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return day
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`
}
