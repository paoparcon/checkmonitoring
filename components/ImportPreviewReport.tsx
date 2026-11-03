import type { StagedReason } from '@prisma/client'
import { formatMoney } from '@/lib/money'
import type { BillPreview, UnmatchedBillReason } from '@/lib/import/bills'
import type { ImportPreview, StagedPreviewRow } from '@/lib/import/preview'
import { KitTable, type KitRow } from '@/components/table-kit/KitTable'
import type { KitColumn } from '@/lib/table-kit/types'
import { dateValue } from '@/lib/table-kit/match'

/**
 * The reconciliation report, shown BEFORE anything is written.
 *
 * The layout carries an argument. "Will import" and "will not import" are two
 * cards of the same size, side by side, because 22% of the client's register
 * does not import and a screen that led with 9,461 and mentioned 2,766
 * somewhere below would be read as success. Nobody has to act on all 2,766 —
 * most of them are cheques already handed over — but nobody should believe
 * 9,461 was the whole register either.
 */

const n = (v: number) => v.toLocaleString('en-PH')

// Enough rows to see the shape of a group without putting 2,639 of them in the
// DOM. The rest are not hidden: they are the staged queue, which is linked.
const ROWS_SHOWN = 200

const REASON_LABEL: Readonly<Record<StagedReason, string>> = {
  NO_COMPANY: 'NO COMPANY — neither a checkbook nor a cash account says whose check this is',
  AMBIGUOUS_COMPANY: 'AMBIGUOUS COMPANY — this check number is claimed by more than one company',
  NO_CHECK_NUMBER: 'NO CHECK NUMBER — the row carries nothing that can key a check',
  SHARED_NUMBER: 'SHARED NUMBER — another Acumatica payment already holds this check number',
}

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

const distinct = (xs: (string | null)[]) =>
  [...new Set(xs.filter((x): x is string => Boolean(x)))].sort().map((v) => ({ value: v, label: v }))

function Figure({ label, value, tone }: { label: string; value: string; tone: 'good' | 'warn' }) {
  const skin = tone === 'good'
    ? 'bg-success-bg ring-success-ink/20 text-success-ink'
    : 'bg-warning-bg ring-warning-ink/20 text-warning-ink'
  return (
    <div className={`rounded-2xl p-6 ring-1 ${skin}`}>
      <p className="text-[11px] font-semibold tracking-widest">{label}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function StagedGroup({ reason, rows }: { reason: StagedReason; rows: StagedPreviewRow[] }) {
  if (rows.length === 0) return null
  const stagedColumns: KitColumn[] = [
    { key: 'sheet', label: 'SHEET', kind: 'enum', options: distinct(rows.map((r) => r.sheet)), className: 'text-slate-600' },
    { key: 'row', label: 'ROW', kind: 'amount', align: 'right', className: 'tabular-nums text-slate-600' },
    { key: 'checkNumber', label: 'CHECK NUMBER', kind: 'text', locked: true, className: 'font-medium' },
    { key: 'payee', label: 'PAYEE', kind: 'text' },
    { key: 'checkDate', label: 'CHECK DATE', kind: 'date', className: 'text-slate-600' },
    { key: 'amount', label: 'AMOUNT', kind: 'amount', align: 'right', className: 'tabular-nums' },
    { key: 'cashAccount', label: 'CASH ACCOUNT', kind: 'text', className: 'text-slate-600' },
    { key: 'checkBook', label: 'CHECK BOOK', kind: 'text', className: 'text-slate-600' },
    { key: 'companies', label: 'COMPANIES CLAIMED', kind: 'text', className: 'text-slate-600' },
    { key: 'implied', label: 'REGISTER IMPLIES', kind: 'enum', options: distinct(rows.map((r) => r.impliedStatus ?? 'NOT RULED ON')), className: 'text-slate-600' },
  ]
  return (
    <details className="rounded-2xl bg-white ring-1 ring-hairline">
      <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
        {n(rows.length)} · {REASON_LABEL[reason]}
      </summary>
      <div className="overflow-x-auto border-t border-slate-100">
        <KitTable
          tableId="import-rows"
          frameClassName=""
          capped={rows.length > ROWS_SHOWN}
          columns={stagedColumns}
          rows={rows.slice(0, ROWS_SHOWN).map((r): KitRow => ({
            key: `${r.sheet}#${r.row}`,
            values: {
              sheet: r.sheet, row: String(r.row), checkNumber: r.checkNumber ?? r.statedCheckRef, payee: r.payeeName,
              checkDate: dateValue(r.checkDate), amount: r.amount, cashAccount: r.cashAccountCode, checkBook: r.checkBookCode,
              companies: r.conflictingCompanies.length ? r.conflictingCompanies.join(' / ') : r.companyCode,
              implied: r.impliedStatus ?? 'NOT RULED ON',
            },
            cells: {
              sheet: r.sheet,
              row: r.row,
              /* For a NO_CHECK_NUMBER row this shows what the cell actually
                 held, which is what a human replaces with the real number. */
              checkNumber: r.checkNumber ?? r.statedCheckRef ?? '—',
              payee: r.payeeName ?? '—',
              checkDate: fmtDate(r.checkDate),
              amount: formatMoney(r.amount, r.currency ?? 'PHP'),
              cashAccount: r.cashAccountCode ?? '—',
              checkBook: r.checkBookCode ?? '—',
              companies: r.conflictingCompanies.length ? r.conflictingCompanies.join(' / ') : r.companyCode ?? '—',
              implied: r.impliedStatus ?? 'NOT RULED ON',
            },
          }))}
        />
        {rows.length > ROWS_SHOWN && (
          <p className="px-4 py-3 text-sm text-slate-500">
            SHOWING {n(ROWS_SHOWN)} OF {n(rows.length)}. Every one of them is kept — after the
            import they are all in the staged queue.
          </p>
        )}
      </div>
    </details>
  )
}

export function RegisterPreviewReport({ preview }: { preview: ImportPreview }) {
  const reasons: StagedReason[] = ['NO_COMPANY', 'AMBIGUOUS_COMPANY', 'NO_CHECK_NUMBER']

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Figure label="WILL IMPORT" value={n(preview.willImport)} tone="good" />
        <Figure label="WILL NOT IMPORT — HELD FOR REVIEW" value={n(preview.willStage)} tone="warn" />
      </div>

      <p className="rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        {n(preview.totalRows)} rows in the workbook, all accounted for. Of the {n(preview.willStage)}{' '}
        that will not import, {n(preview.stagedLive)} are checks still in the release workflow and{' '}
        {n(preview.stagedClosed)} are already released or cancelled
        {preview.stagedUnruled > 0 && `, and ${n(preview.stagedUnruled)} carry a status combination nobody has ruled on`}.
        None of them is discarded.
      </p>

      {preview.unruledClashes.length > 0 && (
        <section className="rounded-2xl bg-danger-bg p-6 ring-1 ring-danger-ink/20">
          <h3 className="text-[11px] font-semibold tracking-widest text-danger-ink">
            {n(preview.unruledClashes.length)} CHECK(S) CANNOT BE IMPORTED AT ALL
          </h3>
          <p className="mt-2 text-sm text-danger-ink">
            Their sheets imply a combination of statuses Finance has not ruled on, so the importer
            cannot choose one. A human has to decide before this workbook can be imported.
          </p>
          <ul className="mt-3 space-y-1 text-sm text-danger-ink">
            {preview.unruledClashes.map((c) => (
              <li key={c.checkNumber}>
                <span className="font-medium">{c.checkNumber}</span> — {c.sheets.join(' + ')}
              </li>
            ))}
          </ul>
        </section>
      )}

      {reasons.map((reason) => (
        <StagedGroup
          key={reason}
          reason={reason}
          rows={preview.stagedRows.filter((r) => r.reason === reason)}
        />
      ))}

      <details className="rounded-2xl bg-white ring-1 ring-hairline">
        <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
          {n(preview.contradictions.length)} · CONTRADICTORY STATUS — and how the Finance ruling of
          3 September 2026 settled each
        </summary>
        <div className="overflow-x-auto border-t border-slate-100">
          <KitTable
            tableId="import-contradictions"
            frameClassName=""
            capped={preview.contradictions.length > ROWS_SHOWN}
            columns={[
              { key: 'checkNumber', label: 'CHECK NUMBER', kind: 'text', locked: true, className: 'font-medium' },
              { key: 'sheets', label: 'SHEETS', kind: 'text', className: 'text-slate-600' },
              { key: 'implied', label: 'THE REGISTER IMPLIES', kind: 'text', className: 'text-slate-600' },
              { key: 'resolvedFrom', label: 'RESOLVED TO', kind: 'text' },
              { key: 'status', label: 'IMPORTED AS', kind: 'enum', options: distinct(preview.contradictions.map((c) => c.status)) },
            ]}
            rows={preview.contradictions.slice(0, ROWS_SHOWN).map((c): KitRow => ({
              key: c.checkNumber,
              values: {
                checkNumber: c.checkNumber, sheets: c.sheets.join(', '), implied: c.implied.join(' and '),
                resolvedFrom: c.resolvedFrom, status: c.status,
              },
              cells: {
                checkNumber: c.checkNumber,
                sheets: c.sheets.join(', '),
                implied: c.implied.join(' and '),
                resolvedFrom: c.resolvedFrom ?? '—',
                status: c.status,
              },
            }))}
          />
        </div>
      </details>

      <details className="rounded-2xl bg-white ring-1 ring-hairline">
        <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
          {n(preview.companyConflicts.length)} · CASH ACCOUNT AND CHECK BOOK NAME DIFFERENT
          COMPANIES — the cash account wins, and the register needs correcting
        </summary>
        <div className="overflow-x-auto border-t border-slate-100">
          <KitTable
            tableId="import-company-conflicts"
            frameClassName=""
            capped={preview.companyConflicts.length > ROWS_SHOWN}
            columns={[
              { key: 'sheet', label: 'SHEET', kind: 'enum', options: distinct(preview.companyConflicts.map((c) => c.sheet)), className: 'text-slate-600' },
              { key: 'row', label: 'ROW', kind: 'amount', align: 'right', className: 'tabular-nums text-slate-600' },
              { key: 'checkNumber', label: 'CHECK NUMBER', kind: 'text', locked: true, className: 'font-medium' },
              { key: 'cashAccount', label: 'CASH ACCOUNT', kind: 'text' },
              { key: 'checkBook', label: 'CHECK BOOK', kind: 'text' },
              { key: 'resolved', label: 'IMPORTED AS', kind: 'text' },
              { key: 'conflictedWith', label: 'THE CHECK BOOK SAID', kind: 'text', className: 'text-slate-600' },
            ]}
            rows={preview.companyConflicts.slice(0, ROWS_SHOWN).map((c): KitRow => ({
              key: `${c.sheet}#${c.row}`,
              values: {
                sheet: c.sheet, row: String(c.row), checkNumber: c.checkNumber, cashAccount: c.cashAccountLabel,
                checkBook: c.checkBook, resolved: c.resolved, conflictedWith: c.conflictedWith,
              },
              cells: {
                sheet: c.sheet,
                row: c.row,
                checkNumber: c.checkNumber,
                cashAccount: c.cashAccountLabel ?? '—',
                checkBook: c.checkBook ?? '—',
                resolved: c.resolved,
                conflictedWith: c.conflictedWith,
              },
            }))}
          />
        </div>
      </details>

      <section className="rounded-2xl bg-white p-6 ring-1 ring-hairline">
        <h3 className="text-[11px] font-semibold tracking-widest text-slate-400">OTHER CONFLICTS</h3>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div><dt className="text-[11px] font-semibold tracking-widest text-slate-400">DUPLICATE ACROSS SHEETS</dt>
            <dd className="tabular-nums">{n(preview.conflictsByKind.DUPLICATE_ACROSS_SHEETS)}</dd></div>
          <div><dt className="text-[11px] font-semibold tracking-widest text-slate-400">AMOUNT MISMATCH</dt>
            <dd className="tabular-nums">{n(preview.conflictsByKind.AMOUNT_MISMATCH)}</dd></div>
          <div><dt className="text-[11px] font-semibold tracking-widest text-slate-400">IMPLAUSIBLE DATE</dt>
            <dd className="tabular-nums">{n(preview.conflictsByKind.IMPLAUSIBLE_DATE)}</dd></div>
          <div><dt className="text-[11px] font-semibold tracking-widest text-slate-400">CONTRADICTORY STATUS</dt>
            <dd className="tabular-nums">{n(preview.conflictsByKind.CONTRADICTORY_STATUS)}</dd></div>
        </dl>
      </section>

      {/* The merge list, presented BEFORE the import runs — spec §8. It is
          reported and never applied: nothing in this system rewrites a payee. */}
      <details className="rounded-2xl bg-white ring-1 ring-hairline">
        <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
          {n(preview.vendorMerges.length)} · VENDOR MERGE LIST — payee spellings that fold to one
          name, out of {n(preview.distinctPayees)} spellings in the file
        </summary>
        <div className="space-y-2 border-t border-slate-100 p-6">
          <p className="text-sm text-slate-600">
            These are reported for confirmation and are never applied automatically. Importing does
            not rewrite a payee.
          </p>
          <ul className="space-y-1 text-sm">
            {preview.vendorMerges.slice(0, ROWS_SHOWN).map((m) => (
              <li key={m.canonical}>
                <span className="font-medium">{m.canonical}</span>
                <span className="text-slate-500"> ← {m.variants.join(' · ')}</span>
              </li>
            ))}
          </ul>
          {preview.vendorMerges.length > ROWS_SHOWN && (
            <p className="text-sm text-slate-500">
              SHOWING {n(ROWS_SHOWN)} OF {n(preview.vendorMerges.length)}.
            </p>
          )}
        </div>
      </details>

      <details className="rounded-2xl bg-white ring-1 ring-hairline">
        <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
          {preview.sheets.length} SHEETS READ
        </summary>
        <ul className="space-y-1 border-t border-slate-100 p-6 text-sm">
          {preview.sheets.map((s) => (
            <li key={s.sheet} className="flex justify-between">
              <span>{s.sheet}</span>
              <span className="tabular-nums text-slate-500">{n(s.rows)}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}

// Spelled out as a record rather than as a ternary chain, and typed against the
// reason union: adding a reason to `UnmatchedBillReason` without a sentence
// here is a compile error, where the chain this replaced would silently have
// shown one reason's wording under another reason's name.
const UNMATCHED_BILL_WHY: Record<UnmatchedBillReason, string> = {
  NO_MATCHING_CHECK:
    'No check with this number is here — it may be staged for want of a company, or absent from the register',
  AMBIGUOUS_CHECK:
    'More than one check carries this number or voucher; a human has to say which',
  NO_CHECK_NUMBER:
    'The check No. cell holds no check number, and the row’s voucher matches no check here — correct the cell, or import the register so the voucher can find it',
}

export function BillPreviewReport({ preview }: { preview: BillPreview }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Figure label="BILLS THAT WILL BE ATTACHED" value={n(preview.willImport)} tone="good" />
        <Figure
          label="BILLS WHOSE CHECK IS NOT HERE"
          value={n(preview.unmatched.length + preview.review.length)}
          tone="warn"
        />
      </div>

      <p className="rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        {n(preview.totalRows)} rows read, all accounted for. This file is a snapshot of the
        approval-for-release working list, not a history: it says nothing about checks outside it,
        and importing it changes no check&apos;s release status.
      </p>

      {/* Which sheets those rows came from, and which sheets were skipped. The
          workbook's sheet names change between exports, so "0 bills" and "we
          never read that sheet" have to be told apart on screen. */}
      <ul className="space-y-1 rounded-2xl bg-white px-6 py-4 text-sm ring-1 ring-hairline">
        {preview.sheets.map((s) => (
          <li key={s.sheet} className="flex justify-between gap-4">
            <span className={s.read ? '' : 'text-slate-500'}>
              {s.sheet}
              {!s.read && (
                <span className="ml-2 text-xs tracking-wide text-slate-500">
                  SKIPPED · no bill header on row 1
                </span>
              )}
            </span>
            <span className="tabular-nums text-slate-500">
              {s.read ? `${n(s.bills)} of ${n(s.rows)}` : n(s.rows)}
            </span>
          </li>
        ))}
      </ul>

      {preview.willResolveByVoucher > 0 && (
        <p className="rounded-lg bg-warning-bg px-4 py-2 text-sm text-warning-ink">
          {n(preview.willResolveByVoucher)} of them will be attached by their VOUCHER, because the
          workbook&apos;s <em>check No.</em> cell does not hold a check number. Each matched exactly
          one check; none was guessed at, and the audit trail records the basis.
        </p>
      )}

      {preview.unmatched.length > 0 && (
        <details className="rounded-2xl bg-white ring-1 ring-hairline" open>
          <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
            {n(preview.unmatched.length)} · BILLS WITH NO CHECK TO ATTACH TO
          </summary>
          <div className="overflow-x-auto border-t border-slate-100">
            <KitTable
              tableId="import-unmatched"
              frameClassName=""
              columns={[
                { key: 'sheet', label: 'SHEET', kind: 'enum', options: distinct(preview.unmatched.map((u) => u.sheet)), className: 'text-slate-600' },
                { key: 'row', label: 'ROW', kind: 'amount', align: 'right', className: 'tabular-nums text-slate-600' },
                { key: 'checkNumber', label: 'CHECK NUMBER', kind: 'text', locked: true, className: 'font-medium' },
                { key: 'stated', label: 'WHAT THE CELL SAID', kind: 'text', className: 'text-slate-600' },
                { key: 'apv', label: 'APV', kind: 'text' },
                { key: 'why', label: 'WHY', kind: 'text', className: 'text-slate-600' },
                { key: 'companies', label: 'COMPANIES', kind: 'text', className: 'text-slate-600' },
              ]}
              rows={preview.unmatched.map((u): KitRow => ({
                key: `${u.sheet}#${u.row}`,
                values: {
                  sheet: u.sheet, row: String(u.row), checkNumber: u.checkNumber, stated: u.statedCheckRef,
                  apv: u.apvNumber, why: UNMATCHED_BILL_WHY[u.reason], companies: u.companies.join(' / ') || null,
                },
                cells: {
                  sheet: u.sheet,
                  row: u.row,
                  /* Null when the cell held no check number at all. An em
                     dash rather than an empty cell, which is
                     indistinguishable from a rendering fault. */
                  checkNumber: u.checkNumber ?? '—',
                  stated: u.statedCheckRef ?? '—',
                  apv: u.apvNumber,
                  why: UNMATCHED_BILL_WHY[u.reason],
                  companies: u.companies.join(' / ') || '—',
                },
              }))}
            />
          </div>
        </details>
      )}

      {preview.review.length > 0 && (
        <details className="rounded-2xl bg-white ring-1 ring-hairline">
          <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
            {n(preview.review.length)} · ROWS THAT ARE NOT A USABLE BILL
          </summary>
          <ul className="space-y-1 border-t border-slate-100 p-6 text-sm">
            {preview.review.map((r) => (
              <li key={`${r.sheet}#${r.row}`}>
                {r.sheet} row {r.row} — {r.reason.replace(/_/g, ' ')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
