import assert from "node:assert/strict";
import { test } from "node:test";
import { ObjectId } from "mongodb";
import { authUserFromRecord } from "../src/lib/server/auth";
import { assignCaseOwnership, type SessionDocument } from "../src/lib/server/store";
import { createDemoCase } from "../src/lib/seed";

function fixture() {
  const record = createDemoCase("workspace");
  const document: SessionDocument = {
    ownerId: "workspace", revision: 0, createdAt: record.createdAt, updatedAt: record.createdAt,
    accountBalanceCents: 0, simulatedDebitsCents: 0, cases: [record],
    tenantUserId: "tenant-user", tenantDisplayName: "Rayaan",
    managedProperty: { id: "property", address: record.building.address, borough: record.building.borough, landlordUserId: "landlord-user", landlordDisplayName: "Alex Morgan" },
    messagingContacts: { tenantPhone: "+19736060558", landlordPhone: "+12018567033" },
  };
  return { record, document };
}

test("account projection exposes a masked configured phone and no full contact", () => {
  const record = { _id: new ObjectId(), email: "tenant1@rentescrow.demo", role: "tenant" as const,
    displayName: "Rayaan", passwordHash: "private", createdAt: new Date(),
    phoneContact: "+19736060558", phoneContactConfiguredAt: new Date() };
  const user = authUserFromRecord(record);
  assert.equal(user.maskedPhone, "+1 (***) ***-0558");
  assert.doesNotMatch(JSON.stringify(user), /19736060558|passwordHash|phoneContact/);
  assert.equal(authUserFromRecord({ ...record, phoneContactConfiguredAt: undefined }).maskedPhone, undefined);
});

test("case binding uses persisted participants, not contact fields submitted with a case", () => {
  const { record, document } = fixture();
  record.tenantPhone = "+12125550100";
  record.landlordContact = "+12125550200";
  record.landlordName = "Untrusted browser name";
  assignCaseOwnership(document, record);
  assert.deepEqual(record.messagingBinding, {
    ownerId: document.ownerId, caseId: record.id,
    tenant: { userId: "tenant-user", phone: "+19736060558" },
    landlord: { userId: "landlord-user", phone: "+12018567033" },
  });
  assert.equal(record.landlordContact, "+12018567033");
  assert.equal(record.landlordName, "Alex Morgan");
});

test("unknown participant contacts and unassigned properties cannot get a two-sided binding", () => {
  for (const scenario of ["unknown-tenant", "unassigned-property", "same-number"] as const) {
    const { record, document } = fixture();
    if (scenario === "unknown-tenant") delete document.messagingContacts!.tenantPhone;
    if (scenario === "unassigned-property") record.building.address = "999 Other Street";
    if (scenario === "same-number") document.messagingContacts!.tenantPhone = document.messagingContacts!.landlordPhone;
    assignCaseOwnership(document, record);
    assert.equal(record.messagingBinding, undefined, scenario);
  }
});
