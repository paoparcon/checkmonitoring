import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth'
import { CashRegister, ChequeRegister } from '@/components/MoneyMachines'
import { DancerVideo } from '@/components/DancerVideo'

/**
 * THE LANDING PAGE.
 *
 * What an anonymous visitor sees at the bare URL: a cash register on the left
 * and a cheque register on the right, both running, and one thing to do —
 * SIGN IN. It is public (`isPublicPath`), so it reads no data and shows no
 * figure: everything on it is the name of the system and where a cheque goes.
 *
 * A signed-in visitor has no business here and is sent to the dashboard. The
 * machines are for people who are not yet in; that is the brief.
 *
 * Rule 1 still holds — this is not a supplier page. It names the system and
 * asks for a Finance sign-in, nothing else.
 */
export default async function WelcomePage() {
  if (await getSessionUser()) redirect('/')

  return (
    <main className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-6">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-10 min-w-[2.5rem] items-center justify-center rounded-xl bg-navy px-2 text-xs font-semibold tracking-widest text-white shadow-sm"
          >
            CRM
          </span>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold tracking-wide text-navy">CHECK RELEASE MONITORING</h1>
            <p className="text-[10px] font-semibold tracking-widest text-slate-400">RCL FINANCE · INTERNAL</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/signup"
            className="whitespace-nowrap rounded-lg bg-white px-3 sm:px-5 py-2.5 text-sm font-medium tracking-wide text-navy shadow-sm ring-1 ring-hairline transition hover:bg-navy-bg"
          >
            CREATE ACCOUNT
          </Link>
          <Link
            href="/login"
            className="whitespace-nowrap rounded-lg bg-navy px-3 sm:px-5 py-2.5 text-sm font-medium tracking-wide text-white shadow-sm transition hover:bg-navy/90"
          >
            SIGN IN
          </Link>
        </div>
      </header>

      <section className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 px-6 py-8 lg:grid-cols-[1fr_1.15fr_1fr]">
        <div className="order-2 lg:order-1">
          <CashRegister className="mx-auto w-full max-w-xs" />
          <p className="mt-2 text-center text-[11px] font-semibold tracking-widest text-slate-400">CASH REGISTER</p>
        </div>

        <div className="order-1 text-center lg:order-2">
          {/* TEMPORARY — for the presentation (2026-09-27), to be removed
              afterwards on the user's own word. The user's own dance clip,
              carrying its own audio, painted with the background removed live
              in the browser (see DancerVideo). It starts on its own where the
              browser allows it, on the first click anywhere otherwise, and
              loops. Delete this block, the component, public/dancing.mp4 and
              its entry in the middleware matcher together. The page's title
              lines came out at the user's request — the header above still
              names the system. */}
          <DancerVideo src="/Woman_dancing_on_terrace_20260927144811.mp4" audioSrc="/chorus.mp3.mp4" />


          <Link
            href="/login"
            className="mt-8 inline-flex h-12 items-center justify-center rounded-xl bg-navy px-8 text-sm font-medium tracking-wide text-white shadow-md transition hover:bg-navy/90"
          >
            SIGN IN TO CONTINUE
          </Link>

          <ol className="mx-auto mt-10 flex max-w-lg flex-wrap items-center justify-center gap-2 text-[11px] font-semibold tracking-wide">
            <li className="rounded-full bg-sky-bg px-3 py-1.5 text-sky-ink ring-1 ring-sky-ink/15">ACUMATICA</li>
            <li aria-hidden="true" className="text-slate-300">→</li>
            <li className="rounded-full bg-navy px-3 py-1.5 text-white">CHECK RELEASE MONITORING</li>
            <li aria-hidden="true" className="text-slate-300">→</li>
            <li className="rounded-full bg-success-bg px-3 py-1.5 text-success-ink ring-1 ring-success-ink/15">FINANCE CONFIRMATION</li>
            <li aria-hidden="true" className="text-slate-300">→</li>
            <li className="rounded-full bg-lavender-bg px-3 py-1.5 text-lavender-ink ring-1 ring-lavender-ink/15">SUPPLIER PORTAL</li>
          </ol>
        </div>

        <div className="order-3">
          <ChequeRegister className="mx-auto w-full max-w-xs" />
          <p className="mt-2 text-center text-[11px] font-semibold tracking-widest text-slate-400">CHECK REGISTER</p>
        </div>
      </section>

      <footer className="mx-auto w-full max-w-6xl px-6 py-6 text-center text-xs text-slate-400">
        Internal Finance system of the RCL group. Authorised users only.
      </footer>
    </main>
  )
}
