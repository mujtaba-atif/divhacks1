import assert from "node:assert/strict";
import { test } from "node:test";
import { createDemoCase } from "../src/lib/seed";
import { evaluatePolicy, makeIntent } from "../src/lib/policy";

function readyCase() {
  const record = createDemoCase("test-owner");
  record.escrow.status = "locked";
  record.status = "verified";
  record.repairReported = true;
  record.tenantConfirmed = true;
  record.verification = { summary: "Demo repair verified", severity: "low", temperatureF: 72,
    verified: true, reasons: [], source: "demo" };
  record.evidence.push({ id: "after", name: "after.png", mimeType: "image/png", stage: "after",
    note: "Sample", createdAt: new Date().toISOString(), isDemo: true, analysis: record.verification });
  return record;
}

test("an active case with sufficient funds can create escrow", () => {
  const record = createDemoCase("owner");
  assert.equal(evaluatePolicy(record, makeIntent(record, "EscrowCreate")).approved, true);
});

test("insufficient funds cannot create escrow", () => {
  const record = createDemoCase("owner");
  record.accountBalanceCents = record.disputedAmountCents - 1;
  assert.equal(evaluatePolicy(record, makeIntent(record, "EscrowCreate")).approved, false);
  assert.equal(record.escrow.status, "unfunded");
});

test("fully verified and tenant-confirmed case can release held funds", () => {
  const record = readyCase();
  record.accountBalanceCents = 0;
  assert.equal(evaluatePolicy(record, makeIntent(record, "EscrowFinish")).approved, true);
});

for (const [field, value] of Object.entries({
  caseId: "RE-OTHER", escrowId: "ESC-OTHER", destination: "ATTACKER", amountCents: 40001,
  transactionType: "Payment", network: "mainnet",
})) {
  test(`rejects tampered ${field} before settlement`, () => {
    const record = readyCase();
    const intent = { ...makeIntent(record, "EscrowFinish"), [field]: value };
    assert.equal(evaluatePolicy(record, intent).approved, false);
  });
}

for (const amountCents of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
  test(`rejects invalid monetary amount ${amountCents}`, () => {
    const record = readyCase();
    assert.equal(evaluatePolicy(record, { ...makeIntent(record, "EscrowFinish"), amountCents }).approved, false);
  });
}

test("each independent release prerequisite is mandatory", () => {
  for (const change of [
    (record: ReturnType<typeof readyCase>) => { record.repairReported = false; },
    (record: ReturnType<typeof readyCase>) => { record.tenantConfirmed = false; },
    (record: ReturnType<typeof readyCase>) => { record.verification = undefined; },
    (record: ReturnType<typeof readyCase>) => { record.evidence = []; },
    (record: ReturnType<typeof readyCase>) => { record.status = "open"; },
    (record: ReturnType<typeof readyCase>) => { record.escrow.status = "unfunded"; },
  ]) {
    const record = readyCase();
    change(record);
    assert.equal(evaluatePolicy(record, makeIntent(record, "EscrowFinish")).approved, false);
  }
});

test("released escrow cannot be released or funded twice", () => {
  const record = readyCase();
  record.escrow.status = "released";
  record.status = "resolved";
  for (const action of ["EscrowCreate", "EscrowFinish"]) {
    assert.equal(evaluatePolicy(record, makeIntent(record, action)).approved, false);
  }
});

test("demo evidence cannot authorize an actual testnet transaction", () => {
  const record = readyCase();
  record.escrow.network = "testnet";
  assert.equal(evaluatePolicy(record, makeIntent(record, "EscrowFinish")).approved, false);
});

test("an older passing upload cannot authorize release with newer unverified evidence", () => {
  const record = readyCase();
  record.evidence.push({ ...record.evidence.at(-1)!, id: "newer-after", analysis: undefined });
  assert.equal(evaluatePolicy(record, makeIntent(record, "EscrowFinish")).approved, false);
});
