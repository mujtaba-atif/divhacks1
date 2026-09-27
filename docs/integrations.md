# Provider Integrations

All credentials belong in server environment variables. No adapter accepts API
keys from a browser or returns their values in integration status. Configuration
status means credentials are present, not that a live request was verified.
XRPL Testnet wallet funding and a real Test XRP settlement were verified. The
Nessie synthetic provisioning CLI and read-only app integration were also verified
against the sandbox. No real messages or production-money transfers were made.

## NYC Open Data

`lookupBuilding(address, borough)` reads the public HPD
[complaints and problems](https://data.cityofnewyork.us/Housing-Development/Housing-Maintenance-Code-Complaints-and-Problems/ygpa-z7cr)
and [housing violations](https://data.cityofnewyork.us/Housing-Development/Housing-Maintenance-Code-Violations/wvxf-dwi5)
Socrata datasets. Both response schemas were checked against public endpoint
samples during implementation. The older `uwyv-629c` complaints dataset is not
used. `NYC_OPEN_DATA_APP_TOKEN` is optional.

The query uses a house number, full street spelling, and one of the five boroughs.
Quotes are escaped before building the SoQL predicate; query parameters are URL
encoded. There is no geocoding or fuzzy address matching. Results are capped at
100 recent records per dataset; a complaint can contain more than one problem.
An empty match is not evidence of a clean building. Timeouts and dataset failures
produce explicit warnings, preserving any successful half of the lookup.

Only the exact fictional address `123 Example Street, Brooklyn` returns the
labeled demonstration fixture. Arbitrary addresses never inherit sample counts.

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

## Photon

The selected API is Photon's legacy
[Advanced iMessage HTTP proxy](https://github.com/photon-hq/advanced-imessage-http-proxy),
using its documented
[`POST /send` implementation](https://github.com/photon-hq/advanced-imessage-http-proxy/blob/main/src/routes/messages.ts).
This is a specific verified HTTP contract; it does not mix the newer Spectrum
gRPC or local macOS SDK interfaces.

Default sends have `delivery: "demo"` and stay inside the app. External delivery
requires all three server settings: `PHOTON_LIVE_SEND=true`,
`PHOTON_PROXY_TOKEN`, and `PHOTON_ALLOWED_RECIPIENT`. The token is the provider's
base64 encoding of `upstreamServerUrl|apiKey`. The recipient must exactly match
the configured E.164 phone number or email address. The endpoint is pinned to
`https://imessage-swagger.photon.codes/send`; no arbitrary URL can receive the
token. Only an explicit tenant send action should call this adapter.

The response must contain a successful receipt with a message ID, matching
recipient, matching text, and send timestamp. `sent` means provider acceptance,
not delivery or a read receipt. Requests are not automatically retried. Any
failure after dispatch, including a timeout or malformed/mismatched receipt,
throws `DeliveryUncertainError` with code `uncertain_delivery`: the message may
already have been sent, so inspect delivery before retrying. Preflight body,
configuration, and recipient validation failures are not uncertain sends. The
backend records uncertainty and temporarily blocks an identical retry. Incoming
landlord replies remain explicitly simulated; no unauthenticated
webhook is treated as proof that a landlord completed a repair.

### Spectrum worker

`pnpm agent` starts the standalone `scripts/spectrum-agent.ts` worker using
the installed `spectrum-ts` SDK. Put `SPECTRUM_PROJECT_ID` and
`SPECTRUM_PROJECT_SECRET` in ignored `.env.local`, or supply them as environment
variables. This is not a proxy token and does not enable the app's Photon adapter.

Starting the worker explicitly enables real replies to new inbound iMessage
text, including group conversations. Use a dedicated test project with consenting
participants. It does not register a webhook, update Atlas, or authorize any
repair or financial state. Provider-side profile/contact-card sharing may also
occur when enabled in the Spectrum project; disable that setting in the provider
dashboard when it is not wanted.

The worker excludes outgoing messages and pre-start history, remembers handled
message IDs for the process lifetime, and does not retry an uncertain send.
Stop and inspect delivery after a send failure before restarting. Application
logs omit message bodies and sender addresses, and SDK telemetry is disabled.
Ctrl+C shuts down the SDK. Automated tests inject a fake client and never start
a live listener or send iMessages.

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
Live execution is limited to local storage on one host; MongoDB signing is
blocked until distributed wallet locking is implemented. MongoDB continues to
support the simulated case workflow.

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
locks for the local hackathon demo. Production authentication, external custody,
and distributed locking remain outside scope. Real rent funds and production
legal workflows are outside this demonstration.
