import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CaseType } from "@/lib/types";
import { createContractCase } from "./cases";
import { getRegisteredUser } from "./auth";
import { ApiError } from "./errors";
import { mutateSession, readSession } from "./store";

export interface ContractAcceptance {
  role: "tenant" | "landlord";
  userId: string;
  acceptedAt: string;
  termsHash: string;
  method: "stored_acceptance";
}

export interface DigitalContract {
  id: string;
  case_type: CaseType;
  terms: string;
  termsHash: string;
  tenantUserId: string;
  landlordUserId?: string;
  createdAt: string;
  acceptances: ContractAcceptance[];
  status: "pending_landlord" | "active" | "used";
  caseId?: string;
}

const terms = z.string().trim().min(1).max(12_000);
export const contractSchema = z.object({
  case_type: z.enum(["bilateral", "self_documentation"]),
  terms,
}).strict();

export const contractAcceptanceSchema = z.object({ role: z.enum(["tenant", "landlord"]) }).strict();
export const contractIdSchema = z.string().uuid();
// This is deliberately separate from the legacy newCaseSchema: tenant-only
// documentation has no landlord, while the existing /api/cases validation is
// unchanged. Bilateral contracts are checked below before case creation.
const contractCaseInputSchema = z.object({
  issue: z.enum(["heating", "mold", "leak", "pests", "elevator", "other"]),
  description: z.string().trim().min(1).max(5_000),
  noticedAt: z.string().trim().min(1).max(40).refine((value) => Number.isFinite(Date.parse(value)), "Enter a valid date."),
  address: z.string().trim().min(1).max(240),
  borough: z.enum(["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"]),
  apartment: z.string().trim().min(1).max(30),
  landlordName: z.string().trim().max(160),
  landlordContact: z.string().trim().max(240),
  monthlyRentCents: z.number().int().positive().max(100_000_000),
  disputedAmountCents: z.number().int().positive().max(100_000_000),
}).strict().refine((value) => value.disputedAmountCents <= value.monthlyRentCents, {
  path: ["disputedAmountCents"], message: "The disputed amount cannot exceed monthly rent.",
}).refine((value) => Date.parse(value.noticedAt) <= Date.now() + 24 * 60 * 60 * 1000, {
  path: ["noticedAt"], message: "The issue date cannot be in the future.",
});

export const contractCaseSchema = z.object({ contractId: contractIdSchema, case: contractCaseInputSchema }).strict();

function hashTerms(caseType: CaseType, termsText: string) {
  // JSON makes the length/content boundaries unambiguous and is stable because
  // this server owns property order. It is an integrity receipt, not a wallet signature.
  return createHash("sha256").update(JSON.stringify({ version: 1, case_type: caseType, terms: termsText })).digest("hex");
}

function active(contract: DigitalContract) {
  return contract.case_type === "self_documentation"
    ? contract.acceptances.some((acceptance) => acceptance.role === "tenant")
    : ["tenant", "landlord"].every((role) => contract.acceptances.some((acceptance) => acceptance.role === role));
}

export async function createContract(ownerId: string, input: z.infer<typeof contractSchema>) {
  const tenant = await getRegisteredUser(ownerId, "tenant");
  const createdAt = new Date().toISOString();
  const termsHash = hashTerms(input.case_type, input.terms);
  const contract: DigitalContract = {
    id: randomUUID(), case_type: input.case_type, terms: input.terms, termsHash, tenantUserId: tenant.id, createdAt,
    acceptances: [{ role: "tenant", userId: tenant.id, acceptedAt: createdAt, termsHash, method: "stored_acceptance" }],
    status: input.case_type === "self_documentation" ? "active" : "pending_landlord",
  };
  return mutateSession(ownerId, (document) => {
    const contracts = document.contracts ??= [];
    if (contracts.length >= 50) throw new ApiError(409, "This demo allows up to 50 contracts per session.");
    contracts.push(contract);
    return contract;
  });
}

export async function acceptContract(ownerId: string, contractId: string, role: "tenant" | "landlord") {
  const user = await getRegisteredUser(ownerId, role);
  return mutateSession(ownerId, (document) => {
    const contract = document.contracts?.find((item) => item.id === contractId);
    if (!contract) throw new ApiError(404, "Contract not found in this demo session.");
    if (contract.status === "used") throw new ApiError(409, "This contract has already created a case.");
    if (contract.case_type === "self_documentation" && role === "landlord") {
      throw new ApiError(409, "Self-documentation contracts are tenant-only.");
    }
    if (role === "tenant" && user.id !== contract.tenantUserId) throw new ApiError(403, "Only the registering tenant may accept this contract.");
    const existing = contract.acceptances.find((item) => item.role === role);
    if (!existing) contract.acceptances.push({ role, userId: user.id, acceptedAt: new Date().toISOString(), termsHash: contract.termsHash, method: "stored_acceptance" });
    if (role === "landlord") contract.landlordUserId = user.id;
    contract.status = active(contract) ? "active" : "pending_landlord";
    return contract;
  });
}

export async function getContracts(ownerId: string) {
  const session = await readSession(ownerId);
  return session?.contracts ?? [];
}

export async function createCaseForContract(ownerId: string, input: z.infer<typeof contractCaseSchema>) {
  const session = await readSession(ownerId);
  const contract = session?.contracts?.find((item) => item.id === input.contractId);
  if (!contract) throw new ApiError(404, "Contract not found in this demo session.");
  if (contract.status !== "active" || !active(contract)) throw new ApiError(409, "A fully accepted contract is required before creating a case.");
  if (contract.case_type === "bilateral" && (!input.case.landlordName || !input.case.landlordContact)) {
    throw new ApiError(400, "Bilateral contract cases require landlord name and contact.");
  }
  return createContractCase(ownerId, input.case, input.contractId);
}
