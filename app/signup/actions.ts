'use server'

import { headers } from 'next/headers'
import { prisma } from '@/lib/db'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import { clientIp } from '@/lib/login-throttle'
import { recordRegistrationAttempt } from '@/lib/registration-throttle'
import { registerUser } from '@/lib/admin/users'
import { loadSettings } from '@/lib/settings/read'

/**
 * Self-registration (spec 2026-10-09). PUBLIC: no session is required and
 * none is created. The account it makes is inactive and pending; an admin's
 * APPROVE on /admin/users is the only way it becomes usable.
 *
 * Order: passwords match → length caps → record the attempt and count →
 * throttle → domain. Every submission that reaches the throttle counts,
 * whether the registration is then accepted, refused by the throttle or
 * refused by the domain, so hammering a refused form extends the wait. The
 * attempt is recorded BEFORE the registration runs (which hashes a password
 * and is the slow part), and the count that decides is taken in the same
 * transaction as that insert and under a per-address advisory lock (see
 * `lib/registration-throttle.ts`), so it includes the caller's own row and
 * every earlier same-address commit: parallel submissions from one address
 * queue and count exactly 1..N, with no count-then-insert window to burst
 * through. The caller is refused when that count is greater than the
 * allowance. A mismatched pair and an over-long entry are refused before any
 * database work and are not attempts against anything.
 *
 * A submission that cannot be counted is refused: if recording throws (a lock
 * timeout, a transaction timeout, a database fault) the failure is logged and
 * the person is told to try again; nothing is registered. The lock queue is
 * something a burst can cause on purpose, so an uncounted submission must not
 * pass unthrottled.
 *
 * On success the result carries the address and nothing else; on failure a
 * sentence. A domain error's wording is for the person at the form (the
 * password policy, "already exists"); anything else is logged by name and
 * first message line only and the person gets a fixed sentence.
 */

export type SignupResult = { ok: true; email: string } | { ok: false; message: string }

const THROTTLED = 'Too many accounts have been created from this connection. Try again later.'
const TOO_LONG = 'That entry is too long.'
const CANNOT_RECORD = 'Could not register right now. Try again in a minute.'

// Not exported: a 'use server' module may export only async functions and types.
/** RFC 5321's path limit. */
const MAX_EMAIL = 254
const MAX_NAME = 200
/** Generous for a passphrase; bounds what argon2 is asked to hash from a public form. */
const MAX_PASSWORD = 1024

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
/** Untrimmed: a leading or trailing space is a legitimate password character, and sign-in does not trim. */
const raw = (f: FormData, k: string) => String(f.get(k) ?? '')

/**
 * Log an unexpected failure without the form. A Prisma validation error
 * embeds the invocation's arguments (email, name, password hash) in its
 * message body, and begins with a newline; the first non-empty line alone
 * names the operation.
 */
function logUnexpected(e: unknown): void {
  console.error(
    e instanceof Error
      ? `${e.name}: ${e.message.split('\n').find((line) => line.trim() !== '') ?? ''}`
      : String(e),
  )
}

export async function registerAction(formData: FormData): Promise<SignupResult> {
  const name = str(formData, 'name')
  const email = str(formData, 'email').toLowerCase()
  const password = raw(formData, 'password')
  const confirm = raw(formData, 'confirm')

  if (password !== confirm) return { ok: false, message: 'The two passwords do not match.' }
  if (email.length > MAX_EMAIL || name.length > MAX_NAME || password.length > MAX_PASSWORD) {
    return { ok: false, message: TOO_LONG }
  }

  const now = new Date()
  const ip = clientIp(await headers())
  const settings = await loadSettings(prisma)
  const limit = settings.values['signup.ipPerHour']

  let recorded: { recent: number }
  try {
    recorded = await recordRegistrationAttempt(prisma, { ip, email, now })
  } catch (e) {
    logUnexpected(e)
    return { ok: false, message: CANNOT_RECORD }
  }
  if (recorded.recent > limit) return { ok: false, message: THROTTLED }

  try {
    await registerUser(prisma, { email, name, password })
    return { ok: true, email }
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message }
    if (isNextControlFlowError(e)) throw e
    logUnexpected(e)
    return { ok: false, message: 'Something went wrong. Please try again.' }
  }
}
