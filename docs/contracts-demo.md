# Contract-governed RentEscrow demo

The signed RentEscrow Agreement is the financial authority. Both authenticated
parties accept the same terms and canonical policy hash. The runtime settlement
agent subsequently executes eligible events without individual payment approval.
Tenant repair confirmation supplies a factual condition; it does not select or
approve a payment.

This is a **prototype agreement** with **contract-configured demo policy**. Fees,
withholding and defaults below are simulated contractual rules, not claims about
their legal validity in NYC. Testnet RLUSD has no monetary value.

## Existing code reused

- Existing `/api/contracts`, acceptance and case-creation routes and
  `src/lib/server/contracts.ts`; agreements remain in the existing workspace
  document in MongoDB, with the existing local test-store compatibility.
- Existing tenant/landlord accounts, authenticated access, managed-property
  assignments and session mutation locks. A frontend role or user ID cannot
  substitute for the authenticated signer.
- Existing case financial binding and Nessie verification, policy engine,
  XRPL settlement agent, RLUSD/XRP adapter, final transaction validation,
  wallet lock, pending journal, `submitAndWait`, exact delivered-asset checks,
  reconciliation and replay protection.

No separate wallet, signing service, LLM loop or payment implementation was added.
Photon, Gemini, Nessie and auth implementations are unchanged. Contract events
are connected in the existing case orchestration layer.

## Agreement and signatures

`ContractPolicy` in `src/lib/contract-types.ts` extends the existing agreement:

| Field group | Signed values |
| --- | --- |
| Identity | Contract ID, `CONTRACT_POLICY_V1`, tenant/landlord user IDs and display names, property ID/address |
| Rent/time | Monthly rent cents, effective date, obligation period, due day, grace days |
| Dispute | `HOLD_ALL`, no partial release, required landlord repair report, verified evidence and tenant factual confirmation |
| Fees/defaults | Fixed late fee and maximum, monetary-default days, repair deadline, `RECORD_ONLY` remedies |
| Settlement | RLUSD, XRPL Testnet, server-bound source and landlord destination, pinned Ripple Testnet issuer/currency, exact amount and autonomous cap |
| Agent | `rentescrow-settlement-v1` |

The prototype covers **one obligation period and one case per agreement**. It is
not a recurring rent scheduler. Creating another agreement version cannot pay
the same property/period twice. Defaults are $400 simulated rent, today's due
day (capped at 28), three grace days, a $25 fixed/max fee, monetary default after
10 days and repair deadline after 30 days. The RLUSD amount comes from server
configuration when the agreement is created, independently of simulated USD.

Draft creation adds no signature. Each party reviews the agreement and clicks
their own signing button. The acceptance route checks the authenticated user,
assigned property, role, reviewed terms hash and reviewed policy hash. Only two
matching signatures make the agreement `active`. No case financial workflow can
start without that authority. Active agreements keep their active status after
being bound to a case.

SHA-256 hashes cover the text terms and the recursively sorted canonical policy.
PATCH/PUT edits are rejected with `CONTRACT_TERMS_IMMUTABLE`. A term change needs
a new agreement and new signatures. Every execution verifies the stored signed
hash and party/property/case/amount bindings again; frontend copies are not
authoritative.

## Deterministic rules

`evaluateContractPolicy(contract, caseState, financialState, now)` has no network,
signing, persistence or model calls. It returns the action, reason, contract ID,
version, policy hash, asset, amount and evaluated checks.

| Condition | Result |
| --- | --- |
| Missing signature, changed hash or incorrect binding | Block |
| Before the signed effective/due date | Hold |
| Due, funded, no dispute | `RELEASE_RENT` |
| Unresolved qualifying dispute | `ACTIVE_DISPUTE`; hold the entire amount |
| Assigned landlord reports completion, fresh tenant evidence verifies, required tenant fact confirmation present | `RELEASE_RENT` |
| Unfunded after grace | Record fixed simulated late fee, never beyond the signed maximum |
| Still unfunded after default threshold | Record `MONETARY_DEFAULT`; no additional legal remedy |
| Repair facts missing after repair deadline | Record `NON_MONETARY_DEFAULT`; hold funds, no additional legal remedy |
| Previously settled | Block another execution |

Actual RLUSD balance, recipient trust-line capacity and XRP reserves/fee are
checked by the existing ledger preflight. Simulated USD funding is an application
condition and does not mint or purchase RLUSD. `evaluateContractFeeRequest`
separately rejects a $500 fee against the signed $25 maximum. Fee/default effects
never create XRPL payments.

The Agreement screen offers explicitly labeled **SIMULATED POLICY PREVIEW**
decisions for due date, dispute, repair resolution, grace expiry and defaults.
These evaluate synthetic server-generated facts against the exact signed policy;
they do not update cases, sign or submit anything.

## Runtime trigger and signing path

Application events enter the existing case service: case creation, dispute
opening, simulated escrow funding, repair reporting, evidence analysis and
verification, tenant repair confirmation, and financial-state refresh. The same
evaluator is used by the scheduled worker. A validated settlement closes the
dispute and records an audit-only reevaluation that prevents another release.

The concrete payment path is:

```text
Authenticated case event / scheduled worker
  → cases.ts: evaluateContractInSession
  → hydrateContractAuthority (locked server agreement + case)
  → contract-policy.ts: evaluateContractPolicy
  → xrpl-agent.ts: proposeContractAgentSettlement
      { contractId, caseId, requestedAction: "RELEASE_RENT" }
  → cases.ts: applyAction(settle_xrpl, actor=settlement_agent)
  → existing Nessie verification + wallet lock + durable replay checks
  → xrpl-settlement.ts: executeXrplSettlement
  → fresh contract and ledger checks + final autofilled Payment validation
  → server wallet signing → durable pending journal → submitAndWait
  → exact validated tesSUCCESS delivery → journal + case receipt
```

The agent cannot supply the seed, destination, amount, asset, issuer, currency,
network, transaction type or permission. The signed policy and trusted server
configuration supply them. Direct per-payment human execution is rejected for
contract-bound cases. The transaction remains the existing issued-currency
XRPL **Payment**. A second memo contains the signed policy hash.

Audit records include agent ID, contract ID, both policy versions, policy hash,
case ID, triggering event, evaluated rules, decision, requested action, asset,
amount, recipient, timestamp and, after validation, transaction hash, ledger
index and result. Submitted/pending is not success. Unknown outcomes reconcile
the existing hash without creating a replacement transaction.

## Scheduled evaluation

```sh
pnpm contracts:evaluate --dry-run
pnpm contracts:evaluate
```

The first command reads and evaluates current cases without updating them. The
second is an operational runtime worker and **can sign and submit** eligible
Testnet payments. It discovers active agreements from existing storage, uses
server time and the same locked evaluator, and accepts no wallet, amount or
clock overrides. Schedule that command with the process scheduler of your choice
(for example once per minute); it does not require a continuously running LLM.
No scheduler is installed automatically.

A proven pre-sign availability failure can be retried by a later runtime event
or worker run after at least 60 seconds. A signed or uncertain attempt is never
blindly retried. Preserve the journal and reconcile its hash.

## Setup and exact judge flow

Use the existing RLUSD configuration, wallets and trust lines described in
[XRPL/RLUSD setup](xrpl-demo.md). No new contract environment variables are
required. Select `XRPL_SETTLEMENT_ASSET=RLUSD` before creating the agreement and
check funding with `pnpm xrpl:setup-rlusd --check`. The worker uses the same
server-only `.env.local` and MongoDB configuration as the app.

No live agreement or settlement was executed while implementing this feature.
The previously validated XRP payment and two RLUSD TrustSets remain historical
evidence. At the last live funding check the RLUSD source balance was zero; fund
the public source through the authenticated Testnet faucet before expecting an
RLUSD `tesSUCCESS`.

1. Start `pnpm dev`. Open `/agreements` as Rayaan
   (`tenant1@rentescrow.demo`, `TenantDemo123!`). Use a workspace without an
   already bound agreement for the same obligation period.
2. Click **Create prototype agreement** (or **Create new agreement** if history
   exists). Review tenant, assigned landlord,
   property, $400 simulated USD, exact Testnet RLUSD amount, due date, grace,
   repair rules, capped fee, recipient and policy hash.
3. Click **Accept and sign as tenant**. Show tenant signed, landlord unsigned, authority
   inactive. Financial case creation is not available yet.
4. In a separate browser session, sign in as Alex Morgan
   (`landlord@rentescrow.demo`, `LandlordDemo123!`) and open `/agreements`.
   Review the same hash and click **Accept and sign as landlord**.
5. Refresh Rayaan's Agreement screen. Show both signatures, **ACTIVE** contract
   and **ACTIVE** agent authority, `rentescrow-settlement-v1` and policy hash.
6. Show the **SIMULATED POLICY PREVIEW** cards: normal due date permits release,
   active dispute holds funds, and late/default rules only record configured
   effects. These cards do not pay or modify the actual case.
7. Click **Create disputed case**, which opens its Escrow view. Click
   **Set aside $400**. Show **ACTIVE_DISPUTE**, held funds and the ready RLUSD
   permission. No transaction is signed.
8. Open **Evidence**, click **Add before photo**, then **Analyze evidence**. Sample facts stay clearly labeled as a demonstration.
9. As Alex on `/agreements`, click **Report agreed repair complete** for the
   linked case. This uses the existing authenticated
   landlord action route.
10. As Rayaan, refresh the case, open **Evidence**, click **Add after photo**,
    analyze it, then click **Verify repair**. Repair evidence must be
    newer than the landlord's report.
11. Open **Escrow** and click **Confirm repair is complete**. This is a factual
    confirmation. The runtime automatically evaluates the signed policy and,
    if all financial/ledger checks pass, sends the contract's Testnet RLUSD.
    There is no individual payment authorization dialog.
12. Show the validated **tesSUCCESS**, transaction hash, ledger index, signed
    agreement/policy hash and settlement-agent audit. Open the transaction link
    in the Testnet explorer and inspect delivered RLUSD, issuer, recipient and
    policy-hash memo. Submission alone must remain pending.
13. In **Compromised-agent demos**, run fee, wallet, amount, issuer, network,
    changed-terms, unsupported-action and replay attacks (also retained: prompt
    injection, wrong case/asset and insufficient funds). Show **BLOCKED BEFORE
    SIGNING**, the exact failed check, **Nothing signed. Nothing submitted.**

For a separate real normal-rent demonstration, choose **Create due-date case**
instead of the disputed case in step 7. Funding on/after its due date triggers
the same runtime immediately. Do not pay normal rent first and then attempt to
reuse that completed obligation for the dispute demonstration.

The pre-existing `/landlord` workspace has a missing `landlord-operations`
component. If login redirects Alex to that error page, enter `/agreements` in
the address bar after signing in; the login cookie is already established. The agreement page supports both roles and its scoped repair action
so this contract flow does not require that unrelated page.

## Verification

```sh
pnpm exec tsx --conditions=react-server --test \
  tests/contracts.test.ts tests/contract-policy.test.ts tests/contract-preview.test.ts \
  tests/contract-runtime.test.ts tests/contract-xrpl.test.ts \
  tests/xrpl-settlement.test.ts tests/xrpl-server.test.ts tests/xrpl-journal.test.ts \
  tests/mongodb-xrpl.test.ts tests/policy.test.ts tests/xrpl-agent.test.ts \
  tests/xrpl-status.test.ts tests/rlusd-policy-journal.test.ts
pnpm test:e2e tests/e2e/contracts.spec.ts tests/e2e/xrpl.spec.ts
pnpm typecheck
pnpm build
```

The targeted backend suites and 13 combined contract/XRPL browser checks passed;
the final focused agreement and contract-settlement browser checks also passed.
Tests use disposable state and mocked ledger interactions. They never sign a
live agreement or send Testnet transactions. Full typecheck/build currently
encounter the pre-existing missing landlord component and messaging
`pendingMaintenanceRequest` type errors; those unrelated implementations are
outside this change.
