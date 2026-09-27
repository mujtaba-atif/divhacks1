# RentEscrow NYC

A tenant case workspace for the DivHacks 2026 no-heat demonstration. Building
records, evidence, landlord messages, expenses, repair verification, and a
guarded simulated USD escrow stay together in one persistent case. An optional,
case-bound XRPL Testnet Payment provides real on-chain settlement using Test XRP.

## Run locally

Requires Node.js 22+, pnpm 11.25.0, and a MongoDB Atlas connection for users, login sessions, and persistent workspaces.

```sh
pnpm install --frozen-lockfile
# Configure MONGODB_URI, MONGODB_DATABASE, and RENTESCROW_STORAGE=mongodb in .env.local.
pnpm seed:users
pnpm dev
```

Open <http://127.0.0.1:3000>. Sign in as Rayaan, Jordan Lee, or Alex Morgan
using the demo shortcuts. Rayaan owns `RE-1042`; Jordan starts with an empty,
separate workspace; Alex sees assigned repair cases with private banking data
excluded. Login and case history persist across browser sessions. Demo messages
remain in the application; simulated USD is not a bank or XRP balance.

See [authentication, role permissions, exact demo credentials, and the full
Tenant → Landlord → Tenant walkthrough](docs/auth-and-roles.md).

## Walk through the demo

1. Open the case and inspect **Building history** and the initial evidence. The
   fictional `RE-1042` address is marked **DEMO DATA**; real-address lookups use
   NYC public records with source, retrieval time, and availability labels.
2. Review the repair request in Messages and approve sending the demo message.
3. Set aside $400 of simulated funds in Escrow.
4. Sign out, sign in as the property manager, and schedule/report the repair.
   Sign back in as Rayaan to continue. Tenant accounts cannot submit landlord reports.
5. Add the 72 F after-repair sample in Evidence and analyze it.
6. Verify the before/after evidence, then confirm the repair is complete.
7. Run the wallet-mismatch check to demonstrate a blocked transaction.
8. Review and release the simulated escrow. Inspect the audit trail and export
   the case dossier. Reset the demo to run it again.

You can also create another case, look up a real NYC building, upload a PNG,
JPEG, WebP, or PDF, and record expenses. Real uploads remain unverified without
Gemini credentials. Sample evidence is always labeled and never passed off as
live AI analysis.

See [Gemini setup, real-image testing, and judge walkthrough](docs/gemini-demo.md)
for the live upload path and the deterministic 54°F → 72°F comparison.

See [NYC building history](docs/nyc-building-history.md) for public-address search,
related complaints, landlord access, caching, MongoDB persistence, and limitations.

## Integrations

Use `.env.example` as the configuration reference. Put secrets in ignored
`.env.local`, then restart the server. See [integration details](docs/integrations.md)
for official API sources, exact settings, testnet approval fields, and current
limitations.

| Service | Available behavior |
| --- | --- |
| NYC Open Data | Case-linked public building history, issue matching, source/freshness labels, and cached HPD complaints/violations |
| Gemini | Real server-side upload analysis when configured; application rules compare before/after readings |
| Nessie | Verified sandbox customer/account binding, rent history, tenant-reviewed costs, and account-substitution guardrail |
| Photon Spectrum | Two-sided iMessage agents, durable send receipts, and authenticated case replies |
| MongoDB Atlas | Users, hashed login sessions, tenant workspaces, assignments, repair actions, GridFS uploads, and settlement coordination |
| XRPL | Guarded real Testnet Payment settlement; application escrow remains simulated USD |

## Photon Spectrum

The existing Messages workflow connects Tenant and Landlord agents through the
Spectrum cloud listener. New cases with trusted participant bindings send a repair
notice; replies from either phone produce safe repair events and mediated updates.
Wallets, amounts, banking identity, and payment approval remain outside messaging.

Run `pnpm seed:users` to configure Rayaan and Alex's demo contacts. Configure both
phone destinations and the Spectrum project in ignored `.env.local`, then run
`pnpm photon:check`, `pnpm dev`, and `pnpm agent` in a separate terminal.
See [configuration, phone demo, routing, and limits](docs/photon-spectrum.md).
`PHOTON_LIVE_SEND=false` retains clearly labeled demo sends. Provider acceptance
is not a delivery/read receipt; uncertain sends are never blindly retried.

## XRP Testnet demo

```sh
pnpm xrpl:setup-testnet
pnpm xrpl:prepare-demo --reported
pnpm dev
```

The one-time setup creates and faucet-funds dedicated tenant and landlord
Testnet wallets, saves only the tenant signing seed to ignored `.env.local`,
and preserves existing wallets when rerun. Use `npm run xrpl:setup-testnet` if
pnpm is unavailable and dependencies are already installed.

In Escrow, set aside the simulated $400 and select **Enable Testnet settlement**,
then **Review agent authorization → Authorize agent settlement**. After repair
verification and tenant confirmation, the agent requests the separate **10 Test XRP**
payment through the existing server policy and signer. Manual review remains available.
The preparation command creates a labeled sample with a sample landlord report;
tenant evidence verification and confirmation are still required. This amount is configurable and has no USD
exchange-rate relationship. Only a validated `tesSUCCESS` receipt closes the case.
The compromised-agent controls demonstrate wallet switching, amount tampering,
prompt injection, insufficient funds, replay, wrong network/case, and unsupported
actions without signing or submitting anything.

See [XRP implementation and judge walkthrough](docs/xrpl-demo.md) for the live
transaction proof, public wallet addresses, configuration, recovery, and limits.

For Atlas, follow [database setup](docs/mongodb-atlas.md), then run
`pnpm db:check` to verify indexes and a temporary write/read/delete probe.
An Atlas Administration API key is not needed. Switching storage does not
automatically import existing local cases.

For Nessie, follow [financial verification setup](docs/nessie.md), then run
`pnpm nessie:check`. The Finances view separates the verified sandbox bank balance
from simulated escrow funds and requires confirmation before imported purchases
count toward issue impact. Its account-substitution check demonstrates a blocked
authorization without sending a payment. Existing expense snapshots are retained
when switching providers; they are not silently rewritten or reclassified.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

The end-to-end tests use local Chrome, a disposable local MongoDB server, and a
dedicated app on port 3100. They seed the three demo users and use real password
verification. Live providers are disabled, and the database URI overrides Atlas
configuration from `.env.local`. The test app builds into `.next-e2e`, separately
from normal development. `E2E_BASE_URL` can select another unused local port.
Tests never send external messages or submit ledger transactions. The first run
may download a local MongoDB test binary.

Tests cover policy tampering, insufficient funds, release prerequisites,
concurrent duplicate funding, persistent state, tenant isolation, upload
validation, Nessie ownership and stale verification, confirmed-cost deduplication,
provider corrections, account substitution, and the full repair-to-settlement
flow. Nessie browser tests intercept the API and exercise failure states without
mutating provider data.
XRP tests additionally cover transaction tampering, reserve/fee checks, delivered
amount validation, durable pending receipts, recovery, and duplicate prevention.

## Structure

- `src/components`: tenant workspace and case views.
- `src/app/api`: authenticated tenant and property-manager HTTP routes.
- `src/lib/server`: persistence, validation, and case state transitions.
- `src/lib/integrations`: provider adapters and isolated XRPL testnet tooling.
- `scripts/xrpl-setup-testnet.ts`: one-time Testnet wallet setup.
- `src/lib/policy.ts`: deterministic escrow authorization.
- `tests`: policy, integration, API, and browser verification.
- `.codex/agents`: the installed VoltAgent specialist profiles.

Authentication uses MongoDB users and revocable opaque browser-session cookies.
The three publicly documented demo passwords are for the hackathon only; there
is no registration, password reset, email verification, or MFA. Local `.data/`
storage remains available for legacy domain tests. Production deployment still
needs credential provisioning, retention/backups, and operational recovery.

## Scope

Implemented from the original 16-page planning PDF, the eight-page Nessie
integration addendum, and the 27-page XRP follow-up supplied on September 26,
2026, and the 15-page two-sided Photon messaging brief supplied September 27.
The XRP flow uses its permitted Payment fallback.
[Implementation contract](docs/implementation-contract.md) records the shared
API and state invariants. [Asset provenance](docs/asset-provenance.md) records the
generated demonstration images. This prototype organizes evidence and demonstrates
escrow policy; it does not determine a tenant's legal right to withhold rent.
