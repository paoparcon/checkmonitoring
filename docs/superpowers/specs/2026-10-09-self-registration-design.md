# Self-registration with admin approval — design

**Date:** 2026-10-09
**Status:** approved in conversation, awaiting implementation plan
**User request:** "i need sign page to create an account. admin will assign the role"

## 1. What this is

A public `/signup` page where a Finance person creates their own account. The
account does nothing until a FINANCE_ADMIN approves it on `/admin/users` and
chooses its role. Until then it is inactive, which is already the one state
this system has for "cannot sign in" (`authorize` in `auth.config.ts` refuses
an inactive account), so no new access path is opened anywhere.

Decisions taken in the brainstorm, in order:

1. **A fresh registration can do nothing** until approved. Not "Finance User
   straight away, promote later" — this is an internet-facing finance system.
2. **Any email address may register.** No company-domain restriction. The
   admin's PENDING list is the filter; a per-address throttle bounds the junk.
3. **Approach A: a pending flag on `User`**, not a third `Role` value and not a
   separate `Registration` table.
4. **Registering with the address of an inactive account re-opens that
   account** rather than being refused. Raised when the user asked to delete
   three deactivated accounts (Ayessa Morinne, Lusie Castroverde, Mary Queen
   Ecat) so the same people could register again. Rule 6 (no delete-user path)
   stands; the re-registration rule makes the delete unnecessary.

Rule 1 (INTERNAL USE ONLY) is untouched: a registered account is a Finance
account awaiting a Finance Admin. Nothing here is a supplier login.

## 2. Data model

One new nullable column on `User`:

```prisma
/// Set when the account was created (or re-opened) by self-registration and
/// no admin has yet approved or rejected it. Cleared by both. An account is
/// PENDING when `active = false AND pendingSince IS NOT NULL`; an inactive
/// account with this null is DEACTIVATED, exactly as before.
pendingSince DateTime?
```

One new table, modelled on `LoginAttempt`:

```prisma
model RegistrationAttempt {
  id        String   @id @default(cuid())
  /// As `clientIp()` derived it, or the literal 'unknown'. Never null — a
  /// shared 'unknown' bucket over-throttles, which is the right way to be wrong.
  ip        String
  email     String
  createdAt DateTime @default(now())

  @@index([ip, createdAt])
}
```

Migration `20261009000000_self_registration` adds both. It must reach the TEST
database before the suite runs (`node scripts/migrate.mjs test`) and production
before the deploy (`node scripts/migrate.mjs prod --confirm`).

No change to `Role`. A pending account carries the schema default
`FINANCE_USER`, which nothing reads while it is inactive; the admin's approval
overwrites it.

## 3. Domain rules — `lib/admin/users.ts`

"Pending" is defined once, here, and every screen reads this definition:

```ts
export const isPending = (u: { active: boolean; pendingSince: Date | null }) =>
  !u.active && u.pendingSince !== null
```

### `registerUser(db, { email, name, password, ip })`

- Same email normalisation (`lowercase().trim()`), the same name requirement
  and the same password policy (`validatePasswordStrength`) as `createUser`.
  The password is read untrimmed by the action, as the admin form does.
- Hash before the transaction opens (argon2id is slow; do not hold a
  connection through it).
- Inside one transaction, look the address up:
  - **No row:** create `{ email, name, passwordHash, active: false,
    pendingSince: now }`. Audit `user_registered`.
  - **Row exists and is ACTIVE:** throw `DomainError('EMAIL_TAKEN',
    'An account for that address already exists.')`. The admin-facing wording
    about reactivating is NOT used here; a stranger is owed no detail.
  - **Row exists and is INACTIVE** (deactivated or already pending): update
    `{ name, passwordHash, pendingSince: now }`, leave `active: false`. The row
    keeps its id and every attribution it carries. Audit `user_reregistered`.
- Both audit rows are `actorType: 'SYSTEM'`, `userId: null`, `checkId: null`,
  with `details: { targetUserId, email, name }` and `remarks: email`. Never the
  password, never the hash.
- Also races the unique index: a concurrent create on the same address is
  caught as P2002 and reported with the same EMAIL_TAKEN sentence.
- **Returns `void`.** There is no shape in which the row — and so the hash —
  can be serialised to the browser.

### `approveUser(db, { userId, role, actorId })`

- Loads the target in a transaction; refuses with `NOT_PENDING` unless
  `isPending`.
- Sets `{ role, active: true, pendingSince: null }`. Audit `user_approved`,
  `details: { targetUserId, email, role }`.
- No last-admin guard applies: approving can only add an active account.

### `rejectUser(db, { userId, actorId })`

- Refuses unless `isPending`.
- Sets `{ pendingSince: null }`; `active` stays `false`. The row is now an
  ordinary DEACTIVATED account: it keeps the address out of a second
  registration landing silently, and the admin can REACTIVATE it later from
  the table if the rejection was a mistake. Audit `user_rejected`.

### Changes to existing functions

- `setUserActive(active: true)` on a pending row throws `DomainError('PENDING',
  '<name> is waiting for approval. Approve them with a role from the PENDING
  APPROVAL list instead.')` — a pending account must not be activated without
  a role being chosen deliberately.
- `changeUserRole` and `setUserPassword` on a pending row are left as they
  are: harmless on an inactive account, and the approval overwrites the role.
- `AdminUserRow` gains `pendingSince: Date | null` and
  `previouslyDeactivated: boolean`. The second is true when the account's most
  recent registration audit row is `user_reregistered` — one query over
  `AuditLog` for the pending ids, inside `listUsers`, so the PENDING list can
  state "re-registered, previously deactivated" against the row.
- `ROW_SELECT` gains `pendingSince`.
- The export-shape test (`tests/admin/users.test.ts`) pins the three new names
  and `isPending`, and still asserts no delete.

## 4. The sign-up page — `/signup`

### Reachability

- `isPublicPath` gains `pathname === '/signup'` (exact match, same reason as
  `/login`). `tests/public-paths.test.ts` pins `/signup` open and `/signupx`
  closed.
- The page guards itself: a signed-in visitor is redirected to `/`, as
  `/login` does. It reads no data from the database and shows no figure — it
  is a page a stranger can load.

### The form (`app/signup/page.tsx`)

- Same two-panel layout as `/login`: `MoneyMachines` on the left, the card on
  the right, the same field classes, so it reads as the same system.
- Fields: NAME, EMAIL, PASSWORD, CONFIRM PASSWORD. Button: CREATE ACCOUNT.
- The password policy from `lib/password.ts` is stated under the password
  field before anyone types, so nobody is refused after the fact.
- `autoComplete`: `name`, `username`, `new-password`, `new-password`.
- Links: "Already have an account? Sign in" to `/login`; "Back to the front
  page" to `/welcome`.
- `/login` gets one line under the card: "Need an account? Create one" →
  `/signup`. `/welcome` gets a CREATE ACCOUNT link beside SIGN IN.

### The action (`app/signup/actions.ts`, `registerAction`)

In order:

1. Read the fields. Trim name and email; password and confirmation untrimmed.
2. If the two passwords differ → `{ ok: false, message: 'The two passwords do
   not match.' }` before any database work.
3. `clientIp(headers())` → `registrationLockout(prisma, { ip, now, limit })`.
   If refused → `{ ok: false, message: 'Too many accounts have been created
   from this connection. Try again later.' }`. The attempt is still recorded
   (step 5), so hammering extends the wait.
4. `registerUser(prisma, …)`. A `DomainError` comes back verbatim (the
   password policy's own wording, the EMAIL_TAKEN sentence). Anything else is
   `console.error`ed — the thrown error only, never the form data — and the
   user gets 'Something went wrong. Please try again.' Next control-flow errors
   are rethrown (`isNextControlFlowError`).
5. `recordRegistrationAttempt(prisma, { ip, email, now })` — written whether
   the registration succeeded, was refused by the throttle, or was refused by
   the domain.
6. `{ ok: true }`.

### After success

The card is replaced by one message: the account for `<email>` has been
created and is waiting for a Finance Admin to approve it; their admin will
tell them when they can sign in. Nothing else about the account is echoed.
No session is created.

### What a pending account sees at `/login`

"Invalid email or password." — the same as every other refusal. The generic
error is deliberate (see the throttle note on the login page) and is not
touched. The success message above already told them to wait.

## 5. The registration throttle — `lib/registration-throttle.ts`

Modelled on `lib/login-throttle.ts`, and for the same reason the counter lives
in Postgres: Vercel is serverless, a module-scope `Map` is per-instance and
starts at zero on every cold start.

- `registrationLockout(db, { ip, now, limit }) → { locked: boolean }`: counts
  `RegistrationAttempt` rows for `ip` with `createdAt > now - 60 min`; locked
  when the count is at or above `limit`.
- `recordRegistrationAttempt(db, { ip, email, now })`.
- `pruneRegistrationAttempts(db, now)`: deletes rows older than 30 days
  (`RETENTION_DAYS`, shared with the login throttle). Not scheduled; exported
  for a one-off clear-out, exactly as `pruneLoginAttempts` is.
- One bucket only, per address. There is no per-email bucket: an email is the
  thing being created, not a thing being guessed.

The limit is a setting: `signup.ipPerHour`, group `LOGIN`, label
`REGISTRATIONS PER ADDRESS PER HOUR`, unit `accounts`, default **5**, min 1,
max 100. Default constant `DEFAULT_SIGNUP_IP_PER_HOUR` in
`lib/settings/defaults.ts`; `IntKey` gains the key; the "eleven settings" in
CLAUDE.md's layout table becomes twelve. `registerAction` reads the value
through `loadSettings` at request time, never the constant.

## 6. The admin side — `/admin/users`

### PENDING APPROVAL section

Above `CreateUserForm`, rendered only when at least one account is pending.
One row per pending account, newest `pendingSince` first:

| Column | Content |
| --- | --- |
| NAME | as typed |
| EMAIL | normalised address |
| REGISTERED | `pendingSince`, en-PH long form like LAST LOGIN |
| ORIGIN | "New account" or "Re-registered — previously deactivated" (from `previouslyDeactivated`) |
| ACTIONS | role `<select>` (FINANCE USER default) + APPROVE; REJECT |

The ORIGIN column is the admin's one defence against somebody re-registering a
deactivated colleague's address with their own password: the row says so, and
approval is a deliberate click per row. That is the same trust an admin
already extends to any pending registration, made visible.

A new client component `components/PendingUserActions.tsx` holds the two
controls, following `UserRowActions` exactly: `useTransition`, the
`AdminActionResult` shown in the row, `router.refresh()` on success. It takes
plain fields (`userId`, `name`), not the row.

### The USERS table

Excludes pending accounts (`!isPending`). They are neither active nor
deactivated, and shown there they would carry a REACTIVATE button that
refuses them. A rejected account appears in the table as DEACTIVATED like any
other, and REACTIVATE works on it as before.

The header's count line gains "· N PENDING APPROVAL" when N > 0.

### Admin tabs badge

`app/admin/layout.tsx` counts pending accounts (one `count` query) and passes
the number to `AdminTabs`, which renders it as a small badge on the USERS tab
when above zero. `AdminTabs`'s `tabs` tuple gains an optional third element,
the badge count; the other tabs pass none.

### Actions — `app/admin/users/actions.ts`

`approveUserAction(formData)` and `rejectUserAction(formData)`, in the shape
of the four existing ones:

- `requireUser()` first, outside any try; `if (user.role !== 'FINANCE_ADMIN')
  return { ok: false, message: ADMIN_ONLY }` — returned, never redirected.
- `approveUserAction` parses `role` with the existing `roleSchema`.
- Both go through `run()`, which additionally `revalidatePath('/admin',
  'layout')` so the tab badge updates.
- Return a bare `{ ok: true }`.

## 7. Audit

New action names, all written through `writeAudit`, all append-only under the
existing trigger:

| Action | Actor | Details |
| --- | --- | --- |
| `user_registered` | SYSTEM | targetUserId, email, name |
| `user_reregistered` | SYSTEM | targetUserId, email, name |
| `user_approved` | USER (admin) | targetUserId, email, role |
| `user_rejected` | USER (admin) | targetUserId, email |

`/admin/audit` lists actions from `SELECT DISTINCT`, so the four appear there
without a code change.

## 8. What is deliberately not built

- **No email verification and no password reset by mail.** The system has no
  mail path. A forgotten password is still `setUserPassword` by an admin.
- **No domain restriction** (decision 2). If junk registrations become a
  problem, a domain allow-list setting is the next step; the throttle is the
  first one.
- **No notification** beyond the tab badge and the count line.
- **No delete.** Rule 6. Re-registration makes the three accounts the user
  asked to delete reusable without one.
- **No change to the generic sign-in error.**

## 9. Tests

Narrow runs, per the usual practice; `npx tsc --noEmit` before claiming done.

- `tests/admin/users.test.ts`: register (new row inactive + pending, audit
  row, no return value); re-register on a deactivated row (same id, new name
  and hash, `user_reregistered`); re-register on a pending row; refusal on an
  active row with the short sentence; approve (role, active, flag cleared,
  audit); approve refused when not pending; reject (flag cleared, still
  inactive, audit); reject refused when not pending; REACTIVATE refused on a
  pending row; `listUsers` carries `pendingSince` and `previouslyDeactivated`;
  export-shape test extended.
- `tests/registration-throttle.test.ts` (new): under the limit admits; at the
  limit refuses; rows older than the hour do not count; `unknown` ip shares a
  bucket; prune.
- `tests/public-paths.test.ts`: `/signup` open, `/signupx` closed.
- `tests/settings/registry.test.ts`: the new key, its default and bounds.
- `tests/actions/signup.test.ts` (new): mismatched passwords refused before
  any write; throttle refusal still records the attempt; a domain error's
  wording passes through; success writes nothing but `{ ok: true }`.
- `tests/actions/admin-users.test.ts` (or wherever the existing four are
  pinned): the two new actions refuse a FINANCE_USER by returning.
- `tests/schema.test.ts` if it enumerates tables/columns: `RegistrationAttempt`
  and `User.pendingSince`.

## 10. Deployment order

1. `node scripts/migrate.mjs test`, run the narrow tests, `tsc`.
2. `node scripts/migrate.mjs prod --confirm`.
3. Deploy. `/signup` is live the moment the deploy is; nothing else needs
   switching on. The three deactivated accounts can register again at once.

## 11. Changes made during implementation (2026-10-09)

**Re-registration holds the typed credentials (§3).** The typed name and password go to `User.pendingName` / `User.pendingPasswordHash` (migration `20261009000200_pending_credentials`), not onto `name` / `passwordHash`. `name` is read live wherever a check says who signed or released it, and an anonymous submission must not rewrite that. `approveUser` copies them into place, `rejectUser` discards them, so REACTIVATE after a reject restores the genuine account, and `setUserPassword` discards a held hash (`heldPasswordDiscarded`). The `user_reregistered` audit row carries the typed `name`, `currentName` and `wasPending`.

**Races (§3).** Every read-then-write (`registerUser` re-open, `approveUser`, `rejectUser`, `setUserActive(true)`) is a conditional `updateMany` on the state it read. `approveUser` takes `seenPendingSince` (the admin page passes the displayed value) and refuses `REREGISTERED` / `NOT_PENDING` / `CHANGED` by re-reading.

**Throttle (§5).** `registrationLockout` was removed. `recordRegistrationAttempt` takes `pg_advisory_xact_lock(hashtext(ip))` with `lock_timeout = 3s`, inserts, counts the window including its own row, and returns `{ recent }`. The action records first and refuses when `recent > limit`. A submission that cannot be recorded is refused ('Could not register right now. Try again in a minute.'), never let through.

**The action (§4).** Length caps: email 254, name 200, password 1024 ('That entry is too long.'). A minimal email shape check (`EMAIL_INVALID`) sits in `registerUser` and `createUser`. Unexpected errors are logged as `name: first non-empty line`. The email field's `autoComplete` is `email`, not `username`.

**Admin (§6).** ORIGIN reads NEW ACCOUNT / REGISTERED AGAIN WHILE PENDING / RE-REGISTERED — PREVIOUSLY DEACTIVATED. The NAME cell shows `→ <pendingName>`, labelled NAME ON APPROVAL, when it differs. The row refreshes on every result. The settings group is retitled SIGN-IN AND SIGN-UP THROTTLES.

**`/login`.** A refused sign-in used to throw next-auth's `CredentialsSignin` out of the inline action and render a 500. It now redirects to `/login?error=CredentialsSignin`. This was already so on master; it is fixed here because pending accounts hit it.

**Accepted tradeoff.** 'An account for that address already exists.' confirms that an address holds an account. The throttle bounds how fast that can be probed.
