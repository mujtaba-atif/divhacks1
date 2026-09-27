import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTRACT_AGENT_ID, CONTRACT_POLICY_VERSION,
  type ContractCaseState, type ContractPolicy, type DigitalContract,
} from "../src/lib/contract-types";
import { RLUSD_CURRENCY, RLUSD_TESTNET_ISSUER } from "../src/lib/xrpl-assets";
import {
  assertContractIntegrity, evaluateContractFeeRequest, evaluateContractPolicy, hashContractPolicy, hashContractTerms,
} from "../src/lib/server/contract-policy";

const tenantId = "tenant-user";
const landlordId = "landlord-user";
const contractId = "89b2d4fb-952e-4c56-a882-039951e2eed2";
const source = "r3sYwD7h1C91HnaCiBReLae9VrcFjexAhg";
const destination = "rKrKcMxW7ZEvidUFGJkc9YwukjYnMCqoVT";

function signedContract(): DigitalContract {
  const policy: ContractPolicy = {
    contractId, policyVersion: CONTRACT_POLICY_VERSION,
    tenantUserId: tenantId, tenantDisplayName: "Rayaan",
    landlordUserId: landlordId, landlordDisplayName: "Alex Morgan",
    property: { id: "property-one", address: "123 Example Street", borough: "Brooklyn" },
    monthlyRentCents: 40_000, dueDay: 1, obligationPeriod: "2026-09", effectiveDate: "2026-09-01",
    gracePeriodDays: 3, disputedFunds: { mode: "HOLD_ALL", allowUndisputedRelease: false },
    repairRules: { repairReportedRequired: true, evidenceVerifiedRequired: true, tenantConfirmationRequired: true },
    lateFeeRule: { feeCents: 2_500, maxLateFeeCents: 2_500 },
    monetaryDefault: { afterDays: 10, remedy: "RECORD_ONLY" },
    nonMonetaryDefault: { obligation: "REPAIR_BY_DEADLINE", deadlineDays: 30, remedy: "RECORD_ONLY" },
    settlement: { asset: "RLUSD", network: "testnet", source, destination, issuer: RLUSD_TESTNET_ISSUER,
      currency: RLUSD_CURRENCY, amountRlusd: "10", maxAutonomousAmountRlusd: "10" },
    agentId: CONTRACT_AGENT_ID,
  };
  const terms = "Prototype agreement with contract-configured demo rules.";
  const termsHash = hashContractTerms("bilateral", terms);
  const policyHash = hashContractPolicy(policy);
  return {
    id: contractId, contractId, case_type: "bilateral", terms, termsHash,
    tenantUserId: tenantId, landlordUserId: landlordId, tenantDisplayName: "Rayaan", landlordDisplayName: "Alex Morgan",
    propertyId: policy.property.id, effectiveDate: policy.effectiveDate,
    policyVersion: CONTRACT_POLICY_VERSION, policy, policyHash, createdAt: "2026-08-20T00:00:00.000Z",
    acceptances: [
      { role: "tenant", userId: tenantId, acceptedAt: "2026-08-21T00:00:00.000Z", termsHash, policyHash, method: "stored_acceptance" },
      { role: "landlord", userId: landlordId, acceptedAt: "2026-08-22T00:00:00.000Z", termsHash, policyHash, method: "stored_acceptance" },
    ], status: "active", caseId: "RE-CONTRACT",
  };
}

function caseState(overrides: Partial<ContractCaseState> = {}): ContractCaseState {
  return {
    id: "RE-CONTRACT", contractId, tenantUserId: tenantId, landlordUserId: landlordId, propertyId: "property-one",
    contractDispute: "none", monthlyRentCents: 40_000, disputedAmountCents: 40_000,
    escrow: { status: "locked", amountCents: 40_000 }, ...overrides,
  };
}

test("a fully signed canonical agreement authorizes its pinned normal rent release", () => {
  const contract = signedContract();
  assert.doesNotThrow(() => assertContractIntegrity(contract));
  const result = evaluateContractPolicy(contract, caseState(), { fundsAvailable: true }, new Date("2026-09-02T00:00:00.000Z"));
  assert.equal(result.allowed, true);
  assert.equal(result.action, "RELEASE_RENT");
  assert.equal(result.reason, "NORMAL_RENT_RELEASE");
  assert.equal(result.amount, "10");
  assert.equal(result.asset, "RLUSD");
});

test("unsigned, altered, misbound and replayed agreements fail deterministically", () => {
  const unsigned = signedContract();
  unsigned.status = "draft";
  unsigned.acceptances = [];
  assert.equal(evaluateContractPolicy(unsigned, caseState(), { fundsAvailable: true }, new Date("2026-09-02")).reason,
    "CONTRACT_NOT_ACTIVE");

  const altered = signedContract();
  altered.policy!.settlement.destination = source;
  assert.equal(evaluateContractPolicy(altered, caseState(), { fundsAvailable: true }, new Date("2026-09-02")).reason,
    "CONTRACT_HASH_MISMATCH");

  assert.equal(evaluateContractPolicy(signedContract(), caseState({ landlordUserId: "attacker" }),
    { fundsAvailable: true }, new Date("2026-09-02")).reason, "CASE_CONTRACT_MISMATCH");
  assert.equal(evaluateContractPolicy(signedContract(), caseState({ contractDispute: undefined }),
    { fundsAvailable: true }, new Date("2026-09-02")).reason, "CASE_CONTRACT_MISMATCH");
  assert.equal(evaluateContractPolicy(signedContract(), caseState({ disputedAmountCents: 50_000 }),
    { fundsAvailable: true }, new Date("2026-09-02")).reason, "CASE_CONTRACT_MISMATCH");
  assert.equal(evaluateContractPolicy(signedContract(), caseState({ escrow: { status: "released", amountCents: 40_000 } }),
    { fundsAvailable: true }, new Date("2026-09-02")).reason, "ALREADY_SETTLED");
});

test("an active dispute holds funds until fresh landlord completion and tenant-verified evidence facts pass", () => {
  const contract = signedContract();
  const open = caseState({ contractDispute: "open", repairReported: true, tenantConfirmed: true,
    verification: { verified: true }, repairs: [{ kind: "reported_complete", landlordUserId: landlordId,
      createdAt: "2026-09-10T12:00:00.000Z" }],
    evidence: [{ stage: "after", uploadedByRole: "tenant", createdAt: "2026-09-09T12:00:00.000Z",
      analysis: { verified: true, analyzedAt: "2026-09-09T12:01:00.000Z" } }] });
  const blocked = evaluateContractPolicy(contract, open, { fundsAvailable: true }, new Date("2026-09-11T00:00:00.000Z"));
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "ACTIVE_DISPUTE");

  open.evidence![0].createdAt = "2026-09-10T13:00:00.000Z";
  open.evidence![0].analysis!.analyzedAt = "2026-09-10T13:01:00.000Z";
  const resolvedFacts = evaluateContractPolicy(contract, open, { fundsAvailable: true }, new Date("2026-09-11T00:00:00.000Z"));
  assert.equal(resolvedFacts.allowed, true);
  assert.equal(resolvedFacts.action, "RELEASE_RENT");
  assert.equal(resolvedFacts.reason, "DISPUTE_CONDITIONS_SATISFIED");
});

test("late and default effects are limited to signed record-only demo remedies", () => {
  const contract = signedContract();
  const late = evaluateContractPolicy(contract, caseState({ escrow: { status: "unfunded", amountCents: 40_000 } }),
    { fundsAvailable: false }, new Date("2026-09-06T00:00:00.000Z"));
  assert.equal(late.action, "RECORD_LATE_PAYMENT");
  assert.deepEqual(late.effects, { lateFeeCents: 2_500 });

  const monetaryDefault = evaluateContractPolicy(contract, caseState({ escrow: { status: "unfunded", amountCents: 40_000 } }),
    { fundsAvailable: false }, new Date("2026-09-12T00:00:00.000Z"));
  assert.equal(monetaryDefault.action, "RECORD_MONETARY_DEFAULT");
  assert.deepEqual(monetaryDefault.effects, { lateFeeCents: 2_500, monetaryDefault: true });

  const changedFee = signedContract();
  changedFee.policy!.lateFeeRule.feeCents = 50_000;
  assert.equal(evaluateContractPolicy(changedFee, caseState({ escrow: { status: "unfunded", amountCents: 40_000 } }),
    { fundsAvailable: false }, new Date("2026-09-12")).allowed, false);
  assert.deepEqual(evaluateContractFeeRequest(contract, 50_000), {
    allowed: false, reason: "FEE_EXCEEDS_CONTRACT_POLICY", configuredFeeCents: 2_500, maximumFeeCents: 2_500,
  });
  assert.equal(evaluateContractFeeRequest(contract, 2_500).allowed, true);
});

test("an unresolved repair after its signed deadline records only non-monetary default", () => {
  const contract = signedContract();
  const result = evaluateContractPolicy(contract, caseState({ contractDispute: "open", repairReported: false }),
    { fundsAvailable: true }, new Date("2026-10-05T00:00:00.000Z"));
  assert.equal(result.action, "RECORD_NON_MONETARY_DEFAULT");
  assert.deepEqual(result.effects, { nonMonetaryDefault: true });
});
