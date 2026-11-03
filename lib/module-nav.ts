/**
 * THE MODULES, and which one a path belongs to.
 *
 * Nine peers: the cheque dashboard and the four reports built in September
 * 2026, plus administration. Client request 2026-09-12: "I want this all to
 * have their own module like CHECK RELEASE." Pure: the bar reads this and
 * decides nothing itself. It highlights; it never gates — every page keeps
 * its own `requireUser()` / `requireAdmin()`. NUMBERING (2026-10-01) checks
 * cheque consecutives per cash account.
 * AGING (2026-10-15) lists SIGNED checks in the
 * Supplier Portal's aging buckets for the next release run.
 */
export type ModuleId = 'CHECK_RELEASE' | 'AGING' | 'VOUCHERS' | 'FORECAST' | 'CLEARING' | 'RECON' | 'NUMBERING' | 'TRANSMITTAL' | 'ADMINISTRATION'
export type Module = {
  id: ModuleId
  label: string
  href: string
  /** The path prefixes that light this module. Whole segments; longest wins. */
  prefixes: readonly string[]
  adminOnly: boolean
}

export const MODULES: readonly Module[] = [
  { id: 'CHECK_RELEASE', label: 'CHECK RELEASE', href: '/', prefixes: ['/', '/checks', '/receipts'], adminOnly: false },
  { id: 'AGING', label: 'AGING', href: '/aging', prefixes: ['/aging'], adminOnly: false },
  { id: 'VOUCHERS', label: 'VOUCHERS', href: '/vouchers', prefixes: ['/vouchers'], adminOnly: false },
  { id: 'FORECAST', label: 'FORECAST', href: '/forecast', prefixes: ['/forecast'], adminOnly: false },
  { id: 'CLEARING', label: 'CLEARING', href: '/clearing', prefixes: ['/clearing'], adminOnly: false },
  { id: 'RECON', label: 'RECON', href: '/recon', prefixes: ['/recon'], adminOnly: false },
  { id: 'NUMBERING', label: 'NUMBERING', href: '/numbering', prefixes: ['/numbering'], adminOnly: false },
  { id: 'TRANSMITTAL', label: 'TRANSMITTAL', href: '/transmittal', prefixes: ['/transmittal'], adminOnly: false },
  { id: 'ADMINISTRATION', label: 'ADMINISTRATION', href: '/admin/sync', prefixes: ['/admin'], adminOnly: true },
]

/** True when `pathname` is `prefix` or lies under it as a whole segment. */
function under(pathname: string, prefix: string): boolean {
  if (prefix === '/') return pathname === '/'
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** The module a path belongs to. Longest matching prefix wins; CHECK RELEASE is the fallback. */
export function activeModule(pathname: string): ModuleId {
  let best: { id: ModuleId; length: number } | null = null
  for (const m of MODULES) {
    for (const p of m.prefixes) {
      if (under(pathname, p) && (best === null || p.length > best.length)) best = { id: m.id, length: p.length }
    }
  }
  return best?.id ?? 'CHECK_RELEASE'
}

export function modulesFor(role: 'FINANCE_USER' | 'FINANCE_ADMIN'): readonly Module[] {
  return role === 'FINANCE_ADMIN' ? MODULES : MODULES.filter((m) => !m.adminOnly)
}
