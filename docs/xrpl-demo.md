# RentEscrow XRPL integration and judge walkthrough

RentEscrow uses a **real XRPL Testnet `Payment`** to settle an enabled case.
The application's **$400 simulated USD dispute** remains independent of the
**10 Test XRP payment**. There is no currency conversion, real rent transfer,
or claim that the application created a native XRPL escrow. The existing
native `EscrowCreate` / `EscrowFinish` operator tooling remains separate.

## What was already working

The existing adapter already constructed a server-owned Payment, rechecked the
final transaction before signing, used `submitAndWait`, checked validated
`tesSUCCESS` and exact delivered amount, and journaled the hash before dispatch.
Local and MongoDB wallet/session locks, replay protection, read-only
reconciliation, attack demos, and the Testnet wallet setup command existed.

The earlier transaction was independently retrieved from Testnet during this
review: [F8C6344C…9335C6A](https://testnet.xrpl.org/transactions/F8C6344CEDE732132C7D925AA685C021AC286EA8B17EBF750C8039D4D9335C6A),
ledger **21076716**, validated `tesSUCCESS`, **10,000,000 drops** delivered.
The application had performed a real transaction; it was not solely a mock.

The current MongoDB UI nevertheless incorrectly marked settlement unavailable,
and payment required a separate manual approval after repair confirmation.

## What was finished

- Corrected XRPL availability for the existing MongoDB lock/journal path.
- Added explicit case-scoped agent authorization. After authorization, repair
  verification and tenant confirmation trigger a server-side settlement agent.
  Its request contains only `{ caseId, action: "settle_xrpl" }`. The existing
  deterministic payment boundary supplies and checks all financial fields.
- Pinned tenant and landlord identities plus the original case beneficiary to
  the settlement permission, policy, journal and hashed transaction memo.
  Authenticated cases require an assigned landlord. Legacy domain fixtures use
  their trusted owner and original beneficiary identifiers. Old unsubmitted
  permissions can explicitly refresh participant authorization without changing
  payment terms; historical pending/validated receipts retain their original binding.
- Persisted full approved/rejected policy decisions and the requesting actor.
  The durable journal includes the final policy, check time, and live balance,
  reserve, fee and exact transaction checks. The UI exposes policy decisions.
- Corrected audit provenance for signed-but-unsubmitted failures and manual
  retries after an agent attempt. The agent never automatically retries a failed,
  denied, interrupted, pending or validated attempt.
- Improved setup to refill accounts when they cannot cover the approved payment
  plus reserves and the fee cap, rather than treating any positive balance as enough.
- Added a non-destructive sample-case preparation command. It preserves existing
  cases, does not send messages, and does not sign or submit a transaction.

Photon, Gemini, Nessie, authentication, and unrelated UI behavior were not changed.

## Verified autonomous transaction

A fresh demonstration was executed through authenticated tenant and assigned
landlord HTTP actions. The agent was authorized before repair completion. The
last client action was `confirm_resolution`; there was no client `settle_xrpl`
request for the successful payment. Live Nessie customer/account verification
passed. The tenant's existing non-demo case was preserved.

| Field | Independently verified value |
| --- | --- |
| Case | `RE-XRP-3126B6BD` |
| Application dispute | $400 simulated USD |
| On-chain amount | 10 Test XRP / 10,000,000 drops |
| Network / transaction | XRPL Testnet / Payment |
| Source | `r3sYwD7h1C91HnaCiBReLae9VrcFjexAhg` |
| Destination | `rKrKcMxW7ZEvidUFGJkc9YwukjYnMCqoVT` |
| Ledger | **21087767** |
| Result | `validated: true`, `tesSUCCESS`, exact delivered amount |
| Requesting actor | `settlement_agent` |
| Persisted policy | **33 checks passed**, MongoDB journal validated |
| Hash | `665D5F44D63673C094FB627524A7FD8603502E9BD6AC4B6187EFC018BF2837F1` |

[Open the new transaction in the XRPL Testnet explorer](https://testnet.xrpl.org/transactions/665D5F44D63673C094FB627524A7FD8603502E9BD6AC4B6187EFC018BF2837F1).
The local public receipt and independent verification are in ignored
`.data/xrpl-agent-receipt.json`; durable state is in the configured MongoDB
`sessions` and `xrpl_journal` collections. No signing seed or session cookie is
included in the receipt. All eight attack controls were blocked. An actual
second settlement request returned HTTP 409 `SETTLEMENT_ALREADY_COMPLETED`.

## Environment and wallet setup

This workspace already has funded wallets, a valid Testnet configuration,
MongoDB, and a live Nessie binding. No additional XRPL environment variables are
needed here. Secrets remain in ignored, untracked, owner-readable `.env.local`
(mode 0600); seeds are never logged or returned to the browser.

To create/fund dedicated Testnet wallets on another setup, or refill these:

```sh
pnpm xrpl:setup-testnet
```

Equivalent without pnpm: `npm run xrpl:setup-testnet`. The command preserves
existing wallets and unrelated environment values and writes the configuration
below to `.env.local`. The recipient never signs, so no landlord seed is stored.
Restart the app after configuration changes.

| Variable | Required value / purpose |
| --- | --- |
| `XRPL_SETTLEMENT_ENABLED` | `true` |
| `XRPL_NETWORK` | `testnet` only |
| `XRPL_RPC_URL` | `wss://s.altnet.rippletest.net:51233` only |
| `XRPL_TENANT_ADDRESS` | Dedicated source public address |
| `XRPL_TENANT_SEED` | Source signing seed, server-side `.env.local` only |
| `XRPL_LANDLORD_ADDRESS` | Dedicated approved recipient public address |
| `XRPL_SETTLEMENT_AMOUNT_XRP` | `10` for this demo; positive, at most 100 |
| `RENTESCROW_STORAGE` | `mongodb` for the authenticated application |
| `MONGODB_URI`, `MONGODB_DATABASE` | Existing application database configuration |

Existing Nessie configuration is reused, including its tenant/customer/account
binding. Configured Nessie failures block settlement; there is no live-to-demo
fallback. When Nessie is explicitly disabled, the application labels its local
financial fixture. Neither bank balance nor simulated USD funds Test XRP.

The old `XRPL_TESTNET_*` variables are for independent native escrow tooling and
are not required by this Payment flow.

## Exact judge demonstration

The already completed case can be inspected immediately in tenant 1's workspace:
select `RE-XRP-3126B6BD`, then **Escrow**, inspect **Settlement complete**, expand
**Policy decision: approved**, and open the hash. Attack controls remain usable.

For another complete run, prepare a fresh sample without resetting history.
`--reported` records a clearly labeled sample landlord completion through the
existing assigned-role service. It leaves evidence verification, tenant confirmation
and all payment authorization incomplete, and sends no external messages:

```sh
pnpm xrpl:prepare-demo --reported
pnpm dev
```

1. Open `http://127.0.0.1:3000`. Sign in as `tenant1@rentescrow.demo` with
   `TenantDemo123!`. Select the new **XRPL agent demo: no heat** case whose ID
   the preparation command printed.
2. Open **Escrow**. Click **Set aside $400**, then **Enable Testnet settlement**.
   Show the distinct $400 USD and 10 Test XRP figures and pinned public wallets.
3. Click **Review agent authorization**. Review the exact source, recipient,
   case, Testnet network and amount. Click **Authorize agent settlement**.
   Show **Agent settlement authorized**. It has not yet requested a payment.
4. Show the checked **Repair reported complete** requirement: the preparation
   command added only that labeled sample report. Verification and tenant
   confirmation are still unchecked, and no transaction has been requested.
5. Open **Evidence**,
   and click **Add after photo**. On the new 72°F sample, click **Analyze evidence** if it
   is not already analyzed. Click **Verify repair**. Evidence remains explicitly
   labeled sample/demo data, while the resulting Testnet payment is real.
6. Open **Escrow**. Click **Confirm repair is complete**. This final tenant
   condition triggers the already-authorized agent. It rebuilds the payment from
   trusted case state, runs policy, signs server-side, and waits for validation.
   No additional payment-approval click is required.
7. Wait for **Settlement complete**, `tesSUCCESS`, ledger index and the linked
   transaction hash. Show **Agent requested settlement** and the persisted
   **Requested by settlement agent** audit row and policy decision.
8. Under **Compromised-agent demos**, click each attack below. Show the failing
   check, attempted versus approved values, and **Nothing signed. Nothing submitted.**

If already verified and confirmed when authorization is granted, the agent runs
immediately. The original manual **Review … payment → Approve Testnet payment**
path remains available for cases without agent authorization.

**Current unrelated workspace blockers:** full typecheck/build are blocked by
an existing import of missing `src/components/landlord-operations.tsx`, plus
`pendingMaintenanceRequest` references missing from `CaseRecord` in messaging
code/tests. The tenant-only walkthrough above remains usable. To demonstrate a landlord
clicking the report, omit `--reported`, restore the unrelated landlord UI dependency,
then sign in as `landlord@rentescrow.demo` / `LandlordDemo123!` in a private window,
open **Open cases → select case → Repairs**, enter a completion note and click
**Report repair complete** before tenant verification. The live run above exercised
that authenticated API successfully. These unrelated files were left untouched
per the requested scope.

## Attacks and deterministic policy

| Control | Attempt | Rejection |
| --- | --- | --- |
| Wallet switch | Substitute recipient | `DESTINATION_WALLET_MISMATCH` |
| Amount tampering | Request 1,000 Test XRP | `AMOUNT_OUTSIDE_AUTHORIZATION` |
| Wrong network | Request Mainnet | `WRONG_NETWORK` |
| Prompt injection | Repair text orders an attacker payment | `DESTINATION_WALLET_MISMATCH` |
| Wrong case | Unrelated case identifier | `WRONG_CASE` |
| Unsupported action | Arbitrary transfer/account action | `ACTION_OUTSIDE_PERMISSION_SCOPE` |
| Insufficient funds | Inject zero spendable balance | `INSUFFICIENT_XRPL_FUNDS` |
| Replay payment | Pretend already settled | `SETTLEMENT_ALREADY_COMPLETED` |

These controls are dry runs and never invoke a signer. The real executor
independently checks source balance minus current reserves and the final fee.
Actual duplicate requests are also blocked by durable receipt/journal state.

The policy checks case/escrow/settlement identity, session ownership, pinned
participants, current customer/account ownership, funded USD record, repair
report, analyzed before/after evidence, successful verification, tenant
confirmation, exact Test XRP amount/spending limit, approved destination,
Testnet-only permission, `Payment` only, and no previous or unresolved settlement.

Immediately before signing, the executor rechecks the fresh case and exact
autofilled transaction. It rejects extra transaction fields, partial payments,
altered wallets/amounts, fees above 1,000 drops, and excessive ledger expiry.
The server must attest Testnet network ID 1. The signed blob is checked again
before submission. Only matching validated `tesSUCCESS` with exact delivered
amount releases the simulated USD record. Policy decisions and ledger metadata
remain in the case audit and durable journal.

## Recovery and verification

Session and wallet locks serialize signing; MongoDB locks do not expire into a
second signer. The signed hash is durably reserved before dispatch. Unknown,
failed or lost responses never count as settlement. Use **Reconcile ledger
result** to retrieve the recorded hash without signing or submitting again.
Never delete a pending journal to retry. A stale process lock requires operator
inspection of the journal and ledger before removal. Preserve case and journal
storage together. A validated case cannot be reset or paid again.

In the Testnet explorer, verify the transaction's **Payment** type, source and
destination above, **10 XRP** amount, successful validated result and ledger
**21087767**. This is Testnet, not Mainnet. Testnet ledger history can be reset;
the saved public receipt and durable journal preserve the demonstration metadata.

Checks run:

```sh
node --conditions=react-server --import tsx --test \
  tests/xrpl-settlement.test.ts tests/xrpl-server.test.ts \
  tests/xrpl-journal.test.ts tests/mongodb-xrpl.test.ts tests/policy.test.ts \
  tests/xrpl-agent.test.ts tests/xrpl-status.test.ts
pnpm test:e2e tests/e2e/xrpl.spec.ts
pnpm typecheck
pnpm build
```

All 54 targeted XRPL/policy tests and all seven XRPL browser tests passed. Typecheck and
build were run and exposed the unrelated blockers listed above; they are not
reported as passing. Routine automated tests use ledger mocks and never spend
Test XRP. The separately recorded live run used the real Testnet network and
real configured Nessie/MongoDB connections.

Protocol references: [direct Payment fields](https://xrpl.org/docs/references/protocol/transactions/types/payment),
[reliable submission](https://xrpl.org/docs/concepts/transactions/reliable-transaction-submission),
[xrpl.js Client](https://js.xrpl.org/classes/Client.html),
and [official Testnet faucets](https://xrpl.org/resources/dev-tools/xrp-faucets).
