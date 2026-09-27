# Authentication and tenant / landlord workspaces

The existing app now requires email/password sign-in and has separate tenant and
property-manager interfaces. MongoDB Atlas stores users, revocable login
sessions, and the shared repair workflow. Existing evidence, Gemini, Photon,
Nessie, NYC Open Data, and guarded XRPL integrations remain available.

## Configure and seed

Keep real credentials in ignored `.env.local`:

```dotenv
MONGODB_URI=<your Atlas connection string>
MONGODB_DATABASE=rentescrow
RENTESCROW_STORAGE=mongodb
```

Use the existing `MONGODB_DATABASE` setting and an Atlas database user with
read/write access. Configure Atlas network access for the
machine running the app. Then:

```sh
pnpm install --frozen-lockfile
pnpm db:check
pnpm seed:users
pnpm dev
```

The seed command reads `.env.local`, upserts exactly these three demo users,
creates indexes, and creates tenant workspaces and the managed demo property.
Rerunning it preserves IDs, cases, assignments, and financial history, while
restoring the documented demo password hashes. It does not delete other data.
It prints only each account's email, role, and display name.

| Display name | Email | Demo password | Role |
| --- | --- | --- | --- |
| Rayaan | tenant1@rentescrow.demo | TenantDemo123! | Tenant |
| Jordan Lee | tenant2@rentescrow.demo | TenantDemo123! | Tenant |
| Alex Morgan | landlord@rentescrow.demo | LandlordDemo123! | Landlord |

## Data and authentication

- `users`: ObjectId, normalized unique email, bcrypt password hash, role,
  display name, and timestamps. No plaintext passwords are stored.
- `auth_sessions`: SHA-256 digest of a cryptographically random 32-byte token,
  user ObjectId, creation time, and 30-day expiry. A unique token index and an
  expiry TTL index are created. Expiry is checked on every lookup, independently
  of MongoDB's eventual TTL cleanup.
- `sessions`: the existing tenant workspace aggregate. Each document has a
  stable owner key derived from the user ObjectId, tenant identity, cases,
  assignments, messages, repair actions, evidence metadata/analysis, timelines,
  normalized Nessie context, and escrow/public settlement metadata. This is
  distinct from the revocable login session collection.
- `properties`: the seeded managed property and its assigned landlord.
- `evidence.files` / `evidence.chunks`: GridFS evidence content, bound to its
  tenant workspace, case, and evidence ID.
- `operation_locks` / `xrpl_journal`: shared operation coordination and durable
  public pending/validated XRPL transaction records.

Passwords use `bcryptjs` with cost 12 and an independent random salt for each
hash. Login compares the submitted password against the stored hash. Unknown
emails also run a bcrypt comparison and receive the same generic error as a
wrong password. API responses never include a password or password hash.

The sign-in role chooser sends an optional `expectedRole` of `tenant` or
`landlord`. The server verifies the credentials first, then compares that choice
with the account's stored role before creating a session. A mismatch returns
`403 ROLE_MISMATCH` with guidance to select the account's actual role. The
choice never assigns or changes an account role, and clients that omit it keep
the existing role-agnostic login behavior.

The browser receives only the opaque token in an HttpOnly, SameSite=Strict
cookie, Secure in production. The server hashes the token, looks up an unexpired
session, and loads the authoritative user from MongoDB on every request. Logout
deletes the server session and clears the cookie. No browser-supplied role or
user ID grants authority. Mutations require a same-origin request.
Open tabs revalidate on focus, visibility, and periodically. Login/logout sends
a browser notification to refresh other tabs; it contains no identity or token.

## Routing, ownership, and privacy

`/` routes unauthenticated visitors to `/login`, tenants to `/tenant`, and
landlords to `/landlord`. Opposite-role page visits redirect safely. Tenant
APIs reject landlords with `403 ROLE_NOT_ALLOWED`; unauthenticated API requests
return `401 AUTH_REQUIRED`.

Rayaan owns case `RE-1042`, for 123 Example Street, apartment 4B. The case stores
Rayaan's `tenantUserId`, Alex's `landlordUserId`, and a property ID. Jordan starts
without cases. Every tenant request resolves its workspace from the signed-in
user and checks case ownership; guessing Rayaan's case ID returns
`403 CASE_ACCESS_DENIED`. Dashboard, evidence, messages, finances, exports, and
settlement share this boundary. Resetting Jordan's demo keeps it empty.

New tenant cases receive tenant ownership from server state. Cases at the known
demo property receive its existing manager assignment. Other addresses remain
unassigned; typing a landlord name or supplying a request-side user ID cannot
grant access. Self-documentation cases remain private to the tenant.

The landlord has a separate workspace and API. The server resolves assigned
cases and constructs an explicit allowlist of shared fields. It shares the
issue, relevant evidence and analysis, messages, operational timeline, repair
records, disputed amount, escrow status, and settlement status. It excludes
private receipts, financial timeline details, Nessie IDs, balances, transaction
history, provider conversation metadata, wallet authorization, and signing
credentials. Error responses also exclude internal case and policy objects.

Alex may message the tenant, schedule maintenance, upload repair evidence, and
report completion. Alex cannot fund or release escrow, initiate XRPL payment,
alter wallets/amounts, change banking bindings, or confirm on the tenant's
behalf. Completion records the case, manager ID, time, notes, and latest repair
evidence reference. It moves the case to verification without resolving it.
Manager uploads are always marked as landlord evidence (`other`) and cannot
satisfy the tenant's before/after verification. Structured repair actions control
state; free-form messages and notes cannot alter financial authority. Authenticated
tenants cannot simulate or paste landlord replies through the tenant action API.
Manager uploads are rejected after tenant verification or confirmation so they
cannot invalidate a tenant's completed review.

Only Rayaan's server-seeded workspace may use the configured Testnet signer.
Jordan's workspace cannot enable, settle, reconcile, or inspect that signer via
the security demonstrations. This capability stays in server state and is never
accepted from the browser. Simulated USD features remain available to Jordan's
own cases.

## Full demonstration

1. Open `/login`, choose Tenant 1, and sign in as Rayaan.
2. Open `RE-1042`: inspect the no-heat report, 54°F sample, Finances, and $400
   disputed amount. Refresh financial context when needed.
3. Approve a landlord message in Messages. With Photon disabled it stays in the
   shared case thread. Set aside $400 simulated USD in Escrow.
4. Sign out; choose Property manager and sign in as Alex. Review the assigned
   case, evidence, and thread. Open Repairs, enter an appointment and notes,
   optionally upload a repair photo, then report completion with notes.
5. Sign out and sign back in as Rayaan. The completion and timeline persist.
6. Upload a new after-repair photo and analyze it with configured Gemini. For
   the deterministic demo, use **Add after photo** and analyze the clearly
   labeled 72°F sample instead. Real uploads remain unverified without Gemini.
7. Select **Verify repair**, then **Confirm repair is complete**. Review and
   release the simulated escrow. If Testnet settlement is enabled, its separate
   review, policy checks, and validated receipt remain required.
8. Sign out and sign in as Jordan. Rayaan's case and banking information are
   absent, and direct requests for `RE-1042` are rejected.

Nessie and Photon operator bindings use the stable `workspaceOwnerId` returned
by authenticated `/api/auth/me`. Previous anonymous workspace IDs do not migrate
automatically. Bind providers deliberately using the existing integration setup
guides. Never copy API keys or wallet seeds into a user or case document.

## Verification and limits

Implementation files are grouped around their responsibilities:

- `src/lib/server/auth.ts`, `auth-store.ts`, `password.ts`, `http.ts`,
  `src/app/api/auth/*`, and `scripts/seed-users.ts`: accounts and login sessions.
- `src/lib/types.ts`, `src/lib/server/store.ts`, `case-access.ts`, `cases.ts`,
  `contracts.ts`, `landlord.ts`, and tenant/landlord API routes: ownership,
  privacy projections, repair actions, and role enforcement.
- `src/app/{page,login/page,tenant/page,landlord/page}.tsx`,
  `src/components/{login-form,landlord-workspace,rent-workspace}.tsx`, and
  `use-session-guard.ts`, `case-panels.tsx`, and `globals.css`: login and separate
  role interfaces with session invalidation.
- `mongodb-lock.ts`, `mongodb.ts`, `xrpl-journal.ts`: MongoDB operation
  coordination and durable settlement recovery.
- `tests/auth.test.ts`, `role-authorization.test.ts`, `mongodb-xrpl.test.ts`,
  the existing XRP tests, and `tests/e2e/*`: regression coverage.
- `scripts/e2e-server.ts`, `scripts/verify-e2e-seed.ts`, Playwright/Next/TypeScript
  configuration, package files, `.env.example`, README, and integration guides:
  isolated verification and setup documentation.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

`bcryptjs` is the new runtime dependency. `mongodb-memory-server` is a test-only
dependency; browser tests run against a disposable real MongoDB process with
external integrations disabled, including live messages and XRPL submissions.
Coverage includes credentials, hash/session persistence, logout, expiry,
ownership, role restrictions, financial redaction, malicious landlord text,
repair verification, and the existing provider policy tests.

Atlas must be configured before the real app can sign in; authentication never
falls back to anonymous access. Only the three demo accounts are provisioned.
There is no OAuth, signup UI/API, password reset, email verification, or MFA.
Property reassignment, production account administration, and new bilateral
contract signing across roles are not part of this demo. Existing self-documentation
contracts remain tenant-only; a tenant cannot impersonate the landlord when
accepting a contract.

MongoDB operation locks do not expire automatically: a crash leaves a lock that
an operator must review against the durable journal and XRPL state before
removing. This avoids an expired lease allowing a second process to sign the
same payment. Publicly known demo credentials are unsuitable for personal
records on a public deployment. XRPL uses Test XRP; USD escrow remains a simulation.

Configured phone contacts and the two-sided iMessage walkthrough are documented in [Photon Spectrum](photon-spectrum.md). Phone numbers are contact destinations, never login credentials; ordinary account UI shows only masked numbers.
