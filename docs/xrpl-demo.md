# RentEscrow XRPL / RLUSD judge walkthrough

RentEscrow extends its existing guarded XRPL Testnet `Payment` adapter to use
**10 Testnet RLUSD** by default in this workspace. The application dispute is
**$400 simulated USD**. These are separate amounts with no conversion between
them. Testnet RLUSD and Test XRP have no monetary value.

## Reused infrastructure

The existing source of truth, Nessie customer/account verification, case and
wallet locks, deterministic policy, final transaction validation, server signer,
`submitAndWait`, durable pending journal, exact validated receipt checks,
reconciliation, autonomous agent trigger, and replay protection remain in place.
The same adapter handles both XRP and RLUSD. Photon, Gemini, Nessie, auth, and
unrelated UI were not changed.

The existing autonomous XRP payment remains verifiable:
[665D5F44…837F1](https://testnet.xrpl.org/transactions/665D5F44D63673C094FB627524A7FD8603502E9BD6AC4B6187EFC018BF2837F1),
case `RE-XRP-3126B6BD`, ledger **21087767**, **10 XRP**, validated `tesSUCCESS`.
Its historical permissions and receipt format remain supported.

## RLUSD extension

The contract-governed runtime agent now emits only:

```json
{ "contractId": "<signed agreement>", "caseId": "<bound case>", "requestedAction": "RELEASE_RENT" }
```

Trusted server configuration is pinned into the bilaterally signed agreement and its case permission. The agent cannot
supply the amount, source, recipient, asset, issuer, currency, network,
transaction type, authorization, or signing credentials. The executor reloads
the case, refreshes trusted financial verification, checks policy and live ledger
state, and revalidates the final autofilled object immediately before signing.

New settlement/audit records identify `rentescrow-settlement-v1`, policy
`CASE_SETTLEMENT_V1`, case ID, requested action, asset, amount, destination,
policy decision, timestamp, and (when available) transaction hash, ledger index,
and validated result. The journal stores the full approved intent and policy
before submission. This is application traceability, not a DID or identity credential.

The settlement transaction is an issued-currency **Payment**, with no paths,
SendMax, partial-payment flag, or agent-selected fields:

```json
{
  "TransactionType": "Payment",
  "Account": "<server-bound source>",
  "Destination": "<server-bound landlord recipient>",
  "Amount": {
    "currency": "524C555344000000000000000000000000000000",
    "issuer": "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
    "value": "10"
  },
  "Flags": 0
}
```

The adapter also binds the case permission through InvoiceID and a hashed memo,
and limits the fee and ledger expiry. Success requires a matching hash and
transaction, `validated: true`, `tesSUCCESS`, and exactly the approved delivered
currency, issuer, and decimal value. `Amount`/`DeliverMax` API variants are handled.
Submission alone never closes a case.

RLUSD balances and recipient trust-line capacity are checked at the same
validated ledger as issuer/recipient account flags. Frozen, unauthorized,
non-parity quality or fee-bearing transfers are rejected. Separate XRP must
cover the current reserve and final network fee. Approved amounts use exact
decimal arithmetic, at most six decimals, with a 1,000 Testnet RLUSD cap.

The issuer/currency were verified against [Ripple's current Testnet RLUSD
documentation](https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl)
on 2026-09-27. Other issuers, including Mainnet RLUSD, are rejected.

## Current live setup and funding dependency

Both real trust-line setup transactions validated successfully:

| Wallet | Public address | Validated TrustSet |
| --- | --- | --- |
| Source | `r3sYwD7h1C91HnaCiBReLae9VrcFjexAhg` | [A7DE4CB4…A29B](https://testnet.xrpl.org/transactions/A7DE4CB4BD91111BD5768B8DF33507788ACF2E28473D9BD77499E8649CBFA29B) |
| RLUSD recipient | `r47xMXQSanLYF3UUBrJj2FgeU1XKTini3S` | [4F4D8672…C1E0](https://testnet.xrpl.org/transactions/4F4D8672790193C351B59028DCAC1070473087C074B8C6C2CC19A1F832C9C1E0) |

Setup was rerun and recovered both validated hashes without signing another
TrustSet. The original XRP recipient (`rKrKcMxW7ZEvidUFGJkc9YwukjYnMCqoVT`) is
preserved. Its discarded recipient seed was not needed for XRP payments; RLUSD
needs a receiving trust line, so a separate RLUSD recipient was created.

**RLUSD Payment is not yet live-verified:** the source had **0 Testnet RLUSD**,
and the official faucet returned HTTP 401, `Authentication required`.
The two transactions above are trust-line setup, not settlement payments.
RLUSD is selected in `.env.local`; lack of funding blocks settlement rather than
silently paying XRP. The existing real autonomous XRP payment remains proof of
the shared settlement path, while RLUSD delivery is covered by deterministic tests.

Historical case `RE-XRP-3D519561` was prepared under the earlier per-case
approval model. It is retained as history and must not be used as the new
contract-authority demo. New authenticated financial workflows require a fresh
bilaterally signed agreement and its bound case. See the
[contract demo](contracts-demo.md) for the current flow.

To obtain Testnet RLUSD:

1. Open [Ripple's linked RLUSD faucet](https://tryrlusd.com/).
2. Click **Sign in with GitHub** and complete the faucet's authentication.
3. Select **XRPL Testnet**, enter source address
   `r3sYwD7h1C91HnaCiBReLae9VrcFjexAhg`, and request Testnet RLUSD.
4. Give the faucet only the public address. It does not need a seed/private key.
5. Run `pnpm xrpl:setup-rlusd` and `pnpm xrpl:setup-rlusd --check`.

## Setup commands and environment

For this already configured workspace, after funding:

```sh
pnpm xrpl:setup-rlusd
pnpm xrpl:setup-rlusd --check
```

For a fresh setup:

```sh
pnpm xrpl:setup-testnet
pnpm xrpl:setup-rlusd --create-recipient --fund
# If the faucet requires sign-in, fund the printed source at tryrlusd.com.
pnpm xrpl:setup-rlusd
pnpm xrpl:setup-rlusd --check
```

`--create-recipient` generates a dedicated RLUSD recipient only if one is not
already configured; it preserves the XRP recipient. Without this option, setup
uses the configured RLUSD recipient or the existing XRP recipient and requires
its setup seed only if a TrustSet is needed. TrustSet is an operator-only setup
action, not a permitted agent settlement action. Both holder wallets must have
XRP for reserves. The existing XRP faucet setup can refill the source.

`--fund` attempts the official faucet using only the public address and explains
when interactive GitHub sign-in is required. It does not circumvent authentication.
`--check` performs no ledger writes, signing, or faucet calls and verifies both
trust lines, source RLUSD, recipient capacity, and XRP reserve/fee headroom.
Setup uses the pinned Testnet endpoint and verifies network ID 1; it never targets
Mainnet. Credentials remain in ignored, untracked `.env.local` with mode 0600.
Only public TrustSet receipt metadata is stored in ignored `.data` files.
Restart the server after configuration changes.

| Variable | Value / purpose |
| --- | --- |
| `XRPL_SETTLEMENT_ENABLED` | `true` |
| `XRPL_SETTLEMENT_ASSET` | `RLUSD` (explicit `XRP` enables fallback/dev mode) |
| `XRPL_NETWORK` | `testnet` only |
| `XRPL_RPC_URL` | `wss://s.altnet.rippletest.net:51233` only |
| `XRPL_RLUSD_ISSUER` | `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` |
| `XRPL_RLUSD_CURRENCY` | `RLUSD` (normalized to the pinned 40-character hex code) |
| `XRPL_SETTLEMENT_AMOUNT_RLUSD` | `10` here; positive, up to six decimals, at most 1,000 |
| `XRPL_TENANT_ADDRESS` / `XRPL_TENANT_SEED` | Existing source wallet; seed stays server-side |
| `XRPL_RLUSD_LANDLORD_ADDRESS` | Dedicated approved RLUSD recipient |
| `XRPL_RLUSD_LANDLORD_SEED` | Setup-only receiving TrustSet signer; never used by settlement |
| `XRPL_LANDLORD_ADDRESS` / `XRPL_SETTLEMENT_AMOUNT_XRP` | Preserved XRP recipient and native amount |
| `RENTESCROW_STORAGE` / MongoDB variables | Existing durable application storage |

Existing Nessie configuration is reused. Configured Nessie verification failures
block settlement; the server does not silently switch to fixture verification.
When Nessie is explicitly disabled, its local fixture is labeled. Neither Nessie
balance nor simulated USD provides RLUSD or Test XRP.

The XRP adapter and explicit `XRPL_SETTLEMENT_ASSET=XRP` dev mode are preserved.
Contract-governed agreements currently authorize RLUSD only: changing the global
asset to XRP cannot change a signed agreement or bypass its required asset.
There is no automatic asset fallback, and existing permissions are never silently
converted. Historical XRP receipts remain reconcilable.
The old `XRPL_TESTNET_*` variables/native EscrowCreate/EscrowFinish tooling are
separate and not used by this Payment flow.

## Exact judge flow

Use the [current contract-governed judge flow](contracts-demo.md#setup-and-exact-judge-flow):
review agreement, tenant signs, assigned landlord signs, authority becomes active,
create a disputed case, fund its simulated obligation, report and verify repair,
then confirm the repair fact. The RentEscrow runtime sends eligible RLUSD using
the existing guarded adapter without an individual payment approval.

The original per-case authorization and developer preparation walkthrough is
superseded. Do not use `xrpl:prepare-demo` to establish financial authority for an
authenticated contract-governed case. Wallet/trust-line setup remains an operator
step; actual settlement originates from the application runtime or its scheduled
contract worker.

| Attack button | Rejection |
| --- | --- |
| Change recipient / Prompt injection | `DESTINATION_WALLET_MISMATCH` |
| Exceed amount cap | `AMOUNT_OUTSIDE_AUTHORIZATION` |
| Wrong network | `WRONG_NETWORK` |
| Change RLUSD issuer | `ASSET_DEFINITION_MISMATCH` |
| Wrong asset | `ASSET_NOT_APPROVED` |
| Wrong case | `WRONG_CASE` |
| Unsupported action | `ACTION_NOT_PERMITTED_BY_CONTRACT` |
| Insufficient funds | `INSUFFICIENT_RLUSD_FUNDS` |
| Replay settlement | `SETTLEMENT_ALREADY_COMPLETED` |
| Fee above maximum | `FEE_EXCEEDS_CONTRACT_POLICY` |
| Mutate active terms | `CONTRACT_HASH_MISMATCH` |

These controls are labeled dry runs. Each shows **BLOCKED BEFORE SIGNING** and
**Nothing signed. Nothing submitted.** The real executor independently enforces
balances and the final transaction. Actual duplicate requests are also blocked
by durable state and wallet/session locks.

## Explorer and recovery

Open the UI's `https://testnet.xrpl.org/transactions/<hash>` link. Confirm:

- **Payment**, the source and approved RLUSD recipient above.
- Delivered value **10**, currency **RLUSD** / its hex code, issuer
  `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`.
- Validated successful result **tesSUCCESS**, with a ledger index matching the UI.
- The separately charged network fee is XRP, not the RLUSD amount or simulated USD.

An uncertain submission remains pending. **Reconcile ledger result** retrieves
only the existing hash; it never re-signs or submits a replacement. Preserve
session and journal storage together. Do not delete a pending journal or stale
operation lock without investigating the ledger outcome. A validated case cannot
settle again. Testnet resets may eventually remove explorer history; durable
receipts preserve the application's recorded proof.

## Validation

```sh
pnpm exec tsx --conditions=react-server --test \
  tests/xrpl-settlement.test.ts tests/xrpl-server.test.ts tests/xrpl-journal.test.ts \
  tests/mongodb-xrpl.test.ts tests/policy.test.ts tests/xrpl-agent.test.ts \
  tests/xrpl-status.test.ts tests/rlusd-policy-journal.test.ts
pnpm test:e2e tests/e2e/xrpl.spec.ts
pnpm typecheck
pnpm build
```

The targeted suites cover legacy XRP, RLUSD construction and configuration,
ledger preflight mocks, exact delivery validation, journal identity, pending
recovery and replay, plus bilateral signatures, signed-contract integrity,
contract events, scheduled execution and agent traceability. Tests do not spend
Testnet assets. See [contract verification](contracts-demo.md#verification) for
the expanded commands.

Full typecheck/build still encounter pre-existing unrelated errors: the missing
`src/components/landlord-operations.tsx` and missing
`CaseRecord.pendingMaintenanceRequest` in messaging code/tests. Those excluded
implementations were not changed. The Agreement page supports both parties and
the scoped repair-report action without depending on the broken landlord page.
RLUSD funding and a real autonomous RLUSD Payment remain the live-validation
dependency described above.
