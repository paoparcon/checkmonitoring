import { describe, it, expect, beforeEach, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { SUMMARY_SHEET } from '@/lib/export/aging-workbook'

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string; role: string } | null,
  dbTouches: 0,
}))

vi.mock('@/lib/auth', () => ({ getSessionUser: async () => state.user }))

vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return {
    prisma: new Proxy(testDb, {
      get(target, prop, receiver) {
        state.dbTouches += 1
        return Reflect.get(target, prop, receiver)
      },
    }),
  }
})

const SIGNED_IN = { id: 'u1', email: 'finance@rcl.test', name: 'Paolo Parcon', role: 'FINANCE_USER' }

async function get() {
  const { GET } = await import('@/app/api/export/aging/route')
  return GET(new Request('http://localhost/api/export/aging'))
}

beforeEach(async () => {
  await resetDb()
  state.user = null
  state.dbTouches = 0
})

describe('GET /api/export/aging', () => {
  it('answers 401 and touches no data when nobody is signed in', async () => {
    const res = await get()
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
  })

  it('returns the workbook of SIGNED checks', async () => {
    state.user = SIGNED_IN
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000001' })
    await makeCheck({ status: 'RELEASED', checkNumber: '6000000002' })
    await makeCheck({ status: 'READY_FOR_RELEASE', checkNumber: '6000000003' })
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="AGING \d{4}-\d{2}-\d{2}\.xlsx"$/)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer())
    expect(wb.getWorksheet(SUMMARY_SHEET)).toBeDefined()
    const sheet = wb.getWorksheet('NO DUE DATE')!
    expect(sheet.rowCount).toBe(4) // header, the SIGNED and READY FOR RELEASE checks, TOTAL (PHP)
    expect([2, 3].map((n) => sheet.getRow(n).getCell(1).value).sort()).toEqual(['6000000001', '6000000003'])
  })
})
