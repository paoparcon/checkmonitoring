import type { PrismaClient } from '@prisma/client'
import { RETENTION_DAYS } from '@/lib/login-throttle'

/**
 * The self-registration throttle (`/signup`, `RegistrationAttempt`).
 *
 * `/signup` is public by definition, and every submission creates a row an
 * admin then has to look at. This bounds how many one client address can
 * create in an hour. It is the login throttle's shape with one bucket: there
 * is no per-email bucket because an email is the thing being created here,
 * not a thing being guessed.
 *
 * **The counter is in Postgres and must stay there.** Same reason as
 * `lib/login-throttle.ts`: Vercel is serverless, a module-scope Map is
 * per-instance and starts at zero on every cold start. `clientIp` from the
 * login throttle supplies the address, with the same rightmost-entry rule and
 * the same shared `unknown` bucket, which is deliberately NOT exempt.
 *
 * **The count is taken after the insert, in the same transaction, under a
 * per-address advisory lock.** A caller records its own submission first and is
 * told how many rows this address now has in the window, its own included, and
 * refuses when `recent` is greater than the limit. Insert-then-count alone is
 * NOT enough: Prisma's interactive transactions run READ COMMITTED, so N
 * parallel submissions each count only the rows already committed and every one
 * of them can see a count within the limit. `pg_advisory_xact_lock` on the
 * address, taken as the transaction's first statement, makes same-address
 * submissions queue, so each one's count includes every earlier commit and the
 * counts are exactly 1..N. Different addresses hash to different locks and do
 * not wait for each other; the lock is released at commit or rollback. The wait
 * is bounded by `SET LOCAL lock_timeout = '3s'`, so a queued submission fails
 * rather than hold a connection; the caller refuses it (see `app/signup/actions.ts`).
 *
 * The allowance is the setting `signup.ipPerHour`; callers read it through
 * `loadSettings` at request time and pass it in. Nothing here reads a
 * constant as the limit.
 */

export const REGISTRATION_WINDOW_MINUTES = 60

const MINUTE = 60_000

function windowStart(now: Date): Date {
  return new Date(now.getTime() - REGISTRATION_WINDOW_MINUTES * MINUTE)
}

function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * MINUTE)
}

/**
 * Record one submission — accepted, refused by this throttle, or refused by
 * the domain — and say how many this address has in the last hour, the one
 * just written included. Every submission counts, so hammering a refused form
 * extends the wait rather than resetting it. The prune rides in the write path
 * because this project has no cron for it, as `recordLoginAttempt` does.
 */
export async function recordRegistrationAttempt(
  db: PrismaClient,
  args: { ip: string; email: string; now: Date },
): Promise<{ recent: number }> {
  return db.$transaction(async (tx) => {
    // Bound the wait for the lock. A submission queued behind a burst gives up
    // here, with an error the caller turns into a refusal, rather than holding
    // a connection until the transaction deadline (P2028) or starving the pool
    // (P2024). A lock timeout is a refused submission, not an error to swallow.
    await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`
    // Then serialise same-address submissions (see the header).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${args.ip}))`
    await tx.registrationAttempt.create({
      data: { ip: args.ip, email: args.email, createdAt: args.now },
    })
    const recent = await tx.registrationAttempt.count({
      where: { ip: args.ip, createdAt: { gte: windowStart(args.now) } },
    })
    await tx.registrationAttempt.deleteMany({ where: { createdAt: { lt: retentionCutoff(args.now) } } })
    return { recent }
  })
}

/** A one-off clear-out, so nobody invents a raw DELETE against this table. */
export async function pruneRegistrationAttempts(
  db: PrismaClient,
  args: { now: Date },
): Promise<number> {
  const { count } = await db.registrationAttempt.deleteMany({
    where: { createdAt: { lt: retentionCutoff(args.now) } },
  })
  return count
}
