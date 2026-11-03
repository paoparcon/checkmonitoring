import type { Notification, Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

/** The page shows at most this many, newest first; it says so when it is full. */
export const NOTIFICATION_PAGE_LIMIT = 200

/** The bell's number: one count on the (userId, readAt, createdAt) index. */
export function countUnread(db: Db, userId: string): Promise<number> {
  return db.notification.count({ where: { userId, readAt: null } })
}

export function listNotifications(db: Db, userId: string, limit = NOTIFICATION_PAGE_LIMIT): Promise<Notification[]> {
  return db.notification.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  })
}

/** Marks one row read, only when it is the user's. Null when it is not (or does not exist). */
export async function markRead(db: Db, userId: string, id: string, now: Date): Promise<{ link: string | null } | null> {
  const row = await db.notification.findFirst({ where: { id, userId }, select: { link: true, readAt: true } })
  if (!row) return null
  if (row.readAt === null) {
    await db.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: now } })
  }
  return { link: row.link }
}

export async function markAllRead(db: Db, userId: string, now: Date): Promise<number> {
  const r = await db.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: now } })
  return r.count
}
