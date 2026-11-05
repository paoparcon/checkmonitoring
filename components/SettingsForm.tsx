'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { SettingDef } from '@/lib/settings/registry'
import { updateSettingAction, resetSettingAction, type SettingActionResult } from '@/app/admin/settings/actions'

/** For a `user` setting: who may be chosen. Active users only — the server refuses anyone else. */
export type UserOption = { id: string; name: string; email: string }

/**
 * One setting: its value in force, SAVE, and RESET TO DEFAULT when a row
 * exists. The bounds are on the input AND enforced on the server — a `min`
 * attribute is a courtesy, `parseSettingText` is the control.
 */
export function SettingsForm({
  def, text, overridden, outOfBounds, usage, users,
}: {
  def: SettingDef
  text: string
  overridden: boolean
  outOfBounds: boolean
  usage?: { name: string; cheques: number; lines: number }[]
  /** `user` kind only. */
  users?: UserOption[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<SettingActionResult | null>(null)
  const field = 'rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'
  const defaultText = def.kind === 'int' ? String(def.default) : def.kind === 'list' ? def.default.join('\n') : 'NOBODY'
  const defaultLabel = def.kind === 'int' ? `${def.default} ${def.unit}` : def.kind === 'list' ? `${def.default.length} categories` : 'NOBODY — no approval step'

  const submit = (action: (f: FormData) => Promise<SettingActionResult>, form: HTMLFormElement) => {
    const f = new FormData(form)
    f.set('key', def.key)
    startTransition(async () => {
      const r = await action(f)
      setResult(r)
      if (r.ok) router.refresh()
    })
  }

  return (
    <div className="space-y-3 px-6 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-[11px] font-semibold tracking-widest text-slate-400">{def.label}</p>
        <p className="text-xs text-slate-500">
          DEFAULT {defaultLabel}
          {def.kind === 'int' && ` · ALLOWED ${def.min}–${def.max}`}
          {overridden && <span className="ml-2 rounded-md bg-navy-bg px-2 py-0.5 text-[11px] font-medium text-navy">CHANGED</span>}
        </p>
      </div>
      <p className="text-sm text-slate-600">{def.help}</p>
      {outOfBounds && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          The stored value is outside the allowed range and is being ignored; the default is in force. Save a value in range or reset.
        </p>
      )}
      {/* A stored id that names nobody active: the gate treats it as NOBODY, and the admin should know. */}
      {def.kind === 'user' && text !== '' && users && !users.some((u) => u.id === text) && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          The person chosen is no longer an active user, so NOBODY is in force and every availability change applies at once. Choose someone, or reset.
        </p>
      )}
      <form className="flex flex-wrap items-start gap-3" onSubmit={(e) => { e.preventDefault(); submit(updateSettingAction, e.currentTarget) }}>
        {def.kind === 'int' ? (
          <input name="value" type="number" inputMode="numeric" min={def.min} max={def.max} step={1} defaultValue={text} disabled={pending} className={`${field} h-10 w-40 text-right tabular-nums`} />
        ) : def.kind === 'list' ? (
          <textarea name="value" rows={8} defaultValue={text} disabled={pending} className={`${field} w-full max-w-md py-2 font-mono`} />
        ) : (
          <select name="value" defaultValue={text} disabled={pending} className={`${field} h-10 w-full max-w-md`}>
            <option value="">NOBODY — no approval step</option>
            {(users ?? []).map((u) => (
              <option key={u.id} value={u.id}>{u.name} · {u.email}</option>
            ))}
          </select>
        )}
        <button type="submit" disabled={pending} className="h-10 rounded-lg bg-navy px-4 text-sm font-medium tracking-wide text-white hover:bg-navy/90 disabled:opacity-50">
          {pending ? 'SAVING…' : 'SAVE'}
        </button>
        {overridden && (
          <button type="button" disabled={pending} title={`Back to ${defaultText}`}
            onClick={(e) => submit(resetSettingAction, e.currentTarget.form ?? (e.currentTarget.closest('form') as HTMLFormElement))}
            className="h-10 rounded-lg border border-hairline bg-white px-4 text-sm font-medium tracking-wide text-navy hover:bg-ground disabled:opacity-50">
            RESET TO DEFAULT
          </button>
        )}
      </form>
      {usage && usage.length > 0 && (
        <ul className="flex flex-wrap gap-2 text-xs text-slate-500">
          {usage.map((u) => (
            <li key={u.name} className="rounded-md bg-ground px-2 py-1">
              {u.name}: {u.cheques.toLocaleString('en-PH')} check{u.cheques === 1 ? '' : 's'}, {u.lines.toLocaleString('en-PH')} line{u.lines === 1 ? '' : 's'}
            </li>
          ))}
        </ul>
      )}
      {result?.ok && <p className="text-xs text-success-ink">Saved. The change is on the audit trail.</p>}
      {result && !result.ok && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>}
    </div>
  )
}
