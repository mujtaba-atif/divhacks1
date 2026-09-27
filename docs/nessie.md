# Nessie Financial Verification

Nessie is Capital One's mock banking API. This integration verifies relationships
inside that sandbox; it is not real KYC, a real bank connection, or a payment
rail. MongoDB Atlas persists case state and reviewed expenses. Nessie supplies
banking context. The application escrow remains a separate simulated USD ledger.

## Configuration

Keep all credentials in ignored `.env.local`, never in `NEXT_PUBLIC_*`, source
code, screenshots, or a Git commit. An Atlas Administration API key is unrelated
to Nessie and is not needed.

```dotenv
NESSIE_ENABLED=true
NESSIE_API_KEY=your-private-nessie-key
NESSIE_TENANT_ID=the-server-issued-workspace-tenant-id
NESSIE_CUSTOMER_ID=the-approved-sandbox-customer-id
NESSIE_ACCOUNT_ID=the-approved-sandbox-account-id
NESSIE_RENT_PAYEE=RentEscrow Demo Landlord
NESSIE_BASE_URL=https://api.nessieisreal.com
```

For a new installation, sign in as the intended tenant and obtain its server-issued
`workspaceOwnerId` (also shown as RentEscrow tenant in Finances). Set that value as
`NESSIE_TENANT_ID`; do not use an email, MongoDB user ID, or a browser-supplied ID.
Provision or select a sandbox customer and its checking account,
set their IDs, enable Nessie, and restart the server. Then run:

```sh
pnpm nessie:check
```

The check performs only GET requests. It verifies the customer, account,
ownership, balance, purchases, and bills. It does not create records, move money,
or save a case. `NESSIE_CASE_ID` optionally changes its case label from `RE-1042`.
Open Finances to load and persist the live context automatically. **Refresh financial
profile** performs another read when needed. A cached live profile is rechecked on
every Finances entry, so changing server configuration cannot preserve a verified badge. An enabled but incomplete configuration
shows an error; it never displays the seeded demo balance as the live balance.

This prototype has one operator-configured tenant/customer/account mapping.
Authentication resolves the session cookie to a MongoDB user. The server derives
`workspaceOwnerId = SHA-256(user.id)` and checks the workspace's `tenantUserId`,
each case's owner, and each case's tenant user against that authenticated user.
`NESSIE_TENANT_ID` must equal that workspace owner. Signing out or using another
browser does not change this identity; signing in as a different tenant does.

The server pins the customer/account IDs from configuration to the current case ID.
Every refresh checks the saved binding and the provider's returned IDs and
`account.customer_id`. An existing live binding cannot silently switch customer
or account when configuration changes. The browser and AI cannot choose any of
these identifiers. Account linking remains an operator configuration task.

The read-only audit for this change confirmed the configured tenant matches
`tenant1@rentescrow.demo` and its saved workspace/case ownership. It also confirmed
that the existing default case still had a demo financial snapshot, explaining why
successful CLI connectivity alone did not make the original UI show live data.

## Optional Synthetic Records

With a private key configured, this opt-in command creates only fictional
records in the mock service:

```sh
pnpm nessie:seed --create-demo
```

It creates one customer, checking account, merchant, three purchases, and three
rent bills. It prints customer/account IDs, never the key. Save those IDs in the
configuration above. The script supports the current HTTPS origin only.

The ignored `.data/nessie-demo.json` manifest records each receipt. An exclusive
lock prevents simultaneous seeds. Every POST is marked pending before dispatch;
an uncertain response blocks retries until an operator reconciles that specific
record with Nessie. A completed manifest reuses IDs without duplicate writes.
Do not delete the manifest to retry or assume completed receipts mean records
still exist; run the read-only check afterward.

Live interoperability was verified on September 26, 2026. The current provider
returns UUID IDs. Bills required `recurring_date: 1` at creation to produce a
readable `upcoming_payment_date`; that latter field cannot be posted directly.
The service returned a submitted $47.99 purchase as $47.00. The app displays the
provider's returned value, not the requested seed amount. Balances and statuses
are always read back, never inferred from seed requests.

## Server Authorization

1. Load the case for the server-issued session owner.
2. Resolve its trusted tenant/case/customer/account binding from server state and
   operator configuration.
3. Fetch the expected customer and account, checking returned IDs and
   `account.customer_id`; validate balance and all transaction account IDs.
4. Evaluate deterministic policy against a server-constructed intent. Claimed
   IDs from untrusted text cannot replace the binding, amount, wallet, or escrow.
5. Permit only the requested action after all checks pass. Application XRPL
   Payment settlement refreshes the financial profile before authorization and
   rechecks its freshness immediately before signing. Isolated native escrow
   tooling additionally refreshes Nessie immediately before signing.

Verification expires after 60 seconds and is refreshed before financial
authorization. The isolated native escrow tooling requires API-backed Nessie
verification. Autonomous settlement now requires live Nessie verification, including
when the
workspace otherwise uses demo features. The existing explicit manual Testnet demo
flow is unchanged for cases that have neither a live binding nor a failed autonomous
financial gate; a demo result is never returned as trusted Nessie verification.
Missing configuration for an enabled provider,
timeouts, missing records, mismatches, invalid amounts/IDs, duplicate records,
and malformed responses fail closed with explicit reason codes. No live-bound
case falls back to fixtures. This includes a failed first live attempt: the case
retains source `nessie`, even if configuration was incomplete or the configured
tenant was wrong. Disabling Nessie afterward cannot restore fixture authorization.
Missing identifiers can be completed by the operator and rechecked; an already
pinned identifier cannot be substituted. Provider URLs contain a query key per
Nessie's API contract, so URLs and raw provider errors are never logged or surfaced.

The adapter uses the official endpoint contracts for
[customers](https://github.com/nessieisreal/nessie-javascript-sdk/blob/master/lib/customer.js),
[accounts](https://github.com/nessieisreal/nessie-javascript-sdk/blob/master/lib/account.js),
[purchases](https://github.com/nessieisreal/nessie-javascript-sdk/blob/master/lib/purchase.js),
and [bills](https://github.com/nessieisreal/nessie-javascript-sdk/blob/master/lib/bills.js),
with runtime schemas and HTTPS-only, allowlisted origins.

## Tenant Review And Demonstration

Completed/executed purchases are imported for tenant review, not automatically
classified as housing-related or added to expenses. Confirming a purchase adds
one immutable expense snapshot; repeating confirmation cannot count it twice.
Dismissing it does not affect impact. Current verification is required for a new
review decision. No AI classification is claimed by this integration.

On refresh, corrected provider values remain visible alongside warnings and the
original confirmed expense amount. Removed or cancelled purchases are marked
missing; their historical expense snapshots are retained. On API failure,
historical records remain visible but are not current authorization. Exact payee
matching via `NESSIE_RENT_PAYEE` determines which bills are rent history.

## Normalized Verification And Privacy

`getTrustedFinancialVerification(record)` in `src/lib/server/nessie-verification.ts`
accepts only a trusted, server-loaded case and returns:

```ts
{
  tenantVerified: true,
  customerVerified: true,
  accountVerified: true,
  ownershipVerified: true,
  balanceAvailable: true
}
```

All five flags are false for demo, stale, failed, incomplete, or configuration-mismatched
verification. The tenant-only `GET /api/cases/:id/finances` exposes this result under
`verification` alongside the saved financial snapshot. It recomputes trust when read;
it does not independently refresh the provider. `sync_finances` refreshes through the
existing adapter, persists the result, and maps the flags into the existing settlement
policy input: `tenantVerified`, `customerVerified`, `accountVerified`,
`accountCustomerBound`, and `financiallyReady`. No contract/policy rewrite or XRPL
signing change is needed. Settlement refreshes this context before policy evaluation;
autonomous requests always receive this live-only gate. Existing freshness checks
still run at the signing boundary.

Finances shows **LIVE / VERIFIED**, **DEMO**, or **ERROR / UNAVAILABLE**, with a
separate stale state once the 60-second verification expires. Live means a real HTTPS
response from the Nessie sandbox, not real banking or KYC. During initial live loading,
seeded banking identities, balances, rent records, and purchases are hidden. The
explicitly labeled local escrow ledger remains separate. On failure the current bank
balance is cleared and prior live history is labeled historical; suggestions cannot
be confirmed until verification is current.

Private finance routes require a tenant session and workspace ownership. Landlord
routes use `toLandlordCase`, an allowlist that excludes the financial profile, customer
and account IDs, balance, rent history, transactions, receipts, and financial timeline
entries. A landlord sees only the disputed amount and escrow/settlement status.

## Capital One Judge Demo

Run the app from this integration worktree, with its ignored `.env.local` configured:

```sh
pnpm nessie:check
pnpm dev --port 3127
```

1. Open `http://127.0.0.1:3127/login`. Sign in as `tenant1@rentescrow.demo` with the
   seeded demo password `TenantDemo123!` and select case **RE-1042**.
2. Open **Finances**. It automatically loads the configured live account. Show
   **LIVE / VERIFIED**, the tenant/case/customer/account binding, ownership checks,
   provider balance, three rent records, and three transactions. **Refresh financial
   profile** renews the 60-second check. No Nessie seeding is required.
3. Click **Check financial binding**. Show the successful server dry run and
   **No settlement action initiated**. The tenant-only finances endpoint also exposes
   the five normalized verification flags; other settlement requirements remain mandatory.
4. Click **Test account substitution**. Show the blocked authorization and
   `NESSIE_CUSTOMER_MISMATCH` / `NESSIE_ACCOUNT_MISMATCH`. The real binding and
   balances stay unchanged; this diagnostic never initiates settlement.
5. Optionally confirm the heater purchase and dismiss groceries. Only a tenant-confirmed
   suggestion enters issue impact; this never debits the account or funds escrow.
6. In a separate browser session, sign in as `landlord@rentescrow.demo` using the
   seeded password `LandlordDemo123!`. The landlord's case response has no private
   banking fields; requesting the tenant's `/api/cases/RE-1042/finances` returns 403.
   (The pre-existing missing `landlord-operations` UI module may prevent rendering the
   landlord screen until the separate UI work lands; the API privacy checks pass.)
7. For an optional failure demonstration, stop the app, temporarily remove the Nessie
   API key from the server configuration, restart, and refresh as the tenant. Show
   **ERROR / UNAVAILABLE**, no current bank balance, and blocked binding verification.
   Restore the key and refresh to recover. Do not change customer/account IDs or reseed.

Validation for this change uses mocked provider responses for deterministic security
and browser tests, plus a real authenticated tenant browser check against the configured
Nessie sandbox. No live XRPL transaction is needed for the sponsor demonstration.

The app never posts purchases, bills, or transfers during this workflow. Only the
explicit provisioning CLI writes synthetic Nessie records. Real Photon sends,
Gemini analysis, and XRPL testnet submission require their own configuration and
are not implied by a successful Nessie check.
