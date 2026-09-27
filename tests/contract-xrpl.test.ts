import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Client, Wallet, decode, hashes, type Payment } from "xrpl";
import type { ContractPolicy, DigitalContract } from "../src/lib/contract-types";
import { CONTRACT_AGENT_ID, CONTRACT_POLICY_VERSION } from "../src/lib/contract-types";
import { hashContractPolicy, hashContractTerms, evaluateContractPolicy } from "../src/lib/server/contract-policy";
import { buildXrplPayment, createXrplSettlement, executeXrplSettlement, XrplError } from "../src/lib/integrations/xrpl-settlement";
import { makeXrplIntent } from "../src/lib/policy";
import { createDemoCase } from "../src/lib/seed";
import type { CaseRecord } from "../src/lib/types";
import { RLUSD_CURRENCY, RLUSD_TESTNET_ISSUER } from "../src/lib/xrpl-assets";

function fixture(t: TestContext) {
  const source = Wallet.generate();
  const destination = Wallet.generate().classicAddress;
  const environment = {
    XRPL_SETTLEMENT_ENABLED: "true", XRPL_SETTLEMENT_ASSET: "RLUSD", XRPL_NETWORK: "testnet",
    XRPL_RPC_URL: "wss://s.altnet.rippletest.net:51233", XRPL_TENANT_SEED: source.seed!,
    XRPL_TENANT_ADDRESS: source.classicAddress, XRPL_RLUSD_LANDLORD_ADDRESS: destination,
    XRPL_LANDLORD_ADDRESS: destination, XRPL_RLUSD_ISSUER: RLUSD_TESTNET_ISSUER,
    XRPL_RLUSD_CURRENCY: "RLUSD", XRPL_SETTLEMENT_AMOUNT_RLUSD: "12.5",
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });

  const record = createDemoCase("workspace-owner");
  record.tenantUserId = "tenant-user";
  record.landlordUserId = "landlord-user";
  record.propertyId = "property-1";
  record.monthlyRentCents = record.disputedAmountCents;
  record.escrow.status = "locked";
  record.escrow.destination = destination;
  record.contractDispute = "none";
  record.contractTrigger = "DUE_DATE_REACHED";
  const policy: ContractPolicy = {
    contractId: crypto.randomUUID(), policyVersion: CONTRACT_POLICY_VERSION,
    tenantUserId: record.tenantUserId, tenantDisplayName: "Rayaan",
    landlordUserId: record.landlordUserId, landlordDisplayName: "Alex Morgan",
    property: { id: record.propertyId, address: "123 Example Street", borough: "Brooklyn" },
    monthlyRentCents: record.monthlyRentCents, dueDay: 1, obligationPeriod: "2025-01",
    effectiveDate: "2025-01-01", gracePeriodDays: 5,
    disputedFunds: { mode: "HOLD_ALL", allowUndisputedRelease: false },
    repairRules: { repairReportedRequired: true, evidenceVerifiedRequired: true, tenantConfirmationRequired: true },
    lateFeeRule: { feeCents: 2500, maxLateFeeCents: 2500 },
    monetaryDefault: { afterDays: 15, remedy: "RECORD_ONLY" },
    nonMonetaryDefault: { obligation: "REPAIR_BY_DEADLINE", deadlineDays: 10, remedy: "RECORD_ONLY" },
    settlement: { asset: "RLUSD", network: "testnet", source: source.classicAddress, destination,
      issuer: RLUSD_TESTNET_ISSUER, currency: RLUSD_CURRENCY, amountRlusd: "7", maxAutonomousAmountRlusd: "25" },
    agentId: CONTRACT_AGENT_ID,
  };
  const terms = "Prototype RentEscrow Agreement with contract-configured demo policy.";
  const policyHash = hashContractPolicy(policy);
  const termsHash = hashContractTerms("bilateral", terms);
  const contract: DigitalContract = {
    id: policy.contractId, contractId: policy.contractId, case_type: "bilateral", terms, termsHash,
    tenantUserId: policy.tenantUserId, landlordUserId: policy.landlordUserId,
    tenantDisplayName: policy.tenantDisplayName, landlordDisplayName: policy.landlordDisplayName,
    propertyId: policy.property.id, effectiveDate: policy.effectiveDate,
    policyVersion: CONTRACT_POLICY_VERSION, policy, policyHash, createdAt: new Date().toISOString(),
    acceptances: ["tenant", "landlord"].map((role) => ({
      role: role as "tenant" | "landlord", userId: role === "tenant" ? policy.tenantUserId : policy.landlordUserId,
      acceptedAt: new Date().toISOString(), termsHash, policyHash, method: "stored_acceptance" as const,
    })),
    status: "active", caseId: record.id,
  };
  record.contractId = contract.id;
  record.contractSnapshot = contract;
  record.contractEvaluation = evaluateContractPolicy(contract, record, { fundsAvailable: true }, new Date("2026-01-01T00:00:00Z"));
  return { source, destination, record, contract };
}

function ledger(t: TestContext, source: string, destination: string) {
  const state = { signs: 0, submits: 0 };
  t.mock.method(Client.prototype, "connect", async () => undefined);
  t.mock.method(Client.prototype, "disconnect", async () => undefined);
  t.mock.method(Client.prototype, "isConnected", () => true);
  t.mock.method(Client.prototype, "getLedgerIndex", async () => 1000);
  t.mock.method(Client.prototype, "request", async (request: Parameters<Client["request"]>[0]) => {
    if (request.command === "server_info") return { result: { info: { network_id: 1,
      validated_ledger: { reserve_base_xrp: 1, reserve_inc_xrp: 0.2 } } } } as never;
    if (request.command === "account_lines") return { result: { validated: true, account: request.account,
      ledger_index: 1000, lines: [{ account: RLUSD_TESTNET_ISSUER, currency: RLUSD_CURRENCY,
        balance: request.account === source ? "100" : "0", limit: "1000", quality_in: 0, quality_out: 0 }] } } as never;
    if (request.command === "account_info") {
      const account = request.account;
      return { result: { validated: true, ledger_index: 1000, account_data: {
        Account: account, Balance: "50000000", OwnerCount: account === source ? 2 : 1,
        Sequence: account === source ? 123 : 1, Flags: 0,
      } } } as never;
    }
    throw new Error(`Unexpected ${request.command}`);
  });
  t.mock.method(Client.prototype, "autofill", async (transaction: Parameters<Client["autofill"]>[0]) => ({
    ...transaction, Fee: "12", Sequence: 123, LastLedgerSequence: 1020,
  }) as never);
  const sign = Wallet.prototype.sign;
  t.mock.method(Wallet.prototype, "sign", function (this: Wallet, ...args: Parameters<Wallet["sign"]>) {
    state.signs++;
    return sign.apply(this, args);
  });
  t.mock.method(Client.prototype, "submitAndWait", async (blob: Parameters<Client["submitAndWait"]>[0]) => {
    state.submits++;
    const transaction = decode(String(blob)) as unknown as Payment;
    return { result: { validated: true, hash: hashes.hashSignedTx(String(blob)), ledger_index: 1001,
      tx_json: { ...transaction, Amount: undefined, DeliverMax: transaction.Amount },
      meta: { TransactionResult: "tesSUCCESS", delivered_amount: {
        currency: RLUSD_CURRENCY, issuer: RLUSD_TESTNET_ISSUER, value: "7",
      }, TransactionIndex: 0, AffectedNodes: [] } } } as never;
  });
  return state;
}

test("signed agreement supplies the exact RLUSD permission and policy hash memo", (t) => {
  const { record, contract, destination } = fixture(t);
  record.xrplSettlement = createXrplSettlement(record);
  const intent = makeXrplIntent(record);
  const payment = buildXrplPayment(intent);
  assert.equal(record.xrplSettlement.amount, "7", "signed amount overrides the environment's demo default");
  assert.equal(intent.requestedAction, "RELEASE_RENT");
  assert.equal(intent.contractId, contract.id);
  assert.equal(intent.policyHash, contract.policyHash);
  assert.equal(payment.Destination, destination);
  assert.deepEqual(payment.Amount, { currency: RLUSD_CURRENCY, issuer: RLUSD_TESTNET_ISSUER, value: "7" });
  assert.equal(payment.Memos?.length, 2);
  assert.equal(payment.Memos?.[1].Memo.MemoData, contract.policyHash!.toUpperCase());
});

test("missing signatures and changed active terms are blocked before any signing boundary", (t) => {
  const { record } = fixture(t);
  let signs = 0;
  t.mock.method(Wallet.prototype, "sign", function () { signs++; throw new Error("must not sign"); });
  const agreement = record.contractSnapshot!;
  record.contractSnapshot = undefined;
  assert.throws(() => createXrplSettlement(record), (error: XrplError) => error.reason === "CONTRACT_REQUIRED");
  record.contractSnapshot = agreement;
  record.contractSnapshot!.acceptances = record.contractSnapshot!.acceptances.filter((item) => item.role !== "landlord");
  assert.throws(() => createXrplSettlement(record), (error: XrplError) => error.reason === "CONTRACT_SIGNATURES_INVALID");
  record.contractSnapshot!.acceptances.push({ role: "landlord", userId: record.landlordUserId!,
    acceptedAt: new Date().toISOString(), termsHash: record.contractSnapshot!.termsHash,
    policyHash: record.contractSnapshot!.policyHash, method: "stored_acceptance" });
  record.contractSnapshot!.policy!.settlement.destination = Wallet.generate().classicAddress;
  assert.throws(() => createXrplSettlement(record), (error: XrplError) => error.reason === "CONTRACT_HASH_MISMATCH");
  assert.equal(signs, 0);
});

test("runtime re-evaluates fresh contract authority before signing and returns contract-bound receipt metadata", async (t) => {
  const { source, destination, record, contract } = fixture(t);
  record.xrplSettlement = createXrplSettlement(record);
  assert.equal(evaluateContractPolicy(contract, record, { fundsAvailable: true }, new Date()).reason, "NORMAL_RENT_RELEASE");
  const state = ledger(t, source.classicAddress, destination);
  const receipt = await executeXrplSettlement({ ownerId: record.ownerId, actor: "settlement_agent",
    loadCase: async () => structuredClone(record), beforeSubmit: async () => undefined });
  assert.equal(state.signs, 1);
  assert.equal(state.submits, 1);
  assert.equal(receipt.contractId, contract.id);
  assert.equal(receipt.contractPolicyVersion, CONTRACT_POLICY_VERSION);
  assert.equal(receipt.policyHash, contract.policyHash);
  assert.equal(receipt.triggeringEvent, "DUE_DATE_REACHED");

  state.signs = 0;
  state.submits = 0;
  let loads = 0;
  await assert.rejects(executeXrplSettlement({ ownerId: record.ownerId, actor: "settlement_agent",
    loadCase: async () => {
      const fresh: CaseRecord = structuredClone(record);
      if (++loads === 2) fresh.contractSnapshot!.policyHash = "0".repeat(64);
      return fresh;
    }, beforeSubmit: async () => assert.fail("must not persist") }),
  (error: XrplError) => error.reason === "CONTRACT_HASH_MISMATCH");
  assert.equal(state.signs, 0);
  assert.equal(state.submits, 0);
});
