import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AuthError } from 'next-auth'
import { getSessionUser, signIn } from '@/lib/auth'
import { MoneyMachines } from '@/components/MoneyMachines'

/**
 * THE SIGN-IN PAGE.
 *
 * Two panels since 2026-09-27: the cash register and the cheque register on the
 * left, still running, and the form on the right. They keep moving for as long
 * as nobody has signed in — the landing page (`/welcome`) shows the same two —
 * and a visitor who already has a session is sent to the dashboard rather than
 * shown a form for a thing they have already done.
 *
 * **Presentation only.** Nothing about authentication changed here except that,
 * since 2026-10-09, a refused sign-in returns to this page with its own message
 * instead of throwing a 500, and nothing else about it should: the `signIn` call, the field names, the generic error and
 * the throttle note below are all load-bearing and are reproduced exactly as
 * they were. In particular the error says the same thing whatever went wrong —
 * see the comment on the throttle note.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getSessionUser()) redirect('/')
  const { error } = await searchParams

  const field =
    'h-11 w-full rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 ' +
    'placeholder:text-slate-400 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* The illustrated panel. Hidden below `lg`, where the form needs the
          whole width; a smaller pair of machines sits above the card there. */}
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
          <p className="text-lg font-semibold tracking-tight text-navy">
            From Acumatica to the supplier&rsquo;s hand, one record.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            Tick a check READY FOR RELEASE here and the Supplier Portal is told. Nothing is typed twice,
            and nothing is released without a Finance user saying so.
          </p>
        </div>
      </aside>

      <section className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm space-y-5">
          <div className="text-center">
            {/* A mark, not a logo: this system has no brand asset and inventing
                one would put a fake company badge on a finance screen. Navy
                square, the product's initials, nothing claimed. */}
            <span
              aria-hidden="true"
              className="mx-auto flex h-12 min-w-[3rem] items-center justify-center rounded-2xl bg-navy px-2 text-sm font-semibold tracking-widest text-white shadow-sm"
            >
              CRM
            </span>
            <h1 className="mt-4 text-lg font-semibold tracking-wide text-navy">
              CHECK RELEASE MONITORING
            </h1>
            <p className="mt-1 text-[11px] font-semibold tracking-widest text-slate-400">
              FINANCE USERS ONLY
            </p>
          </div>

          <MoneyMachines className="mx-auto w-full max-w-xs lg:hidden" />

          <form
            className="rounded-2xl bg-white p-8 shadow-md ring-1 ring-hairline"
            action={async (formData: FormData) => {
              'use server'
              try {
                await signIn('credentials', {
                  email: formData.get('email'),
                  password: formData.get('password'),
                  redirectTo: '/',
                })
              } catch (e) {
                // A refused sign-in is an AuthError (CredentialsSignin) thrown by next-auth's
                // server-action signIn; it is not an exception, it is the answer. Send the
                // visitor back to this page with the flag the generic message renders on.
                // Everything else — including the NEXT_REDIRECT next-auth throws on SUCCESS to
                // send the user to `redirectTo` — must propagate.
                if (e instanceof AuthError) redirect('/login?error=CredentialsSignin')
                throw e
              }
            }}
          >
            <p className="mb-5 text-sm text-slate-500">Sign in with your Finance account to continue.</p>

            {error && (
              // The palette's danger tone: a pale ground with dark ink, like every
              // other refusal in this application. The WORDS are unchanged and
              // must stay unchanged — see the note below.
              <p className="mb-5 rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger-ink">
                Invalid email or password.
              </p>
            )}

            <label
              htmlFor="login-email"
              className="mb-1.5 block text-[11px] font-semibold tracking-widest text-slate-400"
            >
              EMAIL
            </label>
            <input
              id="login-email" name="email" type="email" required autoComplete="username"
              className={`${field} mb-4`}
            />

            <label
              htmlFor="login-password"
              className="mb-1.5 block text-[11px] font-semibold tracking-widest text-slate-400"
            >
              PASSWORD
            </label>
            <input
              id="login-password" name="password" type="password" required autoComplete="current-password"
              className={`${field} mb-6`}
            />

            <button
              type="submit"
              className="h-11 w-full rounded-lg bg-navy text-sm font-medium tracking-wide text-white shadow-sm transition hover:bg-navy/90"
            >
              SIGN IN
            </button>
          </form>

          {/* Static, and shown to everybody on every visit — never conditional on
              whether this visitor is actually being throttled.

              A refused sign-in says only "Invalid email or password", whether the
              password was wrong, the account is deactivated, the address is
              unknown, or the login throttle is refusing a correct password. That
              sameness is the point: a message that said "your account is locked"
              would confirm the account exists, which is precisely what
              `authorize` spends an argon2 hash per rejection to avoid revealing.

              But a Finance user who mistypes at eight in the morning and then
              gets refused with the RIGHT password deserves to understand why, so
              the explanation lives here, where it is a fact about the system
              rather than a fact about them. Do not make this appear only after a
              lockout — that would leak exactly what the generic error hides.

              Moved OUTSIDE the card in the 2026-09-10 restyle, and nothing else
              about it changed. It is a standing fact about the system, not part
              of the form, and outside the card is where it reads as one. */}
          <p className="px-2 text-xs leading-relaxed text-slate-500">
            After several failed attempts, sign-in is refused for a few minutes even if the password
            is correct. It clears on its own — wait a moment and try again. Nobody needs to unlock
            anything.
          </p>

          <p className="px-2 text-center text-xs text-slate-400">
            Need an account?{' '}
            <Link href="/signup" className="underline underline-offset-2 hover:text-navy">Create one</Link>
            {' · '}
            <Link href="/welcome" className="underline underline-offset-2 hover:text-navy">Back to the front page</Link>
          </p>
        </div>
      </section>
    </main>
  )
}
