import type { Prisma, PrismaClient } from '@prisma/client'
import type { Notice } from './messages'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * The one writer. Resolves the audience to the users active NOW (a
 * deactivated or PENDING account receives nothing), drops the actor, and
 * writes one row each. `skipDuplicates` makes a repeated dedupeKey a no-op.
 * Returns the rows written.
 */
export async function notify(db: Db, notice: Notice, opts: { excludeUserId?: string } = {}): Promise<number> {
  const users = await db.user.findMany({
    where: {
      active: true,
      ...(notice.audience === 'ADMINS' ? { role: 'FINANCE_ADMIN' as const } : {}),
      ...(opts.excludeUserId ? { id: { not: opts.excludeUserId } } : {}),
    },
    select: { id: true },
  })
  if (users.length === 0) return 0
  const r = await db.notification.createMany({
    data: users.map((u) => ({
      userId: u.id,
      kind: notice.kind,
      message: notice.message,
      link: notice.link,
      dedupeKey: notice.dedupeKey ?? null,
      checkId: notice.checkId ?? null,
    })),
    skipDuplicates: true,
  })
  return r.count
}

/**
 * For callers whose own work has already committed: a notification that
 * cannot be written is logged and dropped, never turned into a failure of a
 * release, a ready action or a cron run. Each notice is tried on its own.
 */
export async function safeNotify(
  db: Db, notices: Notice | readonly Notice[] | null, opts: { excludeUserId?: string } = {},
): Promise<void> {
  if (notices === null) return
  const list: readonly Notice[] = Array.isArray(notices) ? notices : [notices as Notice]
  for (const n of list) {
    try {
      await notify(db, n, opts)
    } catch (e) {
      console.error(`notification ${n.kind} could not be written:`, e instanceof Error ? e.message : e)
    }
  }
}
