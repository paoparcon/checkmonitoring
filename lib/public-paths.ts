/**
 * Which paths the session middleware lets through WITHOUT a session.
 *
 * Pure, and separated from `middleware.ts` so it can be tested with literals.
 * That matters more than it used to: CLAUDE.md long said the middleware never
 * runs, because a local `next build` leaves the middleware manifest empty. On
 * 2026-09-11 production was measured doing the opposite — `/api/cron/sync`
 * answered 307 to `/login` with NextAuth's own cookies set, on a request that
 * carried a bearer and no session. Vercel's build registers the file; the
 * local one does not. So this list is a real control in production, and a
 * path missing from it is a route that silently becomes a login page.
 *
 * The page guards (`requireUser` / `requireAdmin`) remain the PRIMARY control
 * and must stay: a bad edit here must not be able to expose a page, and a
 * local build that drops the middleware entirely must leave the app protected.
 * This list only decides what the middleware waves through; every path on it
 * guards itself.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    // Exact match, not `startsWith('/login')`: a future `/loginhelp` would
    // otherwise be public.
    pathname === '/login' ||
    // The landing page (2026-09-27): the two machines and a SIGN IN button,
    // reading no data. Exact match for the same reason as `/login`.
    pathname === '/welcome' ||
    // Self-registration (2026-10-09). Creates an INACTIVE account only; the
    // page guards itself (a signed-in visitor is redirected) and reads no
    // data. Exact match for the same reason as `/login`.
    pathname === '/signup' ||
    pathname.startsWith('/api/auth/') ||
    // The scheduled sync. Vercel's cron presents `Authorization: Bearer
    // <CRON_SECRET>` and never a session cookie; the route checks that bearer
    // itself on its first line and refuses outright while the secret is unset.
    // Redirected to `/login` it would "succeed" every evening — a 307 is not
    // an error to a cron log — and never read a row.
    pathname.startsWith('/api/cron/')
  )
}
