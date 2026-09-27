import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  analyzeEvidence,
  classifyLandlordReply,
  getFinancialContext,
  IntegrationError,
  sendLandlordMessage,
  verifyEvidence,
} from "@/lib/integrations";
import {
  createXrplSettlement,
  executeXrplSettlement,
  reconcileXrplSettlement,
  runXrplSecurityDemo,
  XrplError,
  type XrplPending,
  type XrplReceipt,
} from "@/lib/integrations/xrpl-settlement";
import { evaluateFinancialBinding, evaluatePolicy, evaluateXrplPolicy, makeIntent, makeXrplIntent } from "@/lib/policy";
import { demoFinancialProfile } from "@/lib/financial-fixture";
import { NessieError, resolveFinancialBinding } from "@/lib/integrations/nessie";
import { getPhotonConfig, isPhotonCaseBound, prepareLandlordMessage } from "@/lib/integrations/photon";
import { createNewCase } from "@/lib/seed";
import { normalizeMessagingContact } from "@/lib/messaging-contact";
import type {
  AuditRecord,
  AuthUser,
  CaseAction,
  CaseMessage,
  CaseRecord,
  EvidenceRecord,
  LandlordReplyClassification,
  LandlordReplyIntent,
  PolicyResult,
  TimelineEvent,
  TransactionIntent,
  XrplSettlementIntent,
} from "@/lib/types";
import type { z } from "zod";
import { ApiError } from "./errors";
import { assignDemoParticipants } from "./demo-case";
import {
  assertXrplStorageCapability,
  assignCaseOwnership,
  findCase,
  mutateSession,
  updateSharedBalance,
  withXrplWalletLock,
  type SessionDocument,
  type SessionMutationContext,
} from "./store";
import type { newCaseSchema } from "./validation";
import { assertXrplWalletAvailable, readXrplJournal, recordXrplPending, recordXrplValidated } from "./xrpl-journal";
import { requireLandlordCaseAccess } from "./case-access";
import { getBuildingContext } from "./buildings";

export type CaseActionResult = { case: CaseRecord; policy?: PolicyResult };
interface MessagingDependencies {
  prepare: typeof prepareLandlordMessage;
  send: typeof sendLandlordMessage;
}
const defaultMessaging: MessagingDependencies = { prepare: prepareLandlordMessage, send: sendLandlordMessage };

function now() { return new Date().toISOString(); }

function event(caseRecord: CaseRecord, title: string, detail: string, kind: TimelineEvent["kind"]) {
  caseRecord.timeline.push({ id: randomUUID(), title, detail, kind, createdAt: now() });
  caseRecord.updatedAt = now();
}

function updateStatus(caseRecord: CaseRecord) {
  caseRecord.status = caseRecord.escrow.status === "released" ? "resolved"
    : caseRecord.verification?.verified ? "verified"
    : caseRecord.repairReported ? "verification"
    : caseRecord.messages.some((message) => ["demo", "sent", "received"].includes(message.delivery)) || caseRecord.escrow.status === "locked" ? "awaiting_repair"
    : "open";
}

function invalidateVerification(caseRecord: CaseRecord) {
  delete caseRecord.verification;
  caseRecord.tenantConfirmed = false;
  for (const evidence of caseRecord.evidence) {
    if (evidence.analysis) evidence.analysis.verified = false;
  }
  updateStatus(caseRecord);
}

async function analyzeAndRecordEvidence(caseRecord: CaseRecord, evidence: EvidenceRecord): Promise<IntegrationError | undefined> {
  invalidateVerification(caseRecord);
  try {
    // Only the adapter's validated analysis is assigned; never merge model data into a case.
    evidence.analysis = await analyzeEvidence(evidence, caseRecord);
    delete evidence.analysisError;
    event(caseRecord, evidence.isDemo ? "Sample evidence analyzed" : "Gemini AI analysis recorded", evidence.analysis.summary, "evidence");
  } catch (error) {
    if (!(error instanceof IntegrationError)) throw error;
    delete evidence.analysis;
    evidence.analysisError = {
      message: error.message, code: error.code,
      retryable: error.code !== "invalid_input", attemptedAt: now(),
    };
    event(caseRecord, "Evidence analysis unavailable", "The upload is saved and remains unverified. Review the analysis error before retrying.", "evidence");
    return error;
  }
}

const REPLY_EVENT_TITLES: Record<LandlordReplyIntent, string> = {
  scheduled: "Repair visit scheduled",
  repair_complete: "Repair reported complete",
  question: "Landlord asked a question",
  refusal: "Landlord declined the repair",
  other: "Landlord replied",
};

// A landlord reply can move the case into verification but never touches escrow; release still requires verified evidence.
function applyLandlordReply(caseRecord: CaseRecord, body: string, delivery: CaseMessage["delivery"], classification: LandlordReplyClassification) {
  const reportsNewCompletion = classification.intent === "repair_complete" && !caseRecord.repairReported;
  const messageCount = reportsNewCompletion ? 2 : 1;
  if (caseRecord.messages.length + messageCount > 200) throw new ApiError(409, "This case has reached its demo message limit.");
  // These replies are stored application events, never an unconfirmed external
  // delivery. Marking that explicitly lets the isolated demo workspace reset.
  const message: CaseMessage = { id: randomUUID(), sender: "landlord", body, createdAt: now(), delivery, provider: "demo", classification };
  caseRecord.messages.push(message);
  const title = classification.intent === "scheduled" && classification.scheduledFor
    ? `Maintenance scheduled for ${classification.scheduledFor}`
    : REPLY_EVENT_TITLES[classification.intent];
  if (reportsNewCompletion) {
    caseRecord.repairReported = true;
    invalidateVerification(caseRecord);
    caseRecord.messages.push({
      id: randomUUID(), sender: "agent", createdAt: now(), delivery: "demo",
      body: "The landlord reported the repair complete. Please upload new evidence so the case can be verified.",
    });
  }
  updateStatus(caseRecord);
  event(caseRecord, title, body, "message");
  return message;
}

function messageFailure(caseRecord: CaseRecord, message: CaseMessage, error: unknown, dispatched: boolean): never {
  const uncertain = dispatched && (!(error instanceof IntegrationError) || error.code === "uncertain_delivery");
  message.delivery = uncertain ? "uncertain" : "failed";
  message.failureReason = uncertain
    ? "Delivery could not be confirmed. Check the provider conversation; this attempt will not be retried automatically."
    : error instanceof IntegrationError ? error.message : "The messaging provider could not start this send.";
  event(caseRecord, uncertain ? "Message delivery uncertain" : "Message not sent", message.failureReason, "message");
  updateStatus(caseRecord);
  throw new ApiError(error instanceof IntegrationError && error.code === "rejected" ? 409 : 503,
    message.failureReason, true, uncertain ? "MESSAGE_DELIVERY_UNCERTAIN" : "MESSAGE_SEND_FAILED", undefined, caseRecord);
}

async function sendApprovedMessage(
  document: SessionDocument,
  caseRecord: CaseRecord,
  action: Extract<CaseAction, { action: "send_message" }>,
  mutation: SessionMutationContext,
  messaging: MessagingDependencies,
): Promise<CaseActionResult> {
  if (action.approved !== true || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(action.requestId ?? "")) {
    throw new ApiError(400, "Review and explicitly approve this message before sending it.", false, "MESSAGE_APPROVAL_REQUIRED");
  }
  const body = typeof action.body === "string" ? action.body.trim() : "";
  if (!body || body.length > 5_000) throw new ApiError(400, "Messages must contain 1 to 5,000 characters.");
  console.info("Photon send attempt", {
    caseId: caseRecord.id, tenant: { ownerId: caseRecord.ownerId, ...caseRecord.tenant },
    tenantName: caseRecord.tenantName ?? caseRecord.tenant?.name,
    landlordName: caseRecord.landlordName, landlordContact: caseRecord.landlordContact,
    normalizedRecipient: normalizeMessagingContact(caseRecord.landlordContact) ?? null,
    allowedRecipient: normalizeMessagingContact(process.env.PHOTON_ALLOWED_RECIPIENT) ?? null,
    provider: process.env.PHOTON_LIVE_SEND === "true" ? "spectrum" : "demo",
  });
  const previous = document.cases.flatMap((item) => item.messages.map((message) => ({ record: item, message })))
    .find(({ message }) => message.requestId === action.requestId);
  if (previous && previous.record.id !== caseRecord.id) {
    throw new ApiError(409, "This send request belongs to another case.", false, "MESSAGE_REQUEST_CONFLICT");
  }
  const recipient = normalizeMessagingContact(caseRecord.landlordContact) ?? "";
  const attempt: CaseMessage = {
    id: randomUUID(), sender: "tenant", body, createdAt: now(), attemptedAt: now(),
    delivery: "pending", provider: process.env.PHOTON_LIVE_SEND === "true" ? "spectrum" : "demo",
    caseId: caseRecord.id, recipient, requestId: action.requestId,
  };
  let prepared: ReturnType<typeof prepareLandlordMessage>;
  try { prepared = messaging.prepare(caseRecord, body); }
  catch (error) {
    if (previous) throw new ApiError(409, "This request already has a recorded result. Refresh the case before taking another action.", false,
      "MESSAGE_REQUEST_CONFLICT", undefined, caseRecord);
    if (caseRecord.messages.length >= 200) throw new ApiError(409, "This case has reached its message limit.");
    caseRecord.messages.push(attempt);
    messageFailure(caseRecord, attempt, error, false);
  }
  if (previous) {
    if (previous.message.body !== prepared.body || normalizeMessagingContact(previous.message.recipient) !== prepared.recipient) {
      throw new ApiError(409, "This request ID was already used for different message content or a different recipient.", false,
        "MESSAGE_REQUEST_CONFLICT", undefined, caseRecord);
    }
    if (previous.message.delivery === "sent" || previous.message.delivery === "demo") return { case: caseRecord };
    throw new ApiError(409, "This send attempt is already recorded and will not be resent. Check its delivery status.", false,
      "MESSAGE_ALREADY_ATTEMPTED", undefined, caseRecord);
  }
  const sameContent = caseRecord.messages.filter((message) => message.sender === "tenant"
    && normalizeMessagingContact(message.recipient) === prepared.recipient && message.body === prepared.body);
  const legacyHashes = [recipient, caseRecord.landlordContact.trim()]
    .map((contact) => createHash("sha256").update(contact).update("\0").update(body).digest("hex"));
  if (sameContent.some((message) => message.delivery === "pending" || message.delivery === "uncertain")
    || document.uncertainDeliveries?.some((attempt) => attempt.caseId === caseRecord.id && legacyHashes.includes(attempt.messageHash))) {
    throw new ApiError(409, "This message has a pending or uncertain delivery. Check the provider conversation before taking further action.", false,
      "MESSAGE_DELIVERY_UNCERTAIN", undefined, caseRecord);
  }
  if (sameContent.some((message) => message.provider === prepared.provider
    && (message.delivery === "sent" || message.delivery === "demo"))) return { case: caseRecord };
  if (caseRecord.messages.length >= 200) throw new ApiError(409, "This case has reached its message limit.");
  Object.assign(attempt, prepared);
  caseRecord.messages.push(attempt);
  event(caseRecord, "Message approved", "Tenant approved the recorded message and recipient. Delivery has not yet been confirmed.", "message");
  // Persist the reservation before dispatch so a crash or Mongo CAS conflict cannot cause a blind resend.
  await mutation.checkpoint();
  try {
    const result = await messaging.send(caseRecord, body);
    Object.assign(attempt, result);
    delete attempt.failureReason;
  } catch (error) { messageFailure(caseRecord, attempt, error, true); }
  event(caseRecord, attempt.delivery === "demo" ? "Notice saved in demo" : "Notice sent", attempt.body, "message");
  updateStatus(caseRecord);
  return { case: caseRecord };
}

function assertMutable(caseRecord: CaseRecord) {
  if (caseRecord.status === "resolved" || caseRecord.escrow.status === "released") {
    throw new ApiError(409, "This case is resolved and cannot be changed. Start a new case for another issue.");
  }
}

async function assertNoPendingSettlement(caseRecord: CaseRecord) {
  const journal = caseRecord.xrplSettlement ? await readXrplJournal(caseRecord.xrplSettlement) : null;
  if (caseRecord.xrplSettlement?.status === "pending") {
    throw new ApiError(409, "Reconcile the pending XRPL transaction before changing this case.",
      false, "SETTLEMENT_PENDING");
  }
  if (journal?.status === "pending") {
    throw new ApiError(409, "A durable XRPL transaction record must be reconciled before changing this case.",
      false, "SETTLEMENT_PENDING");
  }
  if (journal?.status === "validated" && caseRecord.xrplSettlement?.status !== "validated") {
    throw new ApiError(409, "Apply the durable validated XRPL receipt before changing this case.",
      false, "XRPL_RECEIPT_RECONCILIATION_REQUIRED");
  }
}

async function assertSessionNoPendingSettlement(document: SessionDocument) {
  for (const caseRecord of document.cases) await assertNoPendingSettlement(caseRecord);
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

function failedPolicyCode(policy: PolicyResult) {
  return policy.checks.find((check) => !check.passed)?.key || "XRPL_POLICY_REJECTED";
}

function policyReason(policy: PolicyResult) {
  return policy.checks.filter((check) => !check.passed).map((check) => check.detail).join(" ")
    || "The transaction did not pass XRPL settlement policy checks.";
}

function appendXrplAudit(
  caseRecord: CaseRecord,
  intent: XrplSettlementIntent,
  status: AuditRecord["status"],
  detail: string,
  options: {
    code?: string; hash?: string; ledgerIndex?: number; result?: string;
    validated?: boolean; signed?: boolean; submitted?: boolean;
  } = {},
) {
  const settlement = caseRecord.xrplSettlement;
  caseRecord.escrow.audit.push({
    id: randomUUID(), action: "Payment", status, createdAt: now(), network: "testnet",
    caseId: caseRecord.id, amountCents: intent.amountUsdCents, source: intent.source,
    attemptedCaseId: intent.caseId, settlementId: intent.settlementId,
    requestedAction: intent.requestedAction, requestedTransactionType: intent.transactionType,
    requestedNetwork: intent.network,
    destination: intent.destination, amountDrops: intent.amountDrops,
    approvedAmountDrops: settlement?.amountDrops, detail, ...options,
  });
  caseRecord.updatedAt = now();
}

function applyXrplReceipt(caseRecord: CaseRecord, receipt: XrplReceipt) {
  const settlement = caseRecord.xrplSettlement;
  if (!settlement) throw new ApiError(500, "The XRPL receipt has no case settlement authorization.", false, "XRPL_RECEIPT_MISMATCH");
  if (settlement.status === "validated") {
    if (settlement.hash !== receipt.hash) {
      throw new ApiError(500, "The stored XRPL receipt does not match the durable receipt.", false, "XRPL_RECEIPT_MISMATCH");
    }
    return;
  }
  settlement.status = "validated";
  settlement.hash = receipt.hash;
  settlement.ledgerIndex = receipt.ledgerIndex;
  settlement.result = receipt.result;
  settlement.validatedAt = receipt.validatedAt;
  settlement.detail = "Validated tesSUCCESS on XRPL Testnet.";
  delete settlement.errorCode;
  caseRecord.escrow.status = "released";
  caseRecord.escrow.finishHash = receipt.hash;
  caseRecord.escrow.releasedAt = receipt.validatedAt;
  const intent = makeXrplIntent(caseRecord);
  if (!caseRecord.escrow.audit.some((entry) => entry.action === "Payment"
    && entry.status === "validated" && entry.hash === receipt.hash)) {
    appendXrplAudit(caseRecord, intent, "validated", "Real Test XRP Payment reached a validated tesSUCCESS ledger result.", {
      hash: receipt.hash, ledgerIndex: receipt.ledgerIndex, result: receipt.result,
      validated: true, signed: true, submitted: true,
    });
    event(caseRecord, "XRPL Testnet settlement validated",
      `${receipt.amountDrops} drops reached the authorized recipient. Transaction ${receipt.hash}.`, "escrow");
  }
  updateStatus(caseRecord);
}

function rejectXrplPolicy(
  caseRecord: CaseRecord,
  intent: XrplSettlementIntent,
  policy: PolicyResult,
  explicitCode?: string,
): never {
  const code = explicitCode ?? failedPolicyCode(policy);
  const detail = policyReason(policy);
  appendXrplAudit(caseRecord, intent, "rejected", detail, { code, signed: false, submitted: false });
  throw new ApiError(409, detail, true, code, policy, caseRecord);
}

function throwXrplError(caseRecord: CaseRecord, intent: XrplSettlementIntent, error: unknown): never {
  const settlement = caseRecord.xrplSettlement;
  const xrplError = error instanceof XrplError ? error : undefined;
  const code = xrplError?.reason || "XRPL_EXECUTION_FAILED";
  const detail = error instanceof Error ? error.message : "XRPL settlement failed before validation.";
  const pending = settlement?.status === "pending";
  if (settlement) {
    settlement.errorCode = code;
    settlement.detail = detail;
    if (!pending) settlement.status = "failed";
    if (xrplError?.ledgerResult) {
      settlement.status = "failed";
      settlement.result = xrplError.ledgerResult;
    }
  }
  appendXrplAudit(caseRecord, intent, xrplError?.policy && !xrplError.policy.approved ? "rejected" : "failed",
    detail, { code, hash: xrplError?.submittedHash, signed: pending || Boolean(xrplError?.submittedHash),
      submitted: Boolean(xrplError?.submittedHash), validated: Boolean(xrplError?.ledgerResult),
      result: xrplError?.ledgerResult });
  const temporarilyUnavailable = ["XRPL_VALIDATION_PENDING", "XRPL_SUBMISSION_UNCERTAIN", "XRPL_UNAVAILABLE"]
    .includes(code);
  throw new ApiError(temporarilyUnavailable ? 503 : 409, detail, true,
    code, xrplError?.policy, caseRecord);
}

function financialFailure(caseRecord: CaseRecord, intent: TransactionIntent, policy: PolicyResult): never {
  const reason = policy.checks.filter((check) => !check.passed).map((check) => check.detail).join(" ");
  const action = intent.transactionType === "EscrowCreate" ? "EscrowCreate" : "EscrowFinish";
  const detail = `${policy.reasonCodes?.join(", ") || "POLICY_REJECTED"}: ${reason || "Policy rejected this transaction."}`;
  appendAudit(caseRecord, intent, "rejected", detail, action);
  throw new ApiError(409, detail, true);
}

async function refreshFinancialProfile(caseRecord: CaseRecord): Promise<void> {
  const previous = caseRecord.financialProfile;
  try {
    const context = await getFinancialContext(caseRecord);
    const sameBinding = previous?.binding.source === context.profile.binding.source
      && previous.binding.accountId === context.profile.binding.accountId && previous.binding.customerId === context.profile.binding.customerId;
    const reviewed = new Map((sameBinding ? previous.transactions : []).filter((item) => item.relatedStatus !== "suggested" && item.source === context.profile.binding.source).map((item) => [item.id, item]));
    context.profile.transactions = context.profile.transactions.map((item) => {
      const prior = reviewed.get(item.id);
      if (!prior) return item;
      const confirmed = caseRecord.expenses.find((expense) => expense.transactionId === item.id);
      const changed = prior.relatedStatus === "confirmed" && confirmed && (confirmed.amountCents !== item.amountCents
        || confirmed.label !== item.label || confirmed.date !== item.date || confirmed.category !== item.category);
      return { ...item, relatedStatus: prior.relatedStatus,
        ...(confirmed ? { confirmedAmountCents: confirmed.amountCents } : {}),
        ...(changed ? { providerStatus: "changed" as const,
          reviewNote: `The provider changed this transaction. The original tenant-confirmed issue cost remains ${(confirmed.amountCents / 100).toFixed(2)} USD; this refreshed amount has not replaced it.` } : {}),
      };
    });
    for (const item of reviewed.values()) {
      if (!context.profile.transactions.some((current) => current.id === item.id)) {
        const confirmed = caseRecord.expenses.find((expense) => expense.transactionId === item.id);
        context.profile.transactions.push({ ...item, providerStatus: "missing",
          ...(confirmed ? { confirmedAmountCents: confirmed.amountCents } : {}),
          reviewNote: "Archived review snapshot. This transaction is no longer returned in the provider's completed purchases. Any previously confirmed issue cost is retained unchanged, not reverified." });
      }
    }
    caseRecord.financialProfile = context.profile;
    caseRecord.rentHistory = context.rentHistory;
    // Legacy automatic imports were never tenant-confirmed issue costs.
    caseRecord.expenses = caseRecord.expenses.filter((item) => item.source !== "nessie" || !!item.transactionId);
  } catch (error) {
    if (!(error instanceof NessieError)) throw error;
    let binding = previous?.binding ?? demoFinancialProfile(caseRecord.ownerId, caseRecord.id).binding;
    try { binding = resolveFinancialBinding(caseRecord); } catch { /* Retain the rejected binding for inspection. */ }
    caseRecord.financialProfile = {
      binding, status: ["NESSIE_NOT_CONFIGURED", "NESSIE_API_UNAVAILABLE"].includes(error.reasonCode) ? "unavailable" : "rejected",
      reasonCode: error.reasonCode, detail: error.message, checkedAt: new Date().toISOString(),
      customerVerified: false, accountVerified: false, ownershipVerified: false, transactions: previous?.transactions ?? [],
    };
  }
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
  const building = { ...await getBuildingContext(input.address, input.borough), address: input.address, borough: input.borough };
  return mutateSession(ownerId, async (document) => {
    await assertSessionNoPendingSettlement(document);
    if (document.cases.length >= 20) throw new ApiError(409, "This demo allows up to 20 cases per session.");
    const caseRecord = assignDemoParticipants(createNewCase(ownerId, { ...input, building }));
    assignCaseOwnership(document, caseRecord);
    caseRecord.accountBalanceCents = document.accountBalanceCents;
    document.cases.push(caseRecord);
    return caseRecord;
  });
}

/** Creates a case only after contracts.ts has checked the current session's acceptance record. */
export async function createContractCase(
  ownerId: string,
  input: z.infer<typeof newCaseSchema>,
  contractId: string,
) {
  const building = { ...await getBuildingContext(input.address, input.borough), address: input.address, borough: input.borough };
  return mutateSession(ownerId, async (document) => {
    await assertSessionNoPendingSettlement(document);
    if (document.cases.length >= 20) throw new ApiError(409, "This demo allows up to 20 cases per session.");
    const contract = document.contracts?.find((item) => item.id === contractId);
    if (!contract || contract.status !== "active" || contract.caseId) {
      throw new ApiError(409, "A fully accepted unused contract is required before creating a case.");
    }
    const caseRecord = createNewCase(ownerId, { ...input, building });
    assignCaseOwnership(document, caseRecord);
    caseRecord.case_type = contract.case_type;
    if (contract.case_type === "self_documentation") {
      // No destination wallet is recorded or approved for a tenant-only case.
      caseRecord.escrow.destination = "";
      delete caseRecord.landlordUserId;
    }
    caseRecord.accountBalanceCents = document.accountBalanceCents;
    document.cases.push(caseRecord);
    contract.status = "used";
    contract.caseId = caseRecord.id;
    return caseRecord;
  });
}

export async function addUploadedEvidence(ownerId: string, caseId: string, evidence: EvidenceRecord) {
  return mutateSession(ownerId, async (document, mutation) => {
    const caseRecord = findCase(document, caseId);
    await assertNoPendingSettlement(caseRecord);
    assertMutable(caseRecord);
    assertCapacity(caseRecord);
    if (document.tenantUserId) {
      evidence.uploadedByRole = "tenant";
      evidence.uploadedByUserId = document.tenantUserId;
    }
    caseRecord.evidence.push(evidence);
    invalidateVerification(caseRecord);
    event(caseRecord, "Evidence uploaded", `${evidence.name} added as ${evidence.stage} evidence.`, "evidence");
    // Keep the upload even if the provider times out or the request is interrupted.
    await mutation.checkpoint();
    await analyzeAndRecordEvidence(caseRecord, evidence);
    return caseRecord;
  });
}

export type LandlordAction =
  | { action: "message"; body: string }
  | { action: "schedule"; scheduledFor: string; notes: string }
  | { action: "report_complete"; notes: string };

/** The role is rechecked inside the same serialized mutation as case assignment. */
export async function performLandlordAction(ownerId: string, caseId: string, user: AuthUser, action: LandlordAction) {
  return mutateSession(ownerId, async (document) => {
    const record = findCase(document, caseId);
    requireLandlordCaseAccess(user, record);
    await assertSessionNoPendingSettlement(document);
    assertMutable(record);
    const repairs = record.repairs ??= [];
    if (repairs.length >= 200) throw new ApiError(409, "This case has reached its repair action limit.");
    if (action.action === "message") {
      // Untrusted text is communication only. Structured actions control repair status.
      applyLandlordReply(record, action.body, "received", {
        intent: "other", summary: "Message from the assigned property manager.", source: "rules",
      });
    } else if (action.action === "schedule") {
      if (record.repairReported) throw new ApiError(409, "The repair is awaiting tenant verification.");
      repairs.push({ id: randomUUID(), caseId, landlordUserId: user.id, kind: "scheduled",
        createdAt: now(), scheduledFor: action.scheduledFor, notes: action.notes });
      applyLandlordReply(record, action.notes, "received", {
        intent: "scheduled", scheduledFor: action.scheduledFor, summary: "Maintenance scheduled by the assigned property manager.", source: "rules",
      });
    } else {
      if (record.repairReported) return record;
      repairs.push({ id: randomUUID(), caseId, landlordUserId: user.id, kind: "reported_complete",
        createdAt: now(), notes: action.notes,
        evidenceId: record.evidence.filter((item) => item.uploadedByUserId === user.id).at(-1)?.id });
      applyLandlordReply(record, action.notes, "received", {
        intent: "repair_complete", summary: "The assigned property manager reported the repair complete.", source: "rules",
      });
    }
    return record;
  });
}

export async function addLandlordEvidence(ownerId: string, caseId: string, user: AuthUser, upload: EvidenceRecord) {
  return mutateSession(ownerId, async (document, mutation) => {
    const record = findCase(document, caseId);
    requireLandlordCaseAccess(user, record);
    await assertSessionNoPendingSettlement(document);
    assertMutable(record);
    if (record.verification?.verified || record.tenantConfirmed) {
      throw new ApiError(409, "Tenant verification is already complete. Send a case message to discuss any further evidence.", false, "TENANT_VERIFICATION_PRESERVED");
    }
    assertCapacity(record);
    if ((record.repairs?.length ?? 0) >= 200) throw new ApiError(409, "This case has reached its repair action limit.");
    // Landlord uploads can never satisfy the tenant's before/after evidence requirement.
    const evidence: EvidenceRecord = { ...upload, stage: "other", uploadedByRole: "landlord", uploadedByUserId: user.id };
    record.evidence.push(evidence);
    (record.repairs ??= []).push({ id: randomUUID(), caseId, landlordUserId: user.id, kind: "evidence_uploaded",
      createdAt: now(), notes: evidence.note, evidenceId: evidence.id });
    invalidateVerification(record);
    event(record, "Property manager uploaded repair evidence", evidence.name, "evidence");
    await mutation.checkpoint();
    await analyzeAndRecordEvidence(record, evidence);
    return record;
  });
}

async function applyAction(
  document: SessionDocument,
  caseRecord: CaseRecord,
  action: CaseAction,
  mutation: SessionMutationContext,
  messaging: MessagingDependencies,
): Promise<CaseActionResult> {
  if (action.action === "xrpl_security_demo") {
    if (!caseRecord.xrplSettlement) {
      throw new ApiError(409, "Enable XRPL Testnet settlement before running its security demonstrations.", false,
        "XRPL_NOT_ENABLED");
    }
    const demonstration = runXrplSecurityDemo(caseRecord, document.ownerId, action.scenario);
    const scenarioCode: Record<typeof action.scenario, string> = {
      wallet_switch: "DESTINATION_WALLET_MISMATCH",
      amount_tamper: "AMOUNT_OUTSIDE_AUTHORIZATION",
      prompt_injection: "DESTINATION_WALLET_MISMATCH",
      insufficient_funds: "INSUFFICIENT_XRPL_FUNDS",
      duplicate: "SETTLEMENT_ALREADY_COMPLETED",
      wrong_network: "WRONG_NETWORK",
      wrong_case: "WRONG_CASE",
      unsupported_action: "ACTION_OUTSIDE_PERMISSION_SCOPE",
    };
    const targeted = demonstration.policy.checks.find((check) => check.key === scenarioCode[action.scenario] && !check.passed);
    if (targeted) {
      demonstration.policy.checks = [targeted, ...demonstration.policy.checks.filter((check) => check !== targeted)];
    }
    const status = demonstration.policy.approved ? "validated" : "rejected";
    appendXrplAudit(caseRecord, demonstration.intent, status,
      `Security demo only. ${demonstration.detail}`, {
        code: demonstration.policy.approved ? undefined : scenarioCode[action.scenario],
        signed: false, submitted: false,
      });
    event(caseRecord, demonstration.policy.approved ? "XRPL security check passed" : "XRPL attack blocked",
      demonstration.detail, "escrow");
    return { case: caseRecord, policy: demonstration.policy };
  }
  if (caseRecord.xrplSettlement?.status === "pending"
    && action.action !== "settle_xrpl" && action.action !== "reconcile_xrpl") {
    await assertNoPendingSettlement(caseRecord);
  } else if (action.action !== "settle_xrpl" && action.action !== "reconcile_xrpl") {
    await assertSessionNoPendingSettlement(document);
  }
  if (action.action === "settle_xrpl") {
    const settlement = caseRecord.xrplSettlement;
    if (!settlement) throw new ApiError(409, "Enable XRPL Testnet settlement first.", false, "XRPL_NOT_ENABLED");
    if (settlement.status !== "pending" && settlement.status !== "validated") {
      // Refresh trusted customer/account ownership at the last server boundary before policy and signing.
      // The adapter rechecks the resulting immutable snapshot immediately before it signs.
      await refreshFinancialProfile(caseRecord);
    }
    return withXrplWalletLock(settlement.source, async () => {
      const journal = await readXrplJournal(settlement);
      if (journal?.status === "validated" && journal.receipt) {
        applyXrplReceipt(caseRecord, journal.receipt);
        const duplicatePolicy = evaluateXrplPolicy(caseRecord, makeXrplIntent(caseRecord), document.ownerId);
        rejectXrplPolicy(caseRecord, makeXrplIntent(caseRecord), duplicatePolicy,
          "SETTLEMENT_ALREADY_COMPLETED");
      }
      if (journal?.status === "pending") {
        Object.assign(settlement, {
          status: "pending", hash: journal.pending.hash, sequence: journal.pending.sequence,
          lastLedgerSequence: journal.pending.lastLedgerSequence,
          detail: "A durable pending transaction must be reconciled before any signing retry.",
        });
        const pendingPolicy = evaluateXrplPolicy(caseRecord, makeXrplIntent(caseRecord), document.ownerId);
        rejectXrplPolicy(caseRecord, makeXrplIntent(caseRecord), pendingPolicy, "SETTLEMENT_PENDING");
      }
      await assertXrplWalletAvailable(settlement.source);
      const intent = Object.freeze(makeXrplIntent(caseRecord));
      const policy = evaluateXrplPolicy(caseRecord, intent, document.ownerId);
      if (!policy.approved) rejectXrplPolicy(caseRecord, intent, policy);
      let persistedPending: XrplPending | undefined;
      try {
        const receipt = await executeXrplSettlement({
          ownerId: document.ownerId,
          loadCase: async () => structuredClone(caseRecord),
          beforeSubmit: async (pending) => {
            const finalPolicy = evaluateXrplPolicy(caseRecord, pending.intent, document.ownerId);
            if (!finalPolicy.approved) rejectXrplPolicy(caseRecord, pending.intent, finalPolicy);
            await recordXrplPending(settlement, pending);
            persistedPending = pending;
            Object.assign(settlement, {
              status: "pending", hash: pending.hash, sequence: pending.sequence,
              lastLedgerSequence: pending.lastLedgerSequence,
              detail: `Signed transaction prepared at ledger ${pending.preparedLedgerIndex}; durable reconciliation is required after submission.`,
            });
            event(caseRecord, "XRPL transaction prepared",
              "The signed transaction hash was durably recorded before network submission.", "escrow");
            await mutation.checkpoint();
          },
        });
        if (!persistedPending) {
          throw new ApiError(500, "The XRPL adapter returned a receipt without a durable pending checkpoint.", false,
            "XRPL_JOURNAL_MISMATCH");
        }
        await recordXrplValidated(settlement, persistedPending, receipt);
        applyXrplReceipt(caseRecord, receipt);
        return { case: caseRecord, policy };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throwXrplError(caseRecord, intent, error);
      }
    });
  }
  if (action.action === "reconcile_xrpl") {
    const settlement = caseRecord.xrplSettlement;
    if (!settlement) throw new ApiError(409, "Enable XRPL Testnet settlement first.", false, "XRPL_NOT_ENABLED");
    return withXrplWalletLock(settlement.source, async () => {
      const journal = await readXrplJournal(settlement);
      if (journal?.status === "validated" && journal.receipt) {
        applyXrplReceipt(caseRecord, journal.receipt);
        return { case: caseRecord };
      }
      if (!journal || journal.status !== "pending") {
        throw new ApiError(409, "There is no durable pending XRPL transaction to reconcile.", false,
          "XRPL_NOT_PENDING");
      }
      Object.assign(settlement, {
        status: "pending", hash: journal.pending.hash, sequence: journal.pending.sequence,
        lastLedgerSequence: journal.pending.lastLedgerSequence,
      });
      const intent = journal.pending.intent;
      try {
        const receipt = await reconcileXrplSettlement({
          ownerId: document.ownerId,
          loadCase: async () => structuredClone(caseRecord),
          beforeSubmit: async () => {
            throw new ApiError(500, "Reconciliation cannot submit or sign another transaction.", false,
              "XRPL_RECONCILE_SUBMISSION_BLOCKED");
          },
        }, journal.pending);
        await recordXrplValidated(settlement, journal.pending, receipt);
        applyXrplReceipt(caseRecord, receipt);
        return { case: caseRecord };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throwXrplError(caseRecord, intent, error);
      }
    });
  }
  if (action.action === "release_escrow" && caseRecord.escrow.status === "released") return { case: caseRecord };
  assertMutable(caseRecord);

  switch (action.action) {
    case "add_demo_evidence": {
      if (caseRecord.issue !== "heating") {
        throw new ApiError(409, "The provided sample evidence demonstrates a heating repair. Upload evidence for this issue.");
      }
      const completionAt = action.stage === "after"
        ? caseRecord.repairs?.filter((item) => item.kind === "reported_complete").at(-1)?.createdAt : undefined;
      if (caseRecord.evidence.some((item) => item.isDemo && item.stage === action.stage
        && (!completionAt || Date.parse(item.createdAt) >= Date.parse(completionAt)))) return { case: caseRecord };
      assertCapacity(caseRecord);
      const isAfter = action.stage === "after";
      const evidence: EvidenceRecord = {
        id: randomUUID(),
        name: isAfter ? "After repair - 72F.png" : "Before repair - 54F.png",
        mimeType: "image/png", stage: action.stage,
        note: isAfter ? "Sample heating repair evidence: indoor temperature 72 F." : "Sample heating issue evidence: indoor temperature 54 F.",
        createdAt: now(), temperatureF: isAfter ? 72 : 54, isDemo: true,
        dataUrl: isAfter ? "/evidence-after.png" : "/evidence-before.png",
        ...(document.tenantUserId ? { uploadedByRole: "tenant" as const, uploadedByUserId: document.tenantUserId } : {}),
      };
      caseRecord.evidence.push(evidence);
      invalidateVerification(caseRecord);
      event(caseRecord, "Sample evidence added", `${evidence.name}. Demonstration data only.`, "evidence");
      break;
    }
    case "analyze_evidence": {
      const evidence = caseRecord.evidence.find((item) => item.id === action.evidenceId);
      if (!evidence) throw new ApiError(404, "Evidence not found in this case.");
      if (evidence.analysis && (evidence.isDemo || evidence.analysis.requiresHumanConfirmation)) return { case: caseRecord };
      const error = await analyzeAndRecordEvidence(caseRecord, evidence);
      if (error) throw new ApiError(error.code === "invalid_input" ? 400 : 502, error.message, true, `GEMINI_${error.code.toUpperCase()}`, undefined, caseRecord);
      break;
    }
    case "send_message": {
      return sendApprovedMessage(document, caseRecord, action, mutation, messaging);
    }
    case "simulate_landlord_reply": {
      const completed = action.variant === "completed";
      if (completed && caseRecord.repairReported) return { case: caseRecord };
      if (!completed && caseRecord.repairReported) throw new ApiError(409, "The repair has already been reported complete.");
      const body = completed
        ? "Demo landlord reply: The heating repair is complete. Please check the apartment temperature and upload after-repair evidence."
        : "Demo landlord reply: A technician is scheduled to inspect and repair the heating system tomorrow morning.";
      if (caseRecord.messages.some((message) => message.sender === "landlord" && message.body === body)) return { case: caseRecord };
      applyLandlordReply(caseRecord, body, "demo", completed
        ? { intent: "repair_complete", summary: "The landlord reported the repair complete.", source: "demo" }
        : { intent: "scheduled", scheduledFor: "tomorrow morning", summary: "The landlord scheduled a repair visit for tomorrow morning.", source: "demo" });
      break;
    }
    case "record_landlord_reply": {
      if (caseRecord.messages.length >= 200) throw new ApiError(409, "This case has reached its demo message limit.");
      const body = action.body.trim();
      applyLandlordReply(caseRecord, body, "demo", await classifyLandlordReply(body, caseRecord));
      break;
    }
    case "create_escrow": {
      if (caseRecord.escrow.status === "locked") return { case: caseRecord };
      await refreshFinancialProfile(caseRecord);
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
      const completion = caseRecord.repairs?.filter((item) => item.kind === "reported_complete").at(-1);
      if (afterEvidence.uploadedByRole === "landlord" || (completion && Date.parse(afterEvidence.createdAt) < Date.parse(completion.createdAt))) {
        throw new ApiError(409, "Add tenant after-repair evidence captured after the property manager reported completion.");
      }
      if (caseRecord.verification?.verified) return { case: caseRecord };
      const verification = await verifyEvidence(caseRecord);
      caseRecord.verification = verification;
      // Preserve the upload's observations and provenance. Existing policy consumes
      // this flag, whose value now comes exclusively from the application comparison.
      afterEvidence.analysis.verified = verification.verified;
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
      await refreshFinancialProfile(caseRecord);
      if (caseRecord.xrplSettlement && caseRecord.xrplSettlement.status !== "validated") {
        const intent = makeXrplIntent(caseRecord);
        const evaluated = evaluateXrplPolicy(caseRecord, intent, document.ownerId);
        const policy: PolicyResult = {
          approved: false,
          checks: [...evaluated.checks, {
            key: "XRPL_SETTLEMENT_REQUIRED", label: "XRPL settlement validated", passed: false,
            detail: "The enabled Testnet payment must reach a validated tesSUCCESS result before USD release.",
          }],
        };
        appendXrplAudit(caseRecord, intent, "rejected",
          "The simulated USD escrow cannot be released while its enabled XRPL settlement is unvalidated.", {
            code: "XRPL_SETTLEMENT_REQUIRED", signed: false, submitted: false,
          });
        throw new ApiError(409,
          "Complete and validate the XRPL Testnet settlement before releasing this enabled escrow.",
          true, "XRPL_SETTLEMENT_REQUIRED", policy, caseRecord);
      }
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
    case "enable_xrpl": {
      if (caseRecord.xrplSettlement) return { case: caseRecord };
      if (caseRecord.escrow.status !== "locked") {
        throw new ApiError(409, "Fund the simulated USD escrow before enabling its XRPL settlement.", false,
          "ESCROW_NOT_FUNDED");
      }
      try {
        caseRecord.xrplSettlement = createXrplSettlement(caseRecord);
      } catch (error) {
        if (error instanceof XrplError) {
          throw new ApiError(503, error.message, false, error.reason, error.policy, caseRecord);
        }
        throw error;
      }
      event(caseRecord, "XRPL Testnet settlement enabled",
        `${caseRecord.xrplSettlement.amountDrops} drops are pinned to the authorized source and recipient for this case.`,
        "escrow");
      break;
    }
    case "add_expense": {
      if (caseRecord.expenses.length >= 200) throw new ApiError(409, "This case has reached its demo expense limit.");
      caseRecord.expenses.push({ id: randomUUID(), label: action.label, amountCents: action.amountCents,
        category: action.category, date: now().slice(0, 10), source: "manual" });
      event(caseRecord, "Expense recorded", `${action.label}: ${(action.amountCents / 100).toFixed(2)} USD. Recording an expense does not move funds.`, "case");
      break;
    }
    case "sync_finances": {
      await refreshFinancialProfile(caseRecord);
      event(caseRecord, caseRecord.financialProfile?.status === "verified" ? "Financial context refreshed" : "Financial context unavailable",
        caseRecord.financialProfile!.detail, "case");
      break;
    }
    case "confirm_transaction":
    case "dismiss_transaction": {
      const transaction = caseRecord.financialProfile?.transactions.find((item) => item.id === action.transactionId);
      if (!transaction) throw new ApiError(404, "Transaction not found in this case's financial profile.");
      const status = action.action === "confirm_transaction" ? "confirmed" : "dismissed";
      if (transaction.relatedStatus === status) return { case: caseRecord };
      if (transaction.relatedStatus !== "suggested") throw new ApiError(409, "This transaction has already been reviewed.");
      const profile = caseRecord.financialProfile!;
      if (profile.status !== "verified" || !profile.customerVerified || !profile.accountVerified || !profile.ownershipVerified
        || !profile.expiresAt || !Number.isFinite(Date.parse(profile.expiresAt)) || Date.parse(profile.expiresAt) <= Date.now()) {
        throw new ApiError(409, "NESSIE_VERIFICATION_STALE: Refresh the financial profile before reviewing transactions.");
      }
      const binding = resolveFinancialBinding(caseRecord);
      if (binding.tenantId !== profile.binding.tenantId || binding.caseId !== profile.binding.caseId
        || binding.customerId !== profile.binding.customerId || binding.accountId !== profile.binding.accountId
        || binding.source !== profile.binding.source || transaction.source !== binding.source || transaction.providerStatus === "missing") {
        throw new ApiError(409, "NESSIE_ACCOUNT_MISMATCH: This transaction is not from the current approved financial binding. Refresh the financial profile.");
      }
      if (status === "confirmed") {
        if (caseRecord.expenses.length >= 200) throw new ApiError(409, "This case has reached its expense limit.");
        if (!caseRecord.expenses.some((item) => item.transactionId === transaction.id)) {
          caseRecord.expenses.push({ id: randomUUID(), transactionId: transaction.id, label: transaction.label,
            amountCents: transaction.amountCents, date: transaction.date, category: transaction.category, source: transaction.source });
        }
      }
      transaction.relatedStatus = status;
      event(caseRecord, status === "confirmed" ? "Issue cost confirmed" : "Transaction dismissed",
        `${transaction.label}: ${(transaction.amountCents / 100).toFixed(2)} USD. ${status === "confirmed" ? "Tenant confirmed its connection to this issue." : "Excluded from issue impact."} No funds moved.`, "case");
      break;
    }
    case "check_financial_binding": {
      await refreshFinancialProfile(caseRecord);
      const intent = makeIntent(caseRecord, caseRecord.escrow.status === "unfunded" ? "EscrowCreate" : "EscrowFinish");
      if (action.scenario === "substitution") {
        intent.nessieCustomerId = "customer_attacker";
        intent.nessieAccountId = "account_bad";
      }
      const policy = evaluateFinancialBinding(caseRecord, intent);
      const detail = `Financial binding dry run (${action.scenario}). ${policy.reasonCodes?.join(", ") || "Binding verified"}. No settlement action initiated.`;
      if (!caseRecord.escrow.audit.some((item) => item.action === "PolicyCheck" && item.detail === detail)) {
        appendAudit(caseRecord, intent, policy.approved ? "validated" : "rejected", detail, "PolicyCheck");
      }
      return { case: caseRecord, policy };
    }
    case "policy_check": {
      await refreshFinancialProfile(caseRecord);
      const policy = evaluatePolicy(caseRecord, action.intent);
      appendAudit(caseRecord, action.intent, policy.approved ? "validated" : "rejected",
        `Dry run only. ${policy.checks.filter((check) => !check.passed).map((check) => check.detail).join(" ") || "All policy checks passed; no transaction was submitted."}`,
        "PolicyCheck");
      return { case: caseRecord, policy };
    }
  }
  return { case: caseRecord };
}

export interface IncomingLandlordMessage {
  id: string;
  conversationId: string;
  sender: string;
  body: string;
  createdAt: string;
  sendingLine?: string;
  replyToMessageId?: string;
}

/** Server worker only: its authenticated SDK stream must already exclude outbound and group messages. */
export async function receiveLandlordMessage(ownerId: string, caseId: string | undefined, incoming: IncomingLandlordMessage) {
  const config = getPhotonConfig();
  if (!config || ownerId !== config.tenantId) {
    throw new ApiError(403, "The incoming message is not bound to the configured tenant and case.", false, "MESSAGE_BINDING_REJECTED");
  }
  const body = typeof incoming.body === "string" ? incoming.body.trim() : "";
  const validIdentifier = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value);
  if (!validIdentifier(incoming.id) || !validIdentifier(incoming.conversationId) || !body || body.length > 5_000
    || (incoming.replyToMessageId !== undefined && !validIdentifier(incoming.replyToMessageId))
    || typeof incoming.createdAt !== "string" || !Number.isFinite(Date.parse(incoming.createdAt))
    || Date.parse(incoming.createdAt) > Date.now() + 5 * 60_000) {
    throw new ApiError(400, "The incoming message has invalid provider metadata.", false, "MESSAGE_INVALID_EVENT");
  }
  return mutateSession(ownerId, async (document) => {
    const sender = normalizeMessagingContact(incoming.sender);
    if (!sender || sender !== config.allowedRecipient) {
      throw new ApiError(403, "The sender is not the approved landlord contact for this case.", false, "MESSAGE_BINDING_REJECTED");
    }
    const matches = document.cases.flatMap((record) => record.messages
      .filter((message) => message.sender === "tenant" && message.provider === "spectrum" && message.delivery === "sent"
        && message.providerConversationId === incoming.conversationId && normalizeMessagingContact(message.recipient) === sender
        && message.sendingLine === incoming.sendingLine
        && (!incoming.replyToMessageId || message.providerMessageId === incoming.replyToMessageId))
      .map((message) => ({ record, message })));
    // Plain replies must match one case; a provider reply target can disambiguate a shared DM.
    const targetCaseId = caseId ?? matches[0]?.record.id;
    if (!targetCaseId || !matches.length || matches.some(({ record }) => record.id !== targetCaseId || record.ownerId !== ownerId)
      || (config.sendingLine && incoming.sendingLine !== config.sendingLine)) {
      throw new ApiError(403, "No unambiguous approved conversation matches this reply.", false, "MESSAGE_BINDING_REJECTED");
    }
    const caseRecord = findCase(document, targetCaseId);
    if (!isPhotonCaseBound(caseRecord, config)) {
      throw new ApiError(403, "The incoming message is not bound to the configured tenant and case.", false, "MESSAGE_BINDING_REJECTED");
    }
    const sentTimes = matches.map(({ message }) => Date.parse(message.sentAt ?? message.createdAt));
    if (sentTimes.some((value) => !Number.isFinite(value)) || Date.parse(incoming.createdAt) < Math.min(...sentTimes)
      || (incoming.replyToMessageId && !matches.some(({ message }) => message.providerMessageId === incoming.replyToMessageId))) {
      throw new ApiError(403, "This reply does not follow an approved message in the bound conversation.", false, "MESSAGE_BINDING_REJECTED");
    }
    const existing = document.cases.flatMap((record) => record.messages.map((message) => ({ record, message })))
      .find(({ message }) => message.provider === "spectrum" && message.providerMessageId === incoming.id);
    if (existing) {
      if (existing.record.id !== targetCaseId || existing.message.sender !== "landlord" || existing.message.body !== body
        || existing.message.providerConversationId !== incoming.conversationId) {
        throw new ApiError(409, "The provider message ID is already bound to different content.", false, "MESSAGE_EVENT_CONFLICT");
      }
      return { case: caseRecord };
    }
    await assertSessionNoPendingSettlement(document);
    assertMutable(caseRecord);
    if (caseRecord.messages.length >= 200) throw new ApiError(409, "This case has reached its message limit.");
    const classification = await classifyLandlordReply(body, caseRecord, new Date(incoming.createdAt));
    const message = applyLandlordReply(caseRecord, body, "received", classification);
    Object.assign(message, { provider: "spectrum", caseId: targetCaseId, recipient: sender,
      providerMessageId: incoming.id, providerConversationId: incoming.conversationId,
      sendingLine: incoming.sendingLine, createdAt: new Date(incoming.createdAt).toISOString() });
    return { case: caseRecord };
  });
}

export async function performCaseAction(ownerId: string, caseId: string, action: CaseAction, messaging = defaultMessaging) {
  return mutateSession(ownerId, (document, mutation) => {
    const caseRecord = findCase(document, caseId);
    if (document.tenantUserId && (action.action === "simulate_landlord_reply" || action.action === "record_landlord_reply")) {
      throw new ApiError(403, "Landlord replies and repair reports must come from the assigned property manager.", false, "ROLE_NOT_ALLOWED");
    }
    const xrplAction = action.action === "enable_xrpl" || action.action === "settle_xrpl"
      || action.action === "reconcile_xrpl" || action.action === "xrpl_security_demo";
    if (xrplAction && document.tenantUserId && document.xrplAuthorized !== true) {
      throw new ApiError(403, "This tenant workspace is not authorized to use the configured XRPL signer.", false,
        "XRPL_ACCOUNT_NOT_AUTHORIZED");
    }
    if (action.action === "enable_xrpl") assertXrplStorageCapability();
    return applyAction(document, caseRecord, action, mutation, messaging);
  });
}
