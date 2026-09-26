# RentEscrow implementation contract

Source: the 16-page DivHacks 2026 planning PDF supplied by the user.
Build the full no-heat demonstration in Next.js App Router, TypeScript, and
Node.js. All monetary values use integer USD cents. Demo escrow is simulated
USD; real XRPL adapters use explicit testnet XRP units, never an implicit FX rate.

The subsequent 27-page XRP requirements extend this contract: the existing USD
escrow remains simulated, while an opt-in case-bound Testnet `Payment` provides
real settlement after repair verification and tenant confirmation. This uses the
document's explicit fallback instead of adding native escrow expiry and preimage
custody to the case workflow. See [the XRP walkthrough](xrpl-demo.md).

## Ownership

- Root: scaffolding, types, seed data, deterministic policy, tests, documentation.
- Backend subagent: `src/lib/server/*` and `src/app/api/*` only.
- Frontend subagent: `src/components/*`, `src/app/page.tsx`, `layout.tsx`,
  `globals.css`, `error.tsx`, and `public/icon.svg` only.
- Integrations subagent: `src/lib/integrations/*` and integration notes only.

All shared types are in `src/lib/types.ts`. Do not change them without coordinating.

## HTTP contract

All responses JSON; failures `{ error: string }` with appropriate HTTP status.
Session is isolated using a server-issued HttpOnly cookie. Mutations require a
same-origin request. This is a local hackathon demo, not production tenancy auth.

- `GET /api/dashboard` -> `DashboardData`; seed one RE-1042 heating case per session.
- `GET /api/buildings?address=...&borough=...` -> `BuildingRecord`; actual NYC
  lookup must distinguish unavailable/empty results from the named demo fixture.
- `POST /api/cases` -> `{ case: CaseRecord }`; body `{ issue, description,
  noticedAt, address, borough, apartment, landlordName, landlordContact,
  monthlyRentCents, disputedAmountCents }`.
- `POST /api/cases/:id/actions` -> `{ case: CaseRecord, policy?: PolicyResult }`;
  body is `CaseAction`. Actions implement server-side state transitions.
- `POST /api/cases/:id/evidence` -> `{ case: CaseRecord }`; multipart fields
  `file`, `stage`, `note`, optional `temperatureF`; maximum 5 MiB image/PDF.
- `GET /api/cases/:id/export` -> downloadable JSON case dossier.
- `POST /api/demo/reset` -> `DashboardData`; resets only the current session.

## Domain exports (root)

`src/lib/seed.ts`: `createDemoCase(ownerId): CaseRecord`,
`createNewCase(ownerId, input): CaseRecord`, `demoBuilding(): BuildingRecord`.
`src/lib/policy.ts`: `makeIntent(caseRecord, transactionType): TransactionIntent`,
`evaluatePolicy(caseRecord, intent): PolicyResult`.

## Adapter contract (integrations)

- `getIntegrationStatus(): IntegrationStatus[]`
- `lookupBuilding(address, borough): Promise<BuildingRecord>`
- `analyzeEvidence(evidence, caseRecord): Promise<EvidenceAnalysis>`
- `verifyEvidence(caseRecord): Promise<EvidenceAnalysis>`
- `getFinancialContext(): Promise<{ accountBalanceCents, expenses, rentHistory }>`
- `sendLandlordMessage(caseRecord, body): Promise<{ delivery: "demo" | "sent" }>`
- export these through `src/lib/integrations/index.ts`.

Default adapters are explicit demo providers with deterministic sample evidence
only. Arbitrary real uploads cannot be falsely verified by the demo analyzer.
Gemini is opt-in with credentials; image evidence is untrusted input. Photon
external delivery additionally requires an explicit live opt-in and tenant send
action. If API details cannot be verified, fail closed and document the missing
contract. Do not send real messages during development. The approved XRP follow-up
permits dedicated faucet-funded Testnet wallet setup and real Testnet Payment
verification. The native escrow tooling remains independently callable. Application
USD escrow is always simulated; production funds and Mainnet are unsupported.

## Escrow invariants

No release before repair reported, analyzed after-evidence, verification passed,
and tenant confirmation. Validate case ID, escrow ID, destination, amount,
network, transaction type, and current state. Re-check the exact final intent at
the signing boundary. Rejected attempts go into the audit trail. Repeat release
must not debit twice. The UI may expose a dry-run wallet-tampering test.
Create stays unfunded on insufficient funds. Update state only after simulated
or real validated success. New evidence invalidates previous verification and
tenant confirmation. Resolved cases cannot be mutated.

## User interface

Operational tenant workspace, not marketing. Brand visibly RentEscrow NYC.
White/light-gray canvas, charcoal text, emerald primary and distinct amber
warnings. Compact left navigation, building context, case header, tabs for
Overview, Evidence, Messages, Finances, Escrow. Timeline and release checklist;
file upload, sample evidence, real building search, new-case form, case switcher,
export, reset. Clearly mark sample data and simulated funds. No legal promises.
Mobile layout must preserve all actions. Use lucide-react icons.

## Additive registration and contract approach

Registration remains optional and is bound to the existing server-issued
`rentescrow_session` cookie's owner ID; it neither replaces that cookie nor
changes the anonymous dashboard bootstrap. A registered profile and accepted
contract metadata are persisted with the same server-side session document.
The existing `POST /api/cases` path remains the anonymous/demo-compatible path.
New registered-contract case creation is exposed through a separate route and
requires a stored acceptance of a canonical SHA-256 hash of the supplied terms.

XRPL signing stays server-only: the application Payment action uses the configured
Testnet wallet, and the separate native escrow module remains operator tooling.
Neither accepts a user-supplied private key. Contract acknowledgement stores the
canonical terms hash and acceptance record. A self-documentation case has no approved
destination wallet. It records documentation only; policy rejects every
caller-supplied transfer intent before any funds action.

## Registration and digital contract HTTP contract

All routes below preserve the normal JSON failure shape `{ error: string }` and
the existing same-origin requirement for mutations. They use the existing
`rentescrow_session` cookie and do not create a replacement authentication
cookie.

- `POST /api/auth/register` -> `{ user: RegisteredUser }`; body
  `{ role: "tenant" | "landlord", displayName, email?, walletAddress? }`.
  Registration upserts that role within the current demo session. A supplied
  wallet address is descriptive only; wallet ownership is not proven.
- `GET /api/auth/me` -> `{ users: RegisteredUser[] }` for the current session.
- `GET /api/contracts` -> `{ contracts: DigitalContract[] }` for the current
  session.
- `POST /api/contracts` -> `{ contract: DigitalContract }`; body
  `{ case_type: "bilateral" | "self_documentation", terms }`. A tenant must
  already be registered. The server stores a SHA-256 hash of canonical terms
  and the tenant's stored acceptance. A bilateral contract is
  `pending_landlord`; a self-documentation contract is tenant-only and active.
- `POST /api/contracts/:id/accept` -> `{ contract: DigitalContract }`; body
  `{ role: "tenant" | "landlord" }`. The relevant role must be registered in
  the same demo session. A landlord acceptance activates a bilateral contract;
  landlord acceptance on a self-documentation contract is rejected.
- `POST /api/contracts/cases` -> `{ case: CaseRecord }`; body
  `{ contractId, case: <the existing POST /api/cases payload> }`. The contract
  must be active, fully accepted for its type, and unused; consumption and case
  creation are one session mutation. `landlordName` and `landlordContact` are
  required for bilateral contracts but may be empty for self-documentation.

`CaseRecord.case_type` is optional for legacy demo records and is
`"bilateral"` or `"self_documentation"` for contract-created cases. Legacy
unset behavior is bilateral behavior. A self-documentation case has an empty
`escrow.destination` (no approved landlord or tenant wallet). It supports no
escrow funding, fund release, or other transfer intent: `EscrowCreate`,
`EscrowFinish`, and any forged/different intent are rejected and audited by the
existing actions boundary. For example, RE-2091 can be
recorded as `case_type: "self_documentation"` with tenant wallet
`rTENANT789`, no approved landlord, and a rejected attempted $400 self-release.
