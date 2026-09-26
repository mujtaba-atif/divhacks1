# RentEscrow implementation contract

Source: the 16-page DivHacks 2026 planning PDF supplied by the user.
Build the full no-heat demonstration in Next.js App Router, TypeScript, and
Node.js. All monetary values use integer USD cents. Demo escrow is simulated
USD; real XRPL adapters use explicit testnet XRP units, never an implicit FX rate.

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
contract. Do not send real messages or submit real ledger transactions during
development. Provide independently callable guarded XRPL testnet tooling, but
keep the application escrow demo-only until real auth and wallet custody exist.

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
