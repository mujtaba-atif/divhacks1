import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { Wallet } from "xrpl";
import { runXrplSecurityDemo, type XrplPending, type XrplReceipt } from "../src/lib/integrations/xrpl-settlement";
import { evaluateXrplPolicy, makeXrplIntent } from "../src/lib/policy";
import { createDemoCase } from "../src/lib/seed";
import type { PolicyResult, XrplSettlement } from "../src/lib/types";
import { ApiError } from "../src/lib/server/errors";
import { RLUSD_CURRENCY, RLUSD_TESTNET_ISSUER, SETTLEMENT_AGENT_ID,
  SETTLEMENT_POLICY_VERSION } from "../src/lib/xrpl-assets";

const originalDirectory = process.cwd();
let temporaryDirectory: string;
let journalDirectory: string;
let journal: typeof import("../src/lib/server/xrpl-journal");

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "rentescrow-rlusd-journal-"));
  process.chdir(temporaryDirectory);
  journalDirectory = path.join(temporaryDirectory, ".data", "xrpl-journal");
  journal = await import("../src/lib/server/xrpl-journal");
});
beforeEach(async () => { await rm(journalDirectory, { recursive: true, force: true }); });
after(async () => {
  process.chdir(originalDirectory);
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function policy(): PolicyResult {
  return { approved: true, checks: [{ key: "RLUSD_FINAL_TRANSACTION", label: "Final transaction verified",
    passed: true, detail: "The trusted RLUSD Payment was revalidated before signing." }] };
}

function authorization() {
  const source = Wallet.generate().classicAddress;
  const destination = Wallet.generate().classicAddress;
  const settlement: XrplSettlement = {
    id: crypto.randomUUID(), ownerId: "tenant", caseId: "case", escrowId: "escrow",
    agentId: SETTLEMENT_AGENT_ID, policyVersion: SETTLEMENT_POLICY_VERSION,
    requestedAction: "REQUEST_SETTLEMENT", asset: "RLUSD", amount: "10",
    issuer: RLUSD_TESTNET_ISSUER, currency: RLUSD_CURRENCY,
    network: "testnet", transactionType: "Payment", source, destination,
    amountDrops: "0", amountUsdCents: 40000, status: "ready", createdAt: new Date().toISOString(),
  };
  const decision = policy();
  const pending: XrplPending = {
    hash: createHash("sha256").update(settlement.id).digest("hex").toUpperCase(),
    sequence: 123, preparedLedgerIndex: 1000, lastLedgerSequence: 1020,
    intent: {
      caseId: settlement.caseId, ownerId: settlement.ownerId, escrowId: settlement.escrowId,
      settlementId: settlement.id, requestedAction: "REQUEST_SETTLEMENT", transactionType: "Payment",
      network: "testnet", source, destination, amountDrops: "0", amountUsdCents: 40000,
      agentId: SETTLEMENT_AGENT_ID, policyVersion: SETTLEMENT_POLICY_VERSION,
      asset: "RLUSD", amount: "10", issuer: RLUSD_TESTNET_ISSUER, currency: RLUSD_CURRENCY,
    },
    policyDecision: decision, policyCheckedAt: new Date().toISOString(), actor: "settlement_agent",
  };
  const validatedAt = new Date().toISOString();
  const receipt: XrplReceipt = {
    hash: pending.hash, ledgerIndex: 1001, result: "tesSUCCESS", validated: true,
    amountDrops: "0", destination, source, caseId: settlement.caseId, settlementId: settlement.id,
    validatedAt, agentId: SETTLEMENT_AGENT_ID, policyVersion: SETTLEMENT_POLICY_VERSION,
    requestedAction: "REQUEST_SETTLEMENT", asset: "RLUSD", amount: "10",
    issuer: RLUSD_TESTNET_ISSUER, currency: RLUSD_CURRENCY, transactionHash: pending.hash,
    validatedResult: "tesSUCCESS", timestamp: validatedAt, policyDecision: decision,
  };
  return { settlement, pending, receipt };
}

function journalFile(settlement: XrplSettlement) {
  const filename = createHash("sha256").update(settlement.ownerId).update("\0").update(settlement.caseId)
    .update("\0").update(settlement.escrowId).update("\0").update(settlement.id).digest("hex");
  return path.join(journalDirectory, `${filename}.json`);
}

function policyRecord() {
  const record = createDemoCase("tenant");
  record.escrow.status = "locked";
  record.status = "verified";
  record.repairReported = true;
  record.tenantConfirmed = true;
  record.verification = { summary: "verified", severity: "low", verified: true, reasons: [], source: "demo" };
  record.evidence.push({ id: "after", name: "After", mimeType: "image/png", stage: "after", note: "After",
    createdAt: new Date().toISOString(), isDemo: true, analysis: record.verification });
  record.escrow.destination = Wallet.generate().classicAddress;
  const { settlement } = authorization();
  settlement.ownerId = record.ownerId;
  settlement.caseId = record.id;
  settlement.escrowId = record.escrow.id;
  settlement.destination = record.escrow.destination;
  settlement.tenantUserId = record.ownerId;
  settlement.landlordUserId = record.escrow.destination;
  settlement.landlordWallet = record.escrow.destination;
  record.xrplSettlement = settlement;
  return record;
}

test("RLUSD policy pins agent, policy, asset, amount, issuer and currency", () => {
  const record = policyRecord();
  const intent = makeXrplIntent(record);
  assert.equal(evaluateXrplPolicy(record, intent, record.ownerId).approved, true);

  const attempts = [
    [{ issuer: Wallet.generate().classicAddress }, "ASSET_DEFINITION_MISMATCH"],
    [{ currency: "USD" }, "ASSET_DEFINITION_MISMATCH"],
    [{ asset: "XRP" }, "ASSET_NOT_APPROVED"],
    [{ amount: "11" }, "ASSET_DEFINITION_MISMATCH"],
    [{ agentId: "untrusted-agent" }, "AGENT_IDENTITY_MISMATCH"],
    [{ policyVersion: "CASE_SETTLEMENT_V2" }, "POLICY_VERSION_MISMATCH"],
  ] as const;
  for (const [change, code] of attempts) {
    const result = evaluateXrplPolicy(record, { ...intent, ...change }, record.ownerId);
    assert.equal(result.approved, false);
    assert.ok(result.checks.some((check) => check.key === code && !check.passed), code);
  }
});

test("RLUSD issuer, asset, amount and balance attack demos all fail before signing", () => {
  const record = policyRecord();
  const expected = {
    issuer_tamper: "ASSET_DEFINITION_MISMATCH",
    wrong_asset: "ASSET_NOT_APPROVED",
    amount_tamper: "AMOUNT_OUTSIDE_AUTHORIZATION",
    insufficient_funds: "INSUFFICIENT_RLUSD_FUNDS",
  } as const;
  for (const [scenario, code] of Object.entries(expected) as [keyof typeof expected, string][]) {
    const result = runXrplSecurityDemo(record, record.ownerId, scenario);
    assert.equal(result.policy.approved, false);
    assert.ok(result.policy.checks.some((check) => check.key === code && !check.passed), `${scenario}: ${code}`);
    assert.match(result.detail, /Nothing signed\. Nothing submitted\./);
  }
});

test("RLUSD journal persists traceability and rejects altered delivery metadata", async () => {
  const { settlement, pending, receipt } = authorization();
  await journal.recordXrplPending(settlement, pending);
  await journal.recordXrplValidated(settlement, pending, receipt);
  const stored = await journal.readXrplJournal(settlement);
  assert.equal(stored?.receipt?.agentId, SETTLEMENT_AGENT_ID);
  assert.equal(stored?.receipt?.policyVersion, SETTLEMENT_POLICY_VERSION);
  assert.equal(stored?.receipt?.asset, "RLUSD");
  assert.equal(stored?.receipt?.policyDecision?.approved, true);

  await mkdir(journalDirectory, { recursive: true });
  await writeFile(journalFile(settlement), JSON.stringify({ ...stored,
    receipt: { ...stored!.receipt, issuer: Wallet.generate().classicAddress } }));
  await assert.rejects(journal.readXrplJournal(settlement),
    (error: unknown) => error instanceof ApiError && error.code === "XRPL_JOURNAL_INVALID");

  await writeFile(journalFile(settlement), JSON.stringify({ ...stored,
    pending: { ...stored!.pending, intent: { ...stored!.pending.intent, amount: "11" } },
    receipt: { ...stored!.receipt, amount: "11" } }));
  await assert.rejects(journal.readXrplJournal(settlement),
    (error: unknown) => error instanceof ApiError && error.code === "XRPL_JOURNAL_MISMATCH");
});

test("contract-governed journal binds policy hash, trigger, version and release action", async () => {
  const { settlement, pending, receipt } = authorization();
  const contract = {
    contractId: crypto.randomUUID(), contractPolicyVersion: "CONTRACT_POLICY_V1",
    policyHash: createHash("sha256").update("signed contract policy").digest("hex"),
    triggeringEvent: "TENANT_CONFIRMED_REPAIR",
  };
  Object.assign(settlement, contract, { requestedAction: "RELEASE_RENT" as const });
  Object.assign(pending.intent, contract, { requestedAction: "RELEASE_RENT" });
  Object.assign(receipt, contract, { requestedAction: "RELEASE_RENT" });
  await journal.recordXrplPending(settlement, pending);
  await journal.recordXrplValidated(settlement, pending, receipt);
  const stored = await journal.readXrplJournal(settlement);
  assert.equal(stored?.receipt?.contractId, contract.contractId);
  assert.equal(stored?.receipt?.policyHash, contract.policyHash);
  assert.equal(stored?.receipt?.triggeringEvent, contract.triggeringEvent);

  await mkdir(journalDirectory, { recursive: true });
  await writeFile(journalFile(settlement), JSON.stringify({ ...stored,
    receipt: { ...stored!.receipt, policyHash: "0".repeat(64) } }));
  await assert.rejects(journal.readXrplJournal(settlement),
    (error: unknown) => error instanceof ApiError && error.code === "XRPL_JOURNAL_INVALID");
});
