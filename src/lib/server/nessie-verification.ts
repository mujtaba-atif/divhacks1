import "server-only";

import { NessieError, resolveFinancialBinding } from "@/lib/integrations/nessie";
import type { CaseRecord, FinancialPolicyContext, FinancialProfile } from "@/lib/types";

type FinancialCase = Pick<CaseRecord, "id" | "ownerId" | "financialProfile">;

export interface TrustedFinancialVerification {
  tenantVerified: boolean;
  customerVerified: boolean;
  accountVerified: boolean;
  ownershipVerified: boolean;
  balanceAvailable: boolean;
}

/** Recompute at consumption time; never accept booleans or identity claims from a request/model. */
export function getTrustedFinancialVerification(record: FinancialCase): TrustedFinancialVerification {
  const failed: TrustedFinancialVerification = {
    tenantVerified: false, customerVerified: false, accountVerified: false,
    ownershipVerified: false, balanceAvailable: false,
  };
  const profile = record.financialProfile;
  if (!profile || profile.binding.source !== "nessie" || profile.status !== "verified"
    || !profile.checkedAt || !profile.expiresAt || Date.parse(profile.checkedAt) > Date.now()
    || !Number.isFinite(Date.parse(profile.checkedAt)) || !(Date.parse(profile.expiresAt) > Date.now())) return failed;
  try {
    const expected = resolveFinancialBinding(record);
    if (expected.source !== "nessie" || expected.customerId !== profile.binding.customerId
      || expected.accountId !== profile.binding.accountId) return failed;
  } catch { return failed; }
  const balanceAvailable = Number.isSafeInteger(profile.accountBalanceCents) && profile.accountBalanceCents! >= 0;
  if (!profile.customerVerified || !profile.accountVerified || !profile.ownershipVerified || !balanceAvailable) return failed;
  return { tenantVerified: true, customerVerified: true, accountVerified: true, ownershipVerified: true, balanceAvailable: true };
}

/** Adapter for the existing provider-independent settlement policy input. */
export function nessiePolicyContext(record: FinancialCase): FinancialPolicyContext {
  const verified = getTrustedFinancialVerification(record);
  return {
    tenantVerified: verified.tenantVerified, customerVerified: verified.customerVerified,
    accountVerified: verified.accountVerified, accountCustomerBound: verified.ownershipVerified,
    financiallyReady: Object.values(verified).every((value) => value === true),
  };
}

/** A failed live attempt remains live-bound, including failures before the first provider call. */
export function failedFinancialProfile(record: FinancialCase, error: NessieError): FinancialProfile {
  const previous = record.financialProfile;
  const live = process.env.NESSIE_ENABLED === "true" || previous?.binding.source === "nessie";
  // A different tenant must never see the operator's configured financial identifiers.
  const configuredForTenant = process.env.NESSIE_TENANT_ID === record.ownerId;
  const safeId = (value?: string) => value && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : "";
  const binding = previous?.binding.source === "nessie" ? previous.binding : {
    tenantId: record.ownerId, caseId: record.id, source: live ? "nessie" as const : "demo" as const,
    customerId: live ? configuredForTenant ? safeId(process.env.NESSIE_CUSTOMER_ID) : "" : previous?.binding.customerId ?? "",
    accountId: live ? configuredForTenant ? safeId(process.env.NESSIE_ACCOUNT_ID) : "" : previous?.binding.accountId ?? "",
  };
  return {
    binding, status: ["NESSIE_NOT_CONFIGURED", "NESSIE_API_UNAVAILABLE"].includes(error.reasonCode) ? "unavailable" : "rejected",
    reasonCode: error.reasonCode, detail: error.message, checkedAt: new Date().toISOString(),
    customerVerified: false, accountVerified: false, ownershipVerified: false,
    transactions: previous?.transactions ?? [],
  };
}
