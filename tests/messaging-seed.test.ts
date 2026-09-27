import assert from "node:assert/strict";
import { test } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import { seedUsers } from "../scripts/seed-users";
import { closeMongoConnection } from "../src/lib/server/mongodb";
import { mutateSession, readSession } from "../src/lib/server/store";

test("seeding contact upgrades preserves legacy live conversations and financial history", async () => {
  const mongo = await MongoMemoryServer.create({ instance: { dbName: "messaging_seed_test" } });
  const settings = { MONGODB_URI: mongo.getUri(), MONGODB_DATABASE: "messaging_seed_test",
    RENTESCROW_STORAGE: "mongodb", PHOTON_LIVE_SEND: "false", PHOTON_ALLOWED_RECIPIENT: "" };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  try {
    const users = await seedUsers();
    const tenant = users.find((user) => user.email === "tenant1@rentescrow.demo")!;
    await mutateSession(tenant.workspaceOwnerId, (document) => {
      const original = document.cases[0];
      document.cases = (["spectrum", "photon", undefined] as const).map((provider, index) => {
        const record = structuredClone(original);
        record.id = `RE-LEGACY-${index}`;
        delete record.messagingBinding;
        record.tenantName = "Previous tenant name";
        record.landlordName = "Previous landlord name";
        record.tenantPhone = "+12125550101";
        record.landlordContact = "+12125550102";
        record.messages = [{ id: `live-${index}`, sender: "tenant", body: "Existing private notice",
          createdAt: record.createdAt, delivery: "sent", provider, providerConversationId: "old-thread" }];
        record.escrow.status = "locked";
        return record;
      });
    });
    const before = (await readSession(tenant.workspaceOwnerId))!.cases;
    const reseeded = await seedUsers();
    assert.deepEqual(reseeded.map((user) => user.id), users.map((user) => user.id));
    const document = (await readSession(tenant.workspaceOwnerId))!;
    assert.deepEqual(document.cases, before, "a contact migration must not rewrite any live case");
    assert.deepEqual(document.messagingContacts, { tenantPhone: "+19736060558", landlordPhone: "+12018567033" });
    assert.equal(document.tenantDisplayName, "Rayaan");
  } finally {
    await closeMongoConnection();
    await mongo.stop();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
