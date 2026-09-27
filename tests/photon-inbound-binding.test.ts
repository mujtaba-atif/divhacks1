import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareParticipantMessage } from "../src/lib/integrations/photon";
import type { MessagingRole } from "../src/lib/types";
import type { ParticipantMessagingDependencies, PhotonBindingDiagnostic } from "../src/lib/server/cases";

const tenantPhone = "+19736060558";
const landlordPhone = "+12018567033";
const tenantId = "6ab8b3cd278117b4c7673860";
const landlordId = "6ab8b3cd278117b4c7673862";
const originalDirectory = process.cwd();
let directory: string;
let createSession: typeof import("../src/lib/server/store")["createSession"];
let mutateSession: typeof import("../src/lib/server/store")["mutateSession"];
let readSession: typeof import("../src/lib/server/store")["readSession"];
let receiveParticipantMessage: typeof import("../src/lib/server/cases")["receiveParticipantMessage"];

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "rentescrow-inbound-binding-"));
  process.chdir(directory);
  ({ createSession, mutateSession, readSession } = await import("../src/lib/server/store"));
  ({ receiveParticipantMessage } = await import("../src/lib/server/cases"));
});
after(async () => { process.chdir(originalDirectory); await rm(directory, { recursive: true, force: true }); });

const routingOnly: ParticipantMessagingDependencies = {
  prepare: prepareParticipantMessage,
  classify: async () => ({ intent: "other", summary: "Recorded participant message.", source: "rules" }),
  relay: () => undefined,
  send: async () => { assert.fail("Routing tests must not send physical messages"); },
};

async function fixture() {
  Object.assign(process.env, { RENTESCROW_STORAGE: "local", PHOTON_LIVE_SEND: "true",
    SPECTRUM_PROJECT_ID: "offline-project", SPECTRUM_PROJECT_SECRET: "offline-secret",
    PHOTON_TENANT_PHONE: tenantPhone, PHOTON_ALLOWED_RECIPIENT: landlordPhone, SPECTRUM_SENDING_LINE: "shared" });
  const { document } = await createSession();
  const ownerId = document.ownerId;
  const caseId = document.cases[0].id;
  Object.assign(process.env, { PHOTON_TENANT_ID: ownerId, PHOTON_CASE_ID: caseId });
  await mutateSession(ownerId, (stored) => {
    stored.tenantUserId = tenantId;
    stored.managedProperty = { id: "assigned-property", address: stored.cases[0].building.address,
      borough: stored.cases[0].building.borough, landlordUserId: landlordId };
    const record = stored.cases[0];
    record.tenantUserId = tenantId;
    record.landlordUserId = landlordId;
    record.landlordContact = landlordPhone;
    record.messagingBinding = { ownerId, caseId,
      tenant: { userId: tenantId, phone: tenantPhone },
      landlord: { userId: landlordId, phone: landlordPhone, conversationId: `any;-;${landlordPhone}`, sendingLine: "shared" } };
    record.messages.push({ id: "previous-uncertain-relay", sender: "agent", body: "Earlier maintenance update",
      recipient: tenantPhone, recipientUserId: tenantId, delivery: "uncertain", provider: "spectrum",
      createdAt: record.createdAt, triggerMessageId: "prior-landlord-message" });
  });
  return { ownerId, caseId };
}

function incoming(role: MessagingRole, id = `in-${role}`) {
  const sender = role === "tenant" ? tenantPhone : landlordPhone;
  return { id, sender, conversationId: `any;-;${sender}`, sendingLine: "shared",
    body: "Hello about my repair.", createdAt: new Date().toISOString() };
}

function rejection(check?: (diagnostic: PhotonBindingDiagnostic) => void) {
  return (error: unknown) => {
    const value = error as { code?: string; diagnostics?: PhotonBindingDiagnostic[] };
    assert.equal(value.code, "MESSAGE_BINDING_REJECTED");
    if (check) { assert.ok(value.diagnostics?.length); check(value.diagnostics[0]); }
    assert.doesNotMatch(JSON.stringify(value.diagnostics), /19736060558|12018567033|offline-secret|Hello about/);
    return true;
  };
}

test("Rayaan's first trusted DM is pinned and Alex's existing DM still resolves to the same case", async () => {
  const f = await fixture();
  const before = (await readSession(f.ownerId))!.cases[0];
  for (const role of ["tenant", "landlord"] as const) {
    const result = await receiveParticipantMessage(f.ownerId, incoming(role), routingOnly);
    assert.equal(result.case.id, f.caseId);
    assert.equal(result.processing.role, role);
    assert.equal(result.case.messages.find((m) => m.providerMessageId === `in-${role}`)?.participantUserId,
      role === "tenant" ? tenantId : landlordId);
  }
  const stored = (await readSession(f.ownerId))!.cases[0];
  assert.deepEqual(stored.messagingBinding?.tenant,
    { userId: tenantId, phone: tenantPhone, conversationId: `any;-;${tenantPhone}`, sendingLine: "shared" });
  assert.deepEqual(stored.messages.find((m) => m.id === "previous-uncertain-relay"), before.messages[0]);
  for (const key of ["escrow", "financialProfile", "tenantConfirmed", "verification", "xrplSettlement", "disputedAmountCents"] as const) {
    assert.deepEqual(stored[key], before[key]);
  }
  await receiveParticipantMessage(f.ownerId, incoming("tenant", "tenant-again"), routingOnly);
  await assert.rejects(receiveParticipantMessage(f.ownerId,
    { ...incoming("tenant", "changed-thread"), conversationId: `iMessage;-;${tenantPhone}` }, routingOnly),
  rejection((d) => { assert.equal(d.conversationMatch, false); assert.equal(d.firstConversationAllowed, false); }));
});

test("unknown phones and mismatched tenant or landlord IDs cannot mutate a case", async () => {
  for (const scenario of ["unknown", "tenant", "landlord", "workspace-tenant", "workspace-landlord"] as const) {
    const f = await fixture();
    const role = scenario.includes("landlord") ? "landlord" : "tenant";
    await mutateSession(f.ownerId, (document) => {
      const record = document.cases[0];
      if (scenario === "tenant" || scenario === "landlord") record.messagingBinding![scenario].userId = "wrong-user";
      if (scenario === "workspace-tenant") { record.tenantUserId = "wrong-user"; record.messagingBinding!.tenant.userId = "wrong-user"; }
      if (scenario === "workspace-landlord") { record.landlordUserId = "wrong-user"; record.messagingBinding!.landlord.userId = "wrong-user"; }
    });
    const before = await readSession(f.ownerId);
    await assert.rejects(receiveParticipantMessage(f.ownerId,
      { ...incoming(role), ...(scenario === "unknown" ? { sender: "+12125550999" } : {}) }, routingOnly), rejection());
    assert.deepEqual(await readSession(f.ownerId), before);
  }
});

test("an already stored first DM pins its missing route without processing or relaying it again", async () => {
  const f = await fixture();
  const input = incoming("tenant");
  await mutateSession(f.ownerId, (document) => {
    document.cases[0].messages.push({ id: "migrated-inbound", sender: "tenant", participantUserId: tenantId,
      body: input.body, createdAt: input.createdAt, delivery: "received", provider: "spectrum", caseId: f.caseId,
      providerMessageId: input.id, providerConversationId: input.conversationId, sendingLine: "shared",
      processedAt: input.createdAt, relayRequired: false });
  });
  const dependencies: ParticipantMessagingDependencies = { ...routingOnly,
    classify: async () => { assert.fail("A processed duplicate must not be classified again"); } };
  for (let count = 0; count < 2; count += 1) {
    const result = await receiveParticipantMessage(f.ownerId, input, dependencies);
    assert.equal(result.processing.duplicate, true);
    assert.equal(result.case.messages.length, 2);
    assert.deepEqual(result.case.messagingBinding?.tenant,
      { userId: tenantId, phone: tenantPhone, conversationId: input.conversationId, sendingLine: "shared" });
  }
  assert.equal((await readSession(f.ownerId))!.cases[0].messagingBinding?.tenant.conversationId, input.conversationId);
});

test("missing tenant binding is diagnosed without crashing or inferring identity from the body", async () => {
  const f = await fixture();
  await mutateSession(f.ownerId, (document) => {
    Reflect.deleteProperty(document.cases[0].messagingBinding!, "tenant");
  });
  await assert.rejects(receiveParticipantMessage(f.ownerId, incoming("tenant"), routingOnly), rejection((d) => {
    assert.equal(d.ownerMatch, true);
    assert.equal(d.tenantBindingExists, false);
    assert.equal(d.tenantUserIdMatch, false);
    assert.equal(d.landlordBindingExists, true);
    assert.equal(d.firstConversationAllowed, false);
  }));
});

test("first-contact learning requires the configured case, exact sender DM, route and unquoted current event", async () => {
  for (const change of [
    { conversationId: `any;-;${landlordPhone}` }, { conversationId: `iMessage;+;${tenantPhone}` },
    { conversationId: "unrecognized-thread" }, { sendingLine: "+16287896827" },
    { replyToMessageId: "unknown-outbound" }, { createdAt: "2000-01-01T00:00:00.000Z" },
  ]) {
    const f = await fixture();
    await assert.rejects(receiveParticipantMessage(f.ownerId, { ...incoming("tenant"), ...change }, routingOnly), rejection());
    assert.equal((await readSession(f.ownerId))!.cases[0].messagingBinding?.tenant.conversationId, undefined);
  }
  const f = await fixture();
  process.env.PHOTON_CASE_ID = "RE-OTHER";
  await assert.rejects(receiveParticipantMessage(f.ownerId, incoming("tenant"), routingOnly), rejection((d) => {
    assert.equal(d.configuredCaseMatch, false);
    assert.equal(d.firstConversationAllowed, false);
  }));
});

test("an established tenant route on another case cannot be reassigned through first-contact learning", async () => {
  const f = await fixture();
  await mutateSession(f.ownerId, (document) => {
    const another = structuredClone(document.cases[0]);
    another.id = "RE-OTHER";
    another.messagingBinding!.caseId = another.id;
    another.messagingBinding!.tenant.conversationId = "already-bound-tenant-thread";
    document.cases.push(another);
  });
  await assert.rejects(receiveParticipantMessage(f.ownerId, incoming("tenant"), routingOnly), rejection((d) => {
    assert.equal(d.knownRouteExists, true);
    assert.equal(d.firstConversationAllowed, false);
  }));
});
