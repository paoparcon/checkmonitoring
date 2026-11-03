'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { markAllRead, markRead } from '@/lib/notifications/queries'
import { safeLink } from '@/lib/notifications/messages'

/**
 * OPEN: marks the row read and goes where it points. A row that is not the
 * session user's is refused as not found (untouched, back to the list), and a
 * stored link that is not an in-app path is never followed.
 */
export async function openNotificationAction(formData: FormData): Promise<void> {
  const user = await requireUser()
  const id = String(formData.get('id') ?? '').trim()
  const found = id ? await markRead(prisma, user.id, id, new Date()) : null
  revalidatePath('/notifications')
  redirect((found && safeLink(found.link)) ?? '/notifications')
}

/** MARK ALL READ: every unread row of the session user. */
export async function markAllReadAction(): Promise<void> {
  const user = await requireUser()
  await markAllRead(prisma, user.id, new Date())
  revalidatePath('/notifications')
  redirect('/notifications')
}
