import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthUser } from "@/lib/types";
import {
  CONTRACT_AGENT_ID, CONTRACT_POLICY_VERSION,
  type ContractAcceptance, type ContractPolicy, type DigitalContract,
} from "@/lib/contract-types";
import { getXrplConfig, XrplError } from "@/lib/integrations/xrpl-settlement";
import { createContractCase } from "./cases";
import { getRegisteredUser } from "./auth";
import { ApiError } from "./errors";
import { assignedWorkspaceOwners, mutateSession, readSession, type SessionDocument } from "./store";
import { assertContractIntegrity, ContractIntegrityError, hashContractPolicy, hashContractTerms, isActiveContract } from "./contract-policy";

export type { ContractAcceptance, ContractPolicy, DigitalContract } from "@/lib/contract-types";
export { CONTRACT_AGENT_ID, CONTRACT_POLICY_VERSION, assertContractIntegrity, isActiveContract };

const terms = z.string().trim().min(1).max(12_000);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date (YYYY-MM-DD).")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Enter a valid date.");
const bilateralPolicyInput = z.object({
  monthlyRentCents: z.number().int().positive().max(100_000_000).optional(),
  dueDay: z.number().int().min(1).max(28).optional(),
  gracePeriodDays: z.number().int().min(0).max(30).optional(),
  effectiveDate: dateOnly.optional(),
  lateFeeCents: z.number().int().min(0).max(2_500).optional(),
  maxLateFeeCents: z.number().int().min(0).max(2_500).optional(),
  monetaryDefaultAfterDays: z.number().int().min(0).max(90).optional(),
  repairDeadlineDays: z.number().int().min(0).max(90).optional(),
}).strict().refine((value) => (value.lateFeeCents ?? 2_500) <= (value.maxLateFeeCents ?? 2_500), {
  path: ["lateFeeCents"], message: "The late fee cannot exceed the contract maximum.",
}).refine((value) => (value.monetaryDefaultAfterDays ?? Math.max(10, value.gracePeriodDays ?? 3)) >= (value.gracePeriodDays ?? 3), {
  path: ["monetaryDefaultAfterDays"], message: "Monetary default must occur on or after the grace period.",
});

export const contractSchema = z.object({
  case_type: z.enum(["bilateral", "self_documentation"]), terms, policy: bilateralPolicyInput.optional(),
}).strict().refine((value) => value.case_type === "bilateral" || value.policy === undefined, {
  path: ["policy"], message: "Tenant-only documentation cannot grant settlement authority.",
});

export const contractAcceptanceSchema = z.object({
  role: z.enum(["tenant", "landlord"]),
  termsHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const contractIdSchema = z.string().uuid();

const contractCaseInputSchema = z.object({
  issue: z.enum(["heating", "mold", "leak", "pests", "elevator", "other"]),
  description: z.string().trim().min(1).max(5_000),
  noticedAt: z.string().trim().min(1).max(40).refine((value) => Number.isFinite(Date.parse(value)), "Enter a valid date."),
  address: z.string().trim().min(1).max(240), borough: z.enum(["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"]),
  apartment: z.string().trim().min(1).max(30), landlordName: z.string().trim().max(160),
  landlordContact: z.string().trim().max(240), monthlyRentCents: z.number().int().positive().max(100_000_000),
  disputedAmountCents: z.number().int().positive().max(100_000_000),
}).strict().refine((value) => value.disputedAmountCents <= value.monthlyRentCents, {
  path: ["disputedAmountCents"], message: "The disputed amount cannot exceed monthly rent.",
}).refine((value) => Date.parse(value.noticedAt) <= Date.now() + 24 * 60 * 60 * 1000, {
  path: ["noticedAt"], message: "The issue date cannot be in the future.",
});

export const contractCaseSchema = z.union([
  z.object({ contractId: contractIdSchema, mode: z.enum(["rent", "dispute"]), case: contractCaseInputSchema.optional() }).strict(),
  z.object({ contractId: contractIdSchema, case: contractCaseInputSchema }).strict(),
]);

function legacyActive(contract: DigitalContract) {
  return contract.case_type === "self_documentation"
    ? contract.acceptances.some((acceptance) => acceptance.role === "tenant")
    : (["tenant", "landlord"] as const).every((role) => contract.acceptances.some((acceptance) => acceptance.role === role));
}

function requireContractIntegrity(contract: DigitalContract): void {
  try { assertContractIntegrity(contract); }
  catch (error) {
    if (error instanceof ContractIntegrityError) {
      throw new ApiError(409, error.message, false, error.code);
    }
    throw error;
  }
}

function contractUser(document: SessionDocument, role: "tenant" | "landlord") {
  if (document.tenantUserId) {
    if (role !== "tenant") throw new ApiError(403, "A tenant cannot accept as a property manager.", false, "ROLE_NOT_ALLOWED");
    return { id: document.tenantUserId };
  }
  return getRegisteredUser(document, role);
}

function currentPeriodDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildPolicy(contractId: string, document: SessionDocument, user: AuthUser,
  input: z.infer<typeof bilateralPolicyInput> | undefined): ContractPolicy {
  if (user.role !== "tenant" || document.ownerId !== user.workspaceOwnerId || document.tenantUserId !== user.id) {
    throw new ApiError(403, "Only the tenant who owns this workspace may create an agreement.", false, "CASE_ACCESS_DENIED");
  }
  const property = document.managedProperty;
  if (!property?.landlordUserId) {
    throw new ApiError(409, "A trusted property manager assignment is required before creating an agreement.", false, "LANDLORD_MISMATCH");
  }
  let config;
  try { config = getXrplConfig(); }
  catch (error) {
    if (error instanceof XrplError) throw new ApiError(409, error.message, false, error.reason);
    throw error;
  }
  if (!config || config.asset !== "RLUSD" || !config.issuer) {
    throw new ApiError(409, "Configure the approved XRPL Testnet RLUSD settlement before creating a financial agreement.", false,
      "RLUSD_NOT_CONFIGURED");
  }
  const effectiveDate = input?.effectiveDate ?? currentPeriodDate();
  const gracePeriodDays = input?.gracePeriodDays ?? 3;
  const maxLateFeeCents = input?.maxLateFeeCents ?? 2_500;
  const lateFeeCents = input?.lateFeeCents ?? Math.min(2_500, maxLateFeeCents);
  return {
    contractId, policyVersion: CONTRACT_POLICY_VERSION,
    tenantUserId: user.id, tenantDisplayName: user.displayName,
    landlordUserId: property.landlordUserId, landlordDisplayName: property.landlordDisplayName ?? "Property manager",
    property: { id: property.id, address: property.address, borough: property.borough },
    monthlyRentCents: input?.monthlyRentCents ?? 40_000,
    dueDay: input?.dueDay ?? Math.min(Number(effectiveDate.slice(8, 10)), 28),
    obligationPeriod: effectiveDate.slice(0, 7), effectiveDate, gracePeriodDays,
    disputedFunds: { mode: "HOLD_ALL", allowUndisputedRelease: false },
    repairRules: { repairReportedRequired: true, evidenceVerifiedRequired: true, tenantConfirmationRequired: true },
    lateFeeRule: { feeCents: lateFeeCents, maxLateFeeCents },
    monetaryDefault: { afterDays: input?.monetaryDefaultAfterDays ?? Math.max(10, gracePeriodDays), remedy: "RECORD_ONLY" },
    nonMonetaryDefault: { obligation: "REPAIR_BY_DEADLINE", deadlineDays: input?.repairDeadlineDays ?? 30, remedy: "RECORD_ONLY" },
    settlement: { asset: "RLUSD", network: "testnet", source: config.source, destination: config.destination,
      issuer: config.issuer, currency: config.currency, amountRlusd: config.amount, maxAutonomousAmountRlusd: config.amount },
    agentId: CONTRACT_AGENT_ID,
  };
}

export async function createContract(ownerId: string, input: z.infer<typeof contractSchema>, authenticatedUser?: AuthUser) {
  return mutateSession(ownerId, (document) => {
    if (authenticatedUser && authenticatedUser.role !== "tenant") {
      throw new ApiError(403, "Only tenants can create RentEscrow agreements.", false, "ROLE_NOT_ALLOWED");
    }
    const tenant = authenticatedUser ?? contractUser(document, "tenant");
    const createdAt = new Date().toISOString();
    const id = randomUUID();
    const termsHash = hashContractTerms(input.case_type, input.terms);
    let contract: DigitalContract;
    if (input.case_type === "bilateral" && authenticatedUser) {
      const policy = buildPolicy(id, document, authenticatedUser, input.policy);
      contract = { id, contractId: id, case_type: input.case_type, terms: input.terms, termsHash,
        tenantUserId: policy.tenantUserId, landlordUserId: policy.landlordUserId,
        tenantDisplayName: policy.tenantDisplayName, landlordDisplayName: policy.landlordDisplayName,
        propertyId: policy.property.id, effectiveDate: policy.effectiveDate,
        policyVersion: CONTRACT_POLICY_VERSION, policy, policyHash: hashContractPolicy(policy), createdAt,
        acceptances: [], status: "draft" };
    } else {
      const acceptance: ContractAcceptance = { role: "tenant", userId: tenant.id, acceptedAt: createdAt, termsHash,
        method: "stored_acceptance" };
      contract = { id, case_type: input.case_type, terms: input.terms, termsHash, tenantUserId: tenant.id, createdAt,
        acceptances: [acceptance], status: input.case_type === "self_documentation" ? "active" : "pending_landlord" };
    }
    const contracts = document.contracts ??= [];
    if (contracts.length >= 50) throw new ApiError(409, "This demo allows up to 50 contracts per session.");
    contracts.push(contract);
    return contract;
  });
}

export async function acceptContract(ownerId: string, contractId: string, role: "tenant" | "landlord",
  authenticatedUser?: AuthUser, reviewed?: { termsHash?: string; policyHash?: string }) {
  return mutateSession(ownerId, (document) => {
    const contract = document.contracts?.find((item) => item.id === contractId);
    if (!contract) throw new ApiError(404, "Contract not found in this demo session.");
    if (contract.status === "used") throw new ApiError(409, "This contract has already created a case.");
    if (contract.case_type === "self_documentation" && role === "landlord") {
      throw new ApiError(409, "Self-documentation contracts are tenant-only.");
    }
    if (contract.policy) {
      if (!authenticatedUser || authenticatedUser.role !== role) {
        throw new ApiError(403, "Authenticated users may only sign as their own role.", false, "ROLE_NOT_ALLOWED");
      }
      requireContractIntegrity(contract);
      const expectedUserId = role === "tenant" ? contract.tenantUserId : contract.landlordUserId;
      if (authenticatedUser.id !== expectedUserId) {
        throw new ApiError(403, "This agreement is assigned to a different user.", false, "CONTRACT_ACCESS_DENIED");
      }
      if (reviewed?.termsHash !== contract.termsHash || reviewed.policyHash !== contract.policyHash) {
        throw new ApiError(409, "Review the current agreement version before signing.", false, "CONTRACT_VERSION_MISMATCH");
      }
      if (!contract.acceptances.some((item) => item.role === role)) {
        contract.acceptances.push({ role, userId: authenticatedUser.id, acceptedAt: new Date().toISOString(),
          termsHash: contract.termsHash, policyHash: contract.policyHash, method: "stored_acceptance" });
      }
      contract.status = (["tenant", "landlord"] as const).every((expectedRole) =>
        contract.acceptances.some((acceptance) => acceptance.role === expectedRole)) ? "active" : "draft";
      if (contract.status === "active") requireContractIntegrity(contract);
      return contract;
    }
    const user = contractUser(document, role);
    if (role === "tenant" && user.id !== contract.tenantUserId) throw new ApiError(403, "Only the registering tenant may accept this contract.");
    if (!contract.acceptances.some((item) => item.role === role)) contract.acceptances.push({
      role, userId: user.id, acceptedAt: new Date().toISOString(), termsHash: contract.termsHash, method: "stored_acceptance",
    });
    if (role === "landlord") contract.landlordUserId = user.id;
    contract.status = legacyActive(contract) ? "active" : "pending_landlord";
    return contract;
  });
}

export async function getContracts(ownerId: string) {
  const session = await readSession(ownerId);
  return session?.contracts ?? [];
}

export async function getContractsForUser(user: AuthUser): Promise<DigitalContract[]> {
  if (user.role === "tenant") {
    const session = await readSession(user.workspaceOwnerId);
    if (!session || session.tenantUserId !== user.id) throw new ApiError(403, "Contract access denied.", false, "CONTRACT_ACCESS_DENIED");
    return session.contracts ?? [];
  }
  const contracts: DigitalContract[] = [];
  for (const ownerId of await assignedWorkspaceOwners(user.id)) {
    const session = await readSession(ownerId);
    if (session?.managedProperty?.landlordUserId !== user.id) continue;
    contracts.push(...(session.contracts ?? []).filter((contract) => contract.landlordUserId === user.id));
  }
  return contracts;
}

export async function acceptContractForUser(user: AuthUser, contractId: string,
  input: z.infer<typeof contractAcceptanceSchema>): Promise<DigitalContract> {
  if (input.role !== user.role) throw new ApiError(403, "You cannot accept a contract as another role.", false, "ROLE_NOT_ALLOWED");
  if (user.role === "tenant") return acceptContract(user.workspaceOwnerId, contractId, input.role, user, input);
  for (const ownerId of await assignedWorkspaceOwners(user.id)) {
    const session = await readSession(ownerId);
    if (session?.contracts?.some((contract) => contract.id === contractId && contract.landlordUserId === user.id)) {
      return acceptContract(ownerId, contractId, input.role, user, input);
    }
  }
  throw new ApiError(404, "Contract not found.", false, "CONTRACT_NOT_FOUND");
}

function governedCaseInput(contract: DigitalContract, mode: "rent" | "dispute") {
  assertContractIntegrity(contract);
  const borough = z.enum(["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"]).parse(contract.policy.property.borough);
  return { issue: "heating" as const,
    description: mode === "dispute" ? "Contract-governed demo dispute for the signed rent obligation."
      : "Contract-governed demo rent obligation.",
    noticedAt: new Date().toISOString().slice(0, 10), address: contract.policy.property.address, borough,
    apartment: "Agreement", landlordName: contract.policy.landlordDisplayName, landlordContact: "",
    monthlyRentCents: contract.policy.monthlyRentCents, disputedAmountCents: contract.policy.monthlyRentCents };
}

export async function createCaseForContract(ownerId: string, input: z.infer<typeof contractCaseSchema>) {
  const session = await readSession(ownerId);
  const contract = session?.contracts?.find((item) => item.id === input.contractId);
  if (!contract) throw new ApiError(404, "Contract not found in this demo session.");
  const governed = Boolean(contract.policy);
  if (governed ? !isActiveContract(contract) : contract.status !== "active" || !legacyActive(contract)) {
    throw new ApiError(409, "A fully accepted contract is required. Both assigned parties must sign the same agreement version before creating a case.", false,
      "CONTRACT_NOT_ACTIVE");
  }
  const mode = "mode" in input ? input.mode : "dispute";
  const caseInput = input.case ?? governedCaseInput(contract, mode);
  if (!governed && contract.case_type === "bilateral" && (!caseInput.landlordName || !caseInput.landlordContact)) {
    throw new ApiError(400, "Bilateral contract cases require landlord name and contact.");
  }
  return createContractCase(ownerId, caseInput, input.contractId, mode);
}

export async function rejectContractMutation(user: AuthUser, contractId: string): Promise<never> {
  const contracts = await getContractsForUser(user);
  if (!contracts.some((contract) => contract.id === contractId)) {
    throw new ApiError(404, "Contract not found.", false, "CONTRACT_NOT_FOUND");
  }
  throw new ApiError(409, "Contract terms are immutable. Create a new agreement version and collect both signatures.", false,
    "CONTRACT_TERMS_IMMUTABLE");
}
