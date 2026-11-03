'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { registerAction, type SignupResult } from '@/app/signup/actions'

/**
 * CREATE ACCOUNT. The public half of self-registration (spec 2026-10-09).
 *
 * The password goes one way: into the action, into argon2id, into the column.
 * The result on success carries the address only, and the card is replaced
 * by the waiting message, which also clears the password out of the DOM. No
 * session is created here and nothing here reads data.
 */
export function SignupForm() {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<SignupResult | null>(null)

  const field =
    'h-11 w-full rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 ' +
    'placeholder:text-slate-400 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'
  const label = 'mb-1.5 block text-[11px] font-semibold tracking-widest text-slate-400'

  if (result?.ok) {
    return (
      <div className="rounded-2xl bg-white p-8 shadow-md ring-1 ring-hairline">
        <h2 className="text-sm font-semibold tracking-wide text-navy">ACCOUNT CREATED — WAITING FOR APPROVAL</h2>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          The account for <span className="font-medium text-slate-900">{result.email}</span> has been
          created and is waiting for a Finance Admin to approve it and assign a role. You cannot sign in
          until then; your admin will tell you when you can.
        </p>
        <p className="mt-5 text-center text-xs text-slate-400">
          <Link href="/login" className="underline underline-offset-2 hover:text-navy">Go to sign in</Link>
        </p>
      </div>
    )
  }

  return (
    <form
      className="rounded-2xl bg-white p-8 shadow-md ring-1 ring-hairline"
      onSubmit={(e) => {
        e.preventDefault()
        const formData = new FormData(e.currentTarget)
        startTransition(async () => {
          try {
            setResult(await registerAction(formData))
          } catch {
            // A thrown action (network drop, server fault) would otherwise
            // leave the form silent with nothing said to the person.
            setResult({ ok: false, message: 'Something went wrong. Please try again.' })
          }
        })
      }}
    >
      <p className="mb-5 text-sm text-slate-500">
        Create your Finance account. A Finance Admin approves it and assigns your role before you can sign in.
      </p>

      {result && !result.ok && (
        <p role="alert" className="mb-5 rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger-ink">{result.message}</p>
      )}

      <label htmlFor="signup-name" className={label}>NAME</label>
      <input id="signup-name" name="name" required autoComplete="name" className={`${field} mb-4`} />

      <label htmlFor="signup-email" className={label}>EMAIL</label>
      <input id="signup-email" name="email" type="email" required autoComplete="email" className={`${field} mb-4`} />

      <label htmlFor="signup-password" className={label}>PASSWORD</label>
      <input id="signup-password" name="password" type="password" required autoComplete="new-password" className={`${field} mb-1.5`} />
      <p className="mb-4 text-xs text-slate-500">
        At least 12 characters with a lowercase letter, an uppercase letter, a digit and a symbol.
      </p>

      <label htmlFor="signup-confirm" className={label}>CONFIRM PASSWORD</label>
      <input id="signup-confirm" name="confirm" type="password" required autoComplete="new-password" className={`${field} mb-6`} />

      <button
        type="submit" disabled={pending}
        className="h-11 w-full rounded-lg bg-navy text-sm font-medium tracking-wide text-white shadow-sm transition hover:bg-navy/90 disabled:opacity-50"
      >
        {pending ? 'CREATING…' : 'CREATE ACCOUNT'}
      </button>
    </form>
  )
}
