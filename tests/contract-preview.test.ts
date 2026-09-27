import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { AuthUser } from "../src/lib/types";
import {
  CONTRACT_AGENT_ID, CONTRACT_POLICY_VERSION, type ContractPolicy, type DigitalContract,
} from "../src/lib/contract-types";
import { RLUSD_CURRENCY, RLUSD_TESTNET_ISSUER } from "../src/lib/xrpl-assets";
import { hashContractPolicy, hashContractTerms } from "../src/lib/server/contract-policy";
import { buildContractPolicyPreviews, getContractPolicyPreviewForUser } from "../src/lib/server/contract-preview";
import { ApiError } from "../src/lib/server/errors";
import { createSession, mutateSession, readSession } from "../src/lib/server/store";

const contractId = "189f50a9-dcb1-451b-a33f-22f0e32d9018";
const tenantId = "preview-tenant";
const landlordId = "preview-landlord";

function agreement(): DigitalContract {
  const policy: ContractPolicy = {
    contractId, policyVersion: CONTRACT_POLICY_VERSION,
    tenantUserId: tenantId, tenantDisplayName: "Rayaan",
    landlordUserId: landlordId, landlordDisplayName: "Alex Morgan",
    property: { id: "preview-property", address: "123 Example Street", borough: "Brooklyn" },
    monthlyRentCents: 40_000, dueDay: 1, obligationPeriod: "2026-09", effectiveDate: "2026-09-01",
    gracePeriodDays: 3,
    disputedFunds: { mode: "HOLD_ALL", allowUndisputedRelease: false },
    repairRules: { repairReportedRequired: true, evidenceVerifiedRequired: true, tenantConfirmationRequired: true },
    lateFeeRule: { feeCents: 2_500, maxLateFeeCents: 2_500 },
    monetaryDefault: { afterDays: 10, remedy: "RECORD_ONLY" },
    nonMonetaryDefault: { obligation: "REPAIR_BY_DEADLINE", deadlineDays: 30, remedy: "RECORD_ONLY" },
    settlement: {
      asset: "RLUSD", network: "testnet", source: "r3sYwD7h1C91HnaCiBReLae9VrcFjexAhg",
      destination: "rKrKcMxW7ZEvidUFGJkc9YwukjYnMCqoVT", issuer: RLUSD_TESTNET_ISSUER,
      currency: RLUSD_CURRENCY, amountRlusd: "10", maxAutonomousAmountRlusd: "10",
    },
    agentId: CONTRACT_AGENT_ID,
  };
  const terms = "Prototype agreement with contract-configured demo policy.";
  const termsHash = hashContractTerms("bilateral", terms);
  const policyHash = hashContractPolicy(policy);
  return {
    id: contractId, contractId, case_type: "bilateral", terms, termsHash,
    tenantUserId: tenantId, landlordUserId: landlordId,
    tenantDisplayName: policy.tenantDisplayName, landlordDisplayName: policy.landlordDisplayName,
    propertyId: policy.property.id, effectiveDate: policy.effectiveDate,
    policyVersion: CONTRACT_POLICY_VERSION, policy, policyHash, createdAt: "2026-08-20T00:00:00.000Z",
    acceptances: [
      { role: "tenant", userId: tenantId, acceptedAt: "2026-08-21T00:00:00.000Z", termsHash, policyHash,
        method: "stored_acceptance" },
      { role: "landlord", userId: landlordId, acceptedAt: "2026-08-22T00:00:00.000Z", termsHash, policyHash,
        method: "stored_acceptance" },
    ],
    status: "active",
  };
}

function localStorage(t: TestContext) {
  const previous = process.env.RENTESCROW_STORAGE;
  process.env.RENTESCROW_STORAGE = "local";
  t.after(() => {
    if (previous === undefined) delete process.env.RENTESCROW_STORAGE;
    else process.env.RENTESCROW_STORAGE = previous;
  });
}

test("preview deterministically demonstrates signed rules without mutating the agreement", () => {
  const contract = agreement();
  const before = structuredClone(contract);
  const result = buildContractPolicyPreviews(contract);

  assert.equal(result.simulated, true);
  assert.match(result.warning, /no transaction was signed/i);
  assert.equal(result.contractId, contract.id);
  assert.equal(result.policyHash, contract.policyHash);
  assert.deepEqual(result.previews.map((item) => item.scenario), [
    "normal_due_date", "active_dispute", "resolved_dispute", "grace_period_expired",
    "monetary_default", "non_monetary_default",
  ]);
  const decisions = Object.fromEntries(result.previews.map((item) => [item.scenario, item.decision]));
  assert.equal(decisions.normal_due_date.action, "RELEASE_RENT");
  assert.equal(decisions.normal_due_date.reason, "NORMAL_RENT_RELEASE");
  assert.equal(decisions.active_dispute.allowed, false);
  assert.equal(decisions.active_dispute.reason, "ACTIVE_DISPUTE");
  assert.equal(decisions.resolved_dispute.action, "RELEASE_RENT");
  assert.equal(decisions.resolved_dispute.reason, "NORMAL_RENT_RELEASE");
  assert.equal(decisions.resolved_dispute.evaluatedRules.some((rule) => rule.code === "TENANT_FACT_CONFIRMATION" && rule.passed), true);
  assert.equal(decisions.grace_period_expired.action, "RECORD_LATE_PAYMENT");
  assert.deepEqual(decisions.grace_period_expired.effects, { lateFeeCents: 2_500 });
  assert.equal(decisions.monetary_default.action, "RECORD_MONETARY_DEFAULT");
  assert.equal(decisions.non_monetary_default.action, "RECORD_NON_MONETARY_DEFAULT");
  assert.deepEqual(contract, before);
});

test("preview rejects inactive or altered authority", () => {
  const inactive = agreement();
  inactive.status = "draft";
  inactive.acceptances = [];
  assert.throws(() => buildContractPolicyPreviews(inactive),
    (error: unknown) => error instanceof ApiError && error.code === "CONTRACT_NOT_ACTIVE");

  const altered = agreement();
  altered.policy!.settlement.amountRlusd = "500";
  assert.throws(() => buildContractPolicyPreviews(altered),
    (error: unknown) => error instanceof ApiError && error.code === "CONTRACT_HASH_MISMATCH");
});

test("authenticated tenant and assigned landlord can preview read-only; unrelated users cannot", async (t) => {
  localStorage(t);
  const { document } = await createSession();
  const contract = agreement();
  const tenant: AuthUser = { id: tenantId, role: "tenant", displayName: "Rayaan", email: "tenant@example.test",
    workspaceOwnerId: document.ownerId };
  const landlord: AuthUser = { id: landlordId, role: "landlord", displayName: "Alex Morgan",
    email: "landlord@example.test", workspaceOwnerId: "landlord-workspace" };
  await mutateSession(document.ownerId, (stored) => {
    stored.tenantUserId = tenant.id;
    stored.tenantDisplayName = tenant.displayName;
    stored.managedProperty = { id: contract.propertyId!, address: contract.policy!.property.address,
      borough: contract.policy!.property.borough, landlordUserId: landlord.id, landlordDisplayName: landlord.displayName };
    stored.contracts = [contract];
  });
  const before = await readSession(document.ownerId);
  const tenantPreview = await getContractPolicyPreviewForUser(tenant, contract.id);
  const landlordPreview = await getContractPolicyPreviewForUser(landlord, contract.id);
  assert.deepEqual(landlordPreview, tenantPreview);
  assert.deepEqual(await readSession(document.ownerId), before, "preview must not persist a revision, case or audit event");

  await assert.rejects(getContractPolicyPreviewForUser({ ...landlord, id: "unassigned-landlord" }, contract.id),
    (error: unknown) => error instanceof ApiError && error.code === "CONTRACT_NOT_FOUND");
});
