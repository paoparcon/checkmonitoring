// tests/actions/inventory-note-action.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'

const currentUser = { id: '', email: 'f@rcl.test', name: 'Finance User', role: 'FINANCE_USER' as const }

vi.mock('@/lib/auth', () => ({ requireUser: async () => currentUser, requireAdmin: async () => currentUser }))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})
const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }))

beforeEach(async () => {
  await resetDb()
  const u = await makeUser()
  currentUser.id = u.id
  revalidatePath.mockClear()
})

function fd(entries: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}
async function book() {
  const c = await makeCheck({ checkNumber: '100' })
  const acc = await testDb.cashAccount.findUniqueOrThrow({ where: { id: c.cashAccountId! } })
  const b = await testDb.checkBook.create({ data: { code: 'BPI-S-TEST', bankId: acc.bankId, companyId: c.companyId } })
  await testDb.check.update({ where: { id: c.id }, data: { checkBookId: b.id } })
  return b
}

describe('recordInventoryNoteAction (spec §H)', () => {
  it('records a tick and remark as any Finance user and answers with who and when, revalidating /numbering', async () => {
    const { recordInventoryNoteAction } = await import('@/app/numbering/actions')
    const b = await book()
    const r = await recordInventoryNoteAction(fd({ checkBookId: b.id, checkNumber: '102', ticked: '1', remarks: ' unused, in vault ' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.note).toMatchObject({ ticked: true, remarks: 'unused, in vault', updatedBy: 'Finance User' })
    expect(new Date(r.note.updatedAt).getTime()).toBeGreaterThan(0)
    expect(revalidatePath).toHaveBeenCalledWith('/numbering')
    expect(await testDb.checkInventoryNote.count({ where: { checkBookId: b.id, checkNumber: '102', ticked: true } })).toBe(1)
  })

  it('passes a run end through, and an unticked save with empty remarks records exactly that', async () => {
    const { recordInventoryNoteAction } = await import('@/app/numbering/actions')
    const b = await book()
    const r = await recordInventoryNoteAction(fd({ checkBookId: b.id, checkNumber: '200', runTo: '500', ticked: '0', remarks: '' }))
    expect(r).toMatchObject({ ok: true, note: { ticked: false, remarks: null } })
    expect(await testDb.checkInventoryNote.findFirst({ where: { checkBookId: b.id } })).toMatchObject({ checkNumber: '200', runTo: '500', ticked: false, remarks: null })
  })

  it('returns the domain refusal, in its own words, for a number a check holds', async () => {
    const { recordInventoryNoteAction } = await import('@/app/numbering/actions')
    const b = await book()
    const r = await recordInventoryNoteAction(fd({ checkBookId: b.id, checkNumber: '100', ticked: '1', remarks: '' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('Check 100 is on record in BPI-S-TEST')
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
