# Photon Spectrum: two-sided repair coordination

The existing Messages workflow connects a Tenant Agent and a Landlord Agent.
They share the existing MongoDB case, receive authenticated Spectrum cloud
messages, interpret permitted repair events, and send mediated updates. Original
human text, interpretation, event, and relay remain in the same case history.

## Accounts and configuration

Run `pnpm seed:users` after configuring MongoDB. It preserves user IDs and history
and configures the existing demo accounts:

| Account | Role | Contact | Password |
| --- | --- | --- | --- |
| `tenant1@rentescrow.demo` (Rayaan) | Tenant | +1 (***) ***-0558 | `TenantDemo123!` |
| `landlord@rentescrow.demo` (Alex Morgan) | Landlord | +1 (***) ***-7033 | `LandlordDemo123!` |

MongoDB `users.phoneContact` stores normalized E.164 and
`phoneContactConfiguredAt` records operator configuration. These are configured
demo destinations, not SMS-verified identities or login credentials. Account
responses return only `maskedPhone`. Jordan has no configured phone and cannot
inherit Rayaan's live authority.

Configure ignored `.env.local`; never use `NEXT_PUBLIC_` prefixes:

```dotenv
RENTESCROW_STORAGE=mongodb
MONGODB_URI=<MongoDB connection string>
MONGODB_DATABASE=rentescrow
SPECTRUM_PROJECT_ID=<Photon project ID>
SPECTRUM_PROJECT_SECRET=<Photon project secret>
PHOTON_LIVE_SEND=true
PHOTON_RECEIVE_ENABLED=true
PHOTON_TENANT_ID=<Rayaan's workspaceOwnerId from authenticated /api/auth/me>
PHOTON_CASE_ID=RE-1042
PHOTON_ALLOWED_RECIPIENT=+12018567033
PHOTON_TENANT_PHONE=+19736060558
# Optional: a particular project-owned line, or shared.
# SPECTRUM_SENDING_LINE=shared
# For general natural-language interpretation:
GEMINI_API_KEY=<Gemini API key>
GEMINI_MODEL=gemini-3.8-flash
```

`PHOTON_ALLOWED_RECIPIENT` is the landlord; `PHOTON_TENANT_PHONE` is the tenant.
Neither is the provider sending line. The tenant ID is the server-generated
workspace owner ID, not a phone, cookie, or MongoDB user ID. New bound cases have
unique IDs; leave `PHOTON_CASE_ID=RE-1042` for the legacy seed. Restart app and
listener after changing settings.

## Photon dashboard and inbound transport

1. Select the intended project in the [Photon dashboard](https://app.photon.codes).
2. Copy `PROJECT_ID` and `SECRET_KEY` from project **Settings** into the two
   Spectrum variables above. See [credential setup](https://photon.codes/docs/spectrum-ts/getting-started).
3. Ensure that project has an active cloud iMessage line. `imessage.config()`
   discovers project lines; optionally pin a dedicated line with
   `SPECTRUM_SENDING_LINE`. See [cloud line routing](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing).
4. Run one long-lived `pnpm agent` process with the same database and settings as
   Next. It consumes the authenticated provider stream for both contacts.

The send adapter resolves the approved case participant with `im.user()`, opens
the first DM with `im.space.create(user, { phone: sendingLine })`, and reuses a
saved conversation with `im.space.get(id, { phone: savedLine })`. A confirmed
send saves the returned conversation ID and route on the case participant.
Lookup or creation failures do not mark a message sent; failures after dispatch
remain uncertain and are not retried automatically.

On dedicated projects, `SPECTRUM_SENDING_LINE=+16287896827` pins that exact
project-owned line. On managed shared projects, Spectrum 12.10.1 ignores a
physical line parameter and dynamically routes through its shared pool. Its
spaces and replies report `phone: "shared"`; the case saves and reuses that
logical route. The SDK cannot pin a physical shared-pool number. Both approved
contacts must also be registered under the Photon project's **Users** tab.
`im.user()` resolves a handle and does not enroll users or bypass Photon's
provider-side allowlist. See [shared recipient approval](https://photon.codes/docs/spectrum-ts/troubleshooting/imessage).

**Webhook URL: none.** This implementation retains the existing Spectrum
listener. No HTTP inbound route, public tunnel, dashboard webhook URL, or signing
secret is needed. Do not point a dashboard webhook at case action routes. Future
HTTP mode must use [Spectrum's signature verification](https://photon.codes/docs/spectrum-ts/webhooks)
and durable ingestion before acknowledging delivery; it is not enabled here.

The listener disables automatic profile/contact-card sharing through the existing
Spectrum 12.10.1 compatibility wrapper. Review it before upgrading. Do not run
the old isolated echo example in `scripts/spectrum-agent.ts`.

## Binding and routing

Seeding copies configured contacts into the tenant workspace. New cases for the
assigned property use its persisted landlord and the authenticated tenant to
store `case.messagingBinding`: `ownerId`, `caseId`, and two participants with
`userId`, `phone`, and provider conversation/sending line after acceptance. Unknown
contacts and unassigned properties cannot get a two-sided binding. The assigned
demo property is **123 Example Street, Brooklyn**.

Inbound messages must be direct incoming iMessages from configured contacts.
Routing checks participant, workspace ownership, case binding, provider line,
timestamp, and optional quoted message ID. An established participant conversation
or confirmed outbound receipt anchors replies. If neither exists for that sender
anywhere in the workspace, the first authenticated, unquoted DM can establish the
route for `PHOTON_CASE_ID` only. Both persisted participant identities must match
the configured contacts, and the provider DM identifier must name the exact
sender. The accepted conversation and sending line are saved before interpretation
or relay. Later messages reuse that route. A case ID in text grants no access.
If cases share a phone conversation, quote the relevant notice/relay; ambiguous
plain replies are rejected rather than guessed.

Seeding does not reassign existing live conversations or settlement history.
Use a new correctly bound case when old contact roles differ. The guarded
`pnpm photon:bind` command verifies the registered tenant against the workspace
owner, resolves the landlord from the assigned MongoDB property, and checks both
canonical user roles and operator-configured contacts. It repairs absent or
one-sided bindings without replacing existing conversation routes or message and
financial history. Conflicting identities or contacts are rejected. Reruns leave
the case and its binding audit unchanged. The local legacy-demo path is labeled
separately and does not stand in for registered-user verification. Never
reset/delete uncertain sends to force another delivery.

## Agents and payment boundary

Gemini receives untrusted text, sender role, and minimal repair/scheduling context
and returns a strict operational schema. Missing/unavailable Gemini uses labeled
conservative rules.

- Landlord messages can schedule/change maintenance, report progress, or report
  completion. Completion prompts the tenant to upload fresh evidence.
- Tenant messages can request another time, confirm availability, report a missed
  visit/unresolved conditions, or ask a question.
- Agent relays use mediated templates and sanitized schedule details, not raw
  human messages or executable model instructions.
- Neither agent can confirm the repair for the tenant, verify evidence, release
  escrow, sign/submit XRPL, or change wallets, amounts, or banking identifiers.

Both interfaces distinguish Tenant, Landlord, Tenant Agent, and Landlord Agent.
`PHOTON LIVE` indicates configuration, not handset delivery. Provider acceptance
is labeled as acceptance. `PHOTON DEMO` saves simulated sends locally. Incomplete
explicitly enabled live configuration reports unavailable; failed live sends
never become simulated successes.

## Run the real phone demo

```sh
pnpm seed:users    # configure accounts/contacts; no message sent
pnpm photon:check # read-only project authentication; no message sent
pnpm dev          # app terminal
pnpm agent        # second terminal, keep running
```

1. Sign in as Rayaan. Create a no-heat case at the assigned demo property and
   submit the repair-coordination form. The Tenant Agent sends the repair notice
   and records the receipt. New cases have unique IDs, while `RE-1042` is seeded.
   New notices do not invent a 54 F reading; upload/analyze evidence before
   claiming a temperature.
2. Check Alex's phone for the actual iMessage. Reply “I can send someone tomorrow
   at 10.” Check the maintenance event and Rayaan's mediated update.
3. Rayaan replies “Can he come at 11 instead?” Check Alex's phone, then reply
   “Yes 11 works.” Check the revised schedule and tenant confirmation message.
4. Alex replies “The heat is fixed now.” Check the completion report and tenant
   request for fresh evidence. Continue through evidence analysis, verification,
   tenant confirmation, and the existing separate escrow/XRPL review.
5. Inspect both account conversations. With several cases in one DM, use Apple
   Messages' reply-to action on the relevant notice to disambiguate.

### Verify the existing RE-1042 relay after an update

Keep the configured contacts, credentials, ownership, and sending line unchanged.
Stop the old listener with Ctrl-C and start `pnpm agent` from this checkout;
the long-running process does not reload source changes. Restart a production
app after `pnpm build` as well.

For the tenant `case_binding_rejected` failure, a complete two-sided identity
binding alone was insufficient: Rayaan had no saved DM, and the earlier uncertain
tenant relays supplied no confirmed conversation receipt. The old receiver
required one of those anchors, while `photon:bind` correctly left the existing
identities unchanged. Verify the first-contact repair before testing relays:

1. Keep `PHOTON_CASE_ID=RE-1042`, the approved tenant/landlord contacts, the
   registered workspace owner, and `SPECTRUM_SENDING_LINE=shared`. Both phone
   numbers must be approved users in the Photon project.
2. Run `pnpm photon:bind` twice. Both runs should report both approved participants;
   the second must not add another binding audit event or change the case.
3. Restart `pnpm agent` with the same MongoDB configuration. From Rayaan's
   `+19736060558` phone, send a **fresh, unquoted** message in the existing Photon
   iMessage thread: `Can someone come at 11 tomorrow instead?`
4. Expect `PHOTON_EVENT_RECEIVED`, then `INBOUND_PHOTON_MESSAGE` with
   `caseId: "RE-1042"` and `role: "tenant"`. Confirm the persisted tenant binding
   now has the provider conversation ID and `sendingLine: "shared"`, while its
   user ID stays `6ab8b3cd278117b4c7673860`. A successful relay logs
   `LANDLORD_RELAY` with `status: "sent"` and a provider ID; check Alex's phone.
5. Send another tenant message and an Alex reply from `+12018567033`. Both must
   resolve to RE-1042 and retain their own saved routes and user IDs. Check that
   balances, escrow, tenant repair confirmation, and XRPL authority are unchanged.

If rejected, `CASE_BINDING_REJECTED` now reports safe booleans for each candidate
case: owner, participant existence/user ID/contact, workspace identity, line,
conversation, first-contact eligibility, quote, and timestamp checks. The following
`INBOUND_PHOTON_REJECTED` identifies the rejection category. These logs contain no
message body, full contact number, or project secret. Old uncertain sends remain
uncertain and are not automatically resent.

1. From Alex's existing iMessage conversation, reply to the RE-1042 notice with
   `i will send somebody around 10 tomorrow`. Use reply-to if more than one case
   shares that conversation.
2. Expect `PHOTON_EVENT_RECEIVED`, then `INBOUND_PHOTON_MESSAGE` with
   `caseId: "RE-1042"`, `role: "landlord"`, `duplicate: false`, and
   `eventType: "MAINTENANCE_SCHEDULED"`.
3. Expect `TENANT_RELAY` with `status: "sent"`, an outbound provider ID, and
   `conversation: "cold-start-created"` for the first tenant send, or `"reused"`
   thereafter. Check Rayaan's phone and the case's saved schedule/message. An
   omitted AM/PM remains omitted; confirm it with the participants.
4. Rayaan replies `Can he come at 11 instead?`; expect `LANDLORD_RELAY` and
   Alex's phone to receive the request. Alex replies `Yes 11 works.`; expect
   `MAINTENANCE_RESCHEDULED` and another `TENANT_RELAY` using the saved DM.
5. Alex replies `Heat is fixed now.`; expect `REPAIR_REPORTED_COMPLETE` and
   Rayaan's request to upload new evidence. Messaging does not grant tenant
   confirmation, evidence verification, or payment authority.

`TENANT_RELAY_FAILED` / `LANDLORD_RELAY_FAILED` include the persisted failure
state and a sanitized reason. An inbound receipt log alone is not a send result.
`GEMINI_MESSAGE_INTERPRETATION_FALLBACK` identifies an unavailable request or an
invalid model response; the rules remain available, and unrecognized messages
produce a fixed case-review notification without forwarding arbitrary text.
No body, credential, financial instruction, or full phone is included in these
diagnostic logs.

Automated tests send completion messages containing attacker wallets, bank
accounts, amounts, and payment instructions and assert financial authority stays
unchanged. Tests send no real iMessage or ledger transaction.

## Persistence, recovery, and limitations

MongoDB cases retain full trusted contact bindings, original/agent text,
provider IDs/conversations, timestamps, interpretations, safe events, and send
states. Provider credentials are never stored in case documents. Inbound IDs
are deduplicated under the workspace lock. Outgoing attempts are checkpointed
before dispatch. Pending/uncertain sends are retained without blind retry;
inspect the provider conversation before operator reconciliation. Case creation
survives provider failure and exposes its recorded delivery state.

Inbound `processedAt` and `relayRequired` distinguish receipt persistence from
interpretation and relay work. A previously stored interpretation with no relay
attempt can resume when the same authenticated provider event is received again;
old `other` classifications are interpreted again. An existing relay attempt
prevents another send, including failed or uncertain attempts. State events and
intentional stale-event suppression are not duplicated. Original inbound IDs,
local human-message IDs, local relay IDs, and outbound provider IDs remain
separate and are linked through `triggerMessageId`.

The listener must stay online. There is no guaranteed offline provider replay,
inbound attachment import, handset delivery/read subscription, or automatic
uncertain-send reconciliation. This demo supports one configured tenant workspace
and its assigned landlord. Broad language understanding requires Gemini; rules
are intentionally limited and ambiguous times need human review.

USD escrow, sample evidence, and fixture banking remain simulated. Configured
Spectrum messages, Gemini analysis, and separately enabled XRPL Testnet payments
use their real providers. Test XRP has no USD conversion relationship.

## Verification and changed paths

Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm test:e2e`. Tests use fake
Spectrum calls and disposable MongoDB, never the demonstration phones.

Core: `src/lib/server/cases.ts`, `store.ts`, `auth.ts`, `auth-store.ts`,
`src/lib/integrations/photon.ts`, `messaging-agent.ts`, `src/lib/types.ts`,
`messaging-contact.ts`, `seed.ts`, `scripts/seed-users.ts`, `spectrum-replies.ts`,
and `bind-photon-case.ts`. Existing workspace components and landlord projection
show the shared conversation. `.env.example` documents configuration.
