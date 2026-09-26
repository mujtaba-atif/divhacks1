import { z } from "zod";
import { demoFinancialProfile, demoRentHistory, FINANCIAL_VERIFICATION_TTL_MS } from "../financial-fixture";
import type { CaseRecord, FinancialBinding, FinancialProfile, FinancialTransaction, NessieReasonCode, RentPayment } from "../types";
import { assertServer, IntegrationError } from "./shared";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const amount = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER / 100);
const customerSchema = z.object({ _id: id });
const accountSchema = z.object({ _id: id, customer_id: id, balance: amount });
const purchaseSchema = z.object({
  _id: id, payer_id: id, amount, purchase_date: z.string().min(1).max(80),
  description: z.string().max(500).optional(), status: z.string(),
});
const billSchema = z.object({
  _id: id, account_id: id, payment_amount: amount, payment_date: z.string().optional(),
  creation_date: z.string().optional(), nickname: z.string().optional(), payee: z.string(), status: z.string(),
});

export class NessieError extends IntegrationError {
  constructor(public readonly reasonCode: NessieReasonCode, message: string) {
    super(message, "Nessie", reasonCode === "NESSIE_API_UNAVAILABLE" || reasonCode === "NESSIE_NOT_CONFIGURED" ? "unavailable" : "rejected");
    this.name = "NessieError";
  }
}

export interface FinancialContext {
  profile: FinancialProfile;
  rentHistory: RentPayment[];
}

function fail(code: NessieReasonCode, message: string): never { throw new NessieError(code, message); }

export function resolveFinancialBinding(record: Pick<CaseRecord, "id" | "ownerId" | "financialProfile">): FinancialBinding {
  assertServer();
  const stored = record.financialProfile?.binding;
  if (stored && stored.tenantId !== record.ownerId) fail("NESSIE_TENANT_MISMATCH", "The financial binding does not belong to this tenant.");
  if (stored && stored.caseId !== record.id) fail("NESSIE_CASE_MISMATCH", "The financial binding does not belong to this case.");
  if (process.env.NESSIE_ENABLED !== "true") {
    if (stored?.source === "nessie") fail("NESSIE_NOT_CONFIGURED", "Nessie is disabled. An API-bound account cannot fall back to a demo fixture.");
    const expected = demoFinancialProfile(record.ownerId, record.id).binding;
    if (stored && (stored.accountId !== expected.accountId || stored.customerId !== expected.customerId)) {
      fail("NESSIE_ACCOUNT_MISMATCH", "The demo account differs from this case's approved fixture binding.");
    }
    return expected;
  }
  const tenantId = process.env.NESSIE_TENANT_ID;
  const customerId = process.env.NESSIE_CUSTOMER_ID;
  const accountId = process.env.NESSIE_ACCOUNT_ID;
  if (!tenantId || !customerId || !accountId || !process.env.NESSIE_API_KEY) {
    fail("NESSIE_NOT_CONFIGURED", "Nessie requires an API key and an operator-configured tenant/customer/account binding.");
  }
  if (tenantId !== record.ownerId) fail("NESSIE_TENANT_MISMATCH", "No approved Nessie account is configured for this tenant session.");
  if (!id.safeParse(customerId).success || !id.safeParse(accountId).success) {
    fail("NESSIE_INVALID_ID", "The configured Nessie customer or account identifier is invalid.");
  }
  if (stored?.source === "nessie" && stored.customerId !== customerId) fail("NESSIE_CUSTOMER_MISMATCH", "The configured customer differs from the case's saved financial binding.");
  if (stored?.source === "nessie" && stored.accountId !== accountId) fail("NESSIE_ACCOUNT_MISMATCH", "The configured account differs from the case's saved financial binding.");
  return { tenantId, customerId, accountId, caseId: record.id, source: "nessie" };
}

function cents(value: number): number {
  const result = Math.round(value * 100);
  if (!Number.isSafeInteger(result)) fail("NESSIE_INVALID_RESPONSE", "Nessie returned an invalid monetary amount.");
  return result;
}

async function get(path: string, missingCode?: NessieReasonCode): Promise<unknown> {
  const base = process.env.NESSIE_BASE_URL ?? "https://api.nessieisreal.com";
  if (!["https://api.nessieisreal.com", "https://api.reimaginebanking.com"].includes(base)) {
    fail("NESSIE_NOT_CONFIGURED", "Nessie must use an approved HTTPS API origin.");
  }
  const url = new URL(path, base);
  url.searchParams.set("key", process.env.NESSIE_API_KEY!);
  try {
    const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (response.status === 404 && missingCode) fail(missingCode, missingCode === "NESSIE_CUSTOMER_NOT_FOUND" ? "The expected Nessie customer was not found." : "The expected Nessie account was not found.");
    if (!response.ok) fail("NESSIE_API_UNAVAILABLE", "The Nessie API is unavailable. No financial authorization was granted.");
    try { return await response.json(); } catch { fail("NESSIE_INVALID_RESPONSE", "Nessie returned invalid JSON. No financial authorization was granted."); }
  } catch (error) {
    if (error instanceof NessieError) throw error;
    // Never include the request URL, provider payload, or API key in errors.
    fail("NESSIE_API_UNAVAILABLE", "The Nessie API could not be reached. No financial authorization was granted.");
  }
}

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) fail("NESSIE_INVALID_RESPONSE", "Nessie returned an unexpected financial record format.");
  return parsed.data;
}

/** Only accepts a trusted server-loaded case. Request-supplied account IDs never enter this adapter. */
export async function getFinancialContext(record: Pick<CaseRecord, "id" | "ownerId" | "financialProfile">): Promise<FinancialContext> {
  assertServer();
  const binding = resolveFinancialBinding(record);
  if (binding.source === "demo") return { profile: demoFinancialProfile(record.ownerId, record.id), rentHistory: demoRentHistory() };

  const customer = parse(customerSchema, await get(`/customers/${encodeURIComponent(binding.customerId)}`, "NESSIE_CUSTOMER_NOT_FOUND"));
  if (customer._id !== binding.customerId) fail("NESSIE_CUSTOMER_MISMATCH", "Nessie returned a different customer than the case's approved customer.");
  const account = parse(accountSchema, await get(`/accounts/${encodeURIComponent(binding.accountId)}`, "NESSIE_ACCOUNT_NOT_FOUND"));
  if (account._id !== binding.accountId) fail("NESSIE_ACCOUNT_MISMATCH", "Nessie returned a different account than the case's approved account.");
  if (account.customer_id !== binding.customerId) fail("NESSIE_OWNERSHIP_MISMATCH", "The Nessie account does not belong to the expected customer.");
  const purchases = parse(z.array(purchaseSchema).max(1000), await get(`/accounts/${encodeURIComponent(binding.accountId)}/purchases`));
  const bills = parse(z.array(billSchema).max(1000), await get(`/accounts/${encodeURIComponent(binding.accountId)}/bills`));
  if (purchases.some((purchase) => purchase.payer_id !== binding.accountId) || bills.some((bill) => bill.account_id !== binding.accountId)) {
    fail("NESSIE_ACCOUNT_MISMATCH", "Nessie returned transactions for another account.");
  }
  if (new Set(purchases.map((purchase) => purchase._id)).size !== purchases.length || new Set(bills.map((bill) => bill._id)).size !== bills.length) {
    fail("NESSIE_INVALID_RESPONSE", "Nessie returned duplicate financial record identifiers.");
  }
  const transactions: FinancialTransaction[] = purchases.filter((purchase) => ["completed", "executed"].includes(purchase.status.toLowerCase())).map((purchase) => ({
    id: `NESSIE-${purchase._id}`, label: purchase.description || "Sandbox account purchase", amountCents: cents(purchase.amount),
    date: purchase.purchase_date, category: "Imported purchase", source: "nessie", relatedStatus: "suggested",
    suggestionReason: "Imported for tenant review. Relevance to the housing issue has not been confirmed.",
  }));
  const rentPayee = process.env.NESSIE_RENT_PAYEE?.trim().toLowerCase();
  const checkedAt = new Date();
  return {
    profile: {
      binding, status: "verified", customerVerified: true, accountVerified: true, ownershipVerified: true,
      accountBalanceCents: cents(account.balance), checkedAt: checkedAt.toISOString(),
      expiresAt: new Date(checkedAt.getTime() + FINANCIAL_VERIFICATION_TTL_MS).toISOString(), transactions,
      detail: "Customer, account, ownership, and balance verified through the Nessie sandbox API. This is mock banking data, not real KYC.",
    },
    rentHistory: bills.filter((bill) => rentPayee && bill.payee.trim().toLowerCase() === rentPayee
      && ["completed", "executed", "pending", "scheduled", "recurring"].includes(bill.status.toLowerCase()))
      .map((bill) => ({ id: `NESSIE-${bill._id}`, month: bill.payment_date ?? bill.creation_date ?? "Date unavailable",
        amountCents: cents(bill.payment_amount), status: ["completed", "executed"].includes(bill.status.toLowerCase()) ? "paid" : "upcoming", source: "nessie" })),
  };
}
