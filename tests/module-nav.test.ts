import { describe, it, expect } from 'vitest'
import { MODULES, activeModule, modulesFor } from '@/lib/module-nav'

describe('MODULES', () => {
  it('lists the nine in bar order, ADMINISTRATION last and admin-only', () => {
    expect(MODULES.map((m) => m.id)).toEqual(['CHECK_RELEASE', 'AGING', 'VOUCHERS', 'FORECAST', 'CLEARING', 'RECON', 'NUMBERING', 'TRANSMITTAL', 'ADMINISTRATION'])
    expect(MODULES.map((m) => m.adminOnly)).toEqual([false, false, false, false, false, false, false, false, true])
    expect(MODULES.find((m) => m.id === 'ADMINISTRATION')!.href).toBe('/admin/sync')
    expect(MODULES.find((m) => m.id === 'CHECK_RELEASE')!.label).toBe('CHECK RELEASE')
    expect(MODULES.find((m) => m.id === 'NUMBERING')!.href).toBe('/numbering')
    expect(MODULES.find((m) => m.id === 'AGING')!.href).toBe('/aging')
  })
})

describe('activeModule', () => {
  it('lights each module on its own path and on a sub-path', () => {
    expect(activeModule('/')).toBe('CHECK_RELEASE')
    expect(activeModule('/checks/abc')).toBe('CHECK_RELEASE')
    expect(activeModule('/receipts/abc')).toBe('CHECK_RELEASE')
    expect(activeModule('/aging')).toBe('AGING')
    expect(activeModule('/vouchers')).toBe('VOUCHERS')
    expect(activeModule('/forecast')).toBe('FORECAST')
    expect(activeModule('/forecast/planned')).toBe('FORECAST')
    expect(activeModule('/clearing')).toBe('CLEARING')
    expect(activeModule('/recon')).toBe('RECON')
    expect(activeModule('/numbering')).toBe('NUMBERING')
    expect(activeModule('/transmittal')).toBe('TRANSMITTAL')
    expect(activeModule('/admin/sync')).toBe('ADMINISTRATION')
    expect(activeModule('/admin/settings')).toBe('ADMINISTRATION')
  })

  it('falls back to CHECK RELEASE for a path no module claims', () => {
    expect(activeModule('/something-new')).toBe('CHECK_RELEASE')
  })

  it('matches whole segments only', () => {
    expect(activeModule('/reconciliation')).toBe('CHECK_RELEASE')
    expect(activeModule('/forecasting')).toBe('CHECK_RELEASE')
    expect(activeModule('/numberings')).toBe('CHECK_RELEASE')
  })
})

describe('modulesFor', () => {
  it('hides ADMINISTRATION from a Finance user and shows it to an admin', () => {
    expect(modulesFor('FINANCE_USER').map((m) => m.id)).not.toContain('ADMINISTRATION')
    expect(modulesFor('FINANCE_ADMIN').map((m) => m.id)).toContain('ADMINISTRATION')
    expect(modulesFor('FINANCE_USER')).toHaveLength(8)
  })
})
