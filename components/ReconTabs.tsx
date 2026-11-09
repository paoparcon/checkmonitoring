import Link from 'next/link'

/** RECON's two screens: the outstanding checks, and the bank reconciliation built on them (2026-11-09). */
export function ReconTabs({ active }: { active: 'OUTSTANDING' | 'BANK' }) {
  const tab = (on: boolean) =>
    `rounded-lg px-4 py-2 text-sm font-medium tracking-wide transition ${on ? 'bg-navy text-white' : 'bg-white text-navy ring-1 ring-hairline hover:bg-ground'}`
  return (
    <nav aria-label="Recon screens" className="flex flex-wrap gap-2">
      <Link href="/recon" className={tab(active === 'OUTSTANDING')} aria-current={active === 'OUTSTANDING' ? 'page' : undefined}>OUTSTANDING CHECKS</Link>
      <Link href="/recon/bank" className={tab(active === 'BANK')} aria-current={active === 'BANK' ? 'page' : undefined}>BANK RECONCILIATION</Link>
    </nav>
  )
}
