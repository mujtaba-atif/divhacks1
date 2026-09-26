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

For a new installation, first run without `NESSIE_ENABLED=true`, open Finances,
and load the financial profile. Copy the read-only tenant ID into the server
configuration. Provision or select a sandbox customer and its checking account,
set their IDs, enable Nessie, and restart the server. Then run:

```sh
pnpm nessie:check
```

The check performs only GET requests. It verifies the customer, account,
ownership, balance, purchases, and bills. It does not create records, move money,
or save a case. `NESSIE_CASE_ID` optionally changes its case label from `RE-1042`.
Open Finances and refresh to persist the verified context in the application.

This prototype has one operator-configured tenant/customer/account mapping.
Another browser session has a different tenant ID and is rejected, rather than
inheriting the account. Clearing cookies loses that workspace identity. An
existing live binding cannot silently switch customer or account when env values
change. Production onboarding needs authenticated users and an explicit,
audited account-linking process; frontend ID fields are not a substitute.

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
verification. The application's separate Testnet Payment flow permits labeled
demo financial context when Nessie is disabled and the case has no live binding.
Missing configuration for an enabled provider,
timeouts, missing records, mismatches, invalid amounts/IDs, duplicate records,
and malformed responses fail closed with explicit reason codes. No live-bound
case falls back to fixtures. Provider URLs contain a query key per Nessie's API
contract, so URLs and raw provider errors are never logged or surfaced.

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

For the sponsor demonstration:

1. Open Finances and refresh. Inspect the sandbox badge, three identity checks,
   bank balance, rent history, and transactions.
2. Confirm a relevant heater or lodging purchase; dismiss an unrelated purchase.
   Only the confirmed cost changes case impact, never the bank/escrow balance.
3. Run **Check financial binding** for a valid dry run.
4. Run **Test account substitution**. The server creates an intentionally
   mismatched customer/account claim. Authorization is blocked, reason codes are
   shown, and no settlement action occurs.
5. Inspect the audit trail. Other repair, tenant-confirmation, wallet, and amount
   requirements remain mandatory for actual application escrow actions.

The app never posts purchases, bills, or transfers during this workflow. Only the
explicit provisioning CLI writes synthetic Nessie records. Real Photon sends,
Gemini analysis, and XRPL testnet submission require their own configuration and
are not implied by a successful Nessie check.
