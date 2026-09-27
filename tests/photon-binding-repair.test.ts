import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { bindPhotonCase } from "../scripts/bind-photon-case";
import { createDemoCase } from "../src/lib/seed";
import { closeMongoConnection, getMongoDatabase } from "../src/lib/server/mongodb";
import {
  repairPhotonParticipantBinding,
  resolveCanonicalPhotonParticipants,
  type CanonicalPhotonParticipants,
} from "../src/lib/server/photon-binding";
import { readSession, type SessionDocument } from "../src/lib/server/store";

const tenantId = "6ab8b3cd278117b4c7673860";
const landlordId = "6ab8b3cd278117b4c7673862";
const tenantPhone = "+19736060558";
const landlordPhone = "+12018567033";
const ownerId = createHash("sha256").update(tenantId).digest("hex");

function environment(database: string, uri: string) {
  Object.assign(process.env, {
    MONGODB_URI: uri,
    MONGODB_DATABASE: database,
    RENTESCROW_STORAGE: "mongodb",
    PHOTON_LIVE_SEND: "true",
    SPECTRUM_PROJECT_ID: "offline-project",
    SPECTRUM_PROJECT_SECRET: "offline-secret",
    PHOTON_ALLOWED_RECIPIENT: landlordPhone,
    PHOTON_TENANT_PHONE: tenantPhone,
    PHOTON_TENANT_ID: ownerId,
    PHOTON_CASE_ID: "RE-1042",
    SPECTRUM_SENDING_LINE: "shared",
  });
}

function documentFixture(): SessionDocument {
  const record = createDemoCase(ownerId);
  record.tenantUserId = tenantId;
  record.landlordUserId = landlordId;
  record.propertyId = "demo-123-example";
  const now = record.createdAt;
  return {
    ownerId,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    accountBalanceCents: record.accountBalanceCents,
    simulatedDebitsCents: record.escrow.amountCents,
    cases: [record],
    tenantUserId: tenantId,
    tenantDisplayName: "Rayaan",
    messagingContacts: { tenantPhone, landlordPhone },
    managedProperty: {
      id: "demo-123-example",
      address: record.building.address,
      borough: record.building.borough,
      landlordUserId: landlordId,
      landlordDisplayName: "Alex Morgan",
    },
  };
}

async function seedCanonicalRecords(databaseName: string, uri: string, alter?: (document: SessionDocument) => void) {
  environment(databaseName, uri);
  const database = await getMongoDatabase();
  const now = new Date();
  await database.collection("users").insertMany([
    { _id: new ObjectId(tenantId), email: "tenant@example.test", passwordHash: "unused", role: "tenant",
      displayName: "Rayaan", phoneContact: tenantPhone, phoneContactConfiguredAt: now, createdAt: now },
    { _id: new ObjectId(landlordId), email: "landlord@example.test", passwordHash: "unused", role: "landlord",
      displayName: "Alex Morgan", phoneContact: landlordPhone, phoneContactConfiguredAt: now, createdAt: now },
  ]);
  const document = documentFixture();
  alter?.(document);
  await database.collection<{ _id: string; address: string; borough: string; landlordUserId: string;
    createdAt: Date; updatedAt: Date }>("properties").insertOne({ _id: "demo-123-example", address: document.cases[0].building.address,
    borough: document.cases[0].building.borough, landlordUserId: landlordId, createdAt: now, updatedAt: now });
  await database.collection("sessions").insertOne(document);
  return { database, document };
}

test("photon binding repair", async (t) => {
  const mongo = await MongoMemoryServer.create();
  const previous = Object.fromEntries([
    "MONGODB_URI", "MONGODB_DATABASE", "RENTESCROW_STORAGE", "PHOTON_LIVE_SEND", "SPECTRUM_PROJECT_ID",
    "SPECTRUM_PROJECT_SECRET", "PHOTON_ALLOWED_RECIPIENT", "PHOTON_TENANT_PHONE", "PHOTON_TENANT_ID",
    "PHOTON_CASE_ID", "SPECTRUM_SENDING_LINE",
  ].map((key) => [key, process.env[key]]));
  try {
    await t.test("one-sided binding upgrades both participants, preserves route and finances, and reruns idempotently", async () => {
      const databaseName = `binding_${randomUUID().replaceAll("-", "")}`;
      const { document } = await seedCanonicalRecords(databaseName, mongo.getUri(), (stored) => {
        const record = stored.cases[0];
        record.messagingBinding = {
          ownerId,
          caseId: record.id,
          landlord: { userId: landlordId, phone: landlordPhone, conversationId: "any;-;+12018567033", sendingLine: "shared" },
        } as unknown as NonNullable<typeof record.messagingBinding>;
        record.messages.push({ id: "accepted-landlord-message", sender: "tenant", body: "Existing approved notice",
          recipient: landlordPhone, recipientUserId: landlordId, provider: "spectrum", delivery: "sent",
          providerMessageId: "provider-1", providerConversationId: "any;-;+12018567033", sendingLine: "shared",
          createdAt: record.createdAt, sentAt: record.createdAt });
      });
      const beforeFinance = {
        accountBalanceCents: document.accountBalanceCents,
        simulatedDebitsCents: document.simulatedDebitsCents,
        caseBalance: document.cases[0].accountBalanceCents,
        escrow: structuredClone(document.cases[0].escrow),
        financialProfile: structuredClone(document.cases[0].financialProfile),
      };
      const repaired = await bindPhotonCase();
      assert.deepEqual(repaired.messagingBinding, {
        ownerId,
        caseId: "RE-1042",
        tenant: { userId: tenantId, phone: tenantPhone },
        landlord: { userId: landlordId, phone: landlordPhone, conversationId: "any;-;+12018567033", sendingLine: "shared" },
      });
      assert.equal(repaired.messages.length, 1);
      const auditCount = repaired.timeline.filter((event) => event.title === "Participant messaging binding configured").length;
      assert.equal(auditCount, 1);
      const rerun = await bindPhotonCase();
      assert.deepEqual(rerun, repaired);
      assert.equal(rerun.timeline.filter((event) => event.title === "Participant messaging binding configured").length, 1);
      const persisted = (await readSession(ownerId))!;
      assert.deepEqual({
        accountBalanceCents: persisted.accountBalanceCents,
        simulatedDebitsCents: persisted.simulatedDebitsCents,
        caseBalance: persisted.cases[0].accountBalanceCents,
        escrow: persisted.cases[0].escrow,
        financialProfile: persisted.cases[0].financialProfile,
      }, beforeFinance);
    });

    await t.test("wrong tenant or landlord IDs and an unknown bound phone are rejected without mutation", () => {
      const expected: CanonicalPhotonParticipants = {
        tenant: { userId: tenantId, phone: tenantPhone },
        landlord: { userId: landlordId, phone: landlordPhone },
        propertyId: "demo-123-example",
      };
      for (const scenario of ["tenant-id", "landlord-id", "tenant-phone"] as const) {
        const document = documentFixture();
        const record = document.cases[0];
        if (scenario === "tenant-id") record.tenantUserId = new ObjectId().toHexString();
        if (scenario === "landlord-id") record.landlordUserId = new ObjectId().toHexString();
        if (scenario === "tenant-phone") record.messagingBinding = { ownerId, caseId: record.id,
          tenant: { userId: tenantId, phone: "+12125550199" },
          landlord: { userId: landlordId, phone: landlordPhone } };
        const before = structuredClone(document);
        assert.throws(() => repairPhotonParticipantBinding(document, record, expected), /binding rejected/);
        assert.deepEqual(document, before, scenario);
      }
    });

    await t.test("canonical Mongo roles and contacts are required", async () => {
      const databaseName = `binding_${randomUUID().replaceAll("-", "")}`;
      const { database, document } = await seedCanonicalRecords(databaseName, mongo.getUri());
      const record = document.cases[0];
      const settings = { tenantId: ownerId, caseId: record.id, tenantPhone, allowedRecipient: landlordPhone };
      await database.collection("users").updateOne({ _id: new ObjectId(tenantId) }, { $set: { role: "landlord" } });
      await assert.rejects(resolveCanonicalPhotonParticipants(database, document, record, settings), /canonical tenant user/);
      await database.collection("users").updateOne({ _id: new ObjectId(tenantId) },
        { $set: { role: "tenant", phoneContact: "+12125550199" } });
      await assert.rejects(resolveCanonicalPhotonParticipants(database, document, record, settings), /canonical tenant user/);
    });

    await t.test("conflicting live identity history blocks an otherwise missing binding", () => {
      const document = documentFixture();
      const record = document.cases[0];
      delete record.messagingBinding;
      record.messages.push({ id: "conflict", sender: "tenant", participantUserId: new ObjectId().toHexString(),
        recipient: landlordPhone, body: "Existing message", provider: "spectrum", delivery: "received", createdAt: record.createdAt });
      const expected: CanonicalPhotonParticipants = {
        tenant: { userId: tenantId, phone: tenantPhone }, landlord: { userId: landlordId, phone: landlordPhone },
        propertyId: "demo-123-example",
      };
      const before = structuredClone(document);
      assert.throws(() => repairPhotonParticipantBinding(document, record, expected), /unknown participant user/);
      assert.deepEqual(document, before);
    });
  } finally {
    await closeMongoConnection();
    await mongo.stop();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
