import { RECON_STATUSES, type ReconStatus } from './period'
import type { DashboardFilters } from './query'

/** The monthly reconciliation screens' parameters and links. Pure. */
export const MONTHLY_PATH = '/recon/monthly'
export const BALANCES_PATH = '/recon/balances'
export const periodPath = (id: string) => `/recon/periods/${id}`
export const periodExportPath = (id: string) => `/api/export/recon-period?id=${encodeURIComponent(id)}`

export type DashboardParams = { account?: string; year?: string; month?: string; status?: string }

/** Unknown values read as "no filter" — never a widened or invalid query. */
export function parseDashboardFilters(p: DashboardParams, accountKeys: readonly string[]): DashboardFilters {
  const year = Number(p.year)
  const month = Number(p.month)
  return {
    accountKey: p.account && accountKeys.includes(p.account) ? p.account : undefined,
    year: Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : undefined,
    month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : undefined,
    status: (RECON_STATUSES as readonly string[]).includes(p.status ?? '') ? (p.status as ReconStatus) : undefined,
  }
}

export const STATUS_TONE: Record<ReconStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700',
  FOR_REVIEW: 'bg-amber-100 text-amber-900',
  FOR_APPROVAL: 'bg-orange-100 text-orange-900',
  RECONCILED: 'bg-emerald-100 text-emerald-900',
  CLOSED: 'bg-navy-bg text-navy',
}
