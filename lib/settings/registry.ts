// Leaves only. The numbers live in ./defaults and each consumer module defines
// its own named constant FROM them, so this file never imports a server module
// and can never close a cycle through one — see ./defaults.ts.
import {
  DEFAULT_STALE_AFTER_HOURS as STALE_AFTER_HOURS,
  DEFAULT_ABANDONED_AFTER_MINUTES as ABANDONED_AFTER_MINUTES,
  DEFAULT_SYNC_IN_PROGRESS_MINUTES as SYNC_IN_PROGRESS_MINUTES,
  DEFAULT_MAX_BULK_SELECTION as MAX_BULK_SELECTION,
  DEFAULT_EXPORT_ROW_LIMIT as EXPORT_ROW_LIMIT,
  DEFAULT_VOUCHER_SCREEN_ROW_LIMIT as VOUCHER_SCREEN_ROW_LIMIT,
  DEFAULT_WINDOW_MINUTES as WINDOW_MINUTES,
  DEFAULT_EMAIL_FREE_FAILURES as EMAIL_FREE_FAILURES,
  DEFAULT_IP_FREE_FAILURES as IP_FREE_FAILURES,
  DEFAULT_SIGNUP_IP_PER_HOUR as SIGNUP_IP_PER_HOUR,
} from './defaults'
import { DEFAULT_CATEGORIES, isCategory } from './categories'

// Re-exported so existing importers keep working; the domain imports the leaf directly.
export { DEFAULT_CATEGORIES, isCategory }

/**
 * THE TWELVE KNOBS, DECLARED ONCE.
 *
 * Each default is the constant the code already exports, so the paragraph of
 * reasoning beside each constant stays where it was written and the `Setting`
 * table holds only overrides. Bounds are set here and nowhere else: the screen
 * shows them, the parser enforces them, and a stored value that falls outside
 * them (a bound tightened in code after it was saved) is reported, not obeyed.
 *
 * The LOGIN bounds are floors as much as ceilings. Client decision 2026-09-12:
 * the throttle is a setting, and the guardrail is that an admin can tighten it
 * freely and cannot loosen it past the floor. `BACKOFF_MINUTES` and
 * `RETENTION_DAYS` are the throttle's shape, not knobs, and are not here.
 *
 * Pure. Imports only constants.
 */

export type SettingGroup = 'SYNC' | 'CAPS' | 'LOGIN' | 'CATEGORIES'

export type IntKey =
  | 'sync.staleAfterHours' | 'sync.abandonedAfterMinutes' | 'sync.inProgressMinutes'
  | 'caps.bulkSelection' | 'caps.exportRows' | 'caps.voucherScreenRows'
  | 'login.windowMinutes' | 'login.emailFreeFailures' | 'login.ipFreeFailures'
  | 'signup.ipPerHour'
export type SettingKey = IntKey | 'categories'

export type IntSettingDef = {
  kind: 'int'; key: IntKey; group: SettingGroup; label: string; help: string; unit: string
  default: number; min: number; max: number
}
export type ListSettingDef = {
  kind: 'list'; key: 'categories'; group: 'CATEGORIES'; label: string; help: string; default: readonly string[]
}
export type SettingDef = IntSettingDef | ListSettingDef


export const SETTINGS: readonly SettingDef[] = [
  { kind: 'int', key: 'sync.staleAfterHours', group: 'SYNC', label: 'ACUMATICA READ IS STALE AFTER', unit: 'hours',
    help: 'The dashboard warns once the last successful read is older than this. The scheduled run is daily; 30 gives it a night of slack.',
    default: STALE_AFTER_HOURS, min: 1, max: 168 },
  { kind: 'int', key: 'sync.abandonedAfterMinutes', group: 'SYNC', label: 'A RUNNING SYNC IS CALLED ABANDONED AFTER', unit: 'minutes',
    help: 'The SYNC screen stops describing an unfinished run as in progress after this long. A first full read from a terminal legitimately takes an hour.',
    default: ABANDONED_AFTER_MINUTES, min: 10, max: 1440 },
  { kind: 'int', key: 'sync.inProgressMinutes', group: 'SYNC', label: 'SYNC NOW REFUSES TO OVERLAP A RUN YOUNGER THAN', unit: 'minutes',
    help: 'A new sync will not start while one this recent has not finished. Past it, the unfinished run is treated as dead.',
    default: SYNC_IN_PROGRESS_MINUTES, min: 1, max: 120 },
  { kind: 'int', key: 'caps.bulkSelection', group: 'CAPS', label: 'CHECKS PER BULK ACTION, AND LINES PER CLEARING PASTE', unit: 'checks',
    help: 'How much money one click may move. Each check is its own transaction either way; the cap stops a select-all over a filter.',
    default: MAX_BULK_SELECTION, min: 1, max: 500 },
  { kind: 'int', key: 'caps.exportRows', group: 'CAPS', label: 'ROWS PER EXCEL EXTRACT', unit: 'rows',
    help: 'A workbook is built in memory in a serverless function. A capped file states the cap in its title block.',
    default: EXPORT_ROW_LIMIT, min: 100, max: 100000 },
  { kind: 'int', key: 'caps.voucherScreenRows', group: 'CAPS', label: 'ROWS ON THE VOUCHERS SCREEN', unit: 'rows',
    help: 'Beyond this the screen says to narrow the search or take the file.',
    default: VOUCHER_SCREEN_ROW_LIMIT, min: 50, max: 2000 },
  { kind: 'int', key: 'login.windowMinutes', group: 'LOGIN', label: 'FAILED SIGN-INS COUNT FOR', unit: 'minutes',
    help: 'How far back a wrong password still counts against an address or an account.',
    default: WINDOW_MINUTES, min: 5, max: 60 },
  { kind: 'int', key: 'login.emailFreeFailures', group: 'LOGIN', label: 'FREE FAILURES PER EMAIL BEFORE A LOCK', unit: 'failures',
    help: 'The next failure locks the account for a minute, then longer on the published schedule.',
    default: EMAIL_FREE_FAILURES, min: 3, max: 10 },
  { kind: 'int', key: 'login.ipFreeFailures', group: 'LOGIN', label: 'FREE FAILURES PER ADDRESS BEFORE A LOCK', unit: 'failures',
    help: 'Counted across every account one client address tries. Higher than the email allowance because one address may be a whole office.',
    default: IP_FREE_FAILURES, min: 10, max: 100 },
  { kind: 'int', key: 'signup.ipPerHour', group: 'LOGIN', label: 'REGISTRATIONS PER ADDRESS PER HOUR', unit: 'accounts',
    help: 'How many accounts one client address may create on the sign-up page in a rolling hour. Every submission counts, accepted or refused.',
    default: SIGNUP_IP_PER_HOUR, min: 1, max: 100 },
  { kind: 'list', key: 'categories', group: 'CATEGORIES', label: 'CATEGORIES',
    help: 'What a check or a planned outflow may be filed under. One per line. Anything else is refused on the form.',
    default: DEFAULT_CATEGORIES },
]

export const SETTING_KEYS: readonly SettingKey[] = SETTINGS.map((s) => s.key)

export type SettingsValues = Record<IntKey, number> & { categories: readonly string[] }

export const DEFAULTS: SettingsValues = Object.fromEntries(
  SETTINGS.map((s) => [s.key, s.default]),
) as SettingsValues

export function settingDef(key: string): SettingDef | undefined {
  return SETTINGS.find((s) => s.key === key)
}

export function isSettingKey(key: string): key is SettingKey {
  return settingDef(key) !== undefined
}

const WHOLE = /^\d+$/

export function parseSettingText(
  def: SettingDef, text: string,
): { ok: true; value: number | string[] } | { ok: false; message: string } {
  if (def.kind === 'int') {
    const s = text.trim()
    if (!WHOLE.test(s)) return { ok: false, message: `${def.label} must be a whole number of ${def.unit}.` }
    const n = Number(s)
    if (n < def.min || n > def.max) {
      return { ok: false, message: `${def.label} must be between ${def.min} and ${def.max} ${def.unit}.` }
    }
    return { ok: true, value: n }
  }
  const items = text.split(/\r?\n/).map((l) => l.trim().toUpperCase()).filter((l) => l !== '')
  if (items.length === 0) return { ok: false, message: 'At least one category is required.' }
  const dupe = items.find((c, i) => items.indexOf(c) !== i)
  if (dupe) return { ok: false, message: `${dupe} is listed twice.` }
  return { ok: true, value: items }
}

/** What the table stores and the form shows. An int as digits; the list as a JSON array. */
export function formatSettingText(def: SettingDef, value: number | readonly string[]): string {
  return def.kind === 'int' ? String(value) : JSON.stringify(value)
}

/** Parses what the TABLE holds (not what a form sends): the list is JSON there. */
export function parseStoredText(def: SettingDef, stored: string): { ok: true; value: number | string[] } | { ok: false } {
  if (def.kind === 'int') {
    const r = parseSettingText(def, stored)
    return r.ok ? r : { ok: false }
  }
  try {
    const parsed: unknown = JSON.parse(stored)
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((x) => typeof x === 'string' && x.trim() !== '')) return { ok: false }
    const items = parsed.map((x: string) => x.trim().toUpperCase())
    if (new Set(items).size !== items.length) return { ok: false }
    return { ok: true, value: items }
  } catch {
    return { ok: false }
  }
}

