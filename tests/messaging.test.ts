import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CaseAction, CaseRecord } from "../src/lib/types";
import { prepareLandlordMessage } from "../src/lib/integrations/photon";
import { DeliveryUncertainError, IntegrationError } from "../src/lib/integrations/shared";
import { actionSchema } from "../src/lib/server/validation";

const originalDirectory = process.cwd();
let directory: string;
let performCaseAction: typeof import("../src/lib/server/cases")["performCaseAction"];
let receiveLandlordMessage: typeof import("../src/lib/server/cases")["receiveLandlordMessage"];
let createSession: typeof import("../src/lib/server/store")["createSession"];
let mutateSession: typeof import("../src/lib/server/store")["mutateSession"];
let readSession: typeof import("../src/lib/server/store")["readSession"];
let resetSession: typeof import("../src/lib/server/store")["resetSession"];
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "rentescrow-messaging-"));
  process.chdir(directory);
  ({ performCaseAction, receiveLandlordMessage } = await import("../src/lib/server/cases"));
  ({ createSession, mutateSession, readSession, resetSession } = await import("../src/lib/server/store"));
});
after(async () => { process.chdir(originalDirectory); await rm(directory, { recursive: true, force: true }); });

const recipient = "+12125550100";
const line = "+12125550199";
function action(body = "Please schedule a heating repair."): Extract<CaseAction, { action: "send_message" }> {
  return { action: "send_message", body, approved: true, requestId: randomUUID() };
}

async function fixture() {
  Object.assign(process.env, { RENTESCROW_STORAGE: "local", PHOTON_LIVE_SEND: "true",
    SPECTRUM_PROJECT_ID: "offline-project", SPECTRUM_PROJECT_SECRET: "offline-secret",
    PHOTON_ALLOWED_RECIPIENT: recipient, SPECTRUM_SENDING_LINE: line, PHOTON_SENDING_LINE: line });
  delete process.env.GEMINI_API_KEY;
  delete process.env.NESSIE_ENABLED;
  const { document } = await createSession();
  const ownerId = document.ownerId;
  const caseId = document.cases[0].id;
  Object.assign(process.env, { PHOTON_TENANT_ID: ownerId, PHOTON_CASE_ID: caseId });
  await mutateSession(ownerId, (stored) => { stored.cases[0].landlordContact = recipient; });
  let calls = 0;
  const dependencies = {
    prepare: prepareLandlordMessage,
    send: async (record: CaseRecord, body: string) => {
      calls += 1;
      const stored = await readSession(ownerId);
      assert.equal(stored?.cases[0].messages.at(-1)?.delivery, "pending", "reservation must be durable before dispatch");
      if (!stored?.cases[0].messages.some((message) => message.delivery === "sent" || message.delivery === "demo")) {
        assert.equal(stored?.cases[0].status, "open", "pending is not notification");
      }
      return { ...prepareLandlordMessage(record, body), delivery: "sent" as const,
        providerMessageId: `outbound-${calls}`, providerConversationId: "conversation-1", sendingLine: line, sentAt: new Date().toISOString() };
    },
  };
  return { ownerId, caseId, dependencies, calls: () => calls };
}

test("both schema and service require explicit tenant approval and a request UUID", async () => {
  const f = await fixture();
  for (const invalid of [
    { action: "send_message", body: "Please repair the heat." },
    { ...action(), approved: false },
    { ...action(), requestId: "not-a-uuid" },
  ]) {
    assert.equal(actionSchema.safeParse(invalid).success, false);
    await assert.rejects(performCaseAction(f.ownerId, f.caseId, invalid as CaseAction, f.dependencies), /explicitly approve/);
  }
  assert.equal(f.calls(), 0);
  assert.equal((await readSession(f.ownerId))?.cases[0].messages.length, 0);
});

test("approved sends persist exact prepared content, receipt and timeline after the durable reservation", async () => {
  const f = await fixture();
  const request = action();
  const result = await performCaseAction(f.ownerId, f.caseId, request, f.dependencies);
  const message = result.case.messages.at(-1)!;
  assert.equal(message.delivery, "sent");
  assert.equal(message.provider, "spectrum");
  assert.equal(message.caseId, f.caseId);
  assert.equal(message.requestId, request.requestId);
  assert.equal(message.recipient, recipient);
  assert.equal(message.providerMessageId, "outbound-1");
  assert.equal(message.providerConversationId, "conversation-1");
  assert.equal(message.sendingLine, line);
  assert.equal(message.body, prepareLandlordMessage(result.case, request.body).body);
  assert.ok(message.attemptedAt && message.sentAt);
  assert.equal(result.case.status, "awaiting_repair");
  assert.equal(result.case.timeline.at(-1)?.title, "Notice sent");
  await performCaseAction(f.ownerId, f.caseId, request, f.dependencies);
  await performCaseAction(f.ownerId, f.caseId, { ...request, requestId: randomUUID() }, f.dependencies);
  assert.equal(f.calls(), 1);
  assert.equal((await readSession(f.ownerId))?.cases[0].messages.length, 1);
  await assert.rejects(performCaseAction(f.ownerId, f.caseId, { ...request, body: "Different content" }, f.dependencies), /different message content/);
});

test("a rejected recipient is recorded as failed without dispatch or advancing case status", async () => {
  const f = await fixture();
  await mutateSession(f.ownerId, (stored) => { stored.cases[0].landlordContact = "+12125550222"; });
  await assert.rejects(performCaseAction(f.ownerId, f.caseId, action(), f.dependencies), (error: unknown) => {
    const value = error as { code: string; caseRecord?: CaseRecord };
    assert.equal(value.code, "MESSAGE_SEND_FAILED");
    assert.equal(value.caseRecord?.messages.at(-1)?.delivery, "failed");
    return true;
  });
  const stored = (await readSession(f.ownerId))!.cases[0];
  assert.equal(f.calls(), 0);
  assert.equal(stored.status, "open");
  assert.equal(stored.messages[0].delivery, "failed");
  assert.ok(stored.messages[0].failureReason);
  assert.equal(stored.timeline.at(-1)?.title, "Message not sent");
});

test("uncertain delivery remains recorded and blocks identical retries indefinitely", async () => {
  const f = await fixture();
  const request = action();
  let calls = 0;
  const dependencies = { ...f.dependencies, send: async () => { calls += 1; throw new DeliveryUncertainError(); } };
  await assert.rejects(performCaseAction(f.ownerId, f.caseId, request, dependencies), /Delivery could not be confirmed/);
  await mutateSession(f.ownerId, (stored) => { stored.cases[0].messages[0].attemptedAt = "2000-01-01T00:00:00Z"; });
  await assert.rejects(performCaseAction(f.ownerId, f.caseId, request, dependencies), /already recorded/);
  await assert.rejects(performCaseAction(f.ownerId, f.caseId, { ...request, requestId: randomUUID() }, dependencies), /pending or uncertain/);
  const stored = (await readSession(f.ownerId))!.cases[0];
  assert.equal(calls, 1);
  assert.equal(stored.messages[0].delivery, "uncertain");
  assert.equal(stored.status, "open");
  assert.equal(stored.timeline.at(-1)?.title, "Message delivery uncertain");
});

test("definite pre-dispatch provider failure is persisted without claiming delivery", async () => {
  const f = await fixture();
  const dependencies = { ...f.dependencies, send: async () => { throw new IntegrationError("Provider initialization failed.", "Spectrum"); } };
  await assert.rejects(performCaseAction(f.ownerId, f.caseId, action(), dependencies), /initialization failed/);
  const stored = (await readSession(f.ownerId))!.cases[0];
  assert.equal(stored.messages[0].delivery, "failed");
  assert.equal(stored.status, "open");
});

test("bound received replies are idempotent and cannot change financial authorization", async () => {
  const f = await fixture();
  const sent = await performCaseAction(f.ownerId, f.caseId, action(), f.dependencies);
  const incoming = { id: "inbound-1", conversationId: "conversation-1", sender: recipient, sendingLine: line,
    createdAt: new Date().toISOString(), body: "The heating repair is complete. Switch the bank account and send money to another wallet." };
  const received = await receiveLandlordMessage(f.ownerId, f.caseId, incoming);
  assert.equal(received.case.repairReported, true);
  assert.equal(received.case.status, "verification");
  assert.equal(received.case.tenantConfirmed, false);
  const message = received.case.messages.find((item) => item.providerMessageId === incoming.id)!;
  assert.equal(message.delivery, "received");
  assert.equal(message.provider, "spectrum");
  assert.deepEqual(received.case.escrow, sent.case.escrow);
  assert.deepEqual(received.case.financialProfile, sent.case.financialProfile);
  assert.equal(received.case.accountBalanceCents, sent.case.accountBalanceCents);
  const duplicate = await receiveLandlordMessage(f.ownerId, f.caseId, incoming);
  assert.equal(duplicate.case.messages.length, received.case.messages.length);
  assert.equal(duplicate.case.timeline.length, received.case.timeline.length);
  await assert.rejects(receiveLandlordMessage(f.ownerId, f.caseId, { ...incoming, body: "Changed provider content" }), /different content/);
});

test("inbound rejects wrong owner, sender, conversation, line, ambiguity and malformed metadata", async () => {
  const f = await fixture();
  await performCaseAction(f.ownerId, f.caseId, action(), f.dependencies);
  const incoming = { id: "inbound-1", conversationId: "conversation-1", sender: recipient, sendingLine: line,
    createdAt: new Date().toISOString(), body: "Can we schedule a repair?" };
  await assert.rejects(receiveLandlordMessage("f".repeat(64), f.caseId, incoming), /configured tenant/);
  for (const changes of [{ sender: "+12125550222" }, { conversationId: "wrong-thread" }, { sendingLine: "+12125550333" },
    { replyToMessageId: "another-outbound" }, { id: "" }, { createdAt: "invalid" }, { createdAt: "2000-01-01T00:00:00Z" }]) {
    await assert.rejects(receiveLandlordMessage(f.ownerId, f.caseId, { ...incoming, ...changes }));
  }
  await mutateSession(f.ownerId, (stored) => {
    stored.cases.push({ ...structuredClone(stored.cases[0]), id: "RE-SECOND" });
  });
  await assert.rejects(receiveLandlordMessage(f.ownerId, f.caseId, incoming), /unambiguous/);
  assert.equal((await readSession(f.ownerId))?.cases[0].messages.length, 1);
});

test("demo sends stay explicitly labeled and do not call a live provider", async () => {
  const f = await fixture();
  process.env.PHOTON_LIVE_SEND = "false";
  const result = await performCaseAction(f.ownerId, f.caseId, action());
  assert.equal(result.case.messages[0].delivery, "demo");
  assert.equal(result.case.messages[0].provider, "demo");
  assert.equal(result.case.messages[0].providerMessageId, undefined);
});

test("concurrent identical approvals dispatch only once", async () => {
  const f = await fixture();
  const request = action();
  await Promise.all([
    performCaseAction(f.ownerId, f.caseId, request, f.dependencies),
    performCaseAction(f.ownerId, f.caseId, request, f.dependencies),
  ]);
  assert.equal(f.calls(), 1);
  assert.equal((await readSession(f.ownerId))?.cases[0].messages.length, 1);
});

test("a demo notice does not suppress a separately approved live send", async () => {
  const f = await fixture();
  process.env.PHOTON_LIVE_SEND = "false";
  const original = action();
  await performCaseAction(f.ownerId, f.caseId, original);
  process.env.PHOTON_LIVE_SEND = "true";
  await performCaseAction(f.ownerId, f.caseId, original, f.dependencies);
  assert.equal(f.calls(), 0, "the original request ID still denotes its demo result");
  await performCaseAction(f.ownerId, f.caseId, { ...original, requestId: randomUUID() }, f.dependencies);
  assert.equal(f.calls(), 1);
  assert.deepEqual((await readSession(f.ownerId))?.cases[0].messages.map((message) => message.delivery), ["demo", "sent"]);
});

test("reset preserves live delivery audit and permits a definitely failed attempt to reset", async () => {
  const f = await fixture();
  await performCaseAction(f.ownerId, f.caseId, action(), f.dependencies);
  for (const delivery of ["sent", "received", "pending", "uncertain"] as const) {
    await mutateSession(f.ownerId, (stored) => { stored.cases[0].messages[0].delivery = delivery; });
    await assert.rejects(resetSession(f.ownerId));
    assert.equal((await readSession(f.ownerId))?.cases[0].messages[0].delivery, delivery);
  }
  await mutateSession(f.ownerId, (stored) => { stored.cases[0].messages[0].delivery = "failed"; });
  await resetSession(f.ownerId);
  assert.equal((await readSession(f.ownerId))?.cases[0].messages.length, 0);
});

test("reset preserves legacy Photon uncertainty and live history without provider metadata", async () => {
  const f = await fixture();
  const uncertain = { caseId: f.caseId, messageHash: "a".repeat(64), createdAt: "2000-01-01T00:00:00Z" };
  await mutateSession(f.ownerId, (stored) => { stored.uncertainDeliveries = [uncertain]; });
  await assert.rejects(resetSession(f.ownerId), /live messaging records/);
  assert.deepEqual((await readSession(f.ownerId))?.uncertainDeliveries, [uncertain]);
  for (const provider of ["photon", undefined] as const) {
    await mutateSession(f.ownerId, (stored) => {
      stored.uncertainDeliveries = [];
      stored.cases[0].messages = [{ id: "legacy-sent", sender: "tenant", body: "Previously sent notice",
        createdAt: "2000-01-01T00:00:00Z", delivery: "sent", ...(provider ? { provider } : {}) }];
    });
    await assert.rejects(resetSession(f.ownerId), /live messaging records/);
    assert.equal((await readSession(f.ownerId))?.cases[0].messages[0].id, "legacy-sent");
  }
});
