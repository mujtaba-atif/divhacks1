import "server-only";

import type { AuthUser } from "@/lib/types";
import type { ContractCaseState, ContractPolicyDecision, DigitalContract } from "@/lib/contract-types";
import { ApiError } from "./errors";
import { getContractsForUser } from "./contracts";
import { assertContractIntegrity, ContractIntegrityError, evaluateContractPolicy } from "./contract-policy";

const DAY_MS = 86_400_000;

export type ContractPreviewScenario = "normal_due_date" | "active_dispute" | "resolved_dispute"
  | "grace_period_expired" | "monetary_default" | "non_monetary_default";

export interface ContractPolicyPreview {
  scenario: ContractPreviewScenario;
  label: string;
  evaluatedAt: string;
  decision: ContractPolicyDecision;
}

export interface ContractPolicyPreviewResponse {
  simulated: true;
  warning: string;
  contractId: string;
  policyVersion: string;
  policyHash: string;
  previews: ContractPolicyPreview[];
}

function dueTime(contract: DigitalContract & { policy: NonNullable<DigitalContract["policy"]> }): number {
  const [year, month] = contract.policy.obligationPeriod.split("-").map(Number);
  return Date.UTC(year, month - 1, contract.policy.dueDay);
}

function boundCase(contract: DigitalContract & { policy: NonNullable<DigitalContract["policy"]> }): ContractCaseState {
  const policy = contract.policy;
  return {
    id: contract.caseId ?? `PREVIEW-${contract.id}`,
    contractId: contract.id,
    tenantUserId: policy.tenantUserId,
    landlordUserId: policy.landlordUserId,
    propertyId: policy.property.id,
    monthlyRentCents: policy.monthlyRentCents,
    disputedAmountCents: policy.monthlyRentCents,
    contractDispute: "none",
    escrow: { status: "locked", amountCents: policy.monthlyRentCents },
  };
}

function preview(contract: DigitalContract & { policy: NonNullable<DigitalContract["policy"]>; policyHash: string },
  scenario: ContractPreviewScenario, label: string, state: ContractCaseState, at: number): ContractPolicyPreview {
  const evaluatedAt = new Date(at).toISOString();
  return { scenario, label, evaluatedAt,
    decision: evaluateContractPolicy(contract, state, { fundsAvailable: state.escrow.status === "locked" }, new Date(evaluatedAt)) };
}

/** Builds deterministic, synthetic decisions only. It performs no I/O and cannot execute an action. */
export function buildContractPolicyPreviews(contract: DigitalContract): ContractPolicyPreviewResponse {
  try { assertContractIntegrity(contract); }
  catch (error) {
    if (error instanceof ContractIntegrityError) throw new ApiError(409, error.message, false, error.code);
    throw error;
  }
  if (contract.status !== "active") {
    throw new ApiError(409, "Both assigned parties must sign before previewing active authority.", false, "CONTRACT_NOT_ACTIVE");
  }
  const policy = contract.policy;
  const due = dueTime(contract);
  const effective = Date.parse(`${policy.effectiveDate}T00:00:00.000Z`);
  const representativeDue = Math.max(due, effective) + 1_000;
  const base = boundCase(contract);
  const repairAt = representativeDue - 7_200_000;
  const evidenceAt = representativeDue - 3_600_000;
  const analysisAt = representativeDue - 1_800_000;
  const resolved: ContractCaseState = {
    ...base,
    contractDispute: "resolved",
    repairReported: true,
    repairs: [{ kind: "reported_complete", createdAt: new Date(repairAt).toISOString(), landlordUserId: policy.landlordUserId }],
    evidence: [{ stage: "after", createdAt: new Date(evidenceAt).toISOString(), uploadedByRole: "tenant",
      analysis: { verified: true, analyzedAt: new Date(analysisAt).toISOString() } }],
    verification: { verified: true },
    tenantConfirmed: true,
  };
  const unfunded: ContractCaseState = { ...base, escrow: { status: "unfunded", amountCents: policy.monthlyRentCents } };
  return {
    simulated: true,
    warning: "Simulated policy preview only. No case was changed, no transaction was signed, and nothing was submitted.",
    contractId: contract.id,
    policyVersion: contract.policyVersion,
    policyHash: contract.policyHash,
    previews: [
      preview(contract, "normal_due_date", "Normal due-date rule", base, representativeDue),
      preview(contract, "active_dispute", "Active dispute holds the signed amount",
        { ...base, contractDispute: "open" }, representativeDue),
      preview(contract, "resolved_dispute", "Contract repair facts satisfy dispute resolution", resolved, representativeDue),
      preview(contract, "grace_period_expired", "Grace period expires without available funds", unfunded,
        Math.max(effective, due + (policy.gracePeriodDays + 1) * DAY_MS)),
      preview(contract, "monetary_default", "Contract-configured monetary default threshold", unfunded,
        Math.max(effective, due + (policy.monetaryDefault.afterDays + 1) * DAY_MS)),
      preview(contract, "non_monetary_default", "Contract-configured repair deadline expires",
        { ...base, contractDispute: "open" },
        Math.max(effective, due + (policy.nonMonetaryDefault.deadlineDays + 1) * DAY_MS)),
    ],
  };
}

/** Authenticated read boundary. Visibility is inherited from the existing contract service. */
export async function getContractPolicyPreviewForUser(user: AuthUser, contractId: string): Promise<ContractPolicyPreviewResponse> {
  const contract = (await getContractsForUser(user)).find((item) => item.id === contractId);
  if (!contract) throw new ApiError(404, "Contract not found.", false, "CONTRACT_NOT_FOUND");
  return buildContractPolicyPreviews(contract);
}
