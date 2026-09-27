import assert from "node:assert/strict";
import { test } from "node:test";
import { maskMessagingContact, normalizeMessagingContact } from "../src/lib/messaging-contact";
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

test("RE-1042 has Rayaan as tenant and Alex as landlord, without changing workspace ownership", () => {
  const record = createDemoCase("opaque-owner-id");
  assert.equal(record.ownerId, "opaque-owner-id");
  assert.deepEqual(record.tenant, { name: "Rayaan", phone: "+19736060558" });
  assert.equal(record.landlordName, "Alex Morgan");
  assert.equal(record.landlordContact, "+12018567033");
  assert.notEqual(record.landlordContact, record.tenant.phone);
});

test("contact labels expose only the configured destination's last four digits", () => {
  assert.equal(maskMessagingContact("+19736060558"), "+1 (***) ***-0558");
  assert.equal(maskMessagingContact("201-856-7033"), "+1 (***) ***-7033");
  assert.equal(maskMessagingContact("manager@example.com"), "m***@example.com");
  assert.equal(maskMessagingContact(undefined), "Contact not configured");
});
