import { Prisma, type PrismaClient, type Role } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { DomainError } from '@/lib/domain/errors'
import { loginFailureSummary, type LoginFailureState, type ThrottleLimits } from '@/lib/login-throttle'
import { hashPassword, validatePasswordStrength } from '@/lib/password'

/**
 * User administration (spec §13, `/admin/users`).
 *
 * **There is no delete here, and there must never be one.** A `User` is
 * referenced by `AuditLog` and by five `Check` relations — `signedBy`,
 * `readyBy`, `releasedBy`, `cancelledBy`, `eligibilityOverriddenBy` — every one
 * of them an optional relation, which Prisma gives `onDelete: SetNull` by
 * default. Deleting one row would therefore not fail loudly; it would quietly
 * blank out *who released real money* on every cheque that person ever touched,
 * in the audit trail this system exists to preserve. Removal is deactivation:
 * `authorize` in auth.config.ts refuses an inactive account at sign-in, so a
 * deactivated user cannot do anything, while every attribution stays intact.
 * The export-shape test in `tests/admin/users.test.ts` pins the module's surface
 * so a delete helper cannot be added without deleting a test to make room.
 *
 * These functions take a `PrismaClient` rather than the `Db` union used
 * elsewhere in `lib/`, because each of them opens its own transaction and the
 * last-active-admin guard below is only sound inside one.
 */

/**
 * The accounts `prisma/seed.ts` creates with passwords committed to the
 * repository. `seed.ts` derives its own account list from this constant — see
 * `SEED_ACCOUNTS` there — so the two cannot drift and a third seeded account
 * cannot be added without appearing on this screen flagged.
 *
 * They are flagged, not blocked and certainly not deleted: the real admin
 * accounts may not exist yet when this code first runs, and refusing to sign
 * them in from here would lock the client out of their own system. Retiring
 * them is a deliberate human act — deactivate each one from `/admin/users`
 * after a real Finance Admin exists.
 */
export const SEEDED_TEST_ACCOUNT_EMAILS = ['admin@rcl.test', 'finance@rcl.test'] as const

export type SeededTestAccountEmail = (typeof SEEDED_TEST_ACCOUNT_EMAILS)[number]

/**
 * What the screen shows. Deliberately NOT `User`: that carries `passwordHash`,
 * and this row is handed to a client component, which means everything on it is
 * serialised into the page the browser receives. An argon2 hash is nothing a
 * browser needs, and one that reaches a browser is one an attacker can grind
 * offline at their leisure.
 */
export type AdminUserRow = {
  id: string
  name: string
  email: string
  role: Role
  active: boolean
  lastLoginAt: Date | null
  createdAt: Date
  /**
   * Set while a self-registered account waits for an admin. PENDING is
   * `!active && pendingSince !== null` — `isPending` — and is neither ACTIVE
   * nor DEACTIVATED on the screen.
   */
  pendingSince: Date | null
  /**
   * The name typed at a re-registration of an EXISTING account, held aside until
   * an admin approves (`name` stays what it was - it is read live wherever a
   * check says who signed or released it). Null when nothing is held.
   */
  pendingName: string | null
  /**
   * True when a password typed at a re-registration is held aside for approval.
   * The hash itself never leaves this module: `toRow` reduces it to this flag.
   */
  hasPendingCredentials: boolean
  /**
   * True when a registration re-opened a DEACTIVATED (not pending) account and
   * the account has been pending ever since. Walking the account's registration
   * rows newest-first, the first `user_registered` (false) or `user_reregistered`
   * with `wasPending === false` (true) decides; a `user_reregistered` with
   * `wasPending === true` (a pending account registered again) is skipped, so a
   * pending-to-pending re-registration carries the earlier verdict forward. The
   * admin's one defence against somebody re-registering a deactivated
   * colleague's address with their own password: the PENDING list says so
   * against the row.
   */
  previouslyDeactivated: boolean
  /** Seeded by `prisma/seed.ts` with a password anyone can read in git. */
  isSeededTestAccount: boolean
  /**
   * Failed sign-ins against this address inside the throttle's counting window,
   * cleared by the account's own last successful sign-in. Zero for a quiet
   * account; a number that climbs is what an attack looks like from here.
   */
  recentFailedLogins: number
  /**
   * When the login throttle will admit this address again, or null if it is
   * not currently refusing it. Never a time in the past — see
   * `loginFailureSummary`.
   */
  lockedUntil: Date | null
}

// Stated once, as a Prisma select, so no query in this module can accidentally
// widen itself to the whole row.
// `pendingPasswordHash` is selected so `toRow` can reduce it to a boolean; it is
// destructured OUT there and never reaches a row.
const ROW_SELECT = {
  id: true, name: true, email: true, role: true,
  active: true, lastLoginAt: true, createdAt: true, pendingSince: true,
  pendingName: true, pendingPasswordHash: true,
} as const

type SelectedUser = {
  id: string; name: string; email: string; role: Role
  active: boolean; lastLoginAt: Date | null; createdAt: Date; pendingSince: Date | null
  pendingName: string | null; pendingPasswordHash: string | null
}

const SEEDED = new Set<string>(SEEDED_TEST_ACCOUNT_EMAILS)

/**
 * The throttle state for a row that was not read alongside a listing.
 *
 * Every mutating function here returns the row it just wrote, and none of them
 * touches `LoginAttempt` — creating a user or changing a role says nothing
 * about failed sign-ins. Rather than issue a throttle query none of those call
 * sites needs, they report the quiet state, and `listUsers` — the one that
 * feeds the screen — is where the real counts are read.
 */
const NO_FAILURES: LoginFailureState = { recentFailures: 0, lockedUntil: null }

function toRow(
  u: SelectedUser,
  failures: LoginFailureState = NO_FAILURES,
  previouslyDeactivated = false,
): AdminUserRow {
  const { pendingPasswordHash, ...rest } = u
  return {
    ...rest,
    hasPendingCredentials: pendingPasswordHash !== null,
    isSeededTestAccount: SEEDED.has(u.email),
    recentFailedLogins: failures.recentFailures,
    lockedUntil: failures.lockedUntil,
    previouslyDeactivated,
  }
}

/**
 * The address sign-in will look this account up by.
 *
 * `authorize` lowercases and trims what is typed before its `findUnique`, so an
 * account stored as `J.Cruz@RCL.com.ph` could never be signed into at all — and
 * would present as a permanently wrong password rather than as anything a user
 * could diagnose. Normalise on the way in, once, here.
 */
function normaliseEmail(raw: string): string {
  return raw.toLowerCase().trim()
}

/**
 * A minimal shape check, not RFC 5322: something, one `@`, something, a dot,
 * something, no whitespace. It catches a typed name or a missing domain - an
 * account nobody could ever sign in to or be told about - without pretending to
 * decide what a deliverable address is.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function requireEmailShape(email: string): void {
  if (!EMAIL_SHAPE.test(email)) throw new DomainError('EMAIL_INVALID', 'Enter a valid email address.')
}

/**
 * THE definition of a pending account. Inactive, with the registration flag
 * set. An inactive account with the flag clear is DEACTIVATED, as it always
 * was; approving or rejecting clears the flag. Every screen reads this, not
 * the columns.
 */
export function isPending(u: { active: boolean; pendingSince: Date | null }): boolean {
  return !u.active && u.pendingSince !== null
}

function requirePassword(plain: string): void {
  const strength = validatePasswordStrength(plain)
  // The policy's own wording, passed through verbatim: it names which class of
  // character is missing, which is the only part of it a user can act on.
  if (!strength.ok) throw new DomainError('WEAK_PASSWORD', strength.message)
}

/**
 * The guard that matters most: the last active Finance Admin can be neither
 * deactivated nor demoted, **including by themselves**.
 *
 * Without it one click locks everybody out of administration, and because there
 * is no delete-and-reseed path (see the module note above) there is no easy
 * recovery — the client would need someone with database access to flip a
 * column by hand.
 *
 * `SELECT … FOR UPDATE`, not `count()`. A bare count is read-committed and
 * would let two concurrent transactions each demote a different one of the last
 * two admins: each sees the other still standing, each allows its own change,
 * and the system ends with zero. Locking every active admin row serialises
 * those transactions, and Postgres re-evaluates the WHERE clause against the
 * updated row once the lock is released, so the second transaction correctly
 * sees only itself left. Do not "simplify" this back to a count.
 *
 * It counts **active** admins, never admins. A deactivated admin is refused at
 * sign-in and so cannot administer anything; counting them would leave the door
 * looking open while it was in fact locked.
 */
async function assertNotLastActiveAdmin(
  tx: Prisma.TransactionClient,
  targetId: string,
  attempt: 'DEACTIVATE' | 'DEMOTE',
): Promise<void> {
  const activeAdmins = await tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT "id", "name" FROM "User"
    WHERE "role" = 'FINANCE_ADMIN' AND "active" = true
    FOR UPDATE
  `
  const target = activeAdmins.find((a) => a.id === targetId)
  // Not an active admin, so this change cannot close the door behind anyone.
  if (!target) return
  if (activeAdmins.length > 1) return

  const what = attempt === 'DEACTIVATE' ? 'Deactivating them' : 'Changing their role'
  throw new DomainError(
    'LAST_ACTIVE_ADMIN',
    `${target.name} is the last active Finance Admin. ${what} would leave nobody able to ` +
    'administer this system, and there is no way back without one — create another Finance ' +
    'Admin, or reactivate an existing one, first.',
  )
}

async function loadTarget(tx: Prisma.TransactionClient, userId: string): Promise<SelectedUser> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: ROW_SELECT })
  if (!user) throw new DomainError('NOT_FOUND', 'That user account no longer exists.')
  return user
}

/**
 * Active accounts first, then by email.
 *
 * Not ordered by `role`: Prisma sorts an enum by its DECLARATION order in the
 * schema, which today puts FINANCE_USER before FINANCE_ADMIN — an accident of
 * how the enum was typed rather than anything meaningful, and one a future
 * reordering would silently reverse. `lib/admin/staged-queue.ts` carries the
 * same warning about `CheckStatus`.
 */
export async function listUsers(
  db: PrismaClient,
  now: Date = new Date(),
  limits?: ThrottleLimits,
): Promise<AdminUserRow[]> {
  const rows = await db.user.findMany({
    select: ROW_SELECT,
    orderBy: [{ active: 'desc' }, { email: 'asc' }],
  })
  // `now` is a parameter so a test can pin a lockout deadline exactly rather
  // than racing the clock across a Neon round trip. `limits` is the throttle's
  // own settings, read by the page and passed here so this screen agrees with
  // the gate about who is locked; a test that passes neither gets the default.
  const failures = await loginFailureSummary(db, { emails: rows.map((r) => r.email), now, limits })
  const reopened = await reopenedPendingIds(db, rows.filter(isPending).map((r) => r.id))
  return rows.map((u) => toRow(u, failures.get(u.email), reopened.has(u.id)))
}

/**
 * Of these pending accounts, which were RE-OPENED from a DEACTIVATED account
 * rather than created fresh. Walks each account's registration rows
 * newest-first and takes the first that decides: `user_registered` means no,
 * `user_reregistered` with `wasPending === false` means yes. A
 * `user_reregistered` with `wasPending === true` (a pending account registered
 * again) decides nothing and is skipped, so the earlier verdict carries
 * forward. A pending account always has such a row, because only
 * `registerUser` sets the flag.
 */
async function reopenedPendingIds(db: PrismaClient, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await db.auditLog.findMany({
    where: {
      action: { in: ['user_registered', 'user_reregistered'] },
      OR: ids.map((id) => ({ details: { path: ['targetUserId'], equals: id } })),
    },
    orderBy: { createdAt: 'desc' },
    select: { action: true, details: true },
  })
  const wanted = new Set(ids)
  const verdict = new Map<string, boolean>()
  for (const r of rows) {
    const details = r.details as { targetUserId?: unknown; wasPending?: unknown } | null
    const target = details?.targetUserId
    if (typeof target !== 'string' || !wanted.has(target) || verdict.has(target)) continue
    if (r.action === 'user_registered') verdict.set(target, false)
    else if (details?.wasPending === false) verdict.set(target, true)
  }
  return new Set([...verdict].filter(([, reopened]) => reopened).map(([id]) => id))
}

/**
 * Create an account from a password **a human typed into the form**.
 *
 * The plaintext is hashed and then dropped: it is never returned, never written
 * to the audit row, never logged, and never put into an error message. There is
 * deliberately no generated-password path — a generated password has to be
 * shown to somebody to be usable, and the moment it is shown it is in a page, a
 * screenshot, or a chat message. The admin at the keyboard types one and tells
 * the person themselves.
 *
 * There is likewise no password-reset-by-email: this system has no mail path at
 * all, and inventing one is out of scope. `setUserPassword` is how a forgotten
 * password is dealt with.
 */
export async function createUser(
  db: PrismaClient,
  args: { email: string; name: string; password: string; role: Role; actorId: string },
): Promise<AdminUserRow> {
  const email = normaliseEmail(args.email)
  const name = args.name.trim()
  if (!email) throw new DomainError('EMAIL_REQUIRED', 'An email address is required.')
  requireEmailShape(email)
  if (!name) throw new DomainError('NAME_REQUIRED', 'A name is required — the audit trail shows it against every action this person takes.')
  requirePassword(args.password)

  // Hashed BEFORE the transaction opens. argon2id is deliberately slow, and
  // holding a database connection through it for no reason is how a pool runs
  // out under a handful of concurrent admins.
  const passwordHash = await hashPassword(args.password)

  try {
    return await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email, name, passwordHash, role: args.role },
        select: ROW_SELECT,
      })
      await writeAudit(tx, {
        // No `checkId`: a user-administration event is about no cheque, and
        // `AuditLog.checkId` is nullable precisely so such an event can be
        // recorded without inventing one.
        actorType: 'USER',
        userId: args.actorId,
        action: 'user_created',
        details: { targetUserId: created.id, email: created.email, name: created.name, role: created.role },
        remarks: created.email,
      })
      return toRow(created)
    })
  } catch (e) {
    // The unique index on `email` is the only constraint this insert can trip,
    // and a raw Prisma P2002 in front of a Finance user is not an explanation.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new DomainError(
        'EMAIL_TAKEN',
        `An account for ${email} already exists. Accounts here are never deleted — reactivate ` +
        'it or change its role instead.',
      )
    }
    throw e
  }
}

/**
 * Self-registration from `/signup` (spec 2026-10-09).
 *
 * Creates an INACTIVE, PENDING account, or re-opens an inactive one under the
 * same address. Nothing here can produce a signed-in account: `active` is
 * never set true, and `authorize` refuses an inactive account at sign-in. An
 * admin's `approveUser` is the only way in.
 *
 * **An inactive account's address re-registers; an active one's is refused.**
 * The three accounts this was built for had been deactivated and their
 * owners wanted to register again under the same email (user ruling
 * 2026-10-09). The row keeps its id and every attribution it carries.
 *
 * **Nothing on an EXISTING row changes except the pending marker and the
 * held-aside `pendingName` / `pendingPasswordHash`.** `name` is read live by
 * the check page (SIGNED BY, READY BY, RELEASED BY), the receipts page, the
 * audit screen and the portal's `releasedBy`, and `passwordHash` is what a
 * REACTIVATE would let in. This function is reachable by anyone who can load
 * /signup, so writing either at submission would let a stranger rewrite who
 * appears to have released money, and leave their password on the row after a
 * reject. The typed values are copied across by `approveUser` and discarded
 * by `rejectUser`. The PENDING list shows both names and says the account was
 * re-opened, which is the admin's cue to check it is the colleague they think
 * it is before approving. (A brand-new row has nothing to protect and takes
 * the typed name and hash directly.)
 *
 * Returns nothing. There is no shape in which the hash can reach a browser.
 * The audit row is SYSTEM: nobody is signed in.
 */
export async function registerUser(
  db: PrismaClient,
  args: { email: string; name: string; password: string },
): Promise<void> {
  const email = normaliseEmail(args.email)
  const name = args.name.trim()
  if (!email) throw new DomainError('EMAIL_REQUIRED', 'An email address is required.')
  requireEmailShape(email)
  if (!name) throw new DomainError('NAME_REQUIRED', 'A name is required — it is shown against every action this account takes.')
  requirePassword(args.password)

  const passwordHash = await hashPassword(args.password)
  const now = new Date()
  const taken = new DomainError('EMAIL_TAKEN', 'An account for that address already exists.')

  try {
    await db.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email }, select: ROW_SELECT })
      if (existing && existing.active) throw taken

      if (existing) {
        // `active: false` in the WHERE is load-bearing. The read above is
        // READ COMMITTED: an approval or reactivation can commit between it
        // and this write, and an unconditional update would then replace the
        // password of an account that is now ACTIVE with a stranger's.
        // `pendingSince` is in the WHERE for the audit row: `wasPending`
        // below is exactly the state this write saw, not a state the row has
        // since left. Zero rows matched means the row moved - refuse, change
        // nothing.
        const { count } = await tx.user.updateMany({
          where: { id: existing.id, active: false, pendingSince: existing.pendingSince },
          data: { pendingName: name, pendingPasswordHash: passwordHash, pendingSince: now },
        })
        if (count === 0) throw taken
        await writeAudit(tx, {
          actorType: 'SYSTEM',
          action: 'user_reregistered',
          details: {
            targetUserId: existing.id, email, name, currentName: existing.name,
            wasPending: isPending(existing),
          },
          remarks: email,
        })
        return
      }

      const created = await tx.user.create({
        data: { email, name, passwordHash, active: false, pendingSince: now },
        select: { id: true },
      })
      await writeAudit(tx, {
        actorType: 'SYSTEM',
        action: 'user_registered',
        details: { targetUserId: created.id, email, name },
        remarks: email,
      })
    })
  } catch (e) {
    // Two registrations racing on one new address: the loser's create trips
    // the unique index. Reported with the same sentence — the address exists.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw taken
    throw e
  }
}

function reRegisteredMessage(name: string, verb: 'approving' | 'rejecting' = 'approving'): string {
  return `${name} was re-registered after this page loaded. Reload and check the new registration before ${verb}.`
}

function notPendingMessage(name: string): string {
  return `${name} is not waiting for approval.`
}

function pendingMessage(name: string): string {
  return `${name} is waiting for approval. Approve them with a role from the PENDING APPROVAL list instead.`
}

/**
 * A conditional approve/reject wrote nothing: the row moved after it was read.
 * Say which way. No longer pending (someone else approved or rejected it first)
 * is NOT_PENDING; still pending under a different registration is REREGISTERED.
 */
async function explainLostPendingWrite(
  tx: Prisma.TransactionClient,
  userId: string,
  verb: 'approving' | 'rejecting',
): Promise<DomainError> {
  const current = await loadTarget(tx, userId)
  if (!isPending(current)) return new DomainError('NOT_PENDING', notPendingMessage(current.name))
  return new DomainError('REREGISTERED', reRegisteredMessage(current.name, verb))
}

/**
 * Approve a pending account: the role the admin chose, active, flag cleared.
 * No last-admin guard applies — this can only add an active account.
 *
 * A re-registration's held name and password are applied HERE and nowhere
 * earlier: `name` becomes `pendingName` and `passwordHash` becomes
 * `pendingPasswordHash`, both held columns are cleared, and the audit row
 * records the name it replaced (`nameChangedFrom`). The held hash is read
 * inside the transaction and never returned or audited.
 */
export async function approveUser(
  db: PrismaClient,
  args: { userId: string; role: Role; actorId: string; seenPendingSince?: Date },
): Promise<AdminUserRow> {
  return db.$transaction(async (tx) => {
    const target = await loadTarget(tx, args.userId)
    if (!isPending(target)) {
      throw new DomainError('NOT_PENDING', notPendingMessage(target.name))
    }
    // The registration the admin looked at is not the one on file: it was
    // redone (new name, new password) after their page loaded.
    if (args.seenPendingSince && args.seenPendingSince.getTime() !== target.pendingSince!.getTime()) {
      throw new DomainError('REREGISTERED', reRegisteredMessage(target.name))
    }
    // The held hash, read here and used only inside the conditional write
    // below: if a re-registration commits after this read it moves
    // `pendingSince`, the WHERE fails, and nothing is applied.
    const pendingHash = target.pendingPasswordHash
    const nameChanged = target.pendingName !== null && target.pendingName !== target.name
    // Conditional on the registration this function read: a re-registration
    // that commits between the read and this write moves `pendingSince`, the
    // WHERE no longer matches, and the admin is told rather than approving a
    // password they never saw.
    const { count } = await tx.user.updateMany({
      where: { id: target.id, active: false, pendingSince: target.pendingSince },
      data: {
        role: args.role, active: true, pendingSince: null,
        pendingName: null, pendingPasswordHash: null,
        ...(target.pendingName !== null ? { name: target.pendingName } : {}),
        ...(pendingHash !== null ? { passwordHash: pendingHash } : {}),
      },
    })
    if (count === 0) throw await explainLostPendingWrite(tx, target.id, 'approving')
    const updated = await loadTarget(tx, target.id)
    await writeAudit(tx, {
      actorType: 'USER',
      userId: args.actorId,
      action: 'user_approved',
      details: {
        targetUserId: target.id, email: target.email, role: args.role,
        ...(nameChanged ? { nameChangedFrom: target.name } : {}),
      },
      remarks: target.email,
    })
    return toRow(updated)
  })
}

/**
 * Reject a pending account: flag cleared, still inactive. The row stays — an
 * ordinary DEACTIVATED account from here on — so the address cannot re-land on
 * the list silently, and REACTIVATE is there if the rejection was a mistake.
 *
 * Whatever a re-registration typed is DISCARDED (`pendingName`,
 * `pendingPasswordHash`), and the row keeps the name and password it had
 * before. REACTIVATE after a reject therefore restores the genuine account,
 * never one that answers to a stranger's password.
 */
export async function rejectUser(
  db: PrismaClient,
  args: { userId: string; actorId: string },
): Promise<AdminUserRow> {
  return db.$transaction(async (tx) => {
    const target = await loadTarget(tx, args.userId)
    if (!isPending(target)) {
      throw new DomainError('NOT_PENDING', notPendingMessage(target.name))
    }
    // Conditional on the registration this function read, as in approveUser.
    const { count } = await tx.user.updateMany({
      where: { id: target.id, active: false, pendingSince: target.pendingSince },
      data: { pendingSince: null, pendingName: null, pendingPasswordHash: null },
    })
    if (count === 0) throw await explainLostPendingWrite(tx, target.id, 'rejecting')
    const updated = await loadTarget(tx, target.id)
    await writeAudit(tx, {
      actorType: 'USER',
      userId: args.actorId,
      action: 'user_rejected',
      details: { targetUserId: target.id, email: target.email },
      remarks: target.email,
    })
    return toRow(updated)
  })
}

export async function changeUserRole(
  db: PrismaClient,
  args: { userId: string; role: Role; actorId: string },
): Promise<AdminUserRow> {
  return db.$transaction(async (tx) => {
    const target = await loadTarget(tx, args.userId)
    // Checked before the guard, not after: re-selecting FINANCE_ADMIN for the
    // sole admin changes nothing and must not be refused as a demotion. It also
    // keeps the audit trail honest — a row saying the role changed from
    // FINANCE_ADMIN to FINANCE_ADMIN is noise.
    if (target.role === args.role) return toRow(target)

    if (args.role !== 'FINANCE_ADMIN') await assertNotLastActiveAdmin(tx, target.id, 'DEMOTE')

    const updated = await tx.user.update({
      where: { id: target.id }, data: { role: args.role }, select: ROW_SELECT,
    })
    await writeAudit(tx, {
      actorType: 'USER',
      userId: args.actorId,
      action: 'user_role_changed',
      details: { targetUserId: target.id, email: target.email, from: target.role, to: args.role },
      remarks: `${target.email}: ${target.role} → ${args.role}`,
    })
    return toRow(updated)
  })
}

/**
 * Deactivate or reactivate. **This is what "remove a user" means here** — see
 * the module note. A deactivated row keeps every attribution it carries and is
 * refused at sign-in, which is the whole of what removal needs to accomplish.
 */
export async function setUserActive(
  db: PrismaClient,
  args: { userId: string; active: boolean; actorId: string },
): Promise<AdminUserRow> {
  return db.$transaction(async (tx) => {
    const target = await loadTarget(tx, args.userId)
    if (target.active === args.active) return toRow(target)

    // A pending account is activated by APPROVE, which chooses its role.
    // REACTIVATE would let it in under the schema default without anybody
    // having decided that.
    if (args.active && isPending(target)) {
      throw new DomainError('PENDING', pendingMessage(target.name))
    }

    if (!args.active) await assertNotLastActiveAdmin(tx, target.id, 'DEACTIVATE')

    let updated: SelectedUser
    if (args.active) {
      // The other half of the guard in `registerUser`. The pending check above
      // read the row; a re-registration can commit between that read and this
      // write, and an unconditional update would then activate an account that
      // now carries a stranger's password and no approval. `active = false AND
      // pendingSince IS NULL` is the state the check above saw, so zero rows
      // means the row moved: pending now is refused, active now is a no-op,
      // and anything else (rejected meanwhile - inactive, no flag) is a
      // change the admin must be told about, not an inactive row returned as
      // if it had been activated.
      // `pendingPasswordHash: null` is belt and braces: a row holding a typed
      // password is pending, and pending is refused above.
      const { count } = await tx.user.updateMany({
        where: { id: target.id, active: false, pendingSince: null, pendingPasswordHash: null },
        data: { active: true },
      })
      if (count === 0) {
        const current = await loadTarget(tx, target.id)
        if (isPending(current)) {
          throw new DomainError('PENDING', pendingMessage(current.name))
        }
        if (current.active) return toRow(current)
        throw new DomainError(
          'CHANGED',
          `${current.name}'s account changed while you were looking at it. Reload and try again.`,
        )
      }
      updated = await loadTarget(tx, target.id)
    } else {
      updated = await tx.user.update({
        where: { id: target.id }, data: { active: false }, select: ROW_SELECT,
      })
    }
    // Two distinct actions rather than one carrying a boolean: every audit
    // query, filter and screen that groups by action then separates a removal
    // from a restoration for free. `voidCheck` splits `voided_after_release`
    // out for the same reason.
    await writeAudit(tx, {
      actorType: 'USER',
      userId: args.actorId,
      action: args.active ? 'user_reactivated' : 'user_deactivated',
      details: { targetUserId: target.id, email: target.email, role: target.role },
      remarks: target.email,
    })
    return toRow(updated)
  })
}

/**
 * Set an existing user's password to one the admin typed.
 *
 * No last-admin guard: setting a password neither deactivates nor demotes
 * anybody, and a sole admin must always be able to change their own.
 *
 * A re-registered account may hold a typed password aside
 * (`pendingPasswordHash`) for APPROVE to apply. The admin's password
 * supersedes it, so it is discarded here; otherwise a later APPROVE would
 * silently replace the one the admin just set. `pendingName` and
 * `pendingSince` are left alone: the registration is still pending, only its
 * password has been overtaken.
 */
export async function setUserPassword(
  db: PrismaClient,
  args: { userId: string; password: string; actorId: string },
): Promise<AdminUserRow> {
  requirePassword(args.password)
  const passwordHash = await hashPassword(args.password)

  return db.$transaction(async (tx) => {
    const target = await loadTarget(tx, args.userId)
    const updated = await tx.user.update({
      where: { id: target.id }, data: { passwordHash, pendingPasswordHash: null }, select: ROW_SELECT,
    })
    await writeAudit(tx, {
      actorType: 'USER',
      userId: args.actorId,
      action: 'user_password_set',
      // The target and the fact, and nothing else. Neither the plaintext nor
      // the hash goes in here: the audit trail is readable by every admin and
      // is append-only, so anything written to it is written permanently.
      details: {
        targetUserId: target.id, email: target.email,
        ...(target.pendingPasswordHash !== null ? { heldPasswordDiscarded: true } : {}),
      },
      remarks: target.email,
    })
    return toRow(updated)
  })
}
