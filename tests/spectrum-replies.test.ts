import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSpectrumReply, runSpectrumReplies, type ReplyApp } from "../scripts/spectrum-replies";
import { ApiError } from "../src/lib/server/errors";
import { PhotonCaseBindingRejectedError, type ParticipantReceiveResult, type PhotonBindingDiagnostic } from "../src/lib/server/cases";

const config = { provider: "spectrum" as const, projectId: "test", projectSecret: "secret", allowedRecipient: "+15555550123", tenantId: "owner", caseId: "RE-1042", sendingLine: "+15555550124" };
const room = { id: "conversation", type: "dm", phone: config.sendingLine };
const raw = { platform: "imessage", direction: "inbound", id: "reply-id", timestamp: new Date("2026-09-26T12:00:00Z"),
  space: { id: room.id }, sender: { address: config.allowedRecipient }, content: { type: "text", text: "Private reply" } };
const incoming = normalizeSpectrumReply(room, raw)!;

test("Spectrum normalizer accepts only inbound direct-message text with matching space metadata", () => {
  assert.equal(incoming.body, "Private reply");
  assert.equal(incoming.conversationId, room.id);
  assert.equal(incoming.sendingLine, config.sendingLine);
  for (const message of [
    { ...raw, direction: "outbound" }, { ...raw, platform: "slack" }, { ...raw, timestamp: new Date(NaN) },
    { ...raw, space: { id: "wrong" } }, { ...raw, sender: undefined }, { ...raw, content: { type: "image" } },
    { ...raw, content: { type: "text", text: "  " } },
  ]) assert.equal(normalizeSpectrumReply(room, message), undefined);
  assert.equal(normalizeSpectrumReply({ ...room, type: "group" }, raw), undefined);
  const reply = normalizeSpectrumReply(room, { ...raw, content: { type: "reply", content: raw.content, target: { id: "outbound-id" } } });
  assert.equal(reply?.replyToMessageId, "outbound-id");
});

function harness() {
  const logs: string[] = [];
  const received: unknown[] = [];
  let stopped = 0;
  const app: ReplyApp = {
    messages: (async function* () { yield incoming; })(),
    stop: async () => { stopped += 1; },
  };
  const options = { config, enabled: true, createApp: async () => app,
    logger: { log: (text: string) => logs.push(text), error: (text: string) => logs.push(text) },
    receive: async (...args: Parameters<NonNullable<Parameters<typeof runSpectrumReplies>[0]>["receive"] & {}>) => {
      received.push(args);
      return { case: {} as never };
    },
  };
  return { app, options, logs, received, stopped: () => stopped };
}

test("listener requires explicit opt-in and never exposes secrets or bodies in logs", async () => {
  const h = harness();
  assert.equal(await runSpectrumReplies({ ...h.options, enabled: false }), 1);
  assert.equal(h.stopped(), 0);
  assert.equal(await runSpectrumReplies(h.options), 0);
  assert.deepEqual(h.received, [[config.tenantId, undefined, incoming]]);
  assert.equal(h.stopped(), 1);
  assert.doesNotMatch(h.logs.join("\n"), /secret|Private reply|15555550123/);
});

test("listener filters unrelated contacts/lines and ignores rejected conversations without auto-replying", async () => {
  const h = harness();
  h.app.messages = (async function* () {
    yield undefined;
    yield { ...incoming, sender: "+15555550199" };
    yield { ...incoming, sendingLine: "+15555550199" };
    yield incoming;
  })();
  let calls = 0;
  assert.equal(await runSpectrumReplies({ ...h.options, receive: async () => {
    calls += 1;
    throw new ApiError(403, "Private body", false, "MESSAGE_BINDING_REJECTED");
  } }), 0);
  assert.equal(calls, 1);
  assert.equal(h.stopped(), 1);
});

test("managed shared-line replies reach the receiver for exact case binding validation", async () => {
  const h = harness();
  const shared = { ...incoming, sendingLine: "shared" };
  h.app.messages = (async function* () {
    yield { ...shared, sender: "+15555550199" };
    yield shared;
  })();
  assert.equal(await runSpectrumReplies(h.options), 0);
  assert.deepEqual(h.received, [[config.tenantId, undefined, shared]]);
});

test("case binding rejection logs individual checks without contacts, message text or secrets", async () => {
  const h = harness();
  const diagnostic: PhotonBindingDiagnostic = {
    caseId: "RE-1042", senderRole: "tenant", ownerMatch: true, bindingOwnerMatch: true, bindingCaseMatch: true,
    tenantBindingExists: true, tenantUserIdMatch: true, tenantPhoneMatch: true,
    landlordBindingExists: true, landlordUserIdMatch: true, landlordPhoneMatch: true, landlordContactMatch: true,
    supportedCase: true, configuredCaseMatch: true, workspaceOwnerMatch: true,
    workspaceTenantUserIdMatch: true, workspaceLandlordUserIdMatch: true, senderPhoneMatch: true,
    sendingLineMatch: false, conversationMatch: false, conversationBindingExists: false,
    firstConversationAllowed: true, knownRouteExists: false, quoteMatch: true, timestampMatch: true,
  };
  assert.equal(await runSpectrumReplies({ ...h.options, receiveParticipant: async () => {
    throw new PhotonCaseBindingRejectedError("no_matching_conversation", [diagnostic]);
  } }), 0);
  const line = h.logs.find((entry) => entry.startsWith("CASE_BINDING_REJECTED "));
  assert.ok(line);
  assert.deepEqual(JSON.parse(line.slice("CASE_BINDING_REJECTED ".length)), { providerEventId: incoming.id, ...diagnostic });
  assert.match(h.logs.join("\n"), /"reason":"case_binding_rejected","failedCheck":"no_matching_conversation"/);
  assert.doesNotMatch(h.logs.join("\n"), /secret|Private reply|15555550123|15555550124/);
  assert.equal(h.stopped(), 1);
});

test("listener reports interpretation, cold-start success, duplicates and explicit safe relay failures", async () => {
  for (const status of ["sent", "failed", "uncertain"] as const) {
    const h = harness();
    h.app.messages = (async function* () { yield incoming; yield incoming; })();
    let calls = 0;
    const result = await runSpectrumReplies({ ...h.options, receiveParticipant: async () => {
      const duplicate = calls++ > 0;
      const processing: ParticipantReceiveResult["processing"] = {
        caseId: "RE-1042", providerEventId: incoming.id, inboundMessageId: "stored-inbound-id",
        role: "landlord", senderMasked: "+1 (***) ***-0123", duplicate,
        intent: "scheduled", interpretationSource: "rules", eventType: "MAINTENANCE_SCHEDULED", caseStateUpdated: !duplicate,
        relay: { role: "tenant", generated: true, attempted: !duplicate, recipientMasked: "+1 (***) ***-0558", status,
          conversation: duplicate ? "not-started" : status === "sent" ? "cold-start-created" : "cold-start-requested",
          ...(status === "sent" ? { providerMessageId: "outbound-provider-id" } : { reason: "The sending line is unavailable." }) },
      };
      return { case: {} as never, processing };
    } });
    assert.equal(result, 0);
    assert.equal(h.received.length, 0, "the two-sided receiver takes priority over the legacy callback");
    const logs = h.logs.join("\n");
    assert.match(logs, /INBOUND_PHOTON_MESSAGE .*MAINTENANCE_SCHEDULED/);
    assert.match(logs, /"duplicate":true/);
    assert.match(logs, status === "sent" ? /TENANT_RELAY .*outbound-provider-id/ : /TENANT_RELAY_FAILED .*sending line is unavailable/);
    assert.doesNotMatch(logs, /Case reply persisted or already recorded|secret|Private reply|15555550123/);
  }
});

test("persistence failure stops consumption, closes the client, and is sanitized", async () => {
  const h = harness();
  let reads = 0;
  h.app.messages = (async function* () { reads += 1; yield incoming; reads += 1; yield incoming; })();
  assert.equal(await runSpectrumReplies({ ...h.options, receive: async () => { throw new Error("secret Private reply"); } }), 1);
  assert.equal(reads, 1);
  assert.equal(h.stopped(), 1);
  assert.doesNotMatch(h.logs.join("\n"), /secret|Private reply/);
});

test("abort wakes an idle listener and bounds provider cleanup", async () => {
  const h = harness();
  const controller = new AbortController();
  h.app.messages = { [Symbol.asyncIterator]: () => ({ next: () => {
    controller.abort();
    return new Promise(() => {});
  } }) };
  assert.equal(await runSpectrumReplies({ ...h.options, signal: controller.signal }), 0);
  assert.equal(h.stopped(), 1);
  h.app.messages = (async function* () {})();
  h.app.stop = () => new Promise(() => {});
  assert.equal(await runSpectrumReplies({ ...h.options, shutdownTimeoutMs: 5 }), 1);
});
