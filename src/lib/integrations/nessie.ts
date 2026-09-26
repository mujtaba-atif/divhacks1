import { z } from "zod";
import { createDemoCase } from "../seed";
import type { ExpenseRecord, RentPayment } from "../types";
import { assertServer, fetchJson, IntegrationError } from "./shared";

const amount = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER / 100);
const accountSchema = z.object({ _id: z.string(), balance: amount });
const purchaseSchema = z.object({
  _id: z.string(), amount, purchase_date: z.string(), description: z.string().optional(), status: z.string(),
});
const billSchema = z.object({
  _id: z.string(), payment_amount: amount, payment_date: z.string().optional(),
  creation_date: z.string().optional(), nickname: z.string().optional(), payee: z.string(), status: z.string(),
});
export interface FinancialContext {
  accountBalanceCents: number;
  expenses: ExpenseRecord[];
  rentHistory: RentPayment[];
}

function cents(value: number): number {
  const result = Math.round(value * 100);
  if (!Number.isSafeInteger(result)) throw new IntegrationError("Nessie returned an invalid monetary amount.", "Nessie", "invalid_response");
  return result;
}

export async function getFinancialContext(): Promise<FinancialContext> {
  assertServer();
  if (process.env.NESSIE_ENABLED !== "true") {
    const fixture = createDemoCase("integration-fixture");
    return { accountBalanceCents: fixture.accountBalanceCents, expenses: fixture.expenses, rentHistory: fixture.rentHistory };
  }
  const key = process.env.NESSIE_API_KEY;
  const accountId = process.env.NESSIE_ACCOUNT_ID;
  if (!key || !accountId || !/^[a-zA-Z0-9_-]+$/.test(accountId)) {
    throw new IntegrationError("Nessie requires a server-side API key and mock account ID.", "Nessie");
  }
  const base = process.env.NESSIE_BASE_URL ?? "https://api.nessieisreal.com";
  if (!["https://api.nessieisreal.com", "https://api.reimaginebanking.com"].includes(base)) {
    throw new IntegrationError("Nessie must use an approved HTTPS API origin.", "Nessie", "invalid_input");
  }
  const get = (suffix: string) => {
    const url = new URL(`/accounts/${encodeURIComponent(accountId)}${suffix}`, base);
    url.searchParams.set("key", key);
    return fetchJson(url, "Nessie");
  };
  const responses = await Promise.allSettled([get(""), get("/purchases"), get("/bills")]);
  if (responses.some((response) => response.status === "rejected")) {
    throw new IntegrationError("Nessie could not load the mock account. Existing financial records were preserved.", "Nessie");
  }
  try {
    const payloads = responses.map((response) => response.status === "fulfilled" ? response.value : undefined);
    const account = accountSchema.parse(payloads[0]);
    if (account._id !== accountId) throw new Error("Wrong account");
    const purchases = z.array(purchaseSchema).parse(payloads[1]);
    const bills = z.array(billSchema).parse(payloads[2]);
    const rentPayee = process.env.NESSIE_RENT_PAYEE?.trim().toLowerCase();
    return {
      accountBalanceCents: cents(account.balance),
      expenses: purchases.filter((purchase) => ["completed", "executed"].includes(purchase.status.toLowerCase())).map((purchase) => ({
        id: `NESSIE-${purchase._id}`, label: purchase.description || "Mock account purchase",
        amountCents: cents(purchase.amount), date: purchase.purchase_date, category: "Imported purchase", source: "nessie",
      })),
      // Only an explicitly configured payee identifies rent; unrelated bills are never relabeled as rent.
      rentHistory: bills.filter((bill) => rentPayee && bill.payee.trim().toLowerCase() === rentPayee
        && ["completed", "executed", "pending", "scheduled"].includes(bill.status.toLowerCase()))
        .map((bill) => ({
          id: `NESSIE-${bill._id}`, month: bill.payment_date ?? bill.creation_date ?? "Date unavailable",
          amountCents: cents(bill.payment_amount),
          status: ["completed", "executed"].includes(bill.status.toLowerCase()) ? "paid" : "upcoming", source: "nessie",
        })),
    };
  } catch {
    throw new IntegrationError("Nessie returned an unexpected account format. Existing financial records were preserved.", "Nessie", "invalid_response");
  }
}
