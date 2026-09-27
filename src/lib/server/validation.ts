import { z } from "zod";

const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const cents = z.number().int().positive().max(100_000_000);
const issue = z.enum(["heating", "mold", "leak", "pests", "elevator", "other"]);
const borough = z.enum(["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"]);

export const newCaseSchema = z.object({
  issue,
  description: text(5_000),
  noticedAt: text(40).refine((value) => Number.isFinite(Date.parse(value)), "Enter a valid date."),
  address: text(240),
  borough,
  apartment: text(30),
  // This endpoint creates demo cases; the server assigns their participants.
  landlordName: z.string().trim().max(160).nullish().transform((value) => value ?? ""),
  landlordContact: z.string().trim().max(240).nullish().transform((value) => value ?? ""),
  monthlyRentCents: cents,
  disputedAmountCents: cents,
}).strict().refine((value) => value.disputedAmountCents <= value.monthlyRentCents, {
  path: ["disputedAmountCents"], message: "The disputed amount cannot exceed monthly rent.",
}).refine((value) => Date.parse(value.noticedAt) <= Date.now() + 24 * 60 * 60 * 1000, {
  path: ["noticedAt"], message: "The issue date cannot be in the future.",
});

export const buildingQuerySchema = z.object({ address: text(240), borough });

const transactionIntentSchema = z.object({
  caseId: text(120),
  escrowId: text(120),
  transactionType: text(80),
  // A self-documentation case intentionally has no destination wallet; policy
  // must receive that empty intent so it can reject and audit the attempt.
  destination: z.string().trim().max(240),
  amountCents: z.number().int().min(0).max(100_000_000),
  network: text(80),
  tenantId: text(120).optional(),
  nessieCustomerId: text(120).optional(),
  nessieAccountId: text(120).optional(),
}).strict();

export const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add_demo_evidence"), stage: z.enum(["before", "after"]) }).strict(),
  z.object({ action: z.literal("analyze_evidence"), evidenceId: text(120) }).strict(),
  z.object({ action: z.literal("send_message"), body: text(5_000), approved: z.literal(true), requestId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("simulate_landlord_reply"), variant: z.enum(["scheduled", "completed"]) }).strict(),
  z.object({ action: z.literal("record_landlord_reply"), body: text(2_000) }).strict(),
  z.object({ action: z.literal("create_escrow") }).strict(),
  z.object({ action: z.literal("verify_repair") }).strict(),
  z.object({ action: z.literal("confirm_resolution") }).strict(),
  z.object({ action: z.literal("release_escrow") }).strict(),
  z.object({ action: z.literal("enable_xrpl") }).strict(),
  z.object({ action: z.literal("settle_xrpl") }).strict(),
  z.object({ action: z.literal("reconcile_xrpl") }).strict(),
  z.object({ action: z.literal("xrpl_security_demo"), scenario: z.enum([
    "wallet_switch", "amount_tamper", "prompt_injection", "insufficient_funds",
    "duplicate", "wrong_network", "wrong_case", "unsupported_action",
  ]) }).strict(),
  z.object({ action: z.literal("add_expense"), label: text(160), amountCents: cents, category: text(80) }).strict(),
  z.object({ action: z.literal("sync_finances") }).strict(),
  z.object({ action: z.literal("confirm_transaction"), transactionId: text(160) }).strict(),
  z.object({ action: z.literal("dismiss_transaction"), transactionId: text(160) }).strict(),
  z.object({ action: z.literal("check_financial_binding"), scenario: z.enum(["valid", "substitution"]) }).strict(),
  z.object({ action: z.literal("policy_check"), intent: transactionIntentSchema }).strict(),
]);

export const evidenceFieldsSchema = z.object({
  stage: z.enum(["before", "after", "receipt", "other"]),
  note: z.string().trim().max(4_000),
  temperatureF: z.number().finite().min(-100).max(250).optional(),
});
