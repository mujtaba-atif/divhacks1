# RentEscrow NYC

A tenant case workspace for the DivHacks 2026 no-heat demonstration. Building
records, evidence, landlord messages, expenses, repair verification, and a
guarded simulated escrow stay together in one persistent case.

## Run locally

Requires Node.js 22+ and pnpm. No API keys are required for the demo.

```sh
pnpm install
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
| Nessie | Opt-in mock account, rent, and transaction context |
| Photon | Opt-in approved-recipient outbound iMessage; demo replies by default |
| MongoDB Atlas | Session records and GridFS uploads when configured; local atomic JSON persistence by default |
| XRPL | Isolated, guarded testnet tooling; application escrow is always simulated USD |

For Atlas, follow [database setup](docs/mongodb-atlas.md), then run
`pnpm db:check` to verify indexes and a temporary write/read/delete probe.
An Atlas Administration API key is not needed. Switching storage does not
automatically import existing local cases.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

The end-to-end tests use local Chrome and start a local server if needed. An
already-running server is reused. Set `E2E_BASE_URL` to test another local port.
Tests create isolated demo sessions; they do not send real messages or submit
ledger transactions. Run them without live provider credentials.

Tests cover policy tampering, insufficient funds, release prerequisites,
concurrent duplicate funding, persistent state, tenant isolation, upload
validation, and the full repair-to-settlement flow.

## Structure

- `src/components`: tenant workspace and case views.
- `src/app/api`: session-scoped HTTP routes.
- `src/lib/server`: persistence, validation, and case state transitions.
- `src/lib/integrations`: provider adapters and isolated XRPL testnet tooling.
- `src/lib/policy.ts`: deterministic escrow authorization.
- `tests`: policy, integration, API, and browser verification.
- `.codex/agents`: the installed VoltAgent specialist profiles.

Local records and uploads are stored under ignored `.data/`. The demo uses
opaque browser-session cookies, not production user accounts. Do not publicly
deploy this prototype with personal tenant records or live messaging enabled
before adding production authentication, retention and backup controls, and
delivery/reconciliation handling.

## Scope

Implemented from the 16-page planning PDF supplied on September 26, 2026.
[Implementation contract](docs/implementation-contract.md) records the shared
API and state invariants. [Asset provenance](docs/asset-provenance.md) records the
generated demonstration images. This prototype organizes evidence and demonstrates
escrow policy; it does not determine a tenant's legal right to withhold rent.
