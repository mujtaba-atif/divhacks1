import "server-only";

import type { AuthUser, CaseRecord } from "@/lib/types";
import { ApiError } from "./errors";

export function requireCaseAccess(user: AuthUser, record: CaseRecord): void {
  const allowed = user.role === "tenant"
    ? record.tenantUserId === user.id && record.ownerId === user.workspaceOwnerId
    : record.landlordUserId === user.id && !!record.tenantUserId && !!record.propertyId;
  if (!allowed) throw new ApiError(403, "Case access denied.", false, "CASE_ACCESS_DENIED");
}

export function requireLandlordCaseAccess(user: AuthUser, record: CaseRecord): void {
  if (user.role !== "landlord") throw new ApiError(403, "This action requires a property manager account.", false, "ROLE_NOT_ALLOWED");
  requireCaseAccess(user, record);
}
