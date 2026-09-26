import type { FinancialProfile, FinancialTransaction, RentPayment } from "./types";

export const FINANCIAL_VERIFICATION_TTL_MS = 60_000;

export function demoFinancialProfile(tenantId: string, caseId: string): FinancialProfile {
  const date = new Date();
  const transactions: FinancialTransaction[] = [
    { id: "DEMO-PURCHASE-HEATER", label: "Portable space heater", amountCents: 4799, category: "Equipment" },
    { id: "DEMO-PURCHASE-HOTEL", label: "Temporary accommodation", amountCents: 11000, category: "Accommodation" },
  ].map((item) => ({ ...item, date: date.toISOString().slice(0, 10), source: "demo", relatedStatus: "suggested",
    suggestionReason: "Demo suggestion only. Confirm whether this purchase relates to the housing issue." }));
  return {
    binding: { tenantId, caseId, customerId: "customer_123", accountId: "account_456", source: "demo" },
    status: "verified", detail: "Demo fixture customer/account binding verified locally. No Nessie API request or real identity check occurred.",
    checkedAt: date.toISOString(), expiresAt: new Date(date.getTime() + FINANCIAL_VERIFICATION_TTL_MS).toISOString(),
    accountBalanceCents: 243000, customerVerified: true, accountVerified: true, ownershipVerified: true, transactions,
  };
}

export function demoRentHistory(): RentPayment[] {
  return [
    { id: "DEMO-RENT-1", month: "August 2026", amountCents: 185000, status: "paid", source: "demo" },
    { id: "DEMO-RENT-2", month: "September 2026", amountCents: 185000, status: "paid", source: "demo" },
    { id: "DEMO-RENT-3", month: "October 2026", amountCents: 185000, status: "upcoming", source: "demo" },
  ];
}
