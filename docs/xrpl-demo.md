# XRP implementation and judge walkthrough

Reviewed against the 27-page `xrp prompt.pdf` supplied on September 26, 2026.
The existing repair workflow, USD escrow, deterministic policy, audit, APIs,
persistence and UI were extended. The document explicitly permits a real XRP
Payment beneath simulated escrow when native escrow would complicate the MVP.
That is the implemented path: **simulated USD escrow + real Testnet Payment**.

## Verified on-chain result

A real transaction was submitted through the application's session-scoped HTTP
actions and independently retrieved from XRPL Testnet afterward.

| Field | Verified value |
| --- | --- |
| Case | RE-1042 in an isolated demonstration session |
| Application dispute | $400 simulated USD |
| On-chain amount | 10 Test XRP / 10,000,000 drops |
| Transaction type | Payment |
| Tenant public address | `r3sYwD7h1C91HnaCiBReLae9VrcFjexAhg` |
| Landlord public address | `rKrKcMxW7ZEvidUFGJkc9YwukjYnMCqoVT` |
| Validated ledger | 21076716 |
| Result | `validated: true`, `tesSUCCESS`, exact delivered amount |
| Transaction hash | `F8C6344CEDE732132C7D925AA685C021AC286EA8B17EBF750C8039D4D9335C6A` |

[Inspect the transaction on the Testnet explorer](https://testnet.xrpl.org/transactions/F8C6344CEDE732132C7D925AA685C021AC286EA8B17EBF750C8039D4D9335C6A).
The local public receipt and exported dossier are saved in ignored
`.data/xrpl-live-receipt.json` and `.data/xrpl-live-dossier.json`.
The session cookie is kept separately in owner-readable
`.data/xrpl-live-session.json`; do not publish that bearer credential.
Testnet resets can eventually remove historical transactions.

The app resolved the case only after this receipt validated. A second actual
settlement request returned `SETTLEMENT_ALREADY_COMPLETED` without another
payment. All seven other attack controls were exercised through the HTTP API
and blocked before signing.

## Setup and configuration

The repository already depended on `xrpl`; the locked `xrpl.js` 4.6.0 was reused.
No new dependency was added. Existing dependencies were installed from the lockfile.

```sh
pnpm install --frozen-lockfile
pnpm xrpl:setup-testnet
pnpm dev
```

If dependencies are installed and pnpm is unavailable, use
`npm run xrpl:setup-testnet` and `npm run dev`.

Setup checks that `.env.local` is ignored and untracked before generating any
credential. It creates dedicated wallets, uses the official Testnet faucet,
preserves unrelated environment settings and existing wallets, and atomically
writes `.env.local` with owner-only permissions. It persists the tenant seed
before faucet calls so partial funding can resume without replacing the wallet.
Only the landlord's public address is stored because the recipient never signs.
Seeds are never printed, returned to the browser, or placed in examples/source.
Wallet creation happens only when this command runs, never on application startup.

| Variable | Purpose |
| --- | --- |
| `XRPL_SETTLEMENT_ENABLED=true` | Enable the optional application Payment path |
| `XRPL_NETWORK=testnet` | Only accepted network |
| `XRPL_RPC_URL=wss://s.altnet.rippletest.net:51233` | Only accepted endpoint |
| `XRPL_TENANT_ADDRESS` | Dedicated tenant public address |
| `XRPL_TENANT_SEED` | Server-only tenant signing seed in ignored `.env.local` |
| `XRPL_LANDLORD_ADDRESS` | Dedicated recipient public address |
| `XRPL_SETTLEMENT_AMOUNT_XRP=10` | Positive amount, up to six decimal places, capped at 100 Test XRP |
| `RENTESCROW_STORAGE=local` | Required for this single-host live settlement implementation |

Restart the server after changing configuration. Enabling Testnet on a case pins
the wallets and amount to that case. Later configuration changes cannot rewrite
the existing authorization; a mismatch blocks signing. `XRPL_TESTNET_*` variables
belong to the older, separate native escrow operator tooling and are not required
for the application Payment flow.

## Successful judge demonstration

1. Open a fresh workspace at `http://127.0.0.1:3000`. Inspect RE-1042, its 54 F
   sample evidence and $400 simulated dispute.
2. Open **Escrow**, set aside **$400**, and click **Enable Testnet settlement**.
   Show the pinned tenant/landlord public wallets and separate **10 Test XRP**.
3. In **Messages**, use the sample **Report repair complete** action.
4. In **Evidence**, add the after-repair sample, analyze it, and verify the repair.
   The 72 F sample and its analysis stay explicitly labeled demonstration data.
5. In **Escrow**, click **Confirm repair is complete**.
6. Review the Test XRP payment. The dialog shows the exact amount, recipient,
   network and case. Approve the Testnet payment.
7. Wait for validation. Show `tesSUCCESS`, ledger index and the explorer-linked
   hash. The simulated USD escrow closes and the case becomes resolved.

This is a real Testnet `Payment`; the application does not claim that an
`EscrowCreate`/`EscrowFinish` occurred. The $400, case records, sample landlord
reply and sample evidence analysis remain simulated. Test XRP has no real value
and no exchange-rate relationship to the $400 dispute. Production Gemini evidence
can still be used when configured; a key is not needed for the labeled sample demo.

## Compromised-agent demonstrations

In the same Escrow tab, the controls under **Compromised-agent demos** remain
available after settlement. Every control is a dry run; none calls the signer.

| Control | Attempt | Policy result |
| --- | --- | --- |
| Wallet switch | Replace recipient with `rATTACKER999` | `DESTINATION_WALLET_MISMATCH` |
| Amount tampering | Request 1,000 Test XRP | `AMOUNT_OUTSIDE_AUTHORIZATION` |
| Prompt injection | Malicious repair message directs payment to attacker | Override blocked; trusted destination preserved |
| Insufficient funds | Inject zero spendable balance | `INSUFFICIENT_XRPL_FUNDS` |
| Replay payment | Simulate an already-completed settlement | `SETTLEMENT_ALREADY_COMPLETED` |
| Wrong network | Request Mainnet | `WRONG_NETWORK` |
| Wrong case | Use an unrelated case identifier | `WRONG_CASE` |
| Unsupported action | Request arbitrary transfer/account action | `ACTION_OUTSIDE_PERMISSION_SCOPE` |

The UI shows the failed checks, attempted versus authorized values and
**Nothing signed. Nothing submitted.** Real execution failures that may already
have been submitted show pending/reconciliation state instead. The insufficient
funds control explicitly uses an injected balance; real execution independently
queries the validated account and deducts the actual reserves plus fee before
checking the approved payment amount.

## Guardrails and recovery

The session must own the case. The backend builds payment intent from pinned
case state; the API accepts only an action/scenario, never wallets, amounts,
network, transaction JSON or a signing seed. The existing release policy checks
funded simulated escrow, repair report, analyzed evidence, successful comparison
and tenant confirmation. XRP checks add tenant/source/recipient/amount/permission
binding and reject completed or unresolved attempts. Optional trusted normalized
financial fields can enforce tenant/customer/account binding and readiness
without coupling the signer to Nessie's API.

Immediately before signing, the adapter reloads the case, rechecks policy/config
and validates the exact autofilled transaction. It rejects extra fields, partial
payments, altered amounts/wallets, fees above 1,000 drops and expiry more than
25 ledgers away. A hashed permission binding associates the payment with the
tenant, case, escrow and settlement without publishing tenant details. The
signed transaction is decoded and checked again before submission. The pinned
server must attest Testnet network ID 1.

The session and shared source wallet are serialized using cross-process file
locks. A fsynced journal reserves the signed hash **before** dispatch; the session
is also checkpointed. Success is journaled before the final case update. A
timeout, missing transaction, invalid receipt, failed ledger result or lost
session write cannot create a successful settlement or silently authorize a new
payment. A pending hash blocks replay and case/evidence edits, including when the
session checkpoint was lost. The exact delivered amount must match the approved
amount, in addition to a matching hash and validated `tesSUCCESS`.

Use **Reconcile ledger result** for pending outcomes. Reconciliation only queries
the recorded hash and applies a validated receipt; it never signs or submits.
Unresolved/failed hashes remain reserved and require operator review. There is
no automatic new-sequence retry. A process crash can leave an explicit lock in
`.data/locks`; after confirming the owning process stopped, an operator can
remove only that lock and reconcile the journal. Never delete a journal to retry.
Keep `.data/sessions` and `.data/xrpl-journal` together in backups.

Reset is blocked for pending or validated Testnet cases so their audit receipts
are preserved. Use a new case or browser session for another demonstration.

## Files and verification

| Area | Files |
| --- | --- |
| Wallet setup | `scripts/xrpl-setup-testnet.ts`, `package.json`, `.env.example` |
| Payment adapter and shared transaction checks | `src/lib/integrations/xrpl-settlement.ts`, `xrpl-testnet.ts`, `index.ts` |
| Domain policy/types | `src/lib/policy.ts`, `src/lib/types.ts` |
| Actions, persistence, errors, journal | `src/lib/server/cases.ts`, `store.ts`, `xrpl-journal.ts`, `errors.ts`, `http.ts`, `validation.ts` |
| Existing workspace UI | `src/components/case-panels.tsx`, `rent-workspace.tsx`, `src/app/globals.css` |
| New regression tests | `tests/xrpl-settlement.test.ts`, `tests/xrpl-server.test.ts`, `tests/e2e/xrpl.spec.ts` |
| Documentation | `README.md`, this walkthrough, integration notes and implementation contract |

Verification includes TypeScript, production build, 46 unit/integration tests,
15 browser tests, the real Payment above, independent ledger receipt retrieval,
and a rejected duplicate actual settlement request. The browser XRP tests use
mocked ledger responses; routine tests never send real ledger transactions.

```sh
pnpm typecheck
pnpm test
pnpm build
XRPL_SETTLEMENT_ENABLED=false pnpm test:e2e
```

## Remaining boundaries

- This is a loopback hackathon demo with MongoDB email/password users, revocable
  login cookies, and a dedicated server-controlled Testnet wallet. The three
  demo passwords are public; production identity provisioning and custody are outside scope.
- MongoDB uses shared non-expiring session/wallet locks and a durable public
  transaction journal. After a crash, inspect the journal and ledger before
  removing a stale lock; locks never expire into a second signing attempt.
- Native escrow builders remain separate operator tooling. The application's
  settlement transaction is `Payment`; native escrow expiry/cancellation and
  preimage lifecycle were deliberately not introduced into this workflow.
- Failed/expired/unknown submitted transactions stay reserved for manual review;
  the UI does not offer automatic replacement payments.
- The demo uses fixed dedicated counterparty wallets from server configuration;
  production wallet enrollment, rotation and authenticated counterparty binding
  remain future work. No Mainnet, real rent, or legal rent-withholding determination.

Protocol references: [direct Payment fields](https://xrpl.org/docs/references/protocol/transactions/types/payment),
[reliable submission](https://xrpl.org/docs/concepts/transactions/reliable-transaction-submission),
and [xrpl.js Client](https://js.xrpl.org/classes/Client.html).
