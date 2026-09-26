import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createContract, createCaseForContract, acceptContract } from "../src/lib/server/contracts";
import { registerUser } from "../src/lib/server/auth";
import { performCaseAction } from "../src/lib/server/cases";
import { createSession, readSession, resetSession, mutateSession } from "../src/lib/server/store";
import type { TransactionIntent } from "../src/lib/types";

function localStorage(t: TestContext) {
  const previous = process.env.RENTESCROW_STORAGE;
  process.env.RENTESCROW_STORAGE = "local";
  t.after(() => {
    if (previous === undefined) delete process.env.RENTESCROW_STORAGE;
    else process.env.RENTESCROW_STORAGE = previous;
  });
}

const caseInput = {
  issue: "heating" as const,
  description: "The radiator has stopped producing heat in this apartment.",
  noticedAt: "2026-09-23",
  address: "123 Example Street",
  borough: "Brooklyn" as const,
  apartment: "5A",
  landlordName: "Example Manager",
  landlordContact: "manager@example.com",
  monthlyRentCents: 300_000,
  disputedAmountCents: 40_000,
};

test("contract case creation requires the required stored acceptances", async (t) => {
  localStorage(t);
  const { document } = await createSession();
  const ownerId = document.ownerId;
  await registerUser(ownerId, { role: "tenant", displayName: "Taylor Tenant" });
  const contract = await createContract(ownerId, { case_type: "bilateral", terms: "Both parties acknowledge these demo terms." });

  await assert.rejects(
    createCaseForContract(ownerId, { contractId: contract.id, case: caseInput }),
    /fully accepted contract/i,
  );

  await registerUser(ownerId, { role: "landlord", displayName: "Alex Landlord" });
  const accepted = await acceptContract(ownerId, contract.id, "landlord");
  assert.equal(accepted.status, "active");
  assert.equal(accepted.acceptances.every((acceptance) => acceptance.termsHash === accepted.termsHash), true);

  const record = await createCaseForContract(ownerId, { contractId: contract.id, case: caseInput });
  assert.equal(record.case_type, "bilateral");
  const stored = await readSession(ownerId);
  assert.equal(stored?.contracts?.find((item) => item.id === contract.id)?.caseId, record.id);
  await assert.rejects(createCaseForContract(ownerId, { contractId: contract.id, case: caseInput }), /fully accepted contract/i);
});

test("self-documentation cases reject every escrow transfer path without mutating funds", async (t) => {
  localStorage(t);
  const { document } = await createSession();
  const ownerId = document.ownerId;
  await registerUser(ownerId, { role: "tenant", displayName: "Taylor Tenant", walletAddress: "rTENANT789" });
  const contract = await createContract(ownerId, { case_type: "self_documentation", terms: "Tenant-only documentation terms." });
  const record = await createCaseForContract(ownerId, { contractId: contract.id, case: { ...caseInput, landlordName: "", landlordContact: "" } });
  assert.equal(record.case_type, "self_documentation");
  assert.equal(record.escrow.destination, "");
  assert.equal(record.landlordName, "");
  assert.equal(record.landlordContact, "");

  const transferIntents: TransactionIntent[] = [
    { caseId: record.id, escrowId: record.escrow.id, transactionType: "EscrowCreate", destination: "", amountCents: 40_000, network: "demo" },
    { caseId: record.id, escrowId: record.escrow.id, transactionType: "EscrowFinish", destination: "", amountCents: 40_000, network: "demo" },
    { caseId: record.id, escrowId: record.escrow.id, transactionType: "Payment", destination: "rTENANT789", amountCents: 40_000, network: "demo" },
  ];

  await assert.rejects(performCaseAction(ownerId, record.id, { action: "create_escrow" }), /self-documentation/i);
  await assert.rejects(performCaseAction(ownerId, record.id, { action: "release_escrow" }), /self-documentation/i);
  for (const intent of transferIntents) {
    const result = await performCaseAction(ownerId, record.id, { action: "policy_check", intent });
    assert.equal(result.policy?.approved, false, `${intent.transactionType} must be rejected`);
  }

  const stored = await readSession(ownerId);
  const after = stored?.cases.find((item) => item.id === record.id);
  assert.equal(after?.escrow.status, "unfunded");
  assert.equal(after?.escrow.destination, "");
  assert.equal(after?.escrow.createHash, undefined);
  assert.equal(after?.escrow.finishHash, undefined);
  assert.equal(stored?.accountBalanceCents, document.accountBalanceCents);
  assert.equal(stored?.simulatedDebitsCents, 0);
  assert.equal(after?.escrow.audit.length, 5);
  assert.equal(after?.escrow.audit.every((entry) => entry.status === "rejected"), true);
});

test("anonymous dashboard seed remains the unregistered RE-1042 demo fixture", async (t) => {
  localStorage(t);
  const { document } = await createSession();
  const demo = document.cases[0];

  assert.equal(document.cases.length, 1);
  assert.equal(document.users, undefined);
  assert.equal(document.contracts, undefined);
  assert.equal(demo.id, "RE-1042");
  assert.equal(demo.case_type, undefined);
  assert.equal(demo.apartment, "4B");
  assert.equal(demo.building.address, "123 Example Street");
  assert.equal(demo.escrow.id, "ESC-RE-1042");
  assert.equal(demo.escrow.destination, "DEMO_LANDLORD_WALLET");
  assert.equal(demo.disputedAmountCents, 40_000);
  assert.equal(demo.evidence[0]?.id, "DEMO-EVIDENCE-BEFORE");
});

test("registration updates return the same merged profile that is stored", async (t) => {
  localStorage(t);
  const { document } = await createSession();
  const first = await registerUser(document.ownerId, {
    role: "tenant", displayName: "Taylor", email: "Taylor@Example.com", walletAddress: "rTENANT789",
  });
  const updated = await registerUser(document.ownerId, { role: "tenant", displayName: "Taylor Tenant" });
  const stored = await readSession(document.ownerId);
  assert.deepEqual(updated, stored?.users?.[0]);
  assert.equal(updated.id, first.id);
  assert.equal(updated.registeredAt, first.registeredAt);
  assert.equal(updated.email, "taylor@example.com");
  assert.equal(updated.walletAddress, "rTENANT789");
});

test("reset clears registrations and contracts without changing another session", async (t) => {
  localStorage(t);
  const { document } = await createSession();
  const other = await createSession();
  await registerUser(document.ownerId, { role: "tenant", displayName: "Taylor" });
  await registerUser(document.ownerId, { role: "landlord", displayName: "Alex" });
  const contract = await createContract(document.ownerId, { case_type: "self_documentation", terms: "Demo terms" });
  await createCaseForContract(document.ownerId, { contractId: contract.id, case: caseInput });
  await resetSession(document.ownerId);
  const reset = await readSession(document.ownerId);
  assert.equal(reset?.users, undefined);
  assert.equal(reset?.contracts, undefined);
  assert.equal(reset?.cases.length, 1);
  assert.equal(reset?.cases[0].id, "RE-1042");
  assert.deepEqual(await readSession(other.document.ownerId), other.document);
  await assert.rejects(createContract(document.ownerId, { case_type: "self_documentation", terms: "New terms" }), /register a tenant/i);
  await registerUser(document.ownerId, { role: "tenant", displayName: "New registration" });
  const fresh = await createContract(document.ownerId, { case_type: "self_documentation", terms: "New terms" });
  assert.notEqual(fresh.id, contract.id);
});

test("a queued reset cannot leave a contract referring to a removed profile", async (t) => {
  localStorage(t);
  const { document } = await createSession();
  await registerUser(document.ownerId, { role: "tenant", displayName: "Taylor" });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const held = mutateSession(document.ownerId, async () => { entered(); await gate; });
  await ready;
  const reset = resetSession(document.ownerId);
  const creation = createContract(document.ownerId, { case_type: "self_documentation", terms: "Demo terms" });
  const rejected = assert.rejects(creation, /register a tenant/i);
  release();
  await held;
  await reset;
  await rejected;
  const after = await readSession(document.ownerId);
  assert.equal(after?.users, undefined);
  assert.equal(after?.contracts, undefined);
});
