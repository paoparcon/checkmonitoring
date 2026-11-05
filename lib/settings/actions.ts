import type { PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { DomainError } from '@/lib/domain/errors'
import { settingDef, parseSettingText, formatSettingText } from './registry'

/**
 * The two writes. FINANCE_ADMIN only — checked here as well as in the server
 * action, because the action is an HTTP endpoint and this function is what
 * every caller reaches. One transaction: the row and its audit row together.
 * `from` and `to` are the STORED text (an int's digits, the list as JSON), so
 * the trail reads exactly what the table held.
 */
type Role = 'FINANCE_USER' | 'FINANCE_ADMIN'

function assertAdmin(role: Role): void {
  if (role !== 'FINANCE_ADMIN') throw new DomainError('ADMIN_ONLY', 'Only a Finance Admin can change settings.')
}

export async function updateSetting(
  db: PrismaClient, args: { key: string; text: string; actorRole: Role; userId: string },
): Promise<void> {
  assertAdmin(args.actorRole)
  const def = settingDef(args.key)
  if (!def) throw new DomainError('UNKNOWN_SETTING', 'That is not a setting.')
  const parsed = parseSettingText(def, args.text)
  if (!parsed.ok) throw new DomainError('INVALID_SETTING', parsed.message)
  const to = formatSettingText(def, parsed.value)
  await db.$transaction(async (tx) => {
    // A user setting must name an ACTIVE user or nobody: the gate must never
    // queue requests nobody can decide (spec 2026-11-05 §3). Checked inside
    // the transaction, so a deactivation racing this save cannot slip past.
    if (def.kind === 'user' && to !== '') {
      const user = await tx.user.findUnique({ where: { id: to }, select: { active: true } })
      if (!user || !user.active) throw new DomainError('UNKNOWN_USER', `${def.label} must name an active user.`)
    }
    const existing = await tx.setting.findUnique({ where: { key: def.key } })
    const inForce = existing?.value ?? formatSettingText(def, def.default)
    if (inForce === to) return
    await tx.setting.upsert({ where: { key: def.key }, create: { key: def.key, value: to }, update: { value: to } })
    await writeAudit(tx, {
      actorType: 'USER', userId: args.userId, action: 'setting_changed',
      details: { key: def.key, from: existing?.value ?? null, to },
    })
  })
}

export async function resetSetting(
  db: PrismaClient, args: { key: string; actorRole: Role; userId: string },
): Promise<void> {
  assertAdmin(args.actorRole)
  const def = settingDef(args.key)
  if (!def) throw new DomainError('UNKNOWN_SETTING', 'That is not a setting.')
  await db.$transaction(async (tx) => {
    const existing = await tx.setting.findUnique({ where: { key: def.key } })
    if (!existing) return
    await tx.setting.delete({ where: { key: def.key } })
    await writeAudit(tx, {
      actorType: 'USER', userId: args.userId, action: 'setting_reset',
      details: { key: def.key, from: existing.value, to: null },
    })
  })
}
