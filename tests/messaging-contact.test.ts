import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMessagingContact } from "../src/lib/messaging-contact";
import { createDemoCase } from "../src/lib/seed";

test("landlord phone formats normalize to the same E.164 recipient", () => {
  for (const contact of ["+19736060558", "+1 (973) 606-0558", "973-606-0558", "19736060558", " 973.606.0558 "]) {
    assert.equal(normalizeMessagingContact(contact), "+19736060558");
  }
  assert.equal(normalizeMessagingContact("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizeMessagingContact(" manager@example.com "), "manager@example.com");
  for (const contact of [undefined, "", " ", "call 9736060558", "+19736060558 ext 2", "++19736060558", "+0123456789", "973-606", "+1\n9736060558"]) {
    assert.equal(normalizeMessagingContact(contact), undefined);
  }
});

test("RE-1042 has Mujtaba as tenant and Rayyan as landlord, without changing workspace ownership", () => {
  const record = createDemoCase("opaque-owner-id");
  assert.equal(record.ownerId, "opaque-owner-id");
  assert.deepEqual(record.tenant, { name: "Mujtaba Atif", phone: "+12018567033" });
  assert.equal(record.landlordName, "Rayyan Khan");
  assert.equal(record.landlordContact, "+19736060558");
  assert.notEqual(record.landlordContact, record.tenant.phone);
});
