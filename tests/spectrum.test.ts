import assert from "node:assert/strict";
import { test } from "node:test";
import { spectrumClientFromIMessage, type SpectrumDirectMessage, type SpectrumIMessageApi } from "../src/lib/integrations/spectrum";
import { IntegrationError } from "../src/lib/integrations/shared";

const recipient = "+12018567033";
const line = "+16287896827";

function fixture() {
  const calls: unknown[] = [];
  const user = { __platform: "imessage", id: recipient };
  const dm: SpectrumDirectMessage = { id: `any;-;${recipient}`, type: "dm", phone: line,
    send: async (body) => { calls.push(["send", body]); } };
  const im: SpectrumIMessageApi = {
    user: async (phone) => { calls.push(["user", phone]); return user; },
    space: {
      create: async (resolved, params) => { assert.equal(resolved, user); calls.push(["create", resolved.id, params]); return dm; },
      get: async (id, params) => { calls.push(["get", id, params]); return dm; },
    },
  };
  return { calls, user, im, dm, client: spectrumClientFromIMessage(im, async () => {}) };
}

test("a cold start resolves the approved iMessage user, creates its DM on the configured line, and sends", async () => {
  const f = fixture();
  const dm = await f.client.openDirectMessage(recipient, line);
  await dm.send("Approved message");
  assert.deepEqual(f.calls, [["user", recipient], ["create", recipient, { phone: line }], ["send", "Approved message"]]);
});

test("a persisted DM uses space.get with its route and never creates another conversation", async () => {
  const f = fixture();
  const dm = await f.client.openDirectMessage(recipient, line, f.dm.id);
  await dm.send("Follow-up");
  assert.deepEqual(f.calls, [["user", recipient], ["get", f.dm.id, { phone: line }], ["send", "Follow-up"]]);
});

test("failed saved conversation resolution does not fall back to creating or sending", async () => {
  const f = fixture();
  f.im.space.get = async () => { throw new Error("lookup failed"); };
  await assert.rejects(f.client.openDirectMessage(recipient, line, f.dm.id), /lookup failed/);
  assert.deepEqual(f.calls, [["user", recipient]]);
});

test("a resolved user cannot redirect the approved recipient or platform", async () => {
  for (const change of [{ id: "+19736060558" }, { __platform: "other" }]) {
    const f = fixture();
    Object.assign(f.user, change);
    await assert.rejects(f.client.openDirectMessage(recipient, line), /approved iMessage recipient/);
    assert.deepEqual(f.calls, [["user", recipient]]);
  }
});

test("invalid or unavailable dedicated lines produce a clear sanitized error before sending", async () => {
  const f = fixture();
  await assert.rejects(f.client.openDirectMessage(recipient, "not-a-line"), /sending line must be/);
  assert.deepEqual(f.calls, []);
  f.im.space.create = async () => { throw new Error("No iMessage client serves phone private-provider-data"); };
  await assert.rejects(f.client.openDirectMessage(recipient, line), (error: unknown) =>
    error instanceof IntegrationError && /sending line is not available/.test(error.message)
    && !error.message.includes("private-provider-data"));
  assert.deepEqual(f.calls, [["user", recipient]]);
});
