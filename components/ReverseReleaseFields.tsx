'use client'

import { useState } from 'react'

const INPUT = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'
const LABEL = 'block text-[11px] font-semibold tracking-widest text-slate-400'

/**
 * The fields of REVERSE RELEASE, inside `ActionForm` (2026-11-03, user
 * request: "make a selection where the checks will reside next after
 * reversal"). A destination radio — READY FOR RELEASE keeps the cheque
 * available, SIGNED withdraws it — and, for a cheque released outside the app
 * (no pickup date on record) going back to READY FOR RELEASE, the day it is
 * available again. The sentence under the buttons says what each choice means
 * for the portal in general terms; whether the portal is told at all is the
 * domain's decision (`reverseRelease`: only when it was told of the release).
 */
export function ReverseReleaseFields({ hasPickupDate, internal }: { hasPickupDate: boolean; internal: boolean }) {
  const [destination, setDestination] = useState<'READY_FOR_RELEASE' | 'SIGNED'>('READY_FOR_RELEASE')
  const needsDate = destination === 'READY_FOR_RELEASE' && !hasPickupDate
  return (
    <>
      <label className={LABEL}>
        REASON <span className="text-danger-ink">— REQUIRED</span>
      </label>
      <input name="reason" required placeholder="Ticked the wrong row" className={`${INPUT} w-full max-w-md`} />

      <span className={LABEL}>RETURN THE CHECK TO</span>
      <div className="flex flex-wrap gap-4 text-sm text-slate-900">
        <label className="flex items-center gap-2">
          <input type="radio" name="destination" value="READY_FOR_RELEASE"
            checked={destination === 'READY_FOR_RELEASE'} onChange={() => setDestination('READY_FOR_RELEASE')} />
          READY FOR RELEASE
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="destination" value="SIGNED"
            checked={destination === 'SIGNED'} onChange={() => setDestination('SIGNED')} />
          SIGNED
        </label>
      </div>

      {needsDate && (
        <>
          <label className={LABEL}>
            AVAILABLE PICKUP DATE <span className="text-danger-ink">— REQUIRED</span>
          </label>
          <input name="availablePickupDate" type="date" required className={INPUT} />
          <p className="text-[11px] text-slate-500">
            This check was released outside the app and has no pickup date on record.
            Enter the day it is available for pickup again.
          </p>
        </>
      )}

      <p className="text-[11px] text-slate-500">
        {destination === 'READY_FOR_RELEASE'
          ? 'Returns this check to READY FOR RELEASE, still available to the supplier, and clears any pickup that was booked'
          : 'Returns this check to SIGNED, withdrawn from the supplier, and clears its availability and any pickup that was booked'}
        {/* Rule 2: an INTERNAL cheque never produces a supplier-facing portal
            call; its quiet reversal only lets the bill age again. Stating a
            supplier clause for a payroll or tax cheque would be false. */}
        {!internal && (destination === 'READY_FOR_RELEASE'
          ? '; the supplier portal is told it is available again if it was told of the release'
          : '; the supplier portal is told it is withdrawn if it was told of the release')}.
        The release stays on the audit trail with your reason.
      </p>
    </>
  )
}
