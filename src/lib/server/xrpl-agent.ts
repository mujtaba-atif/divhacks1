import "server-only";

import type { CaseRecord } from "@/lib/types";

/**
 * The settlement agent can request one already-authorized case action. Payment
 * details are deliberately absent: the settlement boundary rebuilds them from
 * trusted case state and performs the authoritative policy checks.
 */
export interface XrplAgentSettlementRequest {
  readonly caseId: string;
  readonly requestedAction: "REQUEST_SETTLEMENT";
}

export function proposeXrplAgentSettlement(
  record: Readonly<CaseRecord>,
): XrplAgentSettlementRequest | null {
  const settlement = record.xrplSettlement;
  const authorizedAt = settlement?.agentAuthorizedAt;
  const tenantEvidenceReady = record.evidence.some((evidence) =>
    evidence.stage === "after" && evidence.uploadedByRole !== "landlord" && evidence.analysis?.verified === true);

  if (!settlement
    || settlement.status !== "ready"
    || settlement.hash
    || settlement.agentRequestedAt
    || !authorizedAt
    || !Number.isFinite(Date.parse(authorizedAt))
    || record.escrow.status !== "locked"
    || !record.repairReported
    || !record.verification?.verified
    || !record.tenantConfirmed
    || !tenantEvidenceReady) {
    return null;
  }

  return Object.freeze({ caseId: record.id, requestedAction: "REQUEST_SETTLEMENT" });
}

/** Contract authority replaces individual payment approval for the runtime agent. */
export function proposeContractAgentSettlement(record: Readonly<CaseRecord>) {
  const permission = record.xrplSettlement;
  const decision = record.contractEvaluation;
  if (!record.contractId || record.contractSnapshot?.status !== "active"
    || record.contractSnapshot.id !== record.contractId || decision?.allowed !== true
    || decision.action !== "RELEASE_RENT" || decision.contractId !== record.contractId
    || decision.policyHash !== record.contractSnapshot.policyHash
    || !permission || permission.contractId !== record.contractId
    || permission.policyHash !== decision.policyHash || permission.status !== "ready"
    || permission.hash || permission.agentRequestedAt) return null;
  return Object.freeze({ contractId: record.contractId, caseId: record.id, requestedAction: "RELEASE_RENT" as const });
}
