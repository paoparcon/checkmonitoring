/**
 * Dates and times shown to Finance are Manila's, wherever the page is rendered.
 *
 * Every page here is rendered on the server, and on Vercel the server's clock
 * is UTC: a `toLocaleString('en-PH', …)` with no `timeZone` printed "Last push
 * Nov 3, 9:23 AM" for a push made at 5:23 PM Manila (measured 2026-11-03 on
 * /admin/portal), and a day stored at Manila midnight (`manilaDayStart`) is
 * 16:00 UTC the evening before, so a date-only format without a zone is a day
 * early. Naming the zone fixes both: a `@db.Date` value (UTC midnight) is still
 * the same calendar day at 08:00 Manila. Pure.
 */
export const MANILA_TZ = 'Asia/Manila'

/** `toLocaleString('en-PH', opts)` in Manila time; date-only options give a date-only string. */
export function formatManila(d: Date, opts: Intl.DateTimeFormatOptions): string {
  return d.toLocaleString('en-PH', { ...opts, timeZone: MANILA_TZ })
}
