# RentEscrow NYC

A tenant case workspace for the DivHacks 2026 no-heat demonstration. Building
records, evidence, landlord messages, expenses, repair verification, and a
guarded simulated USD escrow stay together in one persistent case. An optional,
case-bound XRPL Testnet Payment provides real on-chain settlement using Test XRP.

## Run locally

Requires Node.js 22+ and pnpm 11.25.0 (pinned in `package.json`). No API keys are required for the demo.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:3000>. The server binds to the loopback interface by
default. Each browser session starts with a fictional building, a 54 F sample
image, and case `RE-1042`. Demo messages never leave the application; simulated
USD is not a bank balance or an XRP balance.

## Walk through the demo

1. Open the case and inspect its sample building history and initial evidence.
2. Review the repair request in Messages and approve sending the demo message.
3. Set aside $400 of simulated funds in Escrow.
4. Simulate the landlord scheduling a visit and reporting the repair complete.
5. Add the 72 F after-repair sample in Evidence and analyze it.
6. Verify the before/after evidence, then confirm the repair is complete.
7. Run the wallet-mismatch check to demonstrate a blocked transaction.
8. Review and release the simulated escrow. Inspect the audit trail and export
   the case dossier. Reset the demo to run it again.

You can also create another case, look up a real NYC building, upload a PNG,
JPEG, WebP, or PDF, and record expenses. Real uploads remain unverified without
Gemini credentials. Sample evidence is always labeled and never passed off as
live AI analysis.

## Integrations

Use `.env.example` as the configuration reference. Put secrets in ignored
`.env.local`, then restart the server. See [integration details](docs/integrations.md)
for official API sources, exact settings, testnet approval fields, and current
limitations.

| Service | Available behavior |
| --- | --- |
| NYC Open Data | Public building complaint and violation lookup; explicit warnings on unavailable data |
| Gemini | Server-side structured evidence analysis and before/after comparison when configured |
| Nessie | Verified sandbox customer/account binding, rent history, tenant-reviewed costs, and account-substitution guardrail |
| Photon | Opt-in approved-recipient outbound iMessage; demo replies by default |
| Spectrum | Separate opt-in live iMessage echo worker (`pnpm agent`); not connected to case records |
| MongoDB Atlas | Session records and GridFS uploads when configured; local atomic JSON persistence by default |
| XRPL | Guarded real Testnet Payment settlement; application escrow remains simulated USD |

## Spectrum iMessage worker

Set `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` in ignored `.env.local`,
then run `pnpm agent` in a separate terminal. This is a **live** worker: it
replies to newly received iMessage text in the originating conversation,
including group conversations. Only start it on a dedicated test project whose
participants expect automated replies. Stop it with Ctrl+C.

These credentials are distinct from `PHOTON_PROXY_TOKEN`. The worker does not
update cases, classify landlord replies, or persist messages to Atlas. The app's
approved-recipient Photon HTTP adapter remains unchanged. See
[Spectrum limitations](docs/integrations.md#spectrum-worker) before running it.

## XRP Testnet demo

```sh
pnpm xrpl:setup-testnet
pnpm dev
```

The one-time setup creates and faucet-funds dedicated tenant and landlord
Testnet wallets, saves only the tenant signing seed to ignored `.env.local`,
and preserves existing wallets when rerun. Use `npm run xrpl:setup-testnet` if
pnpm is unavailable and dependencies are already installed.

In Escrow, set aside the simulated $400 and select **Enable Testnet settlement**.
Complete the repair verification and tenant confirmation, then review and approve
the separate **10 Test XRP** payment. This amount is configurable and has no USD
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

The end-to-end tests use local Chrome and a dedicated server on port 3100. They
refuse to reuse an existing server and explicitly disable live storage and
providers, so `.env.local` cannot enable Atlas, Nessie, Gemini, Photon, or XRPL
in the test server. Stop `pnpm dev` first because both processes use Next's build
directory; keep its normal port 3000 separate from the test port. `E2E_BASE_URL`
can select another unused local port. Tests create isolated demo sessions and
never send real messages or submit ledger transactions.

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
- `src/app/api`: session-scoped HTTP routes.
- `src/lib/server`: persistence, validation, and case state transitions.
- `src/lib/integrations`: provider adapters and isolated XRPL testnet tooling.
- `scripts/xrpl-setup-testnet.ts`: one-time Testnet wallet setup.
- `src/lib/policy.ts`: deterministic escrow authorization.
- `tests`: policy, integration, API, and browser verification.
- `.codex/agents`: the installed VoltAgent specialist profiles.

Local records and uploads are stored under ignored `.data/`. The demo uses
opaque browser-session cookies, not production user accounts. Do not publicly
deploy this prototype with personal tenant records or live messaging enabled
before adding production authentication, retention and backup controls, and
delivery/reconciliation handling.

## Scope

Implemented from the original 16-page planning PDF, the eight-page Nessie
integration addendum, and the 27-page XRP follow-up supplied on September 26,
2026. The XRP flow uses its permitted Payment fallback.
[Implementation contract](docs/implementation-contract.md) records the shared
API and state invariants. [Asset provenance](docs/asset-provenance.md) records the
generated demonstration images. This prototype organizes evidence and demonstrates
escrow policy; it does not determine a tenant's legal right to withhold rent.
