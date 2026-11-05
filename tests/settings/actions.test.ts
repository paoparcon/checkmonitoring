import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'
import { updateSetting, resetSetting } from '@/lib/settings/actions'
import { loadSettings } from '@/lib/settings/read'

beforeEach(resetDb)

const audit = (action: string) => testDb.auditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } })

describe('updateSetting', () => {
  it('stores an override with one audit row of from → to', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    await updateSetting(testDb, { key: 'sync.staleAfterHours', text: '48', actorRole: 'FINANCE_ADMIN', userId: admin.id })
    expect((await loadSettings(testDb)).values['sync.staleAfterHours']).toBe(48)
    const rows = await audit('setting_changed')
    expect(rows).toHaveLength(1)
    expect(rows[0].checkId).toBeNull()
    expect(rows[0].userId).toBe(admin.id)
    expect(rows[0].details).toEqual({ key: 'sync.staleAfterHours', from: null, to: '48' })
  })

  it('records the previous stored value on a second change', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    await updateSetting(testDb, { key: 'sync.staleAfterHours', text: '48', actorRole: 'FINANCE_ADMIN', userId: admin.id })
    await updateSetting(testDb, { key: 'sync.staleAfterHours', text: '36', actorRole: 'FINANCE_ADMIN', userId: admin.id })
    const rows = await audit('setting_changed')
    expect(rows[1].details).toEqual({ key: 'sync.staleAfterHours', from: '48', to: '36' })
  })

  it('writes nothing when the value equals what is in force', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    await updateSetting(testDb, { key: 'sync.staleAfterHours', text: '30', actorRole: 'FINANCE_ADMIN', userId: admin.id })
    expect(await testDb.setting.count()).toBe(0)
    expect(await audit('setting_changed')).toHaveLength(0)
  })

  it('refuses a FINANCE_USER, an unknown key and an out-of-bounds value, writing nothing', async () => {
    const user = await makeUser('FINANCE_USER')
    const admin = await makeUser('FINANCE_ADMIN')
    await expect(updateSetting(testDb, { key: 'sync.staleAfterHours', text: '48', actorRole: 'FINANCE_USER', userId: user.id }))
      .rejects.toMatchObject({ code: 'ADMIN_ONLY' })
    await expect(updateSetting(testDb, { key: 'nope', text: '1', actorRole: 'FINANCE_ADMIN', userId: admin.id }))
      .rejects.toMatchObject({ code: 'UNKNOWN_SETTING' })
    await expect(updateSetting(testDb, { key: 'login.emailFreeFailures', text: '1', actorRole: 'FINANCE_ADMIN', userId: admin.id }))
      .rejects.toMatchObject({ code: 'INVALID_SETTING' })
    expect(await testDb.setting.count()).toBe(0)
    expect(await testDb.auditLog.count()).toBe(0)
  })

  it('stores the approver only when the id names an active user, and nobody as the empty string', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    const paolo = await makeUser('FINANCE_USER')
    const gone = await makeUser('FINANCE_USER')
    await testDb.user.update({ where: { id: gone.id }, data: { active: false } })
    await expect(updateSetting(testDb, { key: 'approval.availabilityApprover', text: gone.id, actorRole: 'FINANCE_ADMIN', userId: admin.id }))
      .rejects.toMatchObject({ code: 'UNKNOWN_USER' })
    await expect(updateSetting(testDb, { key: 'approval.availabilityApprover', text: 'nobody-here', actorRole: 'FINANCE_ADMIN', userId: admin.id }))
      .rejects.toMatchObject({ code: 'UNKNOWN_USER' })
    expect(await testDb.setting.count()).toBe(0)
    await updateSetting(testDb, { key: 'approval.availabilityApprover', text: paolo.id, actorRole: 'FINANCE_ADMIN', userId: admin.id })
    expect((await loadSettings(testDb)).values['approval.availabilityApprover']).toBe(paolo.id)
    await updateSetting(testDb, { key: 'approval.availabilityApprover', text: '', actorRole: 'FINANCE_ADMIN', userId: admin.id })
    expect((await testDb.setting.findUniqueOrThrow({ where: { key: 'approval.availabilityApprover' } })).value).toBe('')
    expect((await loadSettings(testDb)).values['approval.availabilityApprover']).toBe('')
    expect(await audit('setting_changed')).toHaveLength(2)
  })

  it('stores the category list as JSON', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    await updateSetting(testDb, { key: 'categories', text: 'payroll\nrent', actorRole: 'FINANCE_ADMIN', userId: admin.id })
    expect((await testDb.setting.findUniqueOrThrow({ where: { key: 'categories' } })).value).toBe('["PAYROLL","RENT"]')
    expect((await loadSettings(testDb)).values.categories).toEqual(['PAYROLL', 'RENT'])
  })
})

describe('resetSetting', () => {
  it('removes the override with an audit row, and is a no-op without one', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    await updateSetting(testDb, { key: 'caps.exportRows', text: '500', actorRole: 'FINANCE_ADMIN', userId: admin.id })
    await resetSetting(testDb, { key: 'caps.exportRows', actorRole: 'FINANCE_ADMIN', userId: admin.id })
    expect(await testDb.setting.count()).toBe(0)
    const rows = await audit('setting_reset')
    expect(rows).toHaveLength(1)
    expect(rows[0].details).toEqual({ key: 'caps.exportRows', from: '500', to: null })
    await resetSetting(testDb, { key: 'caps.exportRows', actorRole: 'FINANCE_ADMIN', userId: admin.id })
    expect(await audit('setting_reset')).toHaveLength(1)
  })

  it('refuses a FINANCE_USER', async () => {
    const user = await makeUser('FINANCE_USER')
    await expect(resetSetting(testDb, { key: 'caps.exportRows', actorRole: 'FINANCE_USER', userId: user.id }))
      .rejects.toMatchObject({ code: 'ADMIN_ONLY' })
  })
})
