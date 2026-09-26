import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  analyzeEvidence,
  getFinancialContext,
  IntegrationError,
  lookupBuilding,
  sendLandlordMessage,
  verifyEvidence,
} from "@/lib/integrations";
import { evaluatePolicy, makeIntent } from "@/lib/policy";
import { createNewCase } from "@/lib/seed";
import type {
  AuditRecord,
  CaseAction,
  CaseRecord,
  EvidenceRecord,
  PolicyResult,
  TimelineEvent,
  TransactionIntent,
} from "@/lib/types";
import type { z } from "zod";
import { ApiError } from "./errors";
import { findCase, mutateSession, updateSharedBalance, type SessionDocument } from "./store";
import type { newCaseSchema } from "./validation";

export type CaseActionResult = { case: CaseRecord; policy?: PolicyResult };
const UNCERTAIN_DELIVERY_RETRY_DELAY_MS = 5 * 60 * 1000;

function now() { return new Date().toISOString(); }

function event(caseRecord: CaseRecord, title: string, detail: string, kind: TimelineEvent["kind"]) {
  caseRecord.timeline.push({ id: randomUUID(), title, detail, kind, createdAt: now() });
  caseRecord.updatedAt = now();
}

function updateStatus(caseRecord: CaseRecord) {
  caseRecord.status = caseRecord.escrow.status === "released" ? "resolved"
    : caseRecord.verification?.verified ? "verified"
    : caseRecord.repairReported ? "verification"
    : caseRecord.messages.length > 0 || caseRecord.escrow.status === "locked" ? "awaiting_repair"
    : "open";
}

function invalidateVerification(caseRecord: CaseRecord) {
  delete caseRecord.verification;
  caseRecord.tenantConfirmed = false;
  updateStatus(caseRecord);
}

function assertMutable(caseRecord: CaseRecord) {
  if (caseRecord.status === "resolved" || caseRecord.escrow.status === "released") {
    throw new ApiError(409, "This case is resolved and cannot be changed. Start a new case for another issue.");
  }
}

function assertCapacity(caseRecord: CaseRecord) {
  if (caseRecord.evidence.length >= 30) throw new ApiError(409, "This demo allows up to 30 evidence files per case.");
  const storedBytes = caseRecord.evidence.reduce((total, item) => total + (item.dataUrl?.length || 0), 0);
  if (storedBytes > 32 * 1024 * 1024) throw new ApiError(409, "This case has reached its demo evidence storage limit.");
}

function appendAudit(
  caseRecord: CaseRecord,
  intent: TransactionIntent,
  status: AuditRecord["status"],
  detail: string,
  action: AuditRecord["action"],
  hash?: string,
) {
  caseRecord.escrow.audit.push({
    id: randomUUID(), action, status, createdAt: now(), network: "demo",
    amountCents: intent.amountCents, destination: intent.destination, detail, ...(hash ? { hash } : {}),
  });
  caseRecord.updatedAt = now();
}

function financialFailure(caseRecord: CaseRecord, intent: TransactionIntent, policy: PolicyResult): never {
  const reason = policy.checks.filter((check) => !check.passed).map((check) => check.detail).join(" ");
  const action = intent.transactionType === "EscrowCreate" ? "EscrowCreate" : "EscrowFinish";
  appendAudit(caseRecord, intent, "rejected", reason || "Policy rejected this transaction.", action);
  throw new ApiError(409, reason || "The transaction did not pass escrow policy checks.", true);
}

// Only this boundary can mint a simulated transaction result, using the exact reviewed intent.
function simulateSigningBoundary(caseRecord: CaseRecord, intent: Readonly<TransactionIntent>): string {
  const policy = evaluatePolicy(caseRecord, intent);
  if (!policy.approved) financialFailure(caseRecord, intent, policy);
  if (intent.network !== "demo") {
    appendAudit(caseRecord, intent, "rejected", "Application transactions are limited to simulated demo funds.",
      intent.transactionType === "EscrowCreate" ? "EscrowCreate" : "EscrowFinish");
    throw new ApiError(409, "Only simulated demo transactions are enabled in this application.", true);
  }
  return `DEMO-${randomBytes(24).toString("hex").toUpperCase()}`;
}

export async function createCase(ownerId: string, input: z.infer<typeof newCaseSchema>) {
  const building = await lookupBuilding(input.address, input.borough);
  return mutateSession(ownerId, (document) => {
    if (document.cases.length >= 20) throw new ApiError(409, "This demo allows up to 20 cases per session.");
    const caseRecord = createNewCase(ownerId, { ...input, building });
    caseRecord.accountBalanceCents = document.accountBalanceCents;
    document.cases.push(caseRecord);
    return caseRecord;
  });
}

export async function addUploadedEvidence(ownerId: string, caseId: string, evidence: EvidenceRecord) {
  return mutateSession(ownerId, (document) => {
    const caseRecord = findCase(document, caseId);
    assertMutable(caseRecord);
    assertCapacity(caseRecord);
    caseRecord.evidence.push(evidence);
    invalidateVerification(caseRecord);
    event(caseRecord, "Evidence uploaded", `${evidence.name} added as ${evidence.stage} evidence.`, "evidence");
    return caseRecord;
  });
}

async function applyAction(document: SessionDocument, caseRecord: CaseRecord, action: CaseAction): Promise<CaseActionResult> {
  if (action.action === "release_escrow" && caseRecord.escrow.status === "released") return { case: caseRecord };
  assertMutable(caseRecord);

  switch (action.action) {
    case "add_demo_evidence": {
      if (caseRecord.issue !== "heating") {
        throw new ApiError(409, "The provided sample evidence demonstrates a heating repair. Upload evidence for this issue.");
      }
      if (caseRecord.evidence.some((item) => item.isDemo && item.stage === action.stage)) return { case: caseRecord };
      assertCapacity(caseRecord);
      const isAfter = action.stage === "after";
      const evidence: EvidenceRecord = {
        id: randomUUID(),
        name: isAfter ? "After repair - 72F.png" : "Before repair - 54F.png",
        mimeType: "image/png", stage: action.stage,
        note: isAfter ? "Sample heating repair evidence: indoor temperature 72 F." : "Sample heating issue evidence: indoor temperature 54 F.",
        createdAt: now(), temperatureF: isAfter ? 72 : 54, isDemo: true,
        dataUrl: isAfter ? "/evidence-after.png" : "/evidence-before.png",
      };
      caseRecord.evidence.push(evidence);
      invalidateVerification(caseRecord);
      event(caseRecord, "Sample evidence added", `${evidence.name}. Demonstration data only.`, "evidence");
      break;
    }
    case "analyze_evidence": {
      const evidence = caseRecord.evidence.find((item) => item.id === action.evidenceId);
      if (!evidence) throw new ApiError(404, "Evidence not found in this case.");
      if (evidence.analysis) return { case: caseRecord };
      const analysis = await analyzeEvidence(evidence, caseRecord);
      evidence.analysis = analysis;
      invalidateVerification(caseRecord);
      event(caseRecord, "Evidence analyzed", analysis.summary, "evidence");
      break;
    }
    case "send_message": {
      if (caseRecord.messages.length >= 200) throw new ApiError(409, "This case has reached its demo message limit.");
      const messageHash = createHash("sha256").update(caseRecord.landlordContact).update("\0").update(action.body.trim()).digest("hex");
      document.uncertainDeliveries = (document.uncertainDeliveries ?? []).filter(
        (attempt) => Date.now() - Date.parse(attempt.createdAt) < UNCERTAIN_DELIVERY_RETRY_DELAY_MS,
      );
      if (document.uncertainDeliveries.some((attempt) => attempt.caseId === caseRecord.id && attempt.messageHash === messageHash)) {
        throw new ApiError(409, "This message may already have been sent. Identical retries are blocked for five minutes after uncertain delivery. Check the recipient's conversation before trying again.");
      }
      let result: { delivery: "demo" | "sent" };
      try {
        result = await sendLandlordMessage(caseRecord, action.body);
      } catch (error) {
        if (error instanceof IntegrationError && error.code === "uncertain_delivery") {
          document.uncertainDeliveries.push({ caseId: caseRecord.id, messageHash, createdAt: now() });
          event(caseRecord, "Message delivery uncertain", `${error.message} Message: ${action.body}`, "message");
          throw new ApiError(503, `${error.message} Identical retries are blocked for five minutes.`, true);
        }
        throw error;
      }
      caseRecord.messages.push({
        id: randomUUID(), sender: "tenant", body: action.body, createdAt: now(), delivery: result.delivery,
      });
      event(caseRecord, result.delivery === "demo" ? "Notice saved in demo" : "Notice sent", action.body, "message");
      updateStatus(caseRecord);
      break;
    }
    case "simulate_landlord_reply": {
      const completed = action.variant === "completed";
      if (completed && caseRecord.repairReported) return { case: caseRecord };
      if (!completed && caseRecord.repairReported) throw new ApiError(409, "The repair has already been reported complete.");
      if (caseRecord.messages.length >= 200) throw new ApiError(409, "This case has reached its demo message limit.");
      const body = completed
        ? "Demo landlord reply: The heating repair is complete. Please check the apartment temperature and upload after-repair evidence."
        : "Demo landlord reply: A technician is scheduled to inspect and repair the heating system tomorrow morning.";
      if (caseRecord.messages.some((message) => message.sender === "landlord" && message.body === body)) return { case: caseRecord };
      caseRecord.messages.push({ id: randomUUID(), sender: "landlord", body, createdAt: now(), delivery: "demo" });
      if (completed) {
        caseRecord.repairReported = true;
        invalidateVerification(caseRecord);
      }
      updateStatus(caseRecord);
      event(caseRecord, completed ? "Repair reported complete" : "Repair visit scheduled", body, "message");
      break;
    }
    case "create_escrow": {
      if (caseRecord.escrow.status === "locked") return { case: caseRecord };
      caseRecord.accountBalanceCents = document.accountBalanceCents;
      const intent = Object.freeze(makeIntent(caseRecord, "EscrowCreate"));
      const policy = evaluatePolicy(caseRecord, intent);
      if (!policy.approved) financialFailure(caseRecord, intent, policy);
      if (document.accountBalanceCents < intent.amountCents) {
        const insufficient: PolicyResult = {
          approved: false,
          checks: [{ key: "balance", label: "Available balance", passed: false, detail: "There are insufficient available demo funds to create this escrow." }],
        };
        financialFailure(caseRecord, intent, insufficient);
      }
      const hash = simulateSigningBoundary(caseRecord, intent);
      caseRecord.escrow.status = "locked";
      caseRecord.escrow.createHash = hash;
      caseRecord.escrow.lockedAt = now();
      document.simulatedDebitsCents += intent.amountCents;
      updateSharedBalance(document, document.accountBalanceCents - intent.amountCents);
      appendAudit(caseRecord, intent, "validated", "Simulated funds locked after deterministic policy approval and a final signing-boundary check.", "EscrowCreate", hash);
      updateStatus(caseRecord);
      event(caseRecord, "Demo escrow funded", `${(intent.amountCents / 100).toFixed(2)} USD in simulated funds locked. No bank or blockchain transfer occurred.`, "escrow");
      return { case: caseRecord, policy };
    }
    case "verify_repair": {
      if (!caseRecord.repairReported) throw new ApiError(409, "A completed repair must be reported before verification.");
      const afterEvidence = caseRecord.evidence.filter((item) => item.stage === "after").at(-1);
      if (!afterEvidence?.analysis) {
        throw new ApiError(409, "Upload and analyze after-repair evidence before verifying the repair.");
      }
      if (caseRecord.verification?.verified) return { case: caseRecord };
      const verification = await verifyEvidence(caseRecord);
      caseRecord.verification = verification;
      afterEvidence.analysis = verification;
      caseRecord.tenantConfirmed = false;
      updateStatus(caseRecord);
      event(caseRecord, verification.verified ? "Repair evidence verified" : "Repair needs more evidence", verification.summary, "verification");
      break;
    }
    case "confirm_resolution": {
      if (!caseRecord.repairReported || !caseRecord.verification?.verified) {
        throw new ApiError(409, "The repair must pass evidence verification before you confirm resolution.");
      }
      if (caseRecord.tenantConfirmed) return { case: caseRecord };
      caseRecord.tenantConfirmed = true;
      updateStatus(caseRecord);
      event(caseRecord, "Tenant confirmed resolution", "The tenant confirmed that the reported issue has been resolved. Escrow release remains a separate action.", "verification");
      break;
    }
    case "release_escrow": {
      const intent = Object.freeze(makeIntent(caseRecord, "EscrowFinish"));
      const policy = evaluatePolicy(caseRecord, intent);
      if (!policy.approved) financialFailure(caseRecord, intent, policy);
      const hash = simulateSigningBoundary(caseRecord, intent);
      caseRecord.escrow.status = "released";
      caseRecord.escrow.finishHash = hash;
      caseRecord.escrow.releasedAt = now();
      appendAudit(caseRecord, intent, "validated", "Simulated escrow released after final intent validation. No real funds moved.", "EscrowFinish", hash);
      updateStatus(caseRecord);
      event(caseRecord, "Demo escrow released", "The verified escrow was released in the simulation and the case is resolved.", "escrow");
      return { case: caseRecord, policy };
    }
    case "add_expense": {
      if (caseRecord.expenses.length >= 200) throw new ApiError(409, "This case has reached its demo expense limit.");
      caseRecord.expenses.push({ id: randomUUID(), label: action.label, amountCents: action.amountCents,
        category: action.category, date: now().slice(0, 10), source: "manual" });
      event(caseRecord, "Expense recorded", `${action.label}: ${(action.amountCents / 100).toFixed(2)} USD. Recording an expense does not move funds.`, "case");
      break;
    }
    case "sync_finances": {
      const context = await getFinancialContext();
      if (!Number.isSafeInteger(context.accountBalanceCents) || context.accountBalanceCents < 0) {
        throw new ApiError(502, "The financial provider returned an invalid account balance.");
      }
      updateSharedBalance(document, Math.max(0, context.accountBalanceCents - document.simulatedDebitsCents));
      caseRecord.expenses = [...context.expenses, ...caseRecord.expenses.filter((expense) => expense.source === "manual")];
      caseRecord.rentHistory = context.rentHistory;
      event(caseRecord, "Financial context refreshed", "Account context refreshed; simulated escrow debits remain deducted from the available balance.", "case");
      break;
    }
    case "policy_check": {
      const policy = evaluatePolicy(caseRecord, action.intent);
      appendAudit(caseRecord, action.intent, policy.approved ? "validated" : "rejected",
        `Dry run only. ${policy.checks.filter((check) => !check.passed).map((check) => check.detail).join(" ") || "All policy checks passed; no transaction was submitted."}`,
        "PolicyCheck");
      return { case: caseRecord, policy };
    }
  }
  return { case: caseRecord };
}

export async function performCaseAction(ownerId: string, caseId: string, action: CaseAction) {
  return mutateSession(ownerId, (document) => applyAction(document, findCase(document, caseId), action));
}
