# Provider Integrations

All credentials belong in server environment variables. No adapter accepts API
keys from a browser or returns their values in integration status. Configuration
status means credentials are present, not that a live request was verified.
XRPL Testnet wallet funding and a real Test XRP settlement were verified. The
Nessie synthetic provisioning CLI and read-only app integration were also verified
against the sandbox. No real messages or production-money transfers were made.

## NYC Open Data

The server first resolves an active building in HPD's
[Buildings Subject to HPD Jurisdiction](https://data.cityofnewyork.us/Housing-Development/Buildings-Subject-to-HPD-Jurisdiction/kj4p-ruqc)
dataset, then queries [complaints and problems](https://data.cityofnewyork.us/Housing-Development/Housing-Maintenance-Code-Complaints-and-Problems/ygpa-z7cr)
and [housing violations](https://data.cityofnewyork.us/Housing-Development/Housing-Maintenance-Code-Violations/wvxf-dwi5)
by HPD building ID. Official metadata and public samples were checked during
implementation. `NYC_OPEN_DATA_APP_TOKEN` is optional; no geocoding credentials
are required. The older `uwyv-629c` complaints dataset is not used.

Address normalization handles casing/spacing, common street suffixes and
direction abbreviations, numbered-street ordinals, borough aliases, Queens
hyphenated house numbers, and a trailing ZIP. Lookup is exact, never fuzzy.
Ambiguous active buildings are reported without merging their histories. If the
building file is unavailable, exact address history can be returned with an
explicit partial-data warning. SoQL values are escaped and URL-encoded.

Each history dataset is capped at its latest 100 rows, with a truncation warning.
Complaint problems are grouped by complaint ID. Totals describe returned records,
not a complete building inspection. Deterministic category/description rules
identify complaints relevant to the case in the last 365 days. An empty match
does not establish that a building is free of issues. Unavailable, malformed,
ambiguous, and partial results are explicitly labeled.

The existing tenant and landlord case workflows display public context with
source and retrieval time. Successful records are cached for 15 minutes, persisted
in MongoDB's `nyc_buildings` collection, and saved on `case.building`; failed
refreshes can serve a labeled stale snapshot with its original timestamp.
Only the fictional `123 Example Street, Brooklyn` address returns **DEMO DATA**.
Arbitrary addresses never inherit sample counts. See the
[building-history guide](nyc-building-history.md) for demo steps, cache retention,
privacy boundaries, and tests.

## Gemini

`GEMINI_API_KEY` enables real image/PDF analysis. `GEMINI_MODEL` defaults to
`gemini-3.8-flash` and may be set to another compatible model available to the
account. Calls use Google's documented
[generateContent REST API](https://ai.google.dev/api/generate-content), including
`inlineData` and structured JSON output. Responses must complete with `STOP` and
pass a strict runtime schema. A refusal, timeout, malformed JSON, or invalid
schema cannot become a successful verification.

Uploads are saved before the server requests analysis. The response contains
`issueType`, `observations`, `temperatureF` (null when unreadable), `evidenceType`,
`summary`, `confidence` (0–1), `severity`, and `requiresHumanConfirmation: true`.
The server adds the source, model and analysis timestamp. Unknown fields and
model-provided authorization/verification fields are rejected. A single upload
always starts with `verified: false`.

**Verify repair** compares the latest persisted before/after readings using an
application rule, without another model request. For live heating evidence,
both analyses must identify thermometer photos and heating with confidence at
least 0.8. The before reading must be below 68°F and the improved after reading
must be 68–85°F. This conservative demonstration rule is **not a legal temperature
standard or a safety finding**. Other issues, unreadable readings, low confidence,
and mixed live/sample evidence cannot pass this automatic comparison. The
comparison records both evidence IDs and readings while preserving each upload's
original observations. New evidence clears the comparison and tenant confirmation.

A passing comparison still requires the tenant's explicit confirmation and the
existing deterministic escrow policy; release remains a separate approved action.
Notes, OCR text, PDFs, and image content are untrusted evidence and cannot supply
application commands. The model receives no financial state, payment tools, or
authorization capabilities. It cannot prove identity, authenticity, code compliance,
or safety. XRPL and Nessie adapters and payment policy are unchanged.

The supported media types are PNG, JPEG, WebP, and PDF, up to 5 MiB each. The
analysis sends the uploaded file, case issue/description and evidence metadata.
Banking data, wallet seeds, and unrelated evidence are not part of the request.
Adding a key means uploaded evidence is sent to Google automatically on upload
and when retrying analysis. See Google's [image input](https://ai.google.dev/gemini-api/docs/image-understanding),
[PDF input](https://ai.google.dev/gemini-api/docs/document-processing), and
[structured output](https://ai.google.dev/gemini-api/docs/structured-output) documentation.

Without a key, only server-labeled `isDemo` sample evidence receives deterministic
analysis. The heating sample changes from 54 F to 72 F. Real uploads return an
persist an unavailable error and remain unverified. Transient network, timeout,
HTTP 429 and server failures receive one bounded retry. Invalid credentials,
malformed output and blocked responses do not become sample analysis. The
Evidence tab retains the file and offers manual retry after fixing configuration
or availability. Mixing sample and real evidence for repair verification is rejected.

See [real-image testing and judge walkthrough](gemini-demo.md).

## Capital One Nessie

Nessie is a [mock banking API](https://api.nessieisreal.com/), not a connection to
real bank accounts. `NESSIE_ENABLED=true`, `NESSIE_API_KEY`, `NESSIE_TENANT_ID`,
`NESSIE_CUSTOMER_ID`, and `NESSIE_ACCOUNT_ID` enable a server-controlled binding
and read-only customer/account/purchases/bills imports. The official
[account SDK](https://github.com/nessieisreal/nessie-javascript-sdk/blob/master/lib/account.js),
[purchase SDK](https://github.com/nessieisreal/nessie-javascript-sdk/blob/master/lib/purchase.js),
and [bill SDK](https://github.com/nessieisreal/nessie-javascript-sdk/blob/master/lib/bills.js)
define the endpoint shapes used here. Credentialed HTTPS requests and synthetic
record provisioning were verified against the current API. See
[Nessie setup and demonstration](nessie.md) for configuration, seed receipts,
provider compatibility notes, authorization, and tenant review behavior.

The default origin is `https://api.nessieisreal.com`; `NESSIE_BASE_URL` can select
`https://api.reimaginebanking.com` for the legacy provider. HTTP and arbitrary
origins are rejected. Provider keys appear in query parameters because that is
the documented API contract; request URLs are never included in errors.

Nessie dollars are explicitly converted into integer USD cents. Completed or
executed purchases are suggestions for tenant review, never automatic expenses.
Only explicit confirmation adds a deduplicated expense snapshot.
`NESSIE_RENT_PAYEE` optionally
identifies the exact rent bill payee; unrelated bills are never guessed to be
rent. Cancelled/unknown bill statuses are omitted. Provider failures do not
silently replace records with demo fixtures. With `NESSIE_ENABLED` unset, the
adapter returns explicitly labeled sample financial context for cases that have
not been bound to a live sandbox account. A saved live binding cannot downgrade
to fixtures. Bank balance is separate from the app's simulated escrow ledger.

Customer/account ownership and the trusted case binding are checked before
authorization. Verification expires after 60 seconds; financial actions refresh
it, and testnet tooling checks again immediately before signing. The visible
account-substitution demonstration is a policy dry run with no settlement.

## Photon Spectrum

The app uses the installed `spectrum-ts` SDK and its official
[direct-message API](https://photon.codes/docs/spectrum-ts/spaces-and-users).
Only a validated, explicitly approved send action can dispatch. The adapter
checks the server-owned tenant/case/contact against an operator allowlist,
appends the case reference, creates the approved DM, and checks the returned
outbound message ID, text, conversation, sending line, and timestamp. `sent`
means provider acceptance, not a delivery/read receipt.

Before dispatch, the case mutation checkpoints a pending message. Missing or
invalid post-dispatch receipts become uncertain, never an automatic retry.
Provider failures and their sanitized reasons remain in the case/timeline.
Reset cannot erase live history. Atlas uses optimistic revision checks; if a
post-send save conflicts, the durable pending record still blocks duplicate
dispatch until an operator investigates. There is no automatic reconciliation.

`pnpm agent` now starts `scripts/spectrum-replies.ts`, not the legacy echo example.
The worker accepts only authenticated inbound DM text from the approved contact
in a recorded outbound conversation, matched by tenant, case, sending line,
provider ID and time. Threaded replies must reference a matching outbound ID.
It persists and classifies replies but never auto-replies, changes payment
destinations, or authorizes financial actions. Browser-entered sample replies
remain explicitly demo data. No public unauthenticated webhook is exposed.

The unwrapped SDK can share a provider contact card before application filtering.
Our reply provider disables that behavior locally through a tested, version-pinned
provider configuration wrapper, without changing cloud settings or token renewal.
SDK telemetry is off and application logs omit credentials, contacts and bodies.
See [configuration, limitations, and walkthrough](photon-spectrum.md).

### Dependency setup

Use the pinned pnpm version and `pnpm install --frozen-lockfile`. The workspace
explicitly permits the existing esbuild/sharp installers and skips protobufjs's
advisory-only postinstall. A narrow override patches Spectrum's transitive
OpenTelemetry core dependency for
[GHSA-8988-4f7v-96qf](https://github.com/advisories/GHSA-8988-4f7v-96qf).
Keep the override until upstream dependency resolution no longer includes the
affected release; do not remove it without rerunning `pnpm audit` and the tests.

## XRP Ledger Testnet

### Application settlement

The application now supports an opt-in real Testnet **Payment** beneath its
simulated USD escrow. [The XRP walkthrough](xrpl-demo.md) contains the verified
receipt, environment settings, security demonstrations, and recovery steps.
`xrpl-settlement.ts` reuses the existing final transaction validator and domain
repair policy. Native XRP is approved independently in drops; no implicit USD
conversion occurs. The server constructs an exact direct
[Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment),
rejects partial-payment/extra fields, persists the signed hash before submission,
and accepts only a matching validated `tesSUCCESS` plus exact delivered amount.

`pnpm xrpl:setup-testnet` uses the existing `xrpl.js`
[`Client.fundWallet`](https://js.xrpl.org/classes/Client.html#fundWallet) API.
It writes a dedicated tenant seed directly to ignored `.env.local` and stores
only the landlord's public address. Mainnet and custom RPC endpoints are rejected.
MongoDB execution uses shared, non-expiring session and wallet operation locks
plus a durable transaction journal. Local domain tooling retains its filesystem
locks. A crashed process leaves a lock for operator recovery after reviewing the
journal and ledger; no timeout automatically grants another signer access.

### Separate native escrow tooling

The separate `xrpl-testnet.ts` module is
operator tooling with no HTTP route, no user-supplied signer, no mainnet option,
and no exchange-rate conversion. `xrpl.js` handles validation, serialization,
autofill, signing, and submission. This tooling has offline validation tests;
credentialed ledger submission has not been exercised.

The ledger protocol fixes recipient/value when creating an
[EscrowCreate](https://xrpl.org/docs/references/protocol/transactions/types/escrowcreate).
[EscrowFinish](https://xrpl.org/docs/references/protocol/transactions/types/escrowfinish)
identifies it by owner and creation sequence. A timed-only escrow can be finished
by anyone after its time, so the builder requires a private PREIMAGE-SHA-256
condition as well. The module supports only the fixed 32-byte preimage DER form
described by the [crypto-conditions draft](https://datatracker.ietf.org/doc/html/draft-thomas-crypto-conditions-04#section-8.1)
referenced by XRPL. This is not a new signature algorithm.

Isolated setup variables, all disabled/unset by default:

- `XRPL_TESTNET_ENABLED=true`: explicit opt-in for this tooling only.
- `XRPL_TESTNET_SEED`: a dedicated funded testnet wallet seed.
- `XRPL_TESTNET_PREIMAGE_HEX`: a fresh random 32-byte secret, represented as 64
  hex characters. Never reuse it across escrows or log the fulfillment. Once
  submitted, a fulfillment becomes public ledger data.
- `XRPL_TESTNET_APPROVAL_JSON`: a server-controlled JSON object using the schema
  below. This must never come from an untrusted action request.

```json
{
  "caseId": "an-authorized-testnet-case",
  "escrowId": "its-escrow-id",
  "ownerAddress": "a-classic-testnet-owner-address",
  "destination": "an-approved-classic-testnet-landlord-address",
  "amountUsdCents": 40000,
  "amountDrops": "1000000",
  "offerSequence": 123,
  "finishAfter": 900000000,
  "cancelAfter": 900086400
}
```

Those values illustrate the shape and are not usable credentials or approval.
`amountDrops` is independently approved native testnet XRP, capped at 100 XRP;
`amountUsdCents` binds the business intent and does not determine XRP value.
Times use seconds since the Ripple epoch. `offerSequence` is the owner's
explicitly approved next creation sequence. Pinning it prevents duplicate
creation from stale application state. The memo contains a hash of the case,
escrow, owner, destination, amounts, and sequence, not tenant details.

The caller must hold an authoritative case write lock for the entire operation
and supply `loadCase`, `recordResult`, and `recordFailure` persistence callbacks.
The adapter applies domain policy before network access, validates the prepared
transaction's exact fields after autofill, checks validated native XRP balance,
fees and reserve requirements, reloads the case, and rechecks policy immediately
before signing. It decodes and checks the signed transaction again. The fee cap
is 1,000 drops, and transactions expire within 25 ledger closes. The only server
is the public testnet, whose `network_id` must equal 1.

Release additionally checks the validated creation transaction's memo, owner,
sequence, native value, condition, and destination, plus the current validated
ledger escrow object. State may be persisted only after a matching hash and a
validated `tesSUCCESS` result from `submitAndWait`. Failures are audited; uncertain
submission or persistence failure records the submitted hash for reconciliation.
Never retry an uncertain create with a new sequence. A confirmed ledger receipt
must be reconciled before changing approval or application state.

The native escrow module remains operator-only. The app's separate Payment path
adds case-bound authorization, durable idempotency/reconciliation and cross-process
locks for the hackathon demo, including MongoDB coordination. Email/password
login is limited to the three seeded demo users; production account provisioning
and external custody remain outside scope. Real rent funds and production
legal workflows are outside this demonstration.
