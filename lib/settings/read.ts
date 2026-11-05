import type { Prisma, PrismaClient } from '@prisma/client'
import { SETTINGS, DEFAULTS, parseStoredText, type SettingKey, type SettingsValues } from './registry'

type Db = PrismaClient | Prisma.TransactionClient

export type LoadedSettings = {
  values: SettingsValues
  /** Keys with a stored row in force. */
  overridden: Set<SettingKey>
  /** Keys with a stored row that no longer parses; the default is in force and the screen says so. */
  outOfBounds: Set<SettingKey>
}

/**
 * Every setting in force, in one query. Called once per request by whatever
 * needs a value — a page, a route, an action, the sign-in — and never cached
 * across requests: a serverless instance that cached a setting would keep it
 * until it died, and "I changed it and nothing happened" is the failure the
 * screen exists to remove.
 */
export async function loadSettings(db: Db): Promise<LoadedSettings> {
  const rows = await db.setting.findMany()
  const stored = new Map(rows.map((r) => [r.key, r.value]))
  const values = { ...DEFAULTS } as Record<string, number | readonly string[] | string>
  const overridden = new Set<SettingKey>()
  const outOfBounds = new Set<SettingKey>()
  for (const def of SETTINGS) {
    const text = stored.get(def.key)
    if (text === undefined) continue
    const parsed = parseStoredText(def, text)
    if (parsed.ok) { values[def.key] = parsed.value; overridden.add(def.key) }
    else outOfBounds.add(def.key)
  }
  return { values: values as SettingsValues, overridden, outOfBounds }
}

/** How many cheques and planned lines carry each category, for the screen. */
export async function categoryUsage(db: Db): Promise<Map<string, { cheques: number; lines: number }>> {
  const [cheques, lines] = await Promise.all([
    db.check.groupBy({ by: ['category'], where: { category: { not: null } }, _count: { _all: true } }),
    db.plannedOutflow.groupBy({ by: ['category'], where: { category: { not: null } }, _count: { _all: true } }),
  ])
  const usage = new Map<string, { cheques: number; lines: number }>()
  for (const c of cheques) if (c.category) usage.set(c.category, { cheques: c._count._all, lines: 0 })
  for (const l of lines) {
    if (!l.category) continue
    const prior = usage.get(l.category) ?? { cheques: 0, lines: 0 }
    usage.set(l.category, { ...prior, lines: l._count._all })
  }
  return usage
}
