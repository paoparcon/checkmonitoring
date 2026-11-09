import { STATUS_LABEL, type ReconStatus } from '@/lib/recon/monthly/period'
import { STATUS_TONE } from '@/lib/recon/monthly/view'

export function ReconStatusPill({ status }: { status: ReconStatus | null }) {
  if (!status) return <span className="inline-block rounded-full bg-white px-2.5 py-1 text-xs font-semibold tracking-wide text-slate-500 ring-1 ring-hairline">NOT STARTED</span>
  return <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold tracking-wide ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>
}
