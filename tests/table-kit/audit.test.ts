import { describe, it, expect } from 'vitest'
import { bindingParams } from '@/lib/table-kit/url-binding'
import { AUDIT_BINDINGS, auditColumns } from '@/lib/table-kit/audit'

describe('audit columns', () => {
  const cols = auditColumns({ actions: ['released', 'signed'], users: [{ id: 'u1', name: 'Ana' }] })

  it('bind only the parameters the audit page already parses, and nothing sorts', () => {
    const params = Object.values(AUDIT_BINDINGS).flatMap(bindingParams)
    expect(params.sort()).toEqual(['action', 'check', 'from', 'to', 'user'])
    expect(cols.every((c) => c.noSort)).toBe(true)
  })

  it('offers actions in words and users by id; remarks and details do not filter', () => {
    expect(cols.find((c) => c.key === 'action')!.options).toEqual([
      { value: 'released', label: 'RELEASED' }, { value: 'signed', label: 'SIGNED' },
    ])
    expect(cols.find((c) => c.key === 'who')!.options).toEqual([{ value: 'u1', label: 'Ana' }])
    expect(cols.filter((c) => c.noFilter).map((c) => c.key)).toEqual(['remarks', 'details'])
    expect(cols.find((c) => c.key === 'when')!.ops).not.toContain('ne')
  })
})
