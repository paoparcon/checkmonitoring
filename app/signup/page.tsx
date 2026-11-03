import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth'
import { MoneyMachines } from '@/components/MoneyMachines'
import { SignupForm } from '@/components/SignupForm'

/**
 * THE SIGN-UP PAGE (spec 2026-10-09-self-registration-design.md).
 *
 * Public by name (`isPublicPath`), so like `/welcome` it reads no data and
 * shows no figure. A signed-in visitor is sent to the dashboard, as `/login`
 * does. The same two panels as the sign-in page so it reads as the same
 * system; the form is `components/SignupForm.tsx`.
 */
export default async function SignupPage() {
  if (await getSessionUser()) redirect('/')

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <aside className="hidden flex-col justify-between bg-gradient-to-br from-navy-bg via-lavender-bg to-sky-bg p-10 lg:flex xl:p-14">
        <Link href="/welcome" className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-10 min-w-[2.5rem] items-center justify-center rounded-xl bg-navy px-2 text-xs font-semibold tracking-widest text-white shadow-sm"
          >
            CRM
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-semibold tracking-wide text-navy">CHECK RELEASE MONITORING</span>
            <span className="block text-[10px] font-semibold tracking-widest text-slate-500">RCL FINANCE · INTERNAL</span>
          </span>
        </Link>

        <MoneyMachines className="mx-auto w-full max-w-xl" />

        <div className="max-w-md">
          <p className="text-lg font-semibold tracking-tight text-navy">One account, approved by Finance.</p>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            Create your account here. A Finance Admin approves it and assigns your role; until then it
            cannot sign in.
          </p>
        </div>
      </aside>

      <section className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm space-y-5">
          <div className="text-center">
            <span
              aria-hidden="true"
              className="mx-auto flex h-12 min-w-[3rem] items-center justify-center rounded-2xl bg-navy px-2 text-sm font-semibold tracking-widest text-white shadow-sm"
            >
              CRM
            </span>
            <h1 className="mt-4 text-lg font-semibold tracking-wide text-navy">CREATE ACCOUNT</h1>
            <p className="mt-1 text-[11px] font-semibold tracking-widest text-slate-400">FINANCE USERS ONLY</p>
          </div>

          <MoneyMachines className="mx-auto w-full max-w-xs lg:hidden" />

          <SignupForm />

          <p className="px-2 text-center text-xs text-slate-400">
            Already have an account?{' '}
            <Link href="/login" className="underline underline-offset-2 hover:text-navy">Sign in</Link>
            {' · '}
            <Link href="/welcome" className="underline underline-offset-2 hover:text-navy">Back to the front page</Link>
          </p>
        </div>
      </section>
    </main>
  )
}
