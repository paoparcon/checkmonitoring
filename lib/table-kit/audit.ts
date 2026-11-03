import { actionWords } from '@/lib/audit-view'
import { SERVER_DAY_OPS, type Binding } from './url-binding'
import type { KitColumn } from './types'

/**
 * Audit in kit terms (spec 2026-10-13 §5). The keyset pages newest first only,
 * so no column sorts. The menu writes the page's own parameters.
 */

export const AUDIT_TABLE_ID = 'audit'

export const AUDIT_BINDINGS: Record<string, Binding> = {
  when: { kind: 'range', from: 'from', to: 'to', unit: 'day' },
  who: { kind: 'enum', param: 'user' },
  action: { kind: 'enum', param: 'action' },
  check: { kind: 'text', param: 'check' },
}

export function auditColumns(opts: { actions: readonly string[]; users: readonly { id: string; name: string }[] }): KitColumn[] {
  return [
    { key: 'when', label: 'WHEN', kind: 'date', noSort: true, ops: SERVER_DAY_OPS, locked: true, className: 'whitespace-nowrap tabular-nums text-slate-600' },
    { key: 'who', label: 'WHO', kind: 'enum', noSort: true, options: opts.users.map((u) => ({ value: u.id, label: u.name })), className: 'whitespace-nowrap' },
    { key: 'action', label: 'ACTION', kind: 'enum', noSort: true, options: opts.actions.map((a) => ({ value: a, label: actionWords(a) })), className: 'whitespace-nowrap font-semibold text-navy' },
    { key: 'check', label: 'CHECK', kind: 'text', noSort: true, className: 'whitespace-nowrap' },
    { key: 'remarks', label: 'REMARKS', kind: 'text', noSort: true, noFilter: true, className: 'min-w-[16rem] text-slate-700' },
    { key: 'details', label: 'DETAILS', kind: 'text', noSort: true, noFilter: true, className: 'min-w-[14rem]' },
  ]
}
