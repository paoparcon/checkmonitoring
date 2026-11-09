'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * The RECON module's own tabs (2026-11-09). OUTSTANDING CHECKS keeps its URL,
 * `/recon`, and its export, unchanged; the monthly reconciliation and the
 * beginning balances sit beside it. Highlights only — every page guards itself.
 */
const TABS = [
  ['/recon/monthly', 'MONTHLY RECONCILIATION', ['/recon/monthly', '/recon/periods']],
  ['/recon', 'OUTSTANDING CHECKS', ['/recon']],
  ['/recon/balances', 'BEGINNING BALANCES', ['/recon/balances']],
] as const

export function ReconTabs() {
  const pathname = usePathname()
  const active = TABS.find(([, , prefixes]) => prefixes.some((p) => (p === '/recon' ? pathname === '/recon' : pathname === p || pathname.startsWith(`${p}/`))))?.[0]
  return (
    <nav className="flex flex-wrap gap-2" aria-label="Reconciliation">
      {TABS.map(([href, label]) => (
        <Link
          key={href} href={href} aria-current={href === active ? 'page' : undefined}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold tracking-wide transition ${href === active ? 'bg-navy-bg text-navy ring-1 ring-navy/40' : 'bg-white text-slate-600 ring-1 ring-hairline hover:bg-navy-bg hover:text-navy'}`}
        >
          {label}
        </Link>
      ))}
    </nav>
  )
}
