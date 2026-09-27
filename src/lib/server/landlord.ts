import "server-only";

import { z } from "zod";
import type { AuthUser, CaseRecord, LandlordCase } from "@/lib/types";
import { ApiError } from "./errors";
import { requireLandlordCaseAccess } from "./case-access";
import { assignedWorkspaceOwners, readSession } from "./store";

const notes = z.string().trim().min(1, "Add repair notes.").max(5000);
export const landlordActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("message"), body: z.string().trim().min(1).max(5000) }).strict(),
  z.object({ action: z.literal("schedule"), notes,
    scheduledFor: z.string().datetime({ offset: true }).refine((value) => Date.parse(value) > Date.now(), "Choose a future maintenance time.") }).strict(),
  z.object({ action: z.literal("report_complete"), notes }).strict(),
]);

/** Allowlist projection: private financial state and provider identifiers never cross this boundary. */
export function toLandlordCase(user: AuthUser, record: CaseRecord): LandlordCase {
  requireLandlordCaseAccess(user, record);
  return {
    id: record.id, title: record.title, issue: record.issue, description: record.description,
    noticedAt: record.noticedAt, createdAt: record.createdAt, updatedAt: record.updatedAt, status: record.status,
    property: { id: record.propertyId!, address: record.building.address, borough: record.building.borough, apartment: record.apartment },
    tenant: { displayName: record.tenantDisplayName || "Tenant" },
    evidence: record.evidence.filter((item) => item.stage !== "receipt").map((item) => ({
      id: item.id, name: item.name, mimeType: item.mimeType, stage: item.stage, note: item.note,
      createdAt: item.createdAt, dataUrl: item.dataUrl, temperatureF: item.temperatureF,
      isDemo: item.isDemo, analysis: item.analysis, uploadedByRole: item.uploadedByRole,
    })),
    messages: record.messages.map(({ id, sender, body, createdAt, delivery }) => ({ id, sender, body, createdAt, delivery })),
    // Case-kind events also include expenses and imported transaction labels.
    // Evidence events can reference private receipts. Only share operational events,
    // with evidence details available through the separate receipt-free projection.
    timeline: record.timeline.filter((item) => ["evidence", "message", "verification"].includes(item.kind)
      || (item.kind === "case" && item.title === "Case opened"))
      .map(({ id, title, detail, createdAt, kind }) => ({ id, title, createdAt, kind,
        detail: kind === "evidence" ? "Case evidence updated. Review the shared evidence for details."
          : kind === "message" && /delivery|not sent/i.test(title) ? "Message delivery status updated." : detail })),
    repairReported: record.repairReported,
    repairs: (record.repairs ?? []).map(({ id, caseId, landlordUserId, kind, createdAt, notes, scheduledFor, evidenceId }) =>
      ({ id, caseId, landlordUserId, kind, createdAt, notes, scheduledFor, evidenceId })),
    financialSummary: {
      disputedAmountCents: record.disputedAmountCents, escrowStatus: record.escrow.status,
      settlementStatus: record.escrow.status === "released" ? "complete" : "pending",
    },
    verification: record.verification,
  };
}

export async function landlordCases(user: AuthUser): Promise<LandlordCase[]> {
  if (user.role !== "landlord") throw new ApiError(403, "This workspace requires a property manager account.", false, "ROLE_NOT_ALLOWED");
  const cases: LandlordCase[] = [];
  for (const ownerId of await assignedWorkspaceOwners(user.id)) {
    const document = await readSession(ownerId);
    if (!document) continue;
    for (const record of document.cases) {
      if (record.landlordUserId === user.id && record.tenantUserId === document.tenantUserId
        && record.ownerId === document.ownerId) cases.push(toLandlordCase(user, record));
    }
  }
  return cases.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Resolve owner server-side. No tenant/workspace identifier is accepted from the browser. */
export async function landlordCaseOwner(user: AuthUser, caseId: string): Promise<string> {
  if (user.role !== "landlord") throw new ApiError(403, "This action requires a property manager account.", false, "ROLE_NOT_ALLOWED");
  for (const ownerId of await assignedWorkspaceOwners(user.id)) {
    const document = await readSession(ownerId);
    const record = document?.cases.find((item) => item.id === caseId && item.landlordUserId === user.id
      && item.ownerId === document.ownerId && item.tenantUserId === document.tenantUserId);
    if (record) { requireLandlordCaseAccess(user, record); return ownerId; }
  }
  throw new ApiError(403, "Case access denied.", false, "CASE_ACCESS_DENIED");
}

/** Defense in depth: never serialize an internal case/policy from an error to a landlord. */
export function publicLandlordError(error: unknown): unknown {
  return error instanceof ApiError ? new ApiError(error.status, error.message, false, error.code) : error;
}
