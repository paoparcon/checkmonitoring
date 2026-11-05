import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'

const currentUser = { id: '', email: 'f@rcl.test', name: 'Finance User', role: 'FINANCE_USER' as const }

vi.mock('@/lib/auth', () => ({ requireUser: async () => currentUser, requireAdmin: async () => currentUser }))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

beforeEach(async () => {
  await resetDb()
  currentUser.id = (await makeUser()).id
})

const STATEMENT = [
  'BPI CHECKS CLEARED, ACCOUNT 0123456789',
  'DATE,CHECK NO,AMOUNT',
  '03-Nov-2026,6000000001,"197,715.42"',
  '04-Nov-2026,6000000002,"197,715.42"',
  '04-Nov-2026,6000000003,"1.00"',
  'no date here,6000000004,"197,715.42"',
  '05-Nov-2026,6000000099,"10.00"',
].join('\n')

const fd = (text: string, extra: Record<string, string> = {}) => {
  const f = new FormData()
  f.append('file', new File([text], 'bpi-cleared.csv', { type: 'text/csv' }))
  for (const [k, v] of Object.entries(extra)) f.append(k, v)
  return f
}

describe('uploadClearingFileAction (2026-11-05)', () => {
  it('previews every check the file names and writes nothing', async () => {
    const { uploadClearingFileAction } = await import('@/app/clearing/actions')
    await makeCheck({ status: 'RELEASED', checkNumber: '6000000001' })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000002' })
    await makeCheck({ status: 'RELEASED', checkNumber: '6000000003' })
    await makeCheck({ status: 'RELEASED', checkNumber: '6000000004' })

    const r = await uploadClearingFileAction(fd(STATEMENT, { clearedDate: '2026-11-06' }))
    if (!r.ok || r.stage !== 'PREVIEW') throw new Error(JSON.stringify(r))
    const by = Object.fromEntries(r.plan.rows.map((row) => [row.checkNumber, row]))
    expect(Object.keys(by).sort()).toEqual(['6000000001', '6000000002', '6000000003', '6000000004'])
    expect(by['6000000001'].verdict).toBe('WILL_CLEAR')
    expect(by['6000000001'].clearedDate?.toISOString().slice(0, 10)).toBe('2026-11-03')
    expect(by['6000000001'].dateFrom).toBe('FILE')
    expect(by['6000000001'].amountSeen).toBe(true)
    expect(by['6000000002'].verdict).toBe('NOT_RELEASED')
    expect(by['6000000003'].amountSeen).toBe(false)
    expect(by['6000000004'].dateFrom).toBe('BATCH')
    expect(by['6000000004'].clearedDate?.toISOString().slice(0, 10)).toBe('2026-11-06')
    expect(r.plan.willClear).toBe(3)
    // The account number and the unknown check are counted, not rows.
    expect(r.plan.unmatchedSample.sort()).toEqual(['0123456789', '6000000099'])
    expect(await testDb.check.count({ where: { clearingStatus: 'CLEARED' } })).toBe(0)
  })

  it('on confirm clears through recordClearing, one audit row naming the file and line each', async () => {
    const { uploadClearingFileAction } = await import('@/app/clearing/actions')
    const one = await makeCheck({ status: 'RELEASED', checkNumber: '6000000001' })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000002' })

    const r = await uploadClearingFileAction(fd(STATEMENT, { confirm: 'true' }))
    if (!r.ok || r.stage !== 'APPLIED') throw new Error(JSON.stringify(r))
    expect(r.summary).toEqual({ cleared: 1, failed: [], notReached: 0 })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: one.id } })
    expect(after.clearingStatus).toBe('CLEARED')
    expect(after.clearedDate?.toISOString().slice(0, 10)).toBe('2026-11-03')
    expect(after.crNumber).toBeNull()
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: one.id, action: 'clearing_recorded' } })
    expect(audit.details).toMatchObject({ source: { file: 'bpi-cleared.csv', place: 'line 3' }, clearedDate: '2026-11-03' })
    expect((await testDb.check.findFirstOrThrow({ where: { checkNumber: '6000000002' } })).clearingStatus).toBe('NONE')

    // The same file again: nothing left to clear, and it says so.
    const again = await uploadClearingFileAction(fd(STATEMENT, { confirm: 'true' }))
    expect(again).toEqual({ ok: false, message: 'Nothing on this file names a released check that is not yet cleared.' })
  })

  it('refuses a file it cannot read, and a batch date that is not a day', async () => {
    const { uploadClearingFileAction } = await import('@/app/clearing/actions')
    const f = new FormData()
    f.append('file', new File(['x'], 'photo.jpg'))
    expect((await uploadClearingFileAction(f)).ok).toBe(false)
    expect(await uploadClearingFileAction(fd(STATEMENT, { clearedDate: '2026-02-31' })))
      .toEqual({ ok: false, message: 'The cleared date is not a real day.' })
  })
})
