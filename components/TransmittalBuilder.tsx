'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { formatAmount, compareCheckNumbers } from '@/lib/transmittal'
import type { StatusChoice, TransmittalCandidate } from '@/lib/transmittal-picker'
import { TransmittalPicker, type ReleasedState } from './TransmittalPicker'

export type { TransmittalCandidate }

/** Remembered between visits, per browser: who a transmittal usually goes to and who checks and approves it. */
const STORAGE_KEY = 'check-monitoring.transmittal.v1'

/** Who usually checks and approves a transmittal (client, 2026-10-06); typed names still win and are remembered. */
const DEFAULT_CHECKED_BY = 'Maui'
const DEFAULT_APPROVED_BY = 'GPG / GTC'

const todayManila = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
const formatDay = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return y && m && d ? `${m}/${d}/${y}` : iso
}

/** An input that reads as printed text on paper and as a fill-in line on screen. */
const line =
  'w-full bg-transparent px-1 py-0.5 outline-none border-b border-dotted border-slate-400 focus:border-navy print:border-transparent'

export function TransmittalBuilder({
  candidates: opened, preparedBy: defaultPreparedBy, truncated: openedTruncated,
}: { candidates: TransmittalCandidate[]; preparedBy: string; truncated: boolean }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [status, setStatus] = useState<StatusChoice>('ALL')

  // RELEASED checks are ~10,000 rows: fetched once, the first time that option is chosen.
  const [released, setReleased] = useState<{ candidates: TransmittalCandidate[]; truncated: boolean } | null>(null)
  const [releasedState, setReleasedState] = useState<ReleasedState>('idle')
  // `inFlight` rather than an effect cleanup: the effect re-runs when it sets 'loading',
  // and a cleanup would discard the very response it is waiting for.
  const inFlight = useRef(false)
  useEffect(() => {
    if (status !== 'RELEASED' || released || releasedState !== 'idle' || inFlight.current) return
    inFlight.current = true
    setReleasedState('loading')
    fetch('/api/transmittal/released')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => { setReleased(data); setReleasedState('idle') })
      .catch(() => setReleasedState('failed'))
      .finally(() => { inFlight.current = false })
  }, [status, released, releasedState])

  const candidates = useMemo(() => (released ? [...opened, ...released.candidates] : opened), [opened, released])
  const truncated = openedTruncated || Boolean(released?.truncated)

  const [to, setTo] = useState('')
  const [date, setDate] = useState(todayManila)
  const [preparedBy, setPreparedBy] = useState(defaultPreparedBy)
  const [checkedBy, setCheckedBy] = useState(DEFAULT_CHECKED_BY)
  const [approvedBy, setApprovedBy] = useState(DEFAULT_APPROVED_BY)

  // Browser storage is a convenience only: every access is guarded and the
  // page works without it.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
      if (typeof saved.to === 'string' && saved.to) setTo(saved.to)
      if (typeof saved.checkedBy === 'string' && saved.checkedBy) setCheckedBy(saved.checkedBy)
      if (typeof saved.approvedBy === 'string' && saved.approvedBy) setApprovedBy(saved.approvedBy)
    } catch { /* private window or blocked storage */ }
  }, [])
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ to, checkedBy, approvedBy })) } catch { /* ignore */ }
  }, [to, checkedBy, approvedBy])

  const picked = useMemo(
    () => candidates.filter((c) => selected.has(c.id)).sort((a, b) => compareCheckNumbers(a.checkNumber, b.checkNumber)),
    [candidates, selected],
  )

  const toggle = (id: string) => setSelected((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  return (
    <div className="space-y-4">
      <style>{'@media print { @page { size: letter portrait; margin: 10mm; } }'}</style>

      {/* ── PICKER (screen only) ─────────────────────────────────────── */}
      <section className="print-hide space-y-3 rounded-2xl bg-white p-4 ring-1 ring-hairline">
        <p className="text-sm leading-relaxed text-slate-600">
          Tick the checks to put on the transmittal. The list holds checks at SIGNATURE PENDING or SIGNED with a
          recorded amount; choose RELEASED in the status dropdown to list those instead. Filter under any column
          header, and use COLUMNS to show, hide and reorder them. Fill in the sheet below, then press PRINT — choose{' '}
          <strong>Save as PDF</strong> in the print window to keep a copy. Nothing here changes a check’s status.
        </p>
        <TransmittalPicker
          candidates={candidates} selected={selected} onToggle={toggle}
          onAdd={(ids) => setSelected((s) => new Set([...s, ...ids]))} onClear={() => setSelected(new Set())}
          status={status} onStatus={setStatus} released={releasedState}
          onRetry={() => setReleasedState('idle')} truncated={truncated}
        />
        <div className="flex items-center justify-end gap-3">
          <span className="text-xs text-slate-500">OR USE YOUR BROWSER’S PRINT COMMAND</span>
          {/* A POST, so a thousand ticked checks are not squeezed into a URL. The
              server re-reads and re-checks every id; this carries only the picks and the typed names. */}
          <form method="post" action="/api/export/transmittal">
            <input type="hidden" name="ids" value={picked.map((c) => c.id).join(',')} />
            <input type="hidden" name="to" value={to} />
            <input type="hidden" name="date" value={date} />
            <input type="hidden" name="preparedBy" value={preparedBy} />
            <input type="hidden" name="checkedBy" value={checkedBy} />
            <input type="hidden" name="approvedBy" value={approvedBy} />
            <button
              type="submit" disabled={picked.length === 0}
              className="rounded-lg bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy ring-1 ring-navy disabled:opacity-40"
            >
              DOWNLOAD EXCEL
            </button>
          </form>
          <button
            type="button" onClick={() => window.print()} disabled={picked.length === 0}
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white disabled:opacity-40"
          >
            PRINT / SAVE AS PDF
          </button>
        </div>
      </section>

      {/* ── THE SHEET ────────────────────────────────────────────────── */}
      <section className="print-sheet mx-auto max-w-[1100px] bg-white p-6 text-slate-900 ring-1 ring-hairline print:max-w-none print:p-0 print:ring-0">
        <header className="mb-3 text-center">
          <h1 className="text-xl font-bold tracking-[0.2em]">CHECKS TRANSMITTAL</h1>
        </header>

        <table className="w-full border-collapse border border-black text-sm print:text-[10px] [&_td]:border [&_td]:border-black [&_th]:border [&_th]:border-black">
          <thead>
            <tr>
              <td colSpan={6} className="px-2 py-1.5">
                <label className="flex items-center gap-2">
                  <span className="font-medium">TO:</span>
                  <input value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" className={line} />
                </label>
              </td>
              <td className="px-2 py-1.5 text-center">
                <input
                  type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date"
                  className="print-hide bg-transparent text-center outline-none"
                />
                <span className="hidden print:inline">{formatDay(date)}</span>
              </td>
            </tr>
            <tr className="text-center">
              <th className="w-10 px-2 py-2 font-medium">NO.</th>
              <th className="px-2 py-2 font-medium">CHECK NUMBER</th>
              <th className="px-2 py-2 font-medium">CASH<br />ACCOUNT</th>
              <th className="px-2 py-2 font-medium">PO NUMBER/<br />VENDOR REF</th>
              <th className="px-2 py-2 font-medium">VOUCHER<br />NUMBER</th>
              <th className="px-2 py-2 font-medium">PAYEE</th>
              <th className="px-2 py-2 font-medium">AMOUNT</th>
            </tr>
          </thead>
          <tbody>
            {picked.length === 0 && (
              <tr><td colSpan={7} className="px-2 py-8 text-center text-slate-500">
                NO CHECKS SELECTED — TICK THEM ABOVE.
              </td></tr>
            )}
            {picked.map((c, i) => (
              <tr key={c.id} className="break-inside-avoid">
                <td className="px-2 py-1 text-center">{i + 1}</td>
                <td className="px-2 py-1 text-center">{c.checkNumber}</td>
                <td className="px-2 py-1 text-center">{c.cashAccount}</td>
                <td className="px-2 py-1 text-center">{c.poNumber}</td>
                <td className="px-2 py-1 text-center">{c.voucher}</td>
                <td className="break-words px-2 py-1">{c.payee}</td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {formatAmount(c.amount)}{c.currency !== 'PHP' ? ` ${c.currency}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-6 grid break-inside-avoid grid-cols-3 gap-10 text-sm">
          {([
            ['PREPARED BY:', preparedBy, setPreparedBy],
            ['CHECKED BY:', checkedBy, setCheckedBy],
            ['APPROVED BY:', approvedBy, setApprovedBy],
          ] as const).map(([label, value, set]) => (
            <div key={label} className="space-y-1">
              <p className="font-medium">{label}</p>
              <div className="h-10" />
              <input
                value={value} onChange={(e) => set(e.target.value)} aria-label={label.replace(':', '')}
                className={`${line} text-center font-medium uppercase`}
              />
              <p className="border-t border-black pt-0.5 text-center text-[10px] tracking-widest text-slate-500">
                NAME / SIGNATURE
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
