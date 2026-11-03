import { describe, it, expect, beforeEach, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'

// A mutable session, so one file can exercise both roles. Both admin actions
// must refuse a FINANCE_USER by RETURNING a result, never by redirecting:
// `requireAdmin` redirects, and a redirect thrown inside an action is caught by
// its own error handling and reported as "something went wrong".
const currentUser: { id: string; email: string; name: string; role: 'FINANCE_USER' | 'FINANCE_ADMIN' } = {
  id: '', email: 'admin@rcl.test', name: 'Finance Admin', role: 'FINANCE_ADMIN',
}

vi.mock('@/lib/auth', () => ({
  requireUser: async () => currentUser,
  requireAdmin: async () => currentUser,
}))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

// The feed is injected rather than reached: no admin test may depend on the
// network, and the credentials this module reads must never be needed to run
// the suite.
const feed: { rows: unknown[]; fail: Error | null } = { rows: [], fail: null }
vi.mock('@/lib/integrations/acumatica/from-env', () => ({
  createClientForTenant: () => ({
    fetchPage: async () => [],
    fetchAll: async () => {
      if (feed.fail) throw feed.fail
      return feed.rows
    },
  }),
}))

beforeEach(async () => {
  await resetDb()
  feed.rows = []
  feed.fail = null
  currentUser.role = 'FINANCE_ADMIN'

  const user = await testDb.user.create({
    data: { email: `a${Math.random().toString(36).slice(2)}@rcl.test`, name: 'Finance Admin', passwordHash: 'x', role: 'FINANCE_ADMIN' },
  })
  currentUser.id = user.id

  const company = await testDb.company.create({
    data: { code: 'STK', name: 'Starkson Packaging Inc.', legalNames: ['STARKSON PACKAGING INC.'] },
  })
  const bank = await testDb.bank.create({ data: { code: 'BPI', name: 'BPI' } })
  await testDb.cashAccount.create({ data: { code: 'BPI STK', bankId: bank.id, companyId: company.id } })
  await testDb.checkBook.create({ data: { code: 'BPI-S-4636', bankId: bank.id, companyId: company.id } })
})

const fd = (entries: Record<string, string | File>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

async function xlsx(sheets: Record<string, unknown[][]>): Promise<File> {
  const wb = new ExcelJS.Workbook()
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = wb.addWorksheet(name)
    for (const r of rows) sheet.addRow(r)
  }
  const buffer = await wb.xlsx.writeBuffer()
  return new File([buffer], 'workbook.xlsx')
}

// Column positions that matter to the register parser: E (index 4) is the
// payee and J (index 9) is the amount, both read positionally.
const HEADER = ['CHECK NO.', '', '', '', 'PAYEE', '', '', '', '', 'AMOUNT', '', 'CHECK BOOK']
const registerRow = (
  checkNumber: string, payee: string, amount: number, checkBook: string | null,
) => [checkNumber, '', '', '', payee, '', '', '', '', amount, '', checkBook]

// The approval-for-release workbook's own header, which is what identifies a
// bill sheet — its NAME does not, and the 7 September export renamed every one
// of them.
const BILL_HEADER = [
  'Date', 'Post Period', 'Reference Nbr.', 'Vendor Ref.', 'Vendor Name', 'Balance Amount',
  'Description', 'Due Date', 'Type', 'Detail Total', 'Terms Code', 'Created By', 'NO. OF DAYS',
  '1-30 days Over due', '31-60 days Over due', '61-90days Over due', 'OVER 90 DAYS', 'GL Account',
  'FINANCE REMARKS', 'Payment Ref. #', 'check No. ', 'bank',
]

const billCells = (apvNumber: string, checkNumber: number): unknown[] => {
  const cells: unknown[] = new Array(22).fill(null)
  cells[2] = apvNumber
  cells[6] = 'FREIGHT'
  cells[9] = 1234.56
  cells[18] = 'AVAILABLE'
  cells[20] = checkNumber
  cells[21] = 'BPI STK'
  return cells
}

const registerFile = () =>
  xlsx({
    'BPI RELEASED': [
      HEADER,
      registerRow('6000000001', 'HENKEL PHILIPPINES INC.', 100.5, 'BPI-S-4636'),
      // No checkbook and no cash account: nothing says which company's cheque
      // this is, so it stages rather than importing.
      registerRow('6000000002', 'GDSM MARKETING', 200, null),
      // No cheque number at all: cannot be keyed.
      ['', '', '', '', 'AJZ PAINT CENTER', '', '', '', '', 300, '', null],
    ],
  })

describe('syncNowAction', () => {
  it('runs for a Finance user, not only an admin (2026-10-15)', async () => {
    const { syncNowAction } = await import('@/app/admin/actions')
    currentUser.role = 'FINANCE_USER'
    const result = await syncNowAction(fd({ tenant: 'GOLIVE' }))
    expect(result.ok).toBe(true)
    expect(await testDb.syncRun.count({ where: { tenant: 'GOLIVE', trigger: 'MANUAL' } })).toBe(1)
  })

  it('refuses a tenant it does not recognise', async () => {
    const { syncNowAction } = await import('@/app/admin/actions')
    // The two tenants reuse branch codes for different companies. A run that
    // guessed would file cheques under the wrong legal entity.
    const result = await syncNowAction(fd({ tenant: 'PRODUCTION' }))
    expect(result.ok).toBe(false)
    expect(await testDb.syncRun.count()).toBe(0)
  })

  it('records the run against the tenant it read', async () => {
    const { syncNowAction } = await import('@/app/admin/actions')
    const result = await syncNowAction(fd({ tenant: 'MANUFACTURING' }))
    expect(result.ok).toBe(true)
    const run = await testDb.syncRun.findFirstOrThrow()
    expect(run.tenant).toBe('MANUFACTURING')
  })

  it('reports a failed feed without putting its text in front of the user', async () => {
    const { syncNowAction } = await import('@/app/admin/actions')
    feed.fail = new Error('OData request to https://erp.example/odata?token=SECRET failed')
    const result = await syncNowAction(fd({ tenant: 'GOLIVE' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).not.toMatch(/SECRET/)
    // The run itself is still recorded, with its error count, so the failure is
    // not invisible.
    const run = await testDb.syncRun.findFirstOrThrow()
    expect(run.errors).toBe(1)
  })
})

describe('importWorkbookAction', () => {
  it('refuses a Finance user with a result rather than a redirect', async () => {
    const { importWorkbookAction } = await import('@/app/admin/actions')
    currentUser.role = 'FINANCE_USER'
    const result = await importWorkbookAction(fd({ workbook: await registerFile() }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/Finance Admin/)
  })

  it('asks for a file rather than throwing when none was chosen', async () => {
    const { importWorkbookAction } = await import('@/app/admin/actions')
    const result = await importWorkbookAction(fd({}))
    expect(result.ok).toBe(false)
  })

  it('previews the register and writes absolutely nothing', async () => {
    const { importWorkbookAction } = await import('@/app/admin/actions')
    const result = await importWorkbookAction(fd({ workbook: await registerFile() }))
    expect(result.ok).toBe(true)
    if (!result.ok || result.kind !== 'REGISTER') throw new Error('expected a register preview')
    expect(result.stage).toBe('PREVIEW')
    expect(await testDb.check.count()).toBe(0)
    expect(await testDb.stagedCheck.count()).toBe(0)
  })

  it('shows what will not be imported next to what will', async () => {
    const { importWorkbookAction } = await import('@/app/admin/actions')
    const result = await importWorkbookAction(fd({ workbook: await registerFile() }))
    if (!result.ok || result.kind !== 'REGISTER') throw new Error('expected a register preview')
    expect(result.preview.totalRows).toBe(3)
    expect(result.preview.willImport).toBe(1)
    expect(result.preview.willStage).toBe(2)
    expect(result.preview.stagedByReason).toEqual({
      NO_COMPANY: 1, NO_CHECK_NUMBER: 1, AMBIGUOUS_COMPANY: 0, SHARED_NUMBER: 0,
    })
    // Openable: each staged row is carried, not just counted.
    expect(result.preview.stagedRows.map((r) => r.reason).sort()).toEqual(['NO_CHECK_NUMBER', 'NO_COMPANY'])
  })

  it('imports only once the merge list and the accounting have been confirmed', async () => {
    const { importWorkbookAction } = await import('@/app/admin/actions')
    const file = await registerFile()
    const result = await importWorkbookAction(fd({ workbook: file, confirm: 'true' }))
    expect(result.ok).toBe(true)
    if (!result.ok || result.kind !== 'REGISTER' || result.stage !== 'IMPORTED') {
      throw new Error('expected a completed register import')
    }
    expect(result.summary).toMatchObject({ rows: 3, created: 1, updated: 0, staged: 2 })
    expect(await testDb.check.count()).toBe(1)
    // Both unwritable rows are held, not dropped.
    expect(await testDb.stagedCheck.count()).toBe(2)
  })

  it('creates nothing new when the same workbook is imported again', async () => {
    const { importWorkbookAction } = await import('@/app/admin/actions')
    await importWorkbookAction(fd({ workbook: await registerFile(), confirm: 'true' }))
    const second = await importWorkbookAction(fd({ workbook: await registerFile(), confirm: 'true' }))
    if (!second.ok || second.kind !== 'REGISTER' || second.stage !== 'IMPORTED') {
      throw new Error('expected a completed register import')
    }
    expect(second.summary).toMatchObject({ created: 0, updated: 1, staged: 2 })
    expect(await testDb.check.count()).toBe(1)
    expect(await testDb.stagedCheck.count()).toBe(2)
  })

  it('recognises the approval-for-release workbook without being told', async () => {
    // Sheet names deliberately from the 7 September export — `Sheet3`,
    // `local supplier`, `BROKERAGE`, none of them the `LIST` the importer used
    // to require. The file is recognised by the Acumatica header instead, and a
    // sheet without one is skipped rather than read as bills.
    const { importWorkbookAction } = await import('@/app/admin/actions')
    const file = await xlsx({
      Sheet3: [[], ['BPI STK', 39, 1234567.89]],
      'local supplier': [BILL_HEADER, billCells('AP-ST040284', 6000000001)],
      BROKERAGE: [BILL_HEADER, billCells('AP-ST043131', 6000000002)],
    })

    const result = await importWorkbookAction(fd({ workbook: file }))
    expect(result.ok).toBe(true)
    if (!result.ok || result.kind !== 'BILLS') throw new Error('expected a bill preview')
    expect(result.preview.bills).toBe(2)
    // Said out loud on the way in: which sheets were read, and which was not.
    expect(result.preview.sheets).toEqual([
      { sheet: 'Sheet3', rows: 1, read: false, bills: 0, review: 0 },
      { sheet: 'local supplier', rows: 1, read: true, bills: 1, review: 0 },
      { sheet: 'BROKERAGE', rows: 1, read: true, bills: 1, review: 0 },
    ])
    // No cheque exists yet, so the bills go to review rather than being dropped.
    expect(result.preview.unmatched).toHaveLength(2)
  })

  it('refuses the whole workbook when one check carries a clash nobody has ruled on', async () => {
    const { importWorkbookAction } = await import('@/app/admin/actions')
    // RELEASED + FT_MC is not in the 2026-09-03 ruling table.
    // `resolveImpliedStatus` throws on it by design; the preview catches that so
    // the operator still sees the accounting, and the import refuses outright
    // rather than writing nine thousand rows and stopping on the next one.
    const file = await xlsx({
      'BPI RELEASED': [HEADER, registerRow('6000000001', 'HENKEL PHILIPPINES INC.', 100.5, 'BPI-S-4636')],
      'FT & MC': [HEADER, registerRow('6000000001', 'HENKEL PHILIPPINES INC.', 100.5, 'BPI-S-4636')],
    })
    const result = await importWorkbookAction(fd({ workbook: file, confirm: 'true' }))
    expect(result.ok).toBe(false)
    expect(await testDb.check.count()).toBe(0)
  })

  it('refuses a file that is neither workbook rather than parsing it as one', async () => {
    const { importWorkbookAction } = await import('@/app/admin/actions')
    const file = await xlsx({ Sheet1: [['a'], ['b']] })
    const result = await importWorkbookAction(fd({ workbook: file }))
    expect(result.ok).toBe(false)
  })
})

describe('uploadReadyListAction', () => {
  const readyList = (rows: unknown[][], name = 'ready.xlsx') =>
    xlsx({ READY: [['CHECK NUMBER', 'PAYEE', 'AP BILL'], ...rows] }).then((f) => new File([f], name))

  it('refuses a Finance user with a result rather than a redirect', async () => {
    const { uploadReadyListAction } = await import('@/app/admin/actions')
    currentUser.role = 'FINANCE_USER'
    const result = await uploadReadyListAction(fd({ list: await readyList([]), availablePickupDate: '2026-10-30' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/Finance Admin/)
  })

  it('asks for the file and the pickup date before reading anything', async () => {
    const { uploadReadyListAction } = await import('@/app/admin/actions')
    expect(await uploadReadyListAction(fd({ availablePickupDate: '2026-10-30' }))).toMatchObject({ ok: false, message: /Choose the list/ })
    expect(await uploadReadyListAction(fd({ list: await readyList([]) }))).toMatchObject({ ok: false, message: /pickup date/ })
    expect(await uploadReadyListAction(fd({ list: await readyList([]), availablePickupDate: '2026-02-30' }))).toMatchObject({ ok: false, message: /pickup date/ })
  })

  it('refuses a file with no sheet carrying an AP BILL column, naming each sheet', async () => {
    const { uploadReadyListAction } = await import('@/app/admin/actions')
    const file = await xlsx({ PIVOT: [['Row Labels', 'Sum'], ['BPI', 1]], NUMBERS: [['CHECK NUMBER'], ['6000400001']] })
    const result = await uploadReadyListAction(fd({ list: file, availablePickupDate: '2026-10-30' }))
    expect(result).toMatchObject({ ok: false, message: /PIVOT — no AP BILL header.*NUMBERS — has a CHECK NUMBER column but no AP BILL column/ })
  })

  it("previews Acumatica's AP bill export (Reference Nbr., no check column) keyed on the bill", async () => {
    const { uploadReadyListAction } = await import('@/app/admin/actions')
    const check = await makeCheck({ status: 'SIGNED', checkNumber: '6000400001', apvNumbers: ['AP-A1033419'] })
    const file = await xlsx({ LIST: [
      ['Date', 'Post Period', 'Reference Nbr.', 'Vendor Ref', 'Vendor Name', 'Balance Amount'],
      ['5/22/26', '05-2026', 'AP-A1033419', 'PO-A1-025543', 'GDSM MARKETING', 22300],
      ['6/18/26', '06-2026', 'AP-ST041760', 'PO-ST-028732', 'Siegwerk', 44700],
    ] })
    const result = await uploadReadyListAction(fd({ list: new File([file], 'bills.xlsx'), availablePickupDate: '2026-10-30' }))
    if (!result.ok || result.stage !== 'PREVIEW') throw new Error('expected a preview')
    expect(result.plan.sheets).toEqual([{ sheet: 'LIST', read: true, rows: 2, keyedBy: 'BILL' }])
    expect(result.plan.toReady.map((t) => t.check.id)).toEqual([check.id])
    expect(result.plan.leftAlone.map((l) => l.kind)).toEqual(['NO_CHECK'])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).status).toBe('SIGNED')
  })

  it('previews without writing, then marks ready on confirm with the pickup date and a portal event', async () => {
    const { uploadReadyListAction } = await import('@/app/admin/actions')
    const check = await makeCheck({ status: 'SIGNED', checkNumber: '6000400001', apvNumbers: ['AP-ST000001'] })
    const rows = [['6000400001', 'SUPPLIER', 'AP-ST000001'], ['6000400001', 'SUPPLIER', 'AP-ST000002']]

    const preview = await uploadReadyListAction(fd({ list: await readyList(rows), availablePickupDate: '2026-10-30' }))
    if (!preview.ok || preview.stage !== 'PREVIEW') throw new Error('expected a preview')
    expect(preview.plan.toReady.map((t) => t.check.id)).toEqual([check.id])
    expect(preview.plan.leftAlone.map((l) => l.kind)).toEqual(['BILL_NOT_ON_CHECK'])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).status).toBe('SIGNED')
    expect(await testDb.portalEvent.count()).toBe(0)

    const applied = await uploadReadyListAction(fd({ list: await readyList(rows), availablePickupDate: '2026-10-30', confirm: 'true' }))
    if (!applied.ok || applied.stage !== 'APPLIED') throw new Error('expected an applied upload')
    expect(applied.summary).toEqual({ readied: 1, signed: 0, failed: [], notReached: 0 })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after).toMatchObject({
      status: 'READY_FOR_RELEASE', readyById: currentUser.id, availablePickupDate: new Date('2026-10-30T00:00:00.000Z'),
    })
    expect(await testDb.portalEvent.findMany()).toMatchObject([{ checkId: check.id, kind: 'MARK_AVAILABLE', status: 'PENDING' }])
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'ready_for_release' } })
    expect(audit.details).toMatchObject({ source: { file: 'ready.xlsx' } })
  })
})
