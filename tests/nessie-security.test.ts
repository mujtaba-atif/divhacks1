import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createDemoCase } from "../src/lib/seed";
import { performCaseAction } from "../src/lib/server/cases";
import { createSession, readSession } from "../src/lib/server/store";
import { getTrustedFinancialVerification } from "../src/lib/server/nessie-verification";

function environment(t: TestContext, values: Record<string, string | undefined> = {}) {
  const settings = {
    NESSIE_ENABLED: "true", NESSIE_API_KEY: "unit-test-key", NESSIE_TENANT_ID: "tenant-one",
    NESSIE_CUSTOMER_ID: "customer_123", NESSIE_ACCOUNT_ID: "account_456", ...values,
  };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

function verifiedRecord() {
  const record = createDemoCase("tenant-one");
  const profile = record.financialProfile!;
  profile.binding = { tenantId: record.ownerId, customerId: "customer_123", accountId: "account_456", caseId: record.id, source: "nessie" };
  profile.status = "verified";
  profile.customerVerified = true;
  profile.accountVerified = true;
  profile.ownershipVerified = true;
  profile.accountBalanceCents = 243000;
  profile.checkedAt = new Date().toISOString();
  profile.expiresAt = new Date(Date.now() + 60_000).toISOString();
  return record;
}

function provider(t: TestContext, data: Record<string, unknown | Response>) {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    const path = new URL(input).pathname;
    calls.push(path);
    const payload = data[path];
    assert.notEqual(payload, undefined, `Unexpected Nessie API path ${path}`);
    return payload instanceof Response ? payload.clone() : Response.json(payload);
  });
  return calls;
}

function providerData(): Record<string, unknown | Response> {
  return {
    "/customers/customer_123": { _id: "customer_123" },
    "/accounts/account_456": { _id: "account_456", customer_id: "customer_123", balance: 2430 },
    "/accounts/account_456/purchases": [],
    "/accounts/account_456/bills": [],
  };
}

async function liveSession(t: TestContext, overrides: Record<string, string | undefined> = {}) {
  environment(t, { RENTESCROW_STORAGE: "local", ...overrides });
  const { document } = await createSession();
  if (!("NESSIE_TENANT_ID" in overrides)) process.env.NESSIE_TENANT_ID = document.ownerId;
  return { ownerId: document.ownerId, caseId: document.cases[0].id };
}

const none = { tenantVerified: false, customerVerified: false, accountVerified: false, ownershipVerified: false, balanceAvailable: false };
const trusted = { tenantVerified: true, customerVerified: true, accountVerified: true, ownershipVerified: true, balanceAvailable: true };

test("normalized Nessie trust is true only for the fresh server-configured live tenant/customer/account binding", (t) => {
  environment(t);
  assert.deepEqual(getTrustedFinancialVerification(verifiedRecord()), trusted);
});

for (const [name, modify] of [
  ["wrong saved tenant", (record: ReturnType<typeof verifiedRecord>) => { record.financialProfile!.binding.tenantId = "tenant-other"; }],
  ["wrong saved customer", (record: ReturnType<typeof verifiedRecord>) => { record.financialProfile!.binding.customerId = "customer-other"; }],
  ["wrong saved account", (record: ReturnType<typeof verifiedRecord>) => { record.financialProfile!.binding.accountId = "account-other"; }],
  ["wrong saved case", (record: ReturnType<typeof verifiedRecord>) => { record.financialProfile!.binding.caseId = "RE-OTHER"; }],
  ["configuration drift", (record: ReturnType<typeof verifiedRecord>) => { record.ownerId = "tenant-other"; }],
  ["stale live verification", (record: ReturnType<typeof verifiedRecord>) => { record.financialProfile!.expiresAt = "2000-01-01T00:00:00.000Z"; }],
  ["unavailable provider", (record: ReturnType<typeof verifiedRecord>) => { record.financialProfile!.status = "unavailable"; }],
  ["missing balance", (record: ReturnType<typeof verifiedRecord>) => { record.financialProfile!.accountBalanceCents = undefined; }],
] as const) {
  test(`normalized Nessie trust fails closed for ${name}`, (t) => {
    environment(t);
    const record = verifiedRecord();
    modify(record);
    assert.deepEqual(getTrustedFinancialVerification(record), none);
  });
}

test("demo records and a live record after Nessie is disabled never become trusted financial verification", (t) => {
  environment(t, { NESSIE_ENABLED: "false" });
  const demo = createDemoCase("tenant-one");
  assert.deepEqual(getTrustedFinancialVerification(demo), none);

  const formerlyLive = verifiedRecord();
  assert.deepEqual(getTrustedFinancialVerification(formerlyLive), none);
});

test("a first live configuration failure pins the case to Nessie and disabling it cannot revive demo trust", async (t) => {
  environment(t, { NESSIE_API_KEY: undefined, RENTESCROW_STORAGE: "local" });
  const { document } = await createSession();
  process.env.NESSIE_TENANT_ID = document.ownerId;
  const id = document.cases[0].id;

  await performCaseAction(document.ownerId, id, { action: "sync_finances" });
  let stored = (await readSession(document.ownerId))!.cases[0];
  assert.equal(stored.financialProfile?.binding.source, "nessie");
  assert.equal(stored.financialProfile?.status, "unavailable");
  assert.deepEqual(getTrustedFinancialVerification(stored), none);

  process.env.NESSIE_ENABLED = "false";
  await performCaseAction(document.ownerId, id, { action: "sync_finances" });
  stored = (await readSession(document.ownerId))!.cases[0];
  assert.equal(stored.financialProfile?.binding.source, "nessie");
  assert.deepEqual(getTrustedFinancialVerification(stored), none);
});

test("live sync maps all trusted Nessie checks, and an outage clears them without a demo revival", async (t) => {
  const { ownerId, caseId } = await liveSession(t);
  const data = providerData();
  provider(t, data);

  let result = await performCaseAction(ownerId, caseId, { action: "sync_finances" });
  assert.deepEqual(result.case.financialPolicyContext, {
    tenantVerified: true, customerVerified: true, accountVerified: true,
    accountCustomerBound: true, financiallyReady: true,
  });
  assert.equal(result.case.financialProfile?.accountBalanceCents, 243000);

  data["/customers/customer_123"] = new Response("Unavailable", { status: 503 });
  result = await performCaseAction(ownerId, caseId, { action: "sync_finances" });
  assert.equal(result.case.financialProfile?.binding.source, "nessie");
  assert.equal(result.case.financialProfile?.accountBalanceCents, undefined);
  assert.deepEqual(result.case.financialPolicyContext, {
    tenantVerified: false, customerVerified: false, accountVerified: false,
    accountCustomerBound: false, financiallyReady: false,
  });

  process.env.NESSIE_ENABLED = "false";
  result = await performCaseAction(ownerId, caseId, { action: "sync_finances" });
  assert.equal(result.case.financialProfile?.binding.source, "nessie");
  assert.deepEqual(result.case.financialPolicyContext, {
    tenantVerified: false, customerVerified: false, accountVerified: false,
    accountCustomerBound: false, financiallyReady: false,
  });
});

test("wrong-tenant live attempts do not disclose configured Nessie identities or contact the provider", async (t) => {
  const { ownerId, caseId } = await liveSession(t, { NESSIE_TENANT_ID: "other-tenant" });
  const calls = provider(t, providerData());
  const result = await performCaseAction(ownerId, caseId, { action: "sync_finances" });
  assert.equal(calls.length, 0);
  assert.equal(result.case.financialProfile?.binding.source, "nessie");
  assert.equal(result.case.financialProfile?.binding.customerId, "");
  assert.equal(result.case.financialProfile?.binding.accountId, "");
  assert.deepEqual(result.case.financialPolicyContext, {
    tenantVerified: false, customerVerified: false, accountVerified: false,
    accountCustomerBound: false, financiallyReady: false,
  });
});

for (const [name, path, payload] of [
  ["missing balance", "/accounts/account_456", { _id: "account_456", customer_id: "customer_123" }],
  ["missing purchase history", "/accounts/account_456/purchases", {}],
  ["missing rent history", "/accounts/account_456/bills", {}],
] as const) {
  test(`malformed ${name} fails closed and a later complete provider response can recover`, async (t) => {
    const { ownerId, caseId } = await liveSession(t);
    const data = providerData();
    data[path] = payload;
    provider(t, data);
    let result = await performCaseAction(ownerId, caseId, { action: "sync_finances" });
    assert.equal(result.case.financialProfile?.binding.source, "nessie");
    assert.equal(result.case.financialProfile?.accountBalanceCents, undefined);
    assert.equal(result.case.financialPolicyContext?.financiallyReady, false);

    Object.assign(data, providerData());
    result = await performCaseAction(ownerId, caseId, { action: "sync_finances" });
    assert.equal(result.case.financialProfile?.status, "verified");
    assert.equal(result.case.financialPolicyContext?.financiallyReady, true);
  });
}

test("a tenant can recover only after an initially incomplete live configuration is completed", async (t) => {
  const { ownerId, caseId } = await liveSession(t, { NESSIE_CUSTOMER_ID: undefined, NESSIE_ACCOUNT_ID: undefined });
  const data = providerData();
  const calls = provider(t, data);
  let result = await performCaseAction(ownerId, caseId, { action: "sync_finances" });
  assert.equal(calls.length, 0);
  assert.equal(result.case.financialProfile?.binding.source, "nessie");
  assert.deepEqual(result.case.financialPolicyContext, {
    tenantVerified: false, customerVerified: false, accountVerified: false,
    accountCustomerBound: false, financiallyReady: false,
  });

  process.env.NESSIE_CUSTOMER_ID = "customer_123";
  process.env.NESSIE_ACCOUNT_ID = "account_456";
  result = await performCaseAction(ownerId, caseId, { action: "sync_finances" });
  assert.equal(result.case.financialProfile?.status, "verified");
  assert.deepEqual(result.case.financialPolicyContext, {
    tenantVerified: true, customerVerified: true, accountVerified: true,
    accountCustomerBound: true, financiallyReady: true,
  });
});
