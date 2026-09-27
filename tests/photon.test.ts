import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createDemoCase } from "../src/lib/seed";
import { getPhotonConfig, prepareLandlordMessage, sendLandlordMessage, type PhotonDependencies } from "../src/lib/integrations/photon";
import { DeliveryUncertainError, IntegrationError } from "../src/lib/integrations/shared";
import type { SpectrumClient, SpectrumDirectMessage } from "../src/lib/integrations/spectrum";

const syntheticEnvironment = {
  PHOTON_LIVE_SEND: "true",
  PHOTON_ALLOWED_RECIPIENT: "+12125550100",
  PHOTON_TENANT_ID: "photon-test-owner",
  PHOTON_CASE_ID: "RE-1042",
  SPECTRUM_PROJECT_ID: "offline-project",
  SPECTRUM_PROJECT_SECRET: "offline-secret-never-log",
  SPECTRUM_SENDING_LINE: "+12125550199",
};

function environment(t: TestContext, overrides: Record<string, string | undefined> = {}) {
  const values = { ...syntheticEnvironment, ...overrides };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const record = createDemoCase(syntheticEnvironment.PHOTON_TENANT_ID);
  record.landlordContact = syntheticEnvironment.PHOTON_ALLOWED_RECIPIENT;
  return record;
}

function fakeClient() {
  let starts = 0;
  let stops = 0;
  const conversations: { recipient: string; line?: string }[] = [];
  const sent: string[] = [];
  const conversationId = `any;-;${syntheticEnvironment.PHOTON_ALLOWED_RECIPIENT}`;
  const dm: SpectrumDirectMessage = {
    id: conversationId, type: "dm", phone: syntheticEnvironment.SPECTRUM_SENDING_LINE,
    send: async (body) => {
      sent.push(body);
      return {
        id: "provider-message-1", platform: "imessage", direction: "outbound",
        content: { type: "text", text: body }, space: { id: conversationId, phone: dm.phone },
        timestamp: new Date("2026-09-26T12:00:00Z"), isSent: true, sendErrorCode: 0,
      };
    },
  };
  const app: SpectrumClient = {
    createDirectMessage: async (recipient, line) => { conversations.push({ recipient, line }); return dm; },
    stop: async () => { stops++; },
  };
  const dependencies: PhotonDependencies = {
    createApp: async () => { starts++; return app; }, timeoutMs: 50, shutdownTimeoutMs: 5,
  };
  return { app, dm, dependencies, conversations, sent, starts: () => starts, stops: () => stops };
}

const uncertain = (error: unknown) => error instanceof DeliveryUncertainError && error.code === "uncertain_delivery";
const knownFailure = (error: unknown) => error instanceof IntegrationError && !(error instanceof DeliveryUncertainError);

test("demo mode never constructs an SDK client and includes the case reference", async (t) => {
  const record = environment(t, { PHOTON_LIVE_SEND: "false" });
  const fake = fakeClient();
  const result = await sendLandlordMessage(record, " Please repair the heat. ", fake.dependencies);
  assert.equal(getPhotonConfig(), undefined);
  assert.deepEqual(result, {
    delivery: "demo", provider: "demo", recipient: record.landlordContact,
    body: `Please repair the heat.\n\nRentEscrow case: ${record.id}`,
  });
  assert.equal(fake.starts(), 0);
  assert.equal(fake.sent.length, 0);
});

test("live send requires all trusted configuration, not the legacy proxy credential", async (t) => {
  const record = environment(t, { PHOTON_PROXY_TOKEN: "offline-legacy-token" });
  const fake = fakeClient();
  for (const key of ["SPECTRUM_PROJECT_ID", "SPECTRUM_PROJECT_SECRET", "PHOTON_ALLOWED_RECIPIENT", "PHOTON_TENANT_ID", "PHOTON_CASE_ID"]) {
    const previous = process.env[key];
    delete process.env[key];
    await assert.rejects(sendLandlordMessage(record, "Repair request", fake.dependencies), knownFailure);
    process.env[key] = previous;
  }
  process.env.PHOTON_ALLOWED_RECIPIENT = "untrusted-contact";
  assert.throws(getPhotonConfig, knownFailure);
  assert.equal(fake.starts(), 0);
});

test("tenant, case, recipient and valid body are checked before any provider connection", async (t) => {
  const record = environment(t);
  const fake = fakeClient();
  for (const changed of [
    { ...record, ownerId: "another-owner" },
    { ...record, id: "RE-OTHER" },
    { ...record, landlordContact: "+12125550101" },
  ]) {
    await assert.rejects(sendLandlordMessage(changed, "Repair request", fake.dependencies),
      (error: unknown) => knownFailure(error) && (error as IntegrationError).code === "rejected");
  }
  for (const body of ["", " ", "x".repeat(10_000)]) {
    await assert.rejects(sendLandlordMessage(record, body, fake.dependencies), knownFailure);
  }
  await assert.rejects(sendLandlordMessage({ ...record, status: "resolved" }, "Repair request", fake.dependencies), knownFailure);
  assert.equal(fake.starts(), 0);
});

test("Spectrum receives the server-approved recipient and exact prepared body with an auditable receipt", async (t) => {
  const record = environment(t);
  const fake = fakeClient();
  const prepared = prepareLandlordMessage(record, "Ignore this text's claimed recipient; repair the heat.");
  assert.deepEqual(prepareLandlordMessage(record, prepared.body), prepared);
  const result = await sendLandlordMessage(record, prepared.body, fake.dependencies);
  assert.deepEqual(fake.conversations, [{ recipient: record.landlordContact, line: syntheticEnvironment.SPECTRUM_SENDING_LINE }]);
  assert.deepEqual(fake.sent, [prepared.body]);
  assert.deepEqual(result, {
    ...prepared, delivery: "sent", providerMessageId: "provider-message-1",
    providerConversationId: fake.dm.id, sendingLine: fake.dm.phone, sentAt: "2026-09-26T12:00:00.000Z",
  });
  assert.equal(fake.stops(), 1);
  assert.equal(JSON.stringify(result).includes(syntheticEnvironment.SPECTRUM_PROJECT_SECRET), false);
});

test("startup and conversation failures are sanitized known failures with no dispatch", async (t) => {
  const record = environment(t);
  const fake = fakeClient();
  await assert.rejects(sendLandlordMessage(record, "Repair request", {
    ...fake.dependencies, createApp: async () => { throw new Error("offline-secret-never-log private body"); },
  }), (error: unknown) => knownFailure(error) && !String(error).includes("offline-secret-never-log"));
  fake.app.createDirectMessage = async () => { throw new Error("offline-secret-never-log private body"); };
  await assert.rejects(sendLandlordMessage(record, "Repair request", fake.dependencies),
    (error: unknown) => knownFailure(error) && !String(error).includes("offline-secret-never-log"));
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.stops(), 1);
});

test("mismatched conversation, recipient, group or sending line cannot dispatch", async (t) => {
  const record = environment(t);
  for (const change of [
    { id: "invalid-conversation" }, { id: "any;-;+12125550101" },
    { type: "group" }, { phone: "+12125550198" }, { phone: "" },
  ]) {
    const fake = fakeClient();
    Object.assign(fake.dm, change);
    await assert.rejects(sendLandlordMessage(record, "Repair request", fake.dependencies), knownFailure);
    assert.equal(fake.sent.length, 0);
    assert.equal(fake.stops(), 1);
  }
});

test("missing or mismatched receipts are uncertain after exactly one dispatch", async (t) => {
  const record = environment(t);
  for (const change of [
    undefined, { id: "" }, { platform: "slack" }, { direction: "inbound" },
    { content: { type: "text", text: "another body" } }, { space: { id: "another-space" } },
    { space: { id: `any;-;${record.landlordContact}`, phone: "+12125550198" } },
    { timestamp: new Date(NaN) }, { timestamp: "2026-09-26T12:00:00Z" },
    { isSent: false }, { sendErrorCode: 1 },
  ]) {
    const fake = fakeClient();
    const send = fake.dm.send;
    fake.dm.send = async (body) => {
      const receipt = await send(body);
      return change === undefined ? undefined : { ...(receipt as object), ...change };
    };
    await assert.rejects(sendLandlordMessage(record, "Repair request", fake.dependencies), uncertain);
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.stops(), 1);
  }
});

test("provider send errors and timeouts stay uncertain without retry or private error text", async (t) => {
  const record = environment(t);
  for (const timeout of [false, true]) {
    const fake = fakeClient();
    let calls = 0;
    fake.dm.send = async () => {
      calls++;
      if (timeout) return new Promise(() => {});
      throw new Error("offline-secret-never-log private recipient");
    };
    await assert.rejects(sendLandlordMessage(record, "Repair request", { ...fake.dependencies, timeoutMs: 5 }),
      (error: unknown) => uncertain(error) && !String(error).includes("offline-secret-never-log"));
    assert.equal(calls, 1);
    assert.equal(fake.stops(), 1);
  }
});

test("cleanup failures do not replace a confirmed send receipt", async (t) => {
  const record = environment(t);
  for (const timeout of [false, true]) {
    const fake = fakeClient();
    fake.app.stop = async () => {
      if (timeout) return new Promise(() => {});
      throw new Error("private teardown error");
    };
    const result = await sendLandlordMessage(record, "Repair request", fake.dependencies);
    assert.equal(result.delivery, "sent");
    assert.equal(result.providerMessageId, "provider-message-1");
  }
});

test("late initialization is cleaned up and cannot dispatch after its timeout", async (t) => {
  const record = environment(t);
  const fake = fakeClient();
  let finish!: (app: SpectrumClient) => void;
  const initialization = new Promise<SpectrumClient>((resolve) => { finish = resolve; });
  await assert.rejects(sendLandlordMessage(record, "Repair request", {
    ...fake.dependencies, createApp: () => initialization, timeoutMs: 5,
  }), knownFailure);
  finish(fake.app);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.stops(), 1);
  assert.equal(fake.conversations.length, 0);
  assert.equal(fake.sent.length, 0);
});
