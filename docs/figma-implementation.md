# Tenant design implementation

Source: the user's `Untitled.fig`. Its embedded scene graph, original image fills, vector geometry, and text styles were read directly from the archive. The source file did not include a usable Figma cloud file key.

## Screens

| Figma frame | Node | App surface |
| --- | --- | --- |
| RentEscrow NYC landing page | `55:4504` | `/` and `/login` when signed out |
| My cases dashboard | `9:10856` | `/tenant` |
| Case overview | `9:10962` | Tenant case → Overview |
| Evidence library | `9:11149` | Tenant case → Evidence |
| Evidence review | `9:11345` | Open an evidence item |
| Messages and notice | `9:11481` | Tenant case → Messages |
| Finances | `9:11604` | Tenant case → Finances |
| Rent escrow | `9:11794` | Tenant case → Escrow |
| Case activity | `9:11986` | Tenant case → Activity |

The desktop source uses a 1440px canvas, a 220px tenant sidebar, a 52px workspace header, and Inter. The landing splits at 660/780px. CSS adapts these proportions to smaller screens and keeps the mobile navigation drawer.

## Assets and scope

- `public/figma/nyc-skyline.png`, `door.png`, and `door-brand.png` are the original archive images, copied without alteration.
- The four landing icons are SVG exports of their original vector geometry, retaining the source dimensions.
- Inter is served locally from `src/app/fonts/InterVariable.woff2`; its license is included alongside it.
- Landing styles are scoped to `.figma-landing`; tenant styles are scoped to `.tenant-design` so they do not restyle the landlord workspace.
- Figma empty states appear when no case is selected. Populated cases retain the existing evidence, messaging, financial, and settlement functionality.
- Placeholder capability descriptions are aligned with the actual upload limits and approval mechanisms. No new bank connection, MFA, court approval, or email password-reset service is implied.

The requested addition is a keyboard-accessible Tenant/Landlord sign-in choice. `expectedRole` constrains sign-in after password verification; the stored account role remains authoritative. Demo account prefills are available in a collapsed section. Signed-in visitors retain the existing role-based redirect.

This supplied design covers the tenant experience. The role selector routes landlord accounts to `/landlord`; landlord styling is outside this implementation's scope.

## Tenant contracts

The additional Contracts screenshot is implemented in the tenant workspace at `/tenant?view=contracts`. The sidebar selection and breadcrumb identify the tenant perspective. The page uses stored agreement terms, policy details, and signature dates; tenants can review and sign only for their own account. Both parties must accept the same terms and policy version before a bilateral agreement becomes active.

The current contract API stores immutable text and policy records, not uploaded PDFs. The document pane therefore renders those actual terms. PDF replacement and signature reminders are unavailable, and activation occurs automatically after both signatures. Existing agreement management remains available at `/agreements`.

## Verification

- TypeScript and a production Next.js build.
- Auth unit tests cover both roles, wrong-role selection without session creation, invalid input, and legacy clients without a selection.
- `tests/e2e/landing-entry.spec.ts` verifies the rendered landing routes, original asset dimensions, local font delivery, both role redirects, access guards, and logout using HTTP requests against an isolated temporary database.
- Existing browser workflow specs were adjusted for the new dashboard entry and explicit landlord role selection.
- Tenant Contracts: 11 contract/preview regression tests pass. The HTTP route test verifies the tenant entry, selected navigation, sign-in redirect, and landlord redirect against an isolated database. Browser specs cover review confirmation, exact signature payloads, retry, navigation history, and mobile overflow; they were authored but not executed because browser access was unavailable.
- The full unit suite completed with 316 passing tests and three existing contract-runtime failures. Running those three tests against the unchanged `HEAD` snapshot reproduced the same failures.

Interactive browser visual verification requires Computer Use access, which was unavailable in this session. The reference layouts were inspected through offline renders of the supplied scene graph.
