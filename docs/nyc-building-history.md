# NYC building history

Public housing records load when a tenant selects a case. The overview's
**Building history** card opens dated complaints and violations, issue-related
complaints, provider availability, and the retrieval time. Assigned landlords
can open the same public history from their case workspace. Searching another
address previews public records without changing the case address or assignment.

## Demo

1. Start the app using the README instructions and sign in as Taylor Reed.
2. Open `RE-1042`, then **View public records** in Building history.
3. The fictional `123 Example Street, Brooklyn` address is explicitly labeled
   **DEMO DATA**. Heat and hot-water complaints are highlighted as potentially
   related building context. These are not records from Taylor's apartment.
4. Use the dialog's address search to inspect a real NYC building, or create a
   separate case at a real address to load its public context automatically.
5. Sign in as Alex Morgan to see the public history for an assigned property.
   Another tenant cannot open Taylor's case-building endpoint.

The fictional demo address deliberately remains a fixture. No arbitrary real
address inherits demo complaints when NYC is unavailable. An unavailable dataset
is not an empty or cleared building history.

## Public sources and address identity

The adapter uses the Socrata JSON endpoints at
`https://data.cityofnewyork.us/resource/<dataset>.json`:

| Dataset | Purpose |
| --- | --- |
| `kj4p-ruqc` | Active buildings subject to HPD jurisdiction, including HPD ID, BIN, block and lot |
| `ygpa-z7cr` | Housing complaints and individual problem details, categories, dates and status |
| `wvxf-dwi5` | Housing maintenance code violations, descriptions, inspection dates and status |

Common address abbreviations, whitespace/case, numbered-street ordinals and
borough aliases normalize before an exact lookup. Queens house-number hyphens
are preserved. A trailing ZIP is extracted when supplied. An unambiguous active
HPD building supplies the stable `hpd:<id>` reference for subsequent history
queries; BIN/BBL are retained when available. Unresolved lookups have an
address-based reference and an explicit status. No fuzzy geocoding is used.

Each public request has an eight-second timeout. History datasets are requested
in parallel after building resolution. No API key is required;
`NYC_OPEN_DATA_APP_TOKEN` optionally supplies a Socrata app token server-side.

## Context and authority

The tenant route is `GET /api/cases/[id]/building`; the property-manager route is
`GET /api/landlord/cases/[id]/building`. Both check role and current case access
before lookup. They return a normalized `BuildingRecord`, never a private case
or banking profile. `GET /api/buildings?address=...&borough=...` remains an
authenticated public-address search.

Successful context refreshes update only `case.building`. Public complaints
remain separate from uploaded `case.evidence`; they cannot verify a repair,
confirm a tenant's decision, change wallets or Nessie bindings, release escrow,
or change settlement amounts. Provider text is displayed as text. The normalized
schema strips fields that do not belong in public building context.

## Related complaints

Inspectable rules live in `src/lib/building-context.ts`. They match categories
and descriptions for heat/hot water, mold/moisture, leaks/plumbing, pests/vermin,
and elevators. “Recent” means the last 365 days. A complaint with multiple
problem records is counted once. Results describe potentially related issues
at the building; they do not establish apartment identity or causation.

## Cache and MongoDB

`src/lib/server/buildings.ts` caches normalized public records for 15 minutes.
Concurrent lookups for the same normalized address share one provider request.
The process cache is limited to 200 entries. Provider failures have a one-minute
retry cooldown. A failed refresh can return the last complete snapshot with
`cache.state = "stale"`, its original `fetchedAt`, and an explicit warning.
Unavailable lookups without a prior snapshot do not receive a fresh-data label.

With MongoDB storage enabled, `nyc_buildings` holds normalized records, the
provider identifier, retrieval time, cache expiry, and an address lookup key.
It contains no user IDs, case IDs, apartment, uploaded files, or financial state.
A unique address-key index supports shared lookups; a `purgeAt` TTL index removes
snapshots after seven days. Retrieval expiry remains 15 minutes, independent of
MongoDB's asynchronous cleanup. Raw provider payloads are not retained.

Case snapshots, including `buildingId` and `fetchedAt`, also persist through the
existing session store. Existing cases are upgraded when their context loads;
there is no destructive migration. A public-cache persistence failure returns
available provider data with a warning and keeps an in-process copy. It does not
switch the application's case store or discard user data.

## Verification

Implementation files changed for this feature:

| Area | Files |
| --- | --- |
| Provider and model | `src/lib/integrations/nyc-open-data.ts`, `src/lib/building-context.ts`, `src/lib/types.ts`, `src/lib/seed.ts` |
| Cache and persistence | `src/lib/server/buildings.ts`, `src/lib/server/mongodb.ts`, `src/lib/server/cases.ts` |
| HTTP routes | `src/app/api/buildings/route.ts`, `src/app/api/cases/[id]/building/route.ts`, `src/app/api/landlord/cases/[id]/building/route.ts` |
| Workspace UI | `src/components/building-history.tsx`, `src/components/case-panels.tsx`, `src/components/rent-workspace.tsx`, `src/components/landlord-workspace.tsx`, `src/components/new-case-dialog.tsx`, `src/app/globals.css` |
| Tests | `tests/nyc-open-data.test.ts`, `tests/buildings.test.ts`, `tests/integrations.test.ts`, `tests/mongodb-connection.test.ts`, `tests/e2e/building-history.spec.ts` |
| Documentation | `README.md`, `docs/integrations.md`, `docs/nyc-building-history.md` |

Provider unit tests use mocked NYC responses. Service tests cover cache expiry,
single-flight requests, stale fallback, MongoDB reconnect persistence, access
control, and unchanged case/financial state under malicious provider text.
Browser tests cover the public routes, role boundaries, labels, empty/partial
data, and retry behavior. Run:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e tests/e2e/building-history.spec.ts
```

The browser harness starts a disposable MongoDB and disables financial and
messaging providers; these checks do not send messages or transfer funds.

## Limits

The latest 100 provider rows per history dataset are returned. Complaint problems
are grouped into unique complaints, so counts are counts within that result set.
Open-violation totals can omit older records beyond the cap. Provider publication
lag is independent of this application's refresh time. HPD coverage and exact
principal addresses are required; alternate entrances may not match. Elevator
context appears only when supplied by these HPD datasets; DOB elevator records
are not queried. Public records cannot establish the conditions in a particular
apartment, causation, legal entitlement, or authority to move money.
