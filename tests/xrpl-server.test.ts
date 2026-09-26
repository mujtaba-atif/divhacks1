import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Client, Wallet, decode, hashes, type Payment } from "xrpl";
import { makeXrplIntent } from "../src/lib/policy";
import { addUploadedEvidence, performCaseAction } from "../src/lib/server/cases";
import { ApiError } from "../src/lib/server/errors";
import { createSession, mutateSession, readSession, resetSession } from "../src/lib/server/store";
import { recordXrplPending, recordXrplValidated } from "../src/lib/server/xrpl-journal";

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

async function preparedCase(t: TestContext) {
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
  });
  const { document } = await createSession();
  const ownerId = document.ownerId;
  const caseId = document.cases[0].id;
  await performCaseAction(ownerId, caseId, { action: "create_escrow" });
  await performCaseAction(ownerId, caseId, { action: "simulate_landlord_reply", variant: "completed" });
  const evidence = await performCaseAction(ownerId, caseId, { action: "add_demo_evidence", stage: "after" });
  await performCaseAction(ownerId, caseId, { action: "analyze_evidence", evidenceId: evidence.case.evidence.at(-1)!.id });
  await performCaseAction(ownerId, caseId, { action: "verify_repair" });
  await performCaseAction(ownerId, caseId, { action: "confirm_resolution" });
  const enabled = await performCaseAction(ownerId, caseId, { action: "enable_xrpl" });
  return { ownerId, caseId, source, destination, enabled: enabled.case };
}

function mockLedger(t: TestContext, source: Wallet) {
  let submission: "success" | "uncertain" | "failed" = "success";
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
    if (submission === "uncertain") throw new Error("connection lost after dispatch");
    return validatedResult(signedBlob, submission === "failed" ? "tecUNFUNDED_PAYMENT" : "tesSUCCESS");
  });
  return {
    connect,
    submit,
    setSubmission(value: "success" | "uncertain" | "failed") { submission = value; },
  };
}

function validatedResult(blob: string, result = "tesSUCCESS") {
  const transaction = decode(blob) as unknown as Payment;
  return { result: {
    validated: true,
    hash: hashes.hashSignedTx(blob),
    ledger_index: 1001,
    tx_json: transaction,
    meta: { TransactionResult: result, delivered_amount: transaction.Amount },
  } } as never;
}

test("validated Testnet settlement releases simulated USD once under duplicate concurrency", async (t) => {
  const setup = await preparedCase(t);
  const ledger = mockLedger(t, setup.source);
  const attempts = await Promise.allSettled([
    performCaseAction(setup.ownerId, setup.caseId, { action: "settle_xrpl" }),
    performCaseAction(setup.ownerId, setup.caseId, { action: "settle_xrpl" }),
  ]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
  assert.equal(ledger.submit.mock.callCount(), 1);
  const stored = await readSession(setup.ownerId);
  const record = stored!.cases[0];
  assert.equal(record.xrplSettlement?.status, "validated");
  assert.match(record.xrplSettlement?.hash ?? "", /^[A-F0-9]{64}$/);
  assert.equal(record.escrow.status, "released");
  assert.equal(record.status, "resolved");
  assert.equal(record.escrow.audit.filter((entry) => entry.action === "Payment" && entry.status === "validated").length, 1);
  assert.equal(record.escrow.audit.at(-1)?.code, "SETTLEMENT_ALREADY_COMPLETED");
});

test("uncertain submission stays pending, blocks mutation and replay, then reconciles read-only", async (t) => {
  const setup = await preparedCase(t);
  const ledger = mockLedger(t, setup.source);
  ledger.setSubmission("uncertain");
  await assert.rejects(
    performCaseAction(setup.ownerId, setup.caseId, { action: "settle_xrpl" }),
    (error: unknown) => error instanceof ApiError && error.code === "XRPL_SUBMISSION_UNCERTAIN",
  );
  let stored = await readSession(setup.ownerId);
  assert.equal(stored?.cases[0].xrplSettlement?.status, "pending");
  assert.match(stored?.cases[0].xrplSettlement?.hash ?? "", /^[A-F0-9]{64}$/);
  await assert.rejects(addUploadedEvidence(setup.ownerId, setup.caseId, {
    id: "blocked", name: "blocked.png", mimeType: "image/png", stage: "other",
    note: "must not mutate", createdAt: new Date().toISOString(), isDemo: false,
  }), /Reconcile the pending XRPL transaction/);
  await assert.rejects(resetSession(setup.ownerId), /Reconcile the pending XRPL transaction/);
  await assert.rejects(performCaseAction(setup.ownerId, setup.caseId, { action: "settle_xrpl" }),
    (error: unknown) => error instanceof ApiError && error.code === "SETTLEMENT_PENDING");
  assert.equal(ledger.submit.mock.callCount(), 1);
  ledger.setSubmission("success");
  const reconciled = await performCaseAction(setup.ownerId, setup.caseId, { action: "reconcile_xrpl" });
  assert.equal(reconciled.case.xrplSettlement?.status, "validated");
  assert.equal(ledger.submit.mock.callCount(), 1);
  stored = await readSession(setup.ownerId);
  assert.equal(stored?.cases[0].status, "resolved");
});

test("durable journal blocks mutation and reset when a session checkpoint is lost", async (t) => {
  const setup = await preparedCase(t);
  const settlement = setup.enabled.xrplSettlement!;
  const intent = makeXrplIntent(setup.enabled);
  const pending = {
    hash: "A".repeat(64), sequence: 123, lastLedgerSequence: 1020,
    preparedLedgerIndex: 1000, intent,
  };
  await assert.rejects(mutateSession(setup.ownerId, async (document) => {
    await recordXrplPending(document.cases[0].xrplSettlement!, pending);
    throw new Error("simulated session checkpoint failure");
  }), /simulated session checkpoint failure/);
  assert.equal((await readSession(setup.ownerId))?.cases[0].xrplSettlement?.status, "ready");
  await assert.rejects(addUploadedEvidence(setup.ownerId, setup.caseId, {
    id: "journal-blocked", name: "blocked.png", mimeType: "image/png", stage: "other",
    note: "must not mutate", createdAt: new Date().toISOString(), isDemo: false,
  }), (error: unknown) => error instanceof ApiError && error.code === "SETTLEMENT_PENDING");
  await assert.rejects(resetSession(setup.ownerId),
    (error: unknown) => error instanceof ApiError && error.code === "SETTLEMENT_PENDING");

  const receipt = {
    hash: pending.hash, ledgerIndex: 1001, result: "tesSUCCESS" as const, validated: true as const,
    amountDrops: settlement.amountDrops, destination: settlement.destination, source: settlement.source,
    caseId: settlement.caseId, settlementId: settlement.id, validatedAt: new Date().toISOString(),
  };
  await recordXrplValidated(settlement, pending, receipt);
  await assert.rejects(resetSession(setup.ownerId),
    (error: unknown) => error instanceof ApiError && error.code === "SETTLEMENT_ALREADY_COMPLETED");
  const reconciled = await performCaseAction(setup.ownerId, setup.caseId, { action: "reconcile_xrpl" });
  assert.equal(reconciled.case.xrplSettlement?.status, "validated");
});

test("validated ledger failure is audited as failed without releasing USD or allowing replacement", async (t) => {
  const setup = await preparedCase(t);
  const ledger = mockLedger(t, setup.source);
  ledger.setSubmission("failed");
  await assert.rejects(performCaseAction(setup.ownerId, setup.caseId, { action: "settle_xrpl" }),
    (error: unknown) => error instanceof ApiError && error.code === "XRPL_LEDGER_FAILED");
  const stored = (await readSession(setup.ownerId))!.cases[0];
  assert.equal(stored.xrplSettlement?.status, "failed");
  assert.equal(stored.xrplSettlement?.result, "tecUNFUNDED_PAYMENT");
  assert.equal(stored.escrow.status, "locked");
  assert.notEqual(stored.status, "resolved");
  assert.equal(stored.escrow.audit.at(-1)?.result, "tecUNFUNDED_PAYMENT");
  assert.equal(stored.escrow.audit.at(-1)?.validated, true);
  assert.equal(stored.escrow.audit.at(-1)?.status, "failed");
  await assert.rejects(performCaseAction(setup.ownerId, setup.caseId, { action: "settle_xrpl" }),
    (error: unknown) => error instanceof ApiError && error.code === "SETTLEMENT_PENDING");
  assert.equal(ledger.submit.mock.callCount(), 1);
});

test("server-owned wallets resist config changes, attacks are audited, and USD release cannot bypass XRPL", async (t) => {
  const setup = await preparedCase(t);
  const pinnedDestination = setup.enabled.xrplSettlement!.destination;
  await assert.rejects(
    performCaseAction(setup.ownerId, setup.caseId, { action: "release_escrow" }),
    (error: unknown) => error instanceof ApiError && error.code === "XRPL_SETTLEMENT_REQUIRED",
  );
  for (const scenario of ["wallet_switch", "amount_tamper", "prompt_injection"] as const) {
    const demo = await performCaseAction(setup.ownerId, setup.caseId, { action: "xrpl_security_demo", scenario });
    assert.equal(demo.policy?.approved, false);
    assert.equal(demo.policy?.checks[0].key,
      scenario === "amount_tamper" ? "AMOUNT_OUTSIDE_AUTHORIZATION" : "DESTINATION_WALLET_MISMATCH");
    assert.equal(demo.policy?.checks[0].passed, false);
  }
  const scoped = await performCaseAction(setup.ownerId, setup.caseId, { action: "xrpl_security_demo", scenario: "unsupported_action" });
  assert.equal(scoped.case.escrow.audit.at(-1)?.requestedTransactionType, "AccountSet");
  assert.equal(scoped.case.escrow.audit.at(-1)?.requestedAction, "SEND_ARBITRARY_XRP");
  const network = await performCaseAction(setup.ownerId, setup.caseId, { action: "xrpl_security_demo", scenario: "wrong_network" });
  assert.equal(network.case.escrow.audit.at(-1)?.requestedNetwork, "mainnet");
  process.env.XRPL_LANDLORD_ADDRESS = Wallet.generate().classicAddress;
  const ledger = mockLedger(t, setup.source);
  await assert.rejects(
    performCaseAction(setup.ownerId, setup.caseId, { action: "settle_xrpl" }),
    (error: unknown) => error instanceof ApiError && error.code === "XRPL_CONFIG_CHANGED",
  );
  assert.equal(ledger.submit.mock.callCount(), 0);
  const stored = await readSession(setup.ownerId);
  assert.equal(stored?.cases[0].xrplSettlement?.destination, pinnedDestination);
  assert.equal(stored?.cases[0].xrplSettlement?.status, "failed");
  const attacks = stored!.cases[0].escrow.audit.filter((entry) => entry.action === "Payment" && entry.status === "rejected");
  assert.ok(attacks.every((entry) => entry.signed === false && entry.submitted === false));
  assert.ok(attacks.some((entry) => entry.code === "DESTINATION_WALLET_MISMATCH"));
  assert.ok(attacks.some((entry) => entry.code === "AMOUNT_OUTSIDE_AUTHORIZATION"));
});

test("case ownership is session isolated", async (t) => {
  environment(t, { RENTESCROW_STORAGE: "local" });
  const first = await createSession();
  const second = await createSession();
  first.document.cases[0].id = "RE-OWNER-A";
  // Persist through the public mutation boundary by using the original session's action path.
  const foreignId = first.document.cases[0].id;
  await assert.rejects(performCaseAction(second.document.ownerId, foreignId, { action: "create_escrow" }),
    /Case not found in this demo session/);
});
