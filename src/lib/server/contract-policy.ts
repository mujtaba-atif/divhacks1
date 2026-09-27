import "server-only";

import { createHash } from "node:crypto";
import { isValidClassicAddress } from "xrpl";
import { RLUSD_CURRENCY, RLUSD_TESTNET_ISSUER, compareDecimal, MAX_RLUSD_AMOUNT } from "@/lib/xrpl-assets";
import {
  CONTRACT_AGENT_ID,
  CONTRACT_POLICY_VERSION,
  type ContractCaseState,
  type ContractFeeDecision,
  type ContractFinancialState,
  type ContractPolicy,
  type ContractPolicyCheck,
  type ContractPolicyDecision,
  type DigitalContract,
} from "@/lib/contract-types";

export class ContractIntegrityError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ContractIntegrityError";
  }
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ContractIntegrityError("INVALID_CONTRACT_POLICY", "Contract policy contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(",")}}`;
  }
  throw new ContractIntegrityError("INVALID_CONTRACT_POLICY", "Contract policy contains an unsupported value.");
}

export function canonicalContractPolicy(policy: ContractPolicy): string {
  return canonicalValue(policy);
}

export function hashContractPolicy(policy: ContractPolicy): string {
  return createHash("sha256").update(canonicalContractPolicy(policy)).digest("hex");
}

export function hashContractTerms(caseType: DigitalContract["case_type"], terms: string): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, case_type: caseType, terms })).digest("hex");
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Throws before any signer is reached when persisted signed authority is malformed or changed. */
export function assertContractIntegrity(contract: DigitalContract): asserts contract is DigitalContract & {
  contractId: string;
  policyVersion: typeof CONTRACT_POLICY_VERSION;
  policy: ContractPolicy;
  policyHash: string;
} {
  if (contract.case_type !== "bilateral" || !contract.contractId || contract.contractId !== contract.id
    || contract.policyVersion !== CONTRACT_POLICY_VERSION || !contract.policy || !contract.policyHash) {
    throw new ContractIntegrityError("CONTRACT_POLICY_MISSING", "A signed bilateral contract policy is required.");
  }
  if (hashContractTerms(contract.case_type, contract.terms) !== contract.termsHash
    || hashContractPolicy(contract.policy) !== contract.policyHash) {
    throw new ContractIntegrityError("CONTRACT_HASH_MISMATCH", "The contract terms or policy no longer match the signed hash.");
  }
  const policy = contract.policy;
  if (policy.contractId !== contract.id || policy.policyVersion !== contract.policyVersion
    || policy.tenantUserId !== contract.tenantUserId || policy.landlordUserId !== contract.landlordUserId
    || policy.property.id !== contract.propertyId || policy.effectiveDate !== contract.effectiveDate
    || policy.agentId !== CONTRACT_AGENT_ID) {
    throw new ContractIntegrityError("CONTRACT_BINDING_MISMATCH", "The contract policy is not bound to this agreement and its parties.");
  }
  if (!validDate(policy.effectiveDate) || policy.obligationPeriod !== policy.effectiveDate.slice(0, 7)
    || !Number.isInteger(policy.dueDay) || policy.dueDay < 1 || policy.dueDay > 28
    || !Number.isInteger(policy.gracePeriodDays) || policy.gracePeriodDays < 0 || policy.gracePeriodDays > 30
    || !Number.isInteger(policy.monthlyRentCents) || policy.monthlyRentCents <= 0 || policy.monthlyRentCents > 100_000_000
    || policy.disputedFunds.mode !== "HOLD_ALL" || policy.disputedFunds.allowUndisputedRelease !== false) {
    throw new ContractIntegrityError("INVALID_CONTRACT_POLICY", "The contract policy contains invalid rent or dispute terms.");
  }
  if (!Number.isInteger(policy.lateFeeRule.feeCents) || policy.lateFeeRule.feeCents < 0
    || !Number.isInteger(policy.lateFeeRule.maxLateFeeCents) || policy.lateFeeRule.maxLateFeeCents < 0
    || policy.lateFeeRule.feeCents > policy.lateFeeRule.maxLateFeeCents || policy.lateFeeRule.maxLateFeeCents > 2_500
    || !Number.isInteger(policy.monetaryDefault.afterDays) || policy.monetaryDefault.afterDays < policy.gracePeriodDays
    || policy.monetaryDefault.afterDays > 90
    || policy.monetaryDefault.remedy !== "RECORD_ONLY"
    || !Number.isInteger(policy.nonMonetaryDefault.deadlineDays) || policy.nonMonetaryDefault.deadlineDays < 0
    || policy.nonMonetaryDefault.deadlineDays > 90
    || policy.nonMonetaryDefault.remedy !== "RECORD_ONLY") {
    throw new ContractIntegrityError("INVALID_CONTRACT_POLICY", "The contract policy contains invalid fee or default terms.");
  }
  const settlement = policy.settlement;
  if (settlement.asset !== "RLUSD" || settlement.network !== "testnet"
    || settlement.issuer !== RLUSD_TESTNET_ISSUER || settlement.currency !== RLUSD_CURRENCY
    || !isValidClassicAddress(settlement.source) || !isValidClassicAddress(settlement.destination)
    || settlement.source === settlement.destination || settlement.source === settlement.issuer || settlement.destination === settlement.issuer
    || compareDecimal(settlement.amountRlusd, "0") <= 0
    || compareDecimal(settlement.amountRlusd, settlement.maxAutonomousAmountRlusd) > 0
    || compareDecimal(settlement.maxAutonomousAmountRlusd, MAX_RLUSD_AMOUNT) > 0) {
    throw new ContractIntegrityError("CONTRACT_SETTLEMENT_INVALID", "The contract does not contain an approved Testnet RLUSD settlement definition.");
  }
  if (contract.status === "active") {
    for (const role of ["tenant", "landlord"] as const) {
      const expectedUserId = role === "tenant" ? policy.tenantUserId : policy.landlordUserId;
      const roleAcceptances = contract.acceptances.filter((item) => item.role === role);
      const acceptance = roleAcceptances[0];
      if (roleAcceptances.length !== 1 || acceptance.userId !== expectedUserId
        || acceptance.termsHash !== contract.termsHash || acceptance.policyHash !== contract.policyHash) {
        throw new ContractIntegrityError("CONTRACT_SIGNATURES_INVALID", `The active contract is missing its valid ${role} acceptance.`);
      }
    }
  }
}

export function isActiveContract(contract: DigitalContract): boolean {
  try {
    assertContractIntegrity(contract);
    return contract.status === "active";
  } catch {
    return false;
  }
}

/** Validates a proposed simulated fee against the signed fixed fee and cap. No fee is paid on XRPL. */
export function evaluateContractFeeRequest(contract: DigitalContract, requestedFeeCents: number): ContractFeeDecision {
  try { assertContractIntegrity(contract); }
  catch {
    return { allowed: false, reason: "CONTRACT_INTEGRITY_FAILED", configuredFeeCents: 0, maximumFeeCents: 0 };
  }
  const configuredFeeCents = contract.policy.lateFeeRule.feeCents;
  const maximumFeeCents = contract.policy.lateFeeRule.maxLateFeeCents;
  if (contract.status !== "active") {
    return { allowed: false, reason: "CONTRACT_NOT_ACTIVE", configuredFeeCents, maximumFeeCents };
  }
  if (!Number.isInteger(requestedFeeCents) || requestedFeeCents < 0 || requestedFeeCents > maximumFeeCents) {
    return { allowed: false, reason: "FEE_EXCEEDS_CONTRACT_POLICY", configuredFeeCents, maximumFeeCents };
  }
  if (requestedFeeCents !== configuredFeeCents) {
    return { allowed: false, reason: "FEE_NOT_AUTHORIZED", configuredFeeCents, maximumFeeCents };
  }
  return { allowed: true, reason: "FEE_ALLOWED", configuredFeeCents, maximumFeeCents };
}

function decision(
  contract: DigitalContract & { policy: ContractPolicy; policyHash: string },
  allowed: boolean,
  action: ContractPolicyDecision["action"],
  reason: string,
  evaluatedRules: ContractPolicyCheck[],
  effects: ContractPolicyDecision["effects"] = {},
): ContractPolicyDecision {
  return {
    allowed, action, contractId: contract.id, policyVersion: CONTRACT_POLICY_VERSION,
    policyHash: contract.policyHash, reason, amount: contract.policy.settlement.amountRlusd,
    asset: "RLUSD", evaluatedRules, effects,
  };
}

function utcDate(period: string, day: number): number {
  const [year, month] = period.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * Deterministic policy evaluation. It reads signed terms and trusted case facts;
 * it does not sign, submit, persist, call an LLM, or perform network I/O.
 */
export function evaluateContractPolicy(
  contract: DigitalContract,
  caseState: ContractCaseState,
  financialState: ContractFinancialState,
  now: Date,
): ContractPolicyDecision {
  const checks: ContractPolicyCheck[] = [];
  const check = (code: string, passed: boolean, detail: string) => {
    checks.push({ code, passed, detail });
    return passed;
  };
  try {
    assertContractIntegrity(contract);
  } catch (error) {
    const code = error instanceof ContractIntegrityError ? error.code : "CONTRACT_INTEGRITY_FAILED";
    return {
      allowed: false, action: "NONE", contractId: contract.id, policyVersion: CONTRACT_POLICY_VERSION,
      policyHash: contract.policyHash ?? "", reason: code, amount: contract.policy?.settlement.amountRlusd ?? "0",
      asset: "RLUSD", evaluatedRules: [{ code, passed: false, detail: "Signed contract integrity validation failed." }], effects: {},
    };
  }
  const policy = contract.policy;
  if (!check("CONTRACT_ACTIVE", contract.status === "active", "Both authenticated parties accepted the same terms and policy hash.")) {
    return decision(contract, false, "NONE", "CONTRACT_NOT_ACTIVE", checks);
  }
  const disputeStateValid = caseState.contractDispute === "none" || caseState.contractDispute === "open"
    || caseState.contractDispute === "resolved";
  const bound = caseState.contractId === contract.id && (!contract.caseId || contract.caseId === caseState.id)
    && caseState.tenantUserId === policy.tenantUserId && caseState.landlordUserId === policy.landlordUserId
    && caseState.propertyId === policy.property.id && disputeStateValid
    && caseState.monthlyRentCents === policy.monthlyRentCents
    && caseState.disputedAmountCents === policy.monthlyRentCents
    && caseState.escrow.amountCents === policy.monthlyRentCents;
  if (!check("CASE_CONTRACT_BINDING", bound, "Case, tenant, landlord, property and signed agreement must match.")) {
    return decision(contract, false, "NONE", "CASE_CONTRACT_MISMATCH", checks);
  }
  if (!check("NOT_ALREADY_SETTLED", caseState.escrow.status !== "released", "A released obligation cannot be executed again.")) {
    return decision(contract, false, "NONE", "ALREADY_SETTLED", checks);
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return decision(contract, false, "NONE", "INVALID_EVALUATION_TIME", checks);
  const effectiveMs = Date.parse(`${policy.effectiveDate}T00:00:00.000Z`);
  if (!check("CONTRACT_EFFECTIVE", nowMs >= effectiveMs, "The agreement effective date must have arrived.")) {
    return decision(contract, false, "NONE", "CONTRACT_NOT_EFFECTIVE", checks);
  }
  const dueMs = utcDate(policy.obligationPeriod, policy.dueDay);
  if (!check("DUE_DATE_REACHED", nowMs >= dueMs, "The contract-configured due date must have arrived.")) {
    return decision(contract, false, "NONE", "DUE_DATE_NOT_REACHED", checks);
  }

  const dispute = caseState.contractDispute ?? "none";
  if (dispute !== "none") {
    const repairPassed = !policy.repairRules.repairReportedRequired || caseState.repairReported === true;
    const latestRepair = caseState.repairs?.filter((item) => item.kind === "reported_complete"
      && item.landlordUserId === policy.landlordUserId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    const latestTenantAfterEvidence = caseState.evidence?.filter((item) => item.stage === "after"
      && item.uploadedByRole === "tenant" && item.analysis?.verified === true && item.analysis.analyzedAt
      && latestRepair && Date.parse(item.createdAt) >= Date.parse(latestRepair.createdAt)
      && Date.parse(item.analysis.analyzedAt) >= Date.parse(item.createdAt))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    const evidencePassed = !policy.repairRules.evidenceVerifiedRequired
      || Boolean(latestRepair && latestTenantAfterEvidence && caseState.verification?.verified === true);
    const confirmationPassed = !policy.repairRules.tenantConfirmationRequired || caseState.tenantConfirmed === true;
    check("REPAIR_CONDITION", repairPassed, "The contract-configured repair report condition was evaluated.");
    check("EVIDENCE_CONDITION", evidencePassed, "The contract-configured evidence condition was evaluated.");
    check("TENANT_FACT_CONFIRMATION", confirmationPassed, "Tenant confirmation is a real-world fact, not payment approval.");
    if (!repairPassed || !evidencePassed || !confirmationPassed) {
      const deadlineMs = dueMs + policy.nonMonetaryDefault.deadlineDays * 86_400_000;
      if (nowMs > deadlineMs) {
        check("NON_MONETARY_DEADLINE", false, "The contract-configured repair deadline expired.");
        return decision(contract, true, "RECORD_NON_MONETARY_DEFAULT", "NON_MONETARY_DEFAULT", checks,
          { nonMonetaryDefault: true });
      }
      check("ACTIVE_DISPUTE", false, "The signed HOLD_ALL demo rule keeps disputed funds held until required facts pass.");
      return decision(contract, false, "NONE", "ACTIVE_DISPUTE", checks);
    }
  }

  const fundsAvailable = financialState.fundsAvailable && caseState.escrow.status === "locked";
  check("REQUIRED_FUNDS_AVAILABLE", fundsAvailable, "Trusted server state shows whether allocated funds are locked.");
  if (!fundsAvailable) {
    const defaultMs = dueMs + policy.monetaryDefault.afterDays * 86_400_000;
    if (nowMs > defaultMs) {
      return decision(contract, true, "RECORD_MONETARY_DEFAULT", "MONETARY_DEFAULT", checks,
        { lateFeeCents: policy.lateFeeRule.feeCents, monetaryDefault: true });
    }
    const graceMs = dueMs + policy.gracePeriodDays * 86_400_000;
    if (nowMs > graceMs) {
      return decision(contract, true, "RECORD_LATE_PAYMENT", "LATE_PAYMENT", checks,
        { lateFeeCents: policy.lateFeeRule.feeCents });
    }
    return decision(contract, false, "NONE", "FUNDS_UNAVAILABLE", checks);
  }
  check("CONTRACT_ACTION_ALLOWED", true, "The signed agreement permits its pinned Testnet RLUSD release.");
  return decision(contract, true, "RELEASE_RENT", dispute === "open" ? "DISPUTE_CONDITIONS_SATISFIED" : "NORMAL_RENT_RELEASE", checks);
}
