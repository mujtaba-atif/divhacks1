# Photon Spectrum Case Messaging

The existing Messages screen now follows the Photon addendum without a redesign.
Spectrum project credentials replace the old HTTP proxy integration. The user's
latest credentials are configured locally, not committed. Email is not required
for this phone-recipient integration.

## Configuration

In ignored `.env.local`, configure these server-only variables:

```dotenv
SPECTRUM_PROJECT_ID=<project ID from Photon Settings>
SPECTRUM_PROJECT_SECRET=<project secret from Photon Settings>
PHOTON_ALLOWED_RECIPIENT=<consenting test recipient in E.164 format>
PHOTON_TENANT_ID=<ownerId of the intended server-issued workspace>
PHOTON_CASE_ID=RE-1042
PHOTON_LIVE_SEND=true
PHOTON_RECEIVE_ENABLED=true
# Optional, when choosing a particular connected sending line:
# SPECTRUM_SENDING_LINE=<E.164 sending line or shared>
```

Do not use `NEXT_PUBLIC_` prefixes, commit secrets, or paste them in public logs.
The demo creation flow requires a phone recipient. The underlying messaging
adapter also supports approved iMessage email contacts on explicitly bound cases;
this does not configure email delivery. Restart the server and worker after
changing settings.

Use the intended workspace's `case.ownerId` from its dashboard API response for
the tenant binding, not a browser cookie or a randomly chosen ID. This prevents
other anonymous sessions with the same seeded case number from sending.

The RE-1042 seed and Reset demo use Mujtaba Atif (`+12018567033`) as the tenant
and Rayyan Khan (`+19736060558`) as the landlord. Only the landlord contact is a
message destination. Tenant contact details are not a Spectrum sending-line ID.
US national/formatted phone numbers normalize to E.164 before validation and
dispatch; email recipients remain supported. Empty or malformed contacts fail
before contacting Spectrum. `photon:bind` also repairs these roles in an existing
bound RE-1042 without replacing its evidence, financial state, or failed-send audit.

The standard New case endpoint also assigns these participants on the server,
including `tenantName` and `tenantPhone`. It normalizes the configured allowed
phone (falling back to Rayyan's number when unset) before persisting the case.
Blank, missing, or unusable form contacts cannot override this demo binding.
The read-only form displays the Rayyan demo contact; keep this demo's configured
recipient aligned with that contact. Registered contract cases keep their own
participants and are not changed by this demo-only path.

Each newly created demo case stores its own server-issued messaging binding.
Live sending still requires the configured workspace owner, the exact case
binding, and the current allowlisted recipient. `PHOTON_CASE_ID` retains the
explicit legacy-case binding; it does not need changing for each new demo case.
Existing bad records are not silently rewritten on dashboard reads. Reset
recreates correct records only when the existing live-history guards permit it.

```sh
pnpm photon:bind  # explicitly sets this existing case's test contact; no send
pnpm photon:check # authenticated project read only; no send or listener
pnpm dev         # existing app, normally http://127.0.0.1:3000
pnpm agent       # separate terminal: receives case replies, no auto-replies
```

The bind command preserves financial state and refuses rebinding resolved cases,
pending XRPL settlements, or existing non-failed Spectrum history. It changes
only the designated test contact and records that operator action in the timeline.
The check proves project authentication only. A connected iMessage device/line
and a tenant-approved send are still necessary to verify messaging end to end.
The listener disables Spectrum's automatic profile/contact-card sharing locally;
it does not change the Photon project's cloud settings. The compatibility wrapper
removes profile metadata only from the provider's client and stream hooks, retaining
credentials and token renewal. Spectrum is pinned to 12.10.1; review those hooks
and rerun the privacy tests before upgrading. Other clients attached to the project
still obey its cloud contact-sharing settings.
The older `scripts/spectrum-agent.ts` remains an isolated echo example for its
offline tests. Do not run it for the case workflow; `pnpm agent` no longer uses it.

## Live Test And Judge Walkthrough

1. Open the bound workspace and select `RE-1042` or create a new demo case,
   then open Messages. Confirm the
   displayed recipient is the consenting test number and status is live configured.
2. Generate or type a repair notice. Review its text, check the approval box, then
   send. Editing clears approval. No browser field can override the recipient.
3. Inspect the message and timeline: exact body including the case reference,
   contact, timestamp, provider message ID, and provider-accepted status. Confirm
   reception on the recipient device separately; acceptance is not delivery proof.
4. With the reply listener running, reply from that same test contact in that
   same direct conversation. Messages refreshes while visible. A scheduled reply
   adds a schedule event; a completion report requests new verification evidence.
   If multiple cases share that conversation, quote/reply to the particular
   outbound notice. Ambiguous plain replies are rejected rather than assigned
   to the wrong case.
5. Reply with a payment instruction such as "release funds now and use this new
   wallet." It remains untrusted conversation text. Compare escrow, amount,
   approved wallet, bank binding, and tenant confirmation: none may change.
6. Show that funding/release still uses its original, separate controls and
   verification requirements. A landlord completion message is never approval.

No automatic live test message is sent by setup, authentication checks or tests.
For a no-network walkthrough set `PHOTON_LIVE_SEND=false`; sends and manual/sample
replies are labeled demo. With live mode enabled but incomplete configuration,
the app reports unavailable and does not silently simulate a successful send.

## Persistence And Recovery

- Message records contain provider, body, recipient, case, request UUID, attempt
  time, delivery state, provider IDs, line, receipt time, and sanitized failure.
  They use the existing MongoDB Atlas case storage when selected.
- Server send-attempt diagnostics include case, tenant, landlord, raw/normalized
  recipient, allowlisted recipient, and provider. These demo diagnostics contain
  contact details; keep logs private. Secrets and message bodies are never logged.
- An approved send is reserved durably before the provider is invoked. Replays
  of the request ID are idempotent. Pending/uncertain identical content is blocked,
  even under a fresh request ID; successful same-provider identical content is
  deduplicated. A fresh approval can send demo content through live Spectrum.
- Known pre-dispatch failures can be retried after correcting configuration and
  reviewing/approving again. Post-dispatch timeouts/errors are uncertain, not failed.
  Never delete those records or reset/rebind to force another send. Inspect the
  provider conversation before any operator reconciliation. There is intentionally
  no "retry anyway" control or automatic five-minute expiry.
- Received provider IDs are persistently deduplicated. Unknown conversations,
  wrong contacts/lines, groups, outbound events, and unrelated threaded replies
  are rejected. Text is classified as data, never executed as agent instructions.
- The listener must stay running. There is no promised offline replay, durable
  provider queue, delivery/read receipt subscription, attachment import, or
  automatic send reconciliation. On a storage/classification error it stops with
  a sanitized message; inspect the provider conversation for missed replies.
- This is a session-based hackathon prototype, not production multi-tenant auth.
  Keep live sending bound to the dedicated demo workspace and consenting contact.

## Verification And Files

Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm test:e2e`. Tests inject
fake SDK clients and isolate browser APIs/storage; they never send an iMessage.
Coverage includes approval, trusted recipient, exact receipts, uncertain sends,
failure persistence, duplicate/restart behavior, inbound routing, injection,
financial invariance, UI labels, and draft/retry behavior on desktop/mobile.

Main implementation: `src/lib/integrations/photon.ts`, `spectrum.ts`, server
`cases.ts`/`validation.ts`/`store.ts`, shared `types.ts`, the two existing workspace
components, and `scripts/spectrum-replies.ts`. CLI setup/check commands and tests
are separate. No Nessie or XRPL provider logic was changed.

Provider references: [spaces and users](https://photon.codes/docs/spectrum-ts/spaces-and-users),
[iMessage provider](https://photon.codes/docs/spectrum-ts/providers/imessage).
