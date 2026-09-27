import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Client, Wallet, decode, hashes, type Payment } from "xrpl";
import { performCaseAction } from "../src/lib/server/cases";
import { ApiError } from "../src/lib/server/errors";
import { createSession, mutateSession, readSession } from "../src/lib/server/store";
import { proposeXrplAgentSettlement } from "../src/lib/server/xrpl-agent";
import { actionSchema } from "../src/lib/server/validation";

function environment(t: TestContext, values: Record<string, string | undefined>) {
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
}

async function setup(t: TestContext) {
  const source = Wallet.generate();
  const destination = Wallet.generate();
  environment(t, {
    RENTESCROW_STORAGE: "local",
    XRPL_SETTLEMENT_ENABLED: "true",
    XRPL_NETWORK: "testnet",
    XRPL_RPC_URL: "wss://s.altnet.rippletest.net:51233",
    XRPL_TENANT_ADDRESS: source.classicAddress,
    XRPL_TENANT_SEED: source.seed,
    XRPL_LANDLORD_ADDRESS: destination.classicAddress,
    XRPL_SETTLEMENT_AMOUNT_XRP: "1",
    NESSIE_ENABLED: "false",
  });
  const { document } = await createSession();
  const ownerId = document.ownerId;
  const caseId = document.cases[0].id;
  await performCaseAction(ownerId, caseId, { action: "create_escrow" });
  await performCaseAction(ownerId, caseId, { action: "enable_xrpl" });
  return { ownerId, caseId, source };
}

function mockNessie(t: TestContext, ownerId: string) {
  environment(t, { NESSIE_ENABLED: "true", NESSIE_API_KEY: "test-only", NESSIE_TENANT_ID: ownerId,
    NESSIE_CUSTOMER_ID: "customer_123", NESSIE_ACCOUNT_ID: "account_456" });
  t.mock.method(globalThis, "fetch", async (input: URL | RequestInfo) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/customers/customer_123") return Response.json({ _id: "customer_123" });
    if (pathname === "/accounts/account_456") return Response.json({ _id: "account_456", customer_id: "customer_123", balance: 2430 });
    if (pathname.endsWith("/purchases") || pathname.endsWith("/bills")) return Response.json([]);
    throw new Error(`Unexpected provider request: ${pathname}`);
  });
}

async function makeRepairReady(ownerId: string, caseId: string) {
  await performCaseAction(ownerId, caseId, { action: "simulate_landlord_reply", variant: "completed" });
  const evidence = await performCaseAction(ownerId, caseId, { action: "add_demo_evidence", stage: "after" });
  await performCaseAction(ownerId, caseId, {
    action: "analyze_evidence",
    evidenceId: evidence.case.evidence.at(-1)!.id,
  });
  await performCaseAction(ownerId, caseId, { action: "verify_repair" });
}

function mockLedger(t: TestContext, source: Wallet) {
  let signedBlob = "";
  const connect = t.mock.method(Client.prototype, "connect", async () => undefined);
  t.mock.method(Client.prototype, "disconnect", async () => undefined);
  t.mock.method(Client.prototype, "isConnected", () => true);
  t.mock.method(Client.prototype, "getLedgerIndex", async () => 1000);
  t.mock.method(Client.prototype, "autofill", async (transaction: Parameters<Client["autofill"]>[0]) => ({
    ...transaction, Fee: "12", Sequence: 123, LastLedgerSequence: 1020,
  }) as never);
  t.mock.method(Client.prototype, "request", async (request: Parameters<Client["request"]>[0]) => {
    if (request.command === "server_info") {
      return { result: { info: { network_id: 1, validated_ledger: {
        reserve_base_xrp: 1, reserve_inc_xrp: 0.2,
      } } } } as never;
    }
    if (request.command === "account_info") {
      return { result: { validated: true, account_data: {
        Account: source.classicAddress, Balance: "50000000", OwnerCount: 0, Sequence: 123,
      } } } as never;
    }
    if (request.command === "tx" && signedBlob) return validatedResult(signedBlob);
    throw new Error(`Unexpected ledger request: ${request.command}`);
  });
  const submit = t.mock.method(Client.prototype, "submitAndWait", async (blob: Parameters<Client["submitAndWait"]>[0]) => {
    signedBlob = String(blob);
    return validatedResult(signedBlob);
  });
  return { connect, submit };
}

function validatedResult(blob: string) {
  const transaction = decode(blob) as unknown as Payment;
  return { result: {
    validated: true,
    hash: hashes.hashSignedTx(blob),
    ledger_index: 1001,
    tx_json: transaction,
    meta: { TransactionResult: "tesSUCCESS", delivered_amount: transaction.Amount },
  } } as never;
}

test("agent authorization accepts no payment fields and its request contains only caseId and action", async (t) => {
  assert.equal(actionSchema.safeParse({
    action: "authorize_xrpl_agent",
    destination: Wallet.generate().classicAddress,
    amountDrops: "9000000",
    network: "mainnet",
  }).success, false);

  const prepared = await setup(t);
  await makeRepairReady(prepared.ownerId, prepared.caseId);
  await performCaseAction(prepared.ownerId, prepared.caseId, { action: "confirm_resolution" });
  const record = (await readSession(prepared.ownerId))!.cases[0];
  assert.equal(proposeXrplAgentSettlement(record), null);
  record.xrplSettlement!.agentAuthorizedAt = new Date().toISOString();
  const request = proposeXrplAgentSettlement(record);
  assert.deepEqual(request, { caseId: record.id, action: "settle_xrpl" });
  assert.deepEqual(Object.keys(request!).sort(), ["action", "caseId"]);
});

test("unarmed cases remain manual after tenant confirmation", async (t) => {
  const prepared = await setup(t);
  const connect = t.mock.method(Client.prototype, "connect", async () => undefined);
  await makeRepairReady(prepared.ownerId, prepared.caseId);
  const confirmed = await performCaseAction(prepared.ownerId, prepared.caseId, { action: "confirm_resolution" });
  assert.equal(confirmed.case.tenantConfirmed, true);
  assert.equal(confirmed.case.xrplSettlement?.status, "ready");
  assert.equal(confirmed.case.xrplSettlement?.agentRequestedAt, undefined);
  assert.equal(connect.mock.callCount(), 0);
});

test("historical unsubmitted permission can refresh participants without replacing its terms", async (t) => {
  const prepared = await setup(t);
  await makeRepairReady(prepared.ownerId, prepared.caseId);
  await mutateSession(prepared.ownerId, (document) => {
    const settlement = document.cases[0].xrplSettlement!;
    delete settlement.tenantUserId;
    delete settlement.landlordUserId;
    delete settlement.landlordWallet;
  });
  const before = (await readSession(prepared.ownerId))!.cases[0].xrplSettlement!;
  const refreshed = await performCaseAction(prepared.ownerId, prepared.caseId, { action: "enable_xrpl" });
  assert.deepEqual(refreshed.case.xrplSettlement, { ...before, tenantUserId: prepared.ownerId,
    landlordUserId: refreshed.case.escrow.destination, landlordWallet: refreshed.case.escrow.destination });
  await performCaseAction(prepared.ownerId, prepared.caseId, { action: "confirm_resolution" });
  const ledger = mockLedger(t, prepared.source);
  const paid = await performCaseAction(prepared.ownerId, prepared.caseId, { action: "settle_xrpl" });
  assert.equal(paid.case.xrplSettlement?.status, "validated");
  assert.equal(ledger.submit.mock.callCount(), 1);
});

test("verification expiring after signing records signed but never submitted", async (t) => {
  const prepared = await setup(t);
  await makeRepairReady(prepared.ownerId, prepared.caseId);
  await performCaseAction(prepared.ownerId, prepared.caseId, { action: "confirm_resolution" });
  const ledger = mockLedger(t, prepared.source);
  const sign = Wallet.prototype.sign;
  const currentTime = Date.now;
  const signer = t.mock.method(Wallet.prototype, "sign", function (this: Wallet, ...args: Parameters<Wallet["sign"]>) {
    const result = sign.apply(this, args);
    t.mock.method(Date, "now", () => currentTime() + 120_000);
    return result;
  });
  await assert.rejects(performCaseAction(prepared.ownerId, prepared.caseId, { action: "settle_xrpl" }),
    (error: unknown) => error instanceof ApiError && error.code === "NESSIE_VERIFICATION_STALE");
  const stored = (await readSession(prepared.ownerId))!.cases[0];
  const audit = stored.escrow.audit.at(-1)!;
  assert.equal(audit.signed, true);
  assert.equal(audit.submitted, false);
  assert.equal(audit.policyDecision?.approved, false);
  assert.equal(signer.mock.callCount(), 1);
  assert.equal(ledger.submit.mock.callCount(), 0);
  assert.equal(stored.escrow.audit.filter((entry) => entry.action === "Payment" && entry.signed === false).length, 0);
});

test("armed agent waits for case conditions, then confirmation settles exactly once", async (t) => {
  const prepared = await setup(t);
  mockNessie(t, prepared.ownerId);
  const armed = await performCaseAction(prepared.ownerId, prepared.caseId, { action: "authorize_xrpl_agent" });
  assert.ok(armed.case.xrplSettlement?.agentAuthorizedAt);
  assert.equal(armed.case.xrplSettlement?.agentRequestedAt, undefined);

  await makeRepairReady(prepared.ownerId, prepared.caseId);
  const ledger = mockLedger(t, prepared.source);
  const settled = await performCaseAction(prepared.ownerId, prepared.caseId, { action: "confirm_resolution" });
  assert.equal(settled.case.xrplSettlement?.status, "validated");
  assert.ok(settled.case.xrplSettlement?.agentRequestedAt);
  assert.equal(ledger.submit.mock.callCount(), 1);
  const receipt = settled.case.escrow.audit.find((entry) => entry.status === "validated" && entry.action === "Payment");
  assert.equal(receipt?.actor, "settlement_agent");
  assert.equal(receipt?.policyDecision?.approved, true);
  assert.ok(receipt?.policyDecision?.checks.some((check) => check.key === "XRPL_FINAL_TRANSACTION"));

  await assert.rejects(
    performCaseAction(prepared.ownerId, prepared.caseId, { action: "confirm_resolution" }),
    (error: unknown) => error instanceof ApiError && error.status === 409,
  );
  assert.equal(ledger.submit.mock.callCount(), 1);
});

test("unauthorized authenticated workspace cannot arm or trigger the settlement agent", async (t) => {
  const prepared = await setup(t);
  await makeRepairReady(prepared.ownerId, prepared.caseId);
  await mutateSession(prepared.ownerId, (document) => {
    document.tenantUserId = "unauthorized-tenant";
    document.cases[0].tenantUserId = "unauthorized-tenant";
    delete document.xrplAuthorized;
  });
  await assert.rejects(
    performCaseAction(prepared.ownerId, prepared.caseId, { action: "authorize_xrpl_agent" }),
    (error: unknown) => error instanceof ApiError && error.code === "XRPL_ACCOUNT_NOT_AUTHORIZED",
  );
  await mutateSession(prepared.ownerId, (document) => {
    document.cases[0].xrplSettlement!.agentAuthorizedAt = new Date().toISOString();
  });
  await assert.rejects(
    performCaseAction(prepared.ownerId, prepared.caseId, { action: "confirm_resolution" }),
    (error: unknown) => error instanceof ApiError && error.code === "XRPL_ACCOUNT_NOT_AUTHORIZED",
  );
  const stored = (await readSession(prepared.ownerId))!.cases[0];
  assert.equal(stored.tenantConfirmed, false);
  assert.equal(stored.xrplSettlement?.agentRequestedAt, undefined);
});

test("agent policy denial preserves confirmation, records rejection, and never signs", async (t) => {
  const prepared = await setup(t);
  mockNessie(t, prepared.ownerId);
  await performCaseAction(prepared.ownerId, prepared.caseId, { action: "authorize_xrpl_agent" });
  await makeRepairReady(prepared.ownerId, prepared.caseId);
  await mutateSession(prepared.ownerId, (document) => {
    document.cases[0].xrplSettlement!.landlordWallet = "substituted-beneficiary";
  });
  const connect = t.mock.method(Client.prototype, "connect", async () => undefined);
  await assert.rejects(
    performCaseAction(prepared.ownerId, prepared.caseId, { action: "confirm_resolution" }),
    (error: unknown) => error instanceof ApiError && error.persistAudit && error.policy?.approved === false,
  );
  const stored = (await readSession(prepared.ownerId))!.cases[0];
  assert.equal(stored.tenantConfirmed, true);
  assert.ok(stored.xrplSettlement?.agentRequestedAt);
  assert.equal(stored.xrplSettlement?.status, "ready");
  assert.equal(connect.mock.callCount(), 0);
  const rejection = stored.escrow.audit.at(-1)!;
  assert.equal(rejection.status, "rejected");
  assert.equal(rejection.actor, "settlement_agent");
  assert.equal(rejection.signed, false);
  assert.equal(rejection.submitted, false);
  assert.equal(rejection.policyDecision?.approved, false);
  assert.equal(proposeXrplAgentSettlement(stored), null);
  // Repairing trusted authorization does not turn a later manual request into an agent request.
  await mutateSession(prepared.ownerId, (document) => {
    document.cases[0].xrplSettlement!.landlordWallet = document.cases[0].escrow.destination;
  });
  mockLedger(t, prepared.source);
  const manual = await performCaseAction(prepared.ownerId, prepared.caseId, { action: "settle_xrpl" });
  assert.equal(manual.case.xrplSettlement?.status, "validated");
  assert.equal(manual.case.escrow.audit.at(-1)?.actor, "tenant");
});


test("autonomous settlement cannot treat an explicit demo profile as live financial verification", async (t) => {
  const prepared = await setup(t);
  await performCaseAction(prepared.ownerId, prepared.caseId, { action: "authorize_xrpl_agent" });
  await makeRepairReady(prepared.ownerId, prepared.caseId);
  const ledger = mockLedger(t, prepared.source);
  const signer = t.mock.method(Wallet.prototype, "sign", () => { throw new Error("Must not sign"); });
  await assert.rejects(performCaseAction(prepared.ownerId, prepared.caseId, { action: "confirm_resolution" }),
    (error: unknown) => error instanceof ApiError && error.code === "FINANCIAL_CONTEXT_NOT_VERIFIED");
  const record = (await readSession(prepared.ownerId))!.cases[0];
  assert.equal(record.financialPolicyContext?.financiallyReady, false);
  assert.equal(record.tenantConfirmed, true);
  assert.equal(signer.mock.callCount(), 0);
  assert.equal(ledger.connect.mock.callCount(), 0);
  assert.equal(ledger.submit.mock.callCount(), 0);
});

test("a live Nessie outage blocks autonomous settlement before ledger access or signing", async (t) => {
  const prepared = await setup(t);
  mockNessie(t, prepared.ownerId);
  await performCaseAction(prepared.ownerId, prepared.caseId, { action: "sync_finances" });
  await performCaseAction(prepared.ownerId, prepared.caseId, { action: "authorize_xrpl_agent" });
  await makeRepairReady(prepared.ownerId, prepared.caseId);
  t.mock.method(globalThis, "fetch", async () => new Response("Unavailable", { status: 503 }));
  const ledger = mockLedger(t, prepared.source);
  const signer = t.mock.method(Wallet.prototype, "sign", () => { throw new Error("Must not sign"); });
  await assert.rejects(performCaseAction(prepared.ownerId, prepared.caseId, { action: "confirm_resolution" }),
    (error: unknown) => error instanceof ApiError && error.code === "NESSIE_API_UNAVAILABLE");
  const record = (await readSession(prepared.ownerId))!.cases[0];
  assert.equal(record.financialPolicyContext?.financiallyReady, false);
  assert.equal(record.financialProfile?.binding.source, "nessie");
  assert.equal(record.financialProfile?.accountBalanceCents, undefined);
  assert.equal(record.escrow.status, "locked");
  assert.equal(signer.mock.callCount(), 0);
  assert.equal(ledger.connect.mock.callCount(), 0);
  assert.equal(ledger.submit.mock.callCount(), 0);
});
