'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import { approveUser, changeUserRole, createUser, rejectUser, setUserActive, setUserPassword } from '@/lib/admin/users'
import type { AdminActionResult } from '@/app/admin/actions'

/**
 * The six user-administration actions (spec §12: "manage users" is
 * FINANCE_ADMIN only).
 *
 * **All six refuse a FINANCE_USER by RETURNING a result, never by
 * redirecting.** `requireAdmin` redirects, Next implements a redirect by
 * throwing, and `run()` below would catch that throw and report it as
 * "Something went wrong. Please try again." on a page the user is not entitled
 * to — which they would then try again. `revertAction` in `app/checks/actions.ts`
 * established the pattern and `app/admin/actions.ts` follows it: `requireUser()`
 * first and outside any try, then an explicit role test that returns.
 *
 * **There is no delete action, and there must never be one.** A server action is
 * an HTTP endpoint; one named `deleteUserAction` would be reachable by anyone
 * holding an admin session whether or not a button pointed at it. Removal is
 * `setUserActiveAction(active: false)`. See `lib/admin/users.ts` for why.
 *
 * **No password ever comes back out of here.** Every action returns a bare
 * `{ ok: true }`, never the row it wrote, so there is no shape in which a hash
 * or a plaintext could be serialised to the browser by accident.
 */

const ADMIN_ONLY = 'Only a Finance Admin can manage user accounts.'

const roleSchema = z.enum(['FINANCE_USER', 'FINANCE_ADMIN'])

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

/**
 * The password, read WITHOUT the trim every other field gets.
 *
 * A leading or trailing space is a legitimate character in a password, and
 * `authorize` does not trim what is typed at sign-in — so trimming here would
 * store a hash of a different string than the one the person will type, and the
 * account would present as a permanently wrong password.
 */
const rawPassword = (f: FormData) => String(f.get('password') ?? '')

/**
 * Domain errors carry copy written for a Finance Admin — the password policy,
 * the last-admin refusal, a taken email — and are meant to be read. Anything
 * else is a bug, and its text could name a connection string or a constraint,
 * so it goes to the server log and the user gets a fixed sentence.
 *
 * Note what is NOT logged: `console.error(e)` receives the thrown error only.
 * No form data reaches this function, so a password cannot end up in a log line
 * by way of an error report.
 */
async function run(fn: () => Promise<unknown>): Promise<AdminActionResult> {
  try {
    await fn()
    revalidatePath('/admin/users')
    // The USERS tab badge (pending count) lives in the admin layout.
    revalidatePath('/admin', 'layout')
    return { ok: true }
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message }
    if (isNextControlFlowError(e)) throw e
    console.error(e)
    return { ok: false, message: 'Something went wrong. Please try again.' }
  }
}

export async function createUserAction(formData: FormData): Promise<AdminActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') return { ok: false, message: ADMIN_ONLY }

  const role = roleSchema.safeParse(str(formData, 'role'))
  if (!role.success) return { ok: false, message: 'Choose a role: Finance User or Finance Admin.' }

  return run(() => createUser(prisma, {
    email: str(formData, 'email'),
    name: str(formData, 'name'),
    password: rawPassword(formData),
    role: role.data,
    actorId: user.id,
  }))
}

export async function changeUserRoleAction(formData: FormData): Promise<AdminActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') return { ok: false, message: ADMIN_ONLY }

  const role = roleSchema.safeParse(str(formData, 'role'))
  if (!role.success) return { ok: false, message: 'Choose a role: Finance User or Finance Admin.' }

  return run(() => changeUserRole(prisma, {
    userId: str(formData, 'userId'), role: role.data, actorId: user.id,
  }))
}

export async function setUserActiveAction(formData: FormData): Promise<AdminActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') return { ok: false, message: ADMIN_ONLY }

  // Stated, never inferred from "anything that is not 'true'". A hand-built or
  // mangled submission missing the field would otherwise read as "deactivate",
  // which is the destructive half of this control.
  const raw = str(formData, 'active')
  if (raw !== 'true' && raw !== 'false') {
    return { ok: false, message: 'Say whether the account is to be activated or deactivated.' }
  }

  return run(() => setUserActive(prisma, {
    userId: str(formData, 'userId'), active: raw === 'true', actorId: user.id,
  }))
}

export async function setUserPasswordAction(formData: FormData): Promise<AdminActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') return { ok: false, message: ADMIN_ONLY }

  return run(() => setUserPassword(prisma, {
    userId: str(formData, 'userId'), password: rawPassword(formData), actorId: user.id,
  }))
}

/**
 * The two halves of self-registration's approval step (spec 2026-10-09).
 * Same contract as the four above: a Finance user gets a RESULT, the role is
 * parsed before anything runs, and nothing but `{ ok: true }` comes back.
 *
 * `pendingSince` is the registration moment the admin's page displayed. When
 * present and readable it goes to `approveUser`, which refuses if the account
 * was re-registered since; when absent or unreadable the conditional write
 * inside `approveUser` still protects.
 */
export async function approveUserAction(formData: FormData): Promise<AdminActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') return { ok: false, message: ADMIN_ONLY }

  const role = roleSchema.safeParse(str(formData, 'role'))
  if (!role.success) return { ok: false, message: 'Choose a role: Finance User or Finance Admin.' }

  const seen = str(formData, 'pendingSince')
  const seenDate = seen ? new Date(seen) : null
  const seenPendingSince = seenDate && !Number.isNaN(seenDate.getTime()) ? seenDate : undefined

  return run(() => approveUser(prisma, {
    userId: str(formData, 'userId'), role: role.data, actorId: user.id, seenPendingSince,
  }))
}

export async function rejectUserAction(formData: FormData): Promise<AdminActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') return { ok: false, message: ADMIN_ONLY }

  return run(() => rejectUser(prisma, { userId: str(formData, 'userId'), actorId: user.id }))
}
