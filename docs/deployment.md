# Deploying to `checkmonitoring.rclcompanies.com`

Target: Vercel, region `sin1` (Singapore) — the closest region to the Neon database in
`ap-southeast-1`, which matters because every page render makes several database round trips.

## DNS is already done

`checkmonitoring.rclcompanies.com` resolves to `216.198.79.1` / `216.198.79.65` — Vercel's anycast
addresses, the same ones `www.` and `supplier.` use. The hostname currently returns
`X-Vercel-Error: DEPLOYMENT_NOT_FOUND`, meaning it points at Vercel but has no project attached.

**So no DNS record needs creating.** Adding the domain to the Vercel project is the whole job.
(`portal.rclcompanies.com` returns the same error, so the Supplier Portal is served from somewhere
else — worth knowing before anyone assumes that subdomain is live.)

## Before the first deploy — three blockers

### 1. Deactivate the seeded accounts

`admin@rcl.test` and `finance@rcl.test` are **still active** in the application database, and their
passwords are committed in `prisma/seed.ts`. On a public URL that is an open door.

They cannot be deleted — a `User` row is referenced by `AuditLog` and five `Check` relations, so
deleting one would orphan the record of who released real money. **Deactivate them** from
ADMINISTRATION → USERS, signed in as a real admin. The screen carries a banner until this is done.

### 2. Login rate limiting must be in place

Its absence was accepted **on the explicit basis that deployment would be internal-only**. A public
URL removes that basis. Do not deploy publicly until this has landed.

### 3. A second admin account

Only one account currently holds `FINANCE_ADMIN`. The last-admin guard means a forgotten password on
that one account leaves nobody able to administer the system, and there is no delete-and-reseed
path. Promote the second real account.

## Environment variables to set in Vercel

Set for **Production** (and Preview, if previews are enabled — a preview deployment pointed at the
production database is a real hazard; prefer giving Preview the test database or disabling it).

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | The Neon **pooled** endpoint (`-pooler`). Serverless opens many short-lived connections; the direct endpoint will exhaust its limit. |
| `DIRECT_DATABASE_URL` | The Neon **direct** endpoint. Used only by migrations. |
| `AUTH_SECRET` | **Generate a NEW one for production.** Do not reuse the development value — it exists in a local `.env` and anyone holding it can forge a session cookie. `openssl rand -base64 32`. |
| `AUTH_URL` | `https://checkmonitoring.rclcompanies.com` |
| `AUTH_TRUST_HOST` | `true` — required behind Vercel's proxy, or NextAuth will not trust the forwarded host and callbacks break. |
| `ACUMATICA_ODATA_URL` | as in local `.env` |
| `ACUMATICA_ODATA_URL_MFG` | as in local `.env` |
| `ACUMATICA_ODATA_USER` | as in local `.env` |
| `ACUMATICA_ODATA_PASSWORD` | as in local `.env` |
| `ACUMATICA_GI_NAME` | as in local `.env` |
| `CRON_SECRET` | `openssl rand -base64 32`. Vercel presents it as a bearer when it calls `/api/cron/sync` daily at 18:00 Manila; the route refuses to run while it is unset. |

**Do not set `DATABASE_URL_TEST` or `DIRECT_DATABASE_URL_TEST` in Vercel.** Nothing in production
should be able to reach the test database, and the test-database guard in `tests/helpers/db.ts`
refuses to run when they are absent — which is the correct failure.

## Deploy

```bash
npx vercel link          # once, to associate this directory with a Vercel project
npx vercel --prod
```

Then in the Vercel dashboard: **Project → Settings → Domains → Add** `checkmonitoring.rclcompanies.com`.
Because DNS already points at Vercel, verification should complete without a record change.

## Migrations

Vercel does not run migrations. Run them yourself, from a machine that has the direct URL:

```bash
node scripts/migrate.mjs prod --confirm
```

The connection string contains `&`, which breaks shell invocations of the Prisma CLI; the script
passes the URL in `argv` with no shell, and prints the host and database it is about to touch.
`node scripts/migrate.mjs test` does the same to the test database, which every migration must
reach before the suite is run.

**Run this before `npx vercel --prod`, not after.** `app/page.tsx` now calls `getSyncOverview`,
which selects every `SyncRun` column including `trigger`. Deploy the new code against an
unmigrated database and the dashboard's Prisma client asks for a column that is not there — every
user gets a broken home page, not a degraded one. The reverse order is harmless: the old client
running a moment longer against a migrated database simply never asks for `trigger`, and the
column has a default for the rows it doesn't yet know about. Order is not a preference here; it is
the difference between "nothing changed yet" and "the app is down".

## After the first deploy — verify, do not assume

1. `https://checkmonitoring.rclcompanies.com/` redirects to `/login`.
2. `/admin/users` **while signed out** redirects to `/login`. This is the guard that actually
   protects the app — see the note on middleware below.
3. Sign in as a real admin; the dashboard renders with the seeded reference data.
4. Confirm the seeded accounts show as DEACTIVATED.
5. Trigger a sync from `/admin/sync` and confirm a `SyncRun` row appears with its tenant.
6. Press SYNC NOW once more for EACH tenant on `/admin/sync` before the cron ever fires. The route
   reads both tenants inside one 60-second function, and on the very first scheduled run the
   incremental window is as wide as it will ever get — GOLIVE roughly 33 hours behind,
   MANUFACTURING roughly 3.4 days — with no floor under it: a run the timeout kills never advances
   its watermark, so the next day's window only gets wider. A manual SYNC NOW per tenant is its own
   function invocation with its own 60 seconds, so both watermarks are minutes old by the time the
   schedule first runs, and the first scheduled run has an ordinary window to read.
7. Vercel dashboard → Project → Settings → Cron Jobs lists `/api/cron/sync` at `0 10 * * *`.
   Trigger it once from there. `/admin/sync` then shows a run per tenant with trigger SCHEDULED.
   The next evening at 18:00 Manila, two more appear unprompted — and the dashboard's
   ACUMATICA LAST READ line moves.

## `middleware.ts` runs on Vercel, not locally

A clean local `next build` leaves the middleware manifest empty — Node-runtime middleware
(`export const runtime = 'nodejs'`) is not registered by Next 15.5.25's local build. **Vercel's
build registers it.** Measured 2026-09-11: production answered an unauthenticated
`GET /api/cron/sync` with 307 to `/login` and NextAuth's cookies, on a route that has no session
guard of its own.

**The application is protected regardless**, by the page-level `requireUser()` / `requireAdmin()`
guards that Plan 1 introduced specifically so "a bad matcher edit cannot silently expose pages".
That remains the primary control. The middleware is a second layer with one job that matters in
production: what it waves through. `lib/public-paths.ts` is that list, tested; a route a machine
calls with a bearer — the scheduled sync — must be on it and must guard itself, or every call is a
redirect to a login page that the caller reports as success.

**Every request-time control must therefore live in the request path** — a page guard, a server
action, or the `authorize` callback — never in middleware. A control placed in `middleware.ts` will
pass tests that import it directly and protect nothing in production.

Do **not** delete the file as dead code — earlier text here suggested that, on the belief it never
ran. In production it does, and removing it would drop a working layer. Keep it, keep the page
guards, and keep `isPublicPath` in step with every machine-called route.

## The historical load

The 12,227-row register import has been proven twice against the **test** database
(run 1: 9,247 created / 214 updated; run 2: 0 created / 9,461 updated — idempotent). It has **not**
been run against production. It takes roughly 50 minutes.

Use the dry run first — it predicts the outcome exactly — so Finance can see the 2,766 staged rows
before anything is written:

```bash
npx tsx scripts/import-workbook.ts "CHECK MONITORING 9.1.2026.xlsx" --dry-run
```

## Vercel's DDoS Mitigation blocks the office — and the bypass rule did not stop it

**Symptom.** A white page reading *"This request was blocked — 403 FORBIDDEN — sin1::…"*. That
page is Vercel's firewall, not this app: the response carries `x-vercel-mitigated: deny` and its
`X-Vercel-Id` has a single `sin1::` prefix, meaning the request never reached the function (a
served request reads `sin1::sin1::…`). Nothing in the repository produces it and nothing in the
repository can stop it.

**Measured 2026-09-28, 06:54–07:07 Manila** (Firewall → Traffic, denied): 10 requests, all from
`58.69.113.55` (PLDT — the RCL office), all JA4 `t13d1518h2_8daaf6152771_e2d80978ab2e`, all
Chrome 153 on Windows, rule **DDoS Mitigation**, paths `/`, `/vouchers`, `/welcome`,
`/admin/sync`, `/forecast`. The same day's total was 283 allowed with a peak of 40 requests a
minute — nothing like a flood, and the app has no polling loop (measured: no `setInterval`, no
`useSWR`, table links carry `prefetch={false}`). What decided it was the client fingerprint:

- From the same machine and IP, `curl` and the Claude desktop app's Chromium loaded every page.
- From the blocked Chrome, `fetch('/welcome', { credentials: 'omit' })` was **200** and
  `fetch('/welcome', { credentials: 'include' })` was **403 / deny** — back to back, repeatedly,
  for at least 13 minutes.
- A 12 KB cookie, and cookie values shaped like SQL injection and XSS, sent from the browser that
  was passing, still passed. It is not the cookie content; it is that signed-in traffic from this
  IP + JA4 + user agent has been fingerprinted as an attack.

**The documented remedy was already in place and did not hold.** A System Bypass rule for
`58.69.113.55` on host `checkmonitoring.rclcompanies.com` was created 2026-09-25 (Firewall →
Rules, note *"RCL office (PLDT) - false-positive DDoS blocks 2026-09-25"*), after the first
episode. Vercel's docs say such a rule ensures an IP is "never blocked by the Vercel Firewall's
system mitigations". It was blocked anyway. That is Vercel's defect to explain, and the support
ticket below is the route to a fix that holds.

**Diagnose in one minute, next time.**

```bash
curl -sS -o /dev/null -D - https://checkmonitoring.rclcompanies.com/welcome | grep -iE "^(HTTP|x-vercel)"
```

A 200 here while a browser shows the block page means the block is per-client, not the site.
Then, in the blocked browser's console:

```js
for (const credentials of ['include', 'omit']) {
  const r = await fetch('/welcome', { cache: 'no-store', credentials })
  console.log(credentials, r.status, r.headers.get('x-vercel-mitigated'), r.headers.get('x-vercel-id'))
}
```

Then Vercel → project → **Firewall → Traffic**, filter Denied: the IP, JA4, user agent and the
rule that denied it are all listed. The bypass rules are listed by the API too:

```bash
curl -sS -H "Authorization: Bearer $VERCEL_TOKEN" "https://api.vercel.com/v1/security/firewall/bypass?projectId=prj_ZdotN0Gwt4OEGrvsaZrMHHeAmCDR&teamId=team_w8TDW4AcZogyBdf4yvm826Sd"
```

(The CLI's token is in `%APPDATA%\xdg.data\com.vercel.cli\auth.json`; never paste it anywhere.)

**What to do — a person with the Vercel account has to do all of it.** The coding agent's
permission mode refuses every firewall change as a security-weakening action, by design; it can
diagnose, it cannot unblock.

1. **Unblock the office now:** Firewall → **⋯** (top right) → **Pause System Mitigations**. It
   lasts 24 hours and Vercel bills traffic it would otherwise have dropped, which for this site is
   nothing. Confirm with the console snippet above: `include` should now read 200.
2. **Widen the bypass to the whole project.** The rule in place is scoped to one host name. Add a
   second one scoped to every domain of the project: Firewall → **Add New → System Bypass**, IP
   `58.69.113.55`, Domain `*`, note the date. Or, from a machine that has the CLI token:

   ```bash
   curl -sS -X POST -H "Authorization: Bearer $VERCEL_TOKEN" -H "Content-Type: application/json" "https://api.vercel.com/v1/security/firewall/bypass?projectId=prj_ZdotN0Gwt4OEGrvsaZrMHHeAmCDR&teamId=team_w8TDW4AcZogyBdf4yvm826Sd" -d '{"projectScope":true,"sourceIp":"58.69.113.55","note":"RCL office (PLDT), project-wide, 2026-09-28"}'
   ```

   Do **not** reach for a WAF custom rule with a Bypass action instead: Vercel's own concepts page
   says a custom-rule bypass skips "any custom or managed rules" and only a *system* bypass skips
   "system-level mitigations".
3. **Open a Vercel support ticket** — this is the only step that can make it not happen again,
   because the mechanism Vercel documents for exactly this case is the one that failed. Paste:

   > Project `check-monitoring` (team `rcl-tax-and-compliance`, Pro). Your DDoS Mitigation is
   > denying our own office's signed-in traffic — IP 58.69.113.55, JA4
   > t13d1518h2_8daaf6152771_e2d80978ab2e, Chrome 153/Windows — on
   > checkmonitoring.rclcompanies.com, an internal finance app with ~300 requests a day. A System
   > Bypass rule for that IP and host has existed since 2026-09-25 and the denials continue.
   > Denied request IDs, 2026-09-27 22:54–23:06 UTC: `sin1::z918n-1790549671431-9fc5404cebf6`,
   > `sin1::s7bzt-1790549983422-d0dcf26d000c`, `sin1::rhq66-1790550017759-58568f7a2ba3`,
   > `sin1::tqn2r-1790550405861-8059c16b614c`. The identical request without cookies is allowed.
   > Please explain why the bypass is not honoured and exempt this source durably.

4. **If the office's public IP changes** (PLDT does not promise it stays), every bypass rule
   points at the old one. `curl https://api.ipify.org` from an office machine gives the current
   one; add it and keep the old until it is confirmed gone.

**Not a fix, but the way round it while blocked:** the block follows the cookie-carrying request
from that browser. A different browser engine (Firefox; the Claude desktop app's built-in
browser) from the same office loaded the site throughout.

**Same morning, later:** with System Mitigations **paused** for the whole project (the audit log shows
a `0.0.0.0/0` project bypass at ~00:09 UTC), the denials went on — 20 by 00:20 UTC, all still
attributed to "DDoS Mitigation", all still `58.69.113.55` / Chrome 153. So neither the IP bypass
nor the 24-hour pause reaches whatever is denying. **An Incognito window loaded the site at once.**
The block is bound to the cookies the normal Chrome profile holds for the site (all HttpOnly, so
the exact cookie cannot be read from a page), not to the IP, the machine or the browser build.
The way in, then, is: site-info icon → Cookies and site data → Manage on-device site data →
delete `checkmonitoring.rclcompanies.com` → reload → sign in. Which cookie carries the mark, and
why Vercel's own pause does not clear it, are the open questions in the support ticket. Until
Vercel answers, expect it to recur, and clear the cookies again when it does.

**Correction, 00:21 UTC:** the normal Chrome was served again with nothing changed on the client.
The audit log shows the pause created at ~00:08 UTC, the last denial is at ~00:11 UTC, and the
Traffic view stayed at 20 denied afterwards. So the pause most likely did take effect, after about
three minutes of propagation — the "pause did not help" reading above was measured inside that
window. The alternative, that the mitigation simply expired ~77 minutes after it started, cannot be
ruled out from here. Either way: a pause is measured five minutes after it is set, not one, and it
lapses on its own after 24 hours, so the project-wide bypass (step 2) goes in before it does.

**Root cause, from Vercel support (case 010fc6txWb6faq46, 2026-09-30), confirmed here 2026-10-01.**
Vercel: the denied requests for `checkmonitoring.rclcompanies.com` "arrived over TLS connections
using a different server name." That is Chrome's HTTP/2 connection coalescing (RFC 9113 §9.1.1):
`checkmonitoring.rclcompanies.com` and `supplier-portal.rclcompanies.com` are both on Vercel, both
speak h2, and both present the **same wildcard certificate** (`*.rclcompanies.com`,
`rclcompanies.com` — measured with `openssl s_client`). When a Supplier Portal tab is open, Chrome
reuses that TLS connection (SNI = supplier-portal) for requests to checkmonitoring, and Vercel's
DDoS Mitigation reads SNI ≠ Host as domain fronting and denies. Every measurement follows:

- Credentialed and credential-less fetches use separate socket pools in Chrome, which is why
  `credentials: 'include'` rode the coalesced connection and was denied while `omit` opened a
  fresh one and passed. It was never about the cookies themselves.
- `curl`, the desktop app's Chromium, and Incognito each opened their own connection with the
  right SNI. The office IP was never the key, so no IP bypass and no pause could reach it.
- It "cleared by itself" when the coalesced connection was closed (idle timeout or the portal tab).

**Way in, immediately:** close the Supplier Portal tab(s) and reload, or use Incognito.
**Fix that holds:** either Vercel answers such requests with `421 Misdirected Request` (the
standard signal that makes Chrome retry on a new connection) instead of a firewall deny, or the two
sites stop sharing a certificate — ask Vercel to issue `checkmonitoring.rclcompanies.com` its own
certificate rather than the team wildcard, after which Chrome cannot coalesce. Both are Vercel-side
requests, made on the ticket. Nothing in this repository can prevent it.

Vercel Hobby crons run at most once per day per job; the 12:00 and 18:00 Manila runs are two entries in vercel.json on the same path. A third run means a third entry.

**Vercel's position, 2026-10-03 (Nick, case 010fc6txWb6faq46):** no denials after 27 Sep 17:10 PDT
(00:10 UTC 28 Sep — the cutoff measured here); the same fingerprint was served on 1 and 2 October;
"not currently recurring"; report a new 403 with time and request ID so they can tell "whether the
same connection-coalescing condition has returned". **Nothing was changed on their side.**
Re-measured 2026-10-05: both hosts still present the identical certificate (same serial,
`*.rclcompanies.com`) and resolved to the same IP, so Chrome can still coalesce. The condition
stands; only the mitigation that punished it has gone quiet. Treat a recurrence as expected.

**2026-10-08:** after the reply above (same certificate serial, same IP, so coalescing still
possible), Nick escalated the case to Vercel's engineering team for review. Awaiting their answer
on the two fixes asked for: a 421 instead of a deny on coalesced connections, or a per-host
certificate for `checkmonitoring.rclcompanies.com`. No recurrence reported since 28 September.

**RESOLVED by Vercel, 2026-10-17 (case 010fc6txWb6faq46):** "We have updated how these HTTP/2
connection-coalescing requests are handled. Instead of being denied with a 403 by the rule, the
connection should now receive a 421 response, allowing Chrome to retry the request using the correct
connection." **Verified 2026-10-19 from the office:** an HTTP/2 request with `:authority`
checkmonitoring sent over a TLS connection opened for supplier-portal (Node `http2`, the exact
coalesced case) is now served — 200 on `/welcome`, 307 on `/` — with no `x-vercel-mitigated`; and in
Chrome, signed in with a Supplier Portal tab open, three credentialed requests in a row were 200 and
the dashboard rendered. The certificate is still the shared wildcard (same serial), so coalescing
still happens; it is simply no longer punished. The 25 September System Bypass rule for the office IP
can stay — it is harmless and was never the lever. If the block page ever returns, the first check
is the same: credentialed vs credential-less fetch, then Firewall → Traffic.
