'use client'

import { RECEIPT_TYPES, RECEIPT_TYPE_LABELS, type ReceiptType } from '@/lib/domain/receipt'

/**
 * The supplier's receipt box: a reference, a date, and which kind of receipt it
 * is.
 *
 * One component, used by the tick-box release on the dashboard and by the
 * add-it-later page, so a Finance user meets the same three controls and the
 * same sentence wherever they record a receipt.
 *
 * **Controlled.** The parent owns the value, because the two callers submit
 * very differently — the release bar builds a `FormData` by hand for a batch,
 * the receipt page posts a form — and a component with its own hidden state
 * would have to be reset by each of them anyway. The inputs still carry `name`
 * attributes so a plain `<form>` submits them without any of this running.
 *
 * **The one rejected combination is said here, in the form.** A reference typed
 * with no kind chosen shows the sentence and disables the submit; it is never
 * defaulted to OR. The server refuses it too — `checkReceipt` in
 * `lib/domain/receipt.ts` — because a form control hides nothing from an HTTP
 * endpoint. This is the courtesy; that is the control.
 *
 * **CR here means COLLECTION RECEIPT.** It is not the bank's clearing
 * reference, which is recorded weeks later on its own control. Both letters are
 * spelled out on the toggle for exactly that reason.
 */

export type ReceiptValue = {
  orNumber: string
  orDate: string
  /** '' is "nobody chose", and is a state the server has to be able to see. */
  receiptType: '' | ReceiptType
  receiptAmount: string
}

export const EMPTY_RECEIPT: ReceiptValue = { orNumber: '', orDate: '', receiptType: '', receiptAmount: '' }

/** The one combination the server refuses, answered before the user submits. */
export function receiptTypeMissing(value: ReceiptValue): boolean {
  return value.orNumber.trim() !== '' && value.receiptType === ''
}

export function ReceiptFields({
  value, onChange, idPrefix, disabled = false,
}: {
  value: ReceiptValue
  onChange: (next: ReceiptValue) => void
  /** Unique per instance: two receipt boxes on one page must not share a radio group. */
  idPrefix: string
  disabled?: boolean
}) {
  const missing = receiptTypeMissing(value)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label
            htmlFor={`${idPrefix}-or-number`}
            className="block text-xs font-medium tracking-wide text-slate-600"
          >
            OR / CR REFERENCE
          </label>
          <input
            id={`${idPrefix}-or-number`}
            name="orNumber"
            value={value.orNumber}
            disabled={disabled}
            placeholder="Optional"
            onChange={(e) => onChange({ ...value, orNumber: e.target.value })}
            className="mt-1 w-56 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <fieldset className="flex items-center gap-3" disabled={disabled}>
          <legend className="sr-only">Receipt type</legend>
          {RECEIPT_TYPES.map((t) => (
            <label key={t} htmlFor={`${idPrefix}-type-${t}`} className="flex items-center gap-1.5 text-sm">
              <input
                id={`${idPrefix}-type-${t}`}
                type="radio"
                name="receiptType"
                value={t}
                checked={value.receiptType === t}
                onChange={() => onChange({ ...value, receiptType: t })}
              />
              <span className="font-medium tracking-wide text-slate-700">{t}</span>
              <span className="text-xs text-slate-500">{RECEIPT_TYPE_LABELS[t]}</span>
            </label>
          ))}
        </fieldset>

        <div>
          <label
            htmlFor={`${idPrefix}-or-date`}
            className="block text-xs font-medium tracking-wide text-slate-600"
          >
            RECEIPT DATE
          </label>
          <input
            id={`${idPrefix}-or-date`}
            name="orDate"
            type="date"
            value={value.orDate}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, orDate: e.target.value })}
            className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <label className="block text-xs font-medium tracking-wide text-slate-600" htmlFor={`${idPrefix}-amount`}>
          AMOUNT
          <input id={`${idPrefix}-amount`} name="receiptAmount" inputMode="decimal" value={value.receiptAmount}
            disabled={disabled} placeholder="Optional" onChange={(e) => onChange({ ...value, receiptAmount: e.target.value })}
            className="mt-1 w-40 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
      </div>

      {missing && (
        // Said, not defaulted. The alternative — quietly filing every untyped
        // reference as an OR — would make a guess indistinguishable from an
        // answer on a record about money that has already moved.
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          Choose the receipt type. A receipt reference cannot be recorded without saying which kind of
          receipt it is.
        </p>
      )}
    </div>
  )
}
