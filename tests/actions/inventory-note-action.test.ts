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

type Change = { key: string; checkNumber: string; runTo?: string; ticked: boolean; remarks: string }
function fd(checkBookId: string, changes: Change[] | string) {
  const f = new FormData()
  f.append('checkBookId', checkBookId)
  f.append('changes', typeof changes === 'string' ? changes : JSON.stringify(changes))
  return f
}
async function book() {
  const c = await makeCheck({ checkNumber: '100' })
  const acc = await testDb.cashAccount.findUniqueOrThrow({ where: { id: c.cashAccountId! } })
  const b = await testDb.checkBook.create({ data: { code: 'BPI-S-TEST', bankId: acc.bankId, companyId: c.companyId } })
  await testDb.check.update({ where: { id: c.id }, data: { checkBookId: b.id } })
  return b
}

describe('saveInventoryAction (spec §H, SAVE INVENTORY)', () => {
  it('records every change as any Finance user — a held check, a missing number and a run — answering per row, and revalidates /numbering', async () => {
    const { saveInventoryAction } = await import('@/app/numbering/actions')
    const b = await book()
    const r = await saveInventoryAction(fd(b.id, [
      { key: '100|', checkNumber: '100', ticked: true, remarks: ' in vault ' },
      { key: '102|', checkNumber: '102', ticked: true, remarks: '' },
      { key: '200|500', checkNumber: '200', runTo: '500', ticked: false, remarks: 'booklet unopened' },
    ]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.failed).toEqual([])
    expect(r.unreached).toBe(0)
    expect(r.saved.map((s) => s.key)).toEqual(['100|', '102|', '200|500'])
    expect(r.saved[0].note).toMatchObject({ ticked: true, remarks: 'in vault', updatedBy: 'Finance User' })
    expect(new Date(r.saved[0].note.updatedAt).getTime()).toBeGreaterThan(0)
    expect(r.saved[2].note).toMatchObject({ ticked: false, remarks: 'booklet unopened' })
    expect(revalidatePath).toHaveBeenCalledWith('/numbering')
    expect(await testDb.checkInventoryNote.count({ where: { checkBookId: b.id } })).toBe(3)
    expect(await testDb.checkInventoryNote.findFirst({ where: { checkBookId: b.id, checkNumber: '200' } })).toMatchObject({ runTo: '500', ticked: false })
  })

  it('a refused row fails in the domain\'s own words while the rest are saved', async () => {
    const { saveInventoryAction } = await import('@/app/numbering/actions')
    const b = await book()
    const r = await saveInventoryAction(fd(b.id, [
      { key: '600|599', checkNumber: '600', runTo: '599', ticked: true, remarks: '' },
      { key: '103|', checkNumber: '103', ticked: true, remarks: '' },
    ]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.saved.map((s) => s.key)).toEqual(['103|'])
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].key).toBe('600|599')
    expect(r.failed[0].message).toMatch(/run/i)
    expect(await testDb.checkInventoryNote.count()).toBe(1)
  })

  it('refuses unreadable changes and a missing book outright, writing nothing', async () => {
    const { saveInventoryAction } = await import('@/app/numbering/actions')
    const b = await book()
    const bad = await saveInventoryAction(fd(b.id, 'not json'))
    expect(bad.ok).toBe(false)
    const shape = await saveInventoryAction(fd(b.id, JSON.stringify([{ key: 'x' }])))
    expect(shape.ok).toBe(false)
    const noBook = await saveInventoryAction(fd('', [{ key: '102|', checkNumber: '102', ticked: true, remarks: '' }]))
    expect(noBook.ok).toBe(false)
    expect(await testDb.checkInventoryNote.count()).toBe(0)
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
