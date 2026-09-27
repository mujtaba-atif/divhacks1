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
import { NessieError, resolveFinancialBinding } from "@/lib/integrations/nessie";
import { failedFinancialProfile, nessiePolicyContext } from "./nessie-verification";
import {
  getPhotonConfig,
  isPhotonCaseBound,
  isPhotonParticipantBound,
  isPhotonDirectConversation,
  photonBindingChecks,
  prepareLandlordMessage,
  prepareParticipantMessage,
  sendParticipantMessage,
} from "@/lib/integrations/photon";
import { buildAgentRelay, buildShortReplyRelay, classifyParticipantMessage } from "@/lib/integrations/messaging-agent";
import { matchesSpectrumSendingLine, SpectrumLineUncertainError } from "@/lib/integrations/spectrum";
import { createNewCase } from "@/lib/seed";
import { maskMessagingContact, normalizeMessagingContact } from "@/lib/messaging-contact";
import type {
  AuditRecord,
  AuthUser,
  CaseAction,
  CaseMessage,
  CaseRecord,
  EvidenceRecord,
  LandlordReplyClassification,
  LandlordReplyIntent,
  MessagingRole,
  ParticipantMessageInterpretation,
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
  readSession,
  updateSharedBalance,
  withXrplWalletLock,
  type SessionDocument,
  type SessionMutationContext,
} from "./store";
import type { newCaseSchema } from "./validation";
import { assertXrplWalletAvailable, readXrplJournal, recordXrplPending, recordXrplValidated } from "./xrpl-journal";
import { requireLandlordCaseAccess } from "./case-access";
import { getBuildingContext } from "./buildings";
import { proposeContractAgentSettlement, proposeXrplAgentSettlement } from "./xrpl-agent";
import { evaluateContractFeeRequest, evaluateContractPolicy, isActiveContract } from "./contract-policy";
import type { ContractPolicyDecision } from "@/lib/contract-types";
import { formatSettlementAsset, sameAssetPermission } from "@/lib/xrpl-assets";

export type CaseActionResult = { case: CaseRecord; policy?: PolicyResult };
interface MessagingDependencies {
  prepare: typeof prepareLandlordMessage;
  send: typeof sendLandlordMessage;
}
const defaultMessaging: MessagingDependencies = { prepare: prepareLandlordMessage, send: sendLandlordMessage };

export interface ParticipantMessagingDependencies {
  prepare: typeof prepareParticipantMessage;
  send: typeof sendParticipantMessage;
  classify: typeof classifyParticipantMessage;
  relay: typeof buildAgentRelay;
}
const defaultParticipantMessaging: ParticipantMessagingDependencies = {
  prepare: prepareParticipantMessage,
  send: sendParticipantMessage,
  classify: classifyParticipantMessage,
  relay: buildAgentRelay,
};

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
    ? error instanceof SpectrumLineUncertainError ? error.message
      : "Delivery could not be confirmed. Check the provider conversation; this attempt will not be retried automatically."
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
    caseId: caseRecord.id, tenant: { ownerId: caseRecord.ownerId, name: caseRecord.tenant?.name,
      phone: maskMessagingContact(caseRecord.tenant?.phone) },
    tenantName: caseRecord.tenantName ?? caseRecord.tenant?.name,
    landlordName: caseRecord.landlordName, landlordContact: maskMessagingContact(caseRecord.landlordContact),
    normalizedRecipient: maskMessagingContact(caseRecord.landlordContact),
    allowedRecipient: maskMessagingContact(process.env.PHOTON_ALLOWED_RECIPIENT),
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
    recipientUserId: caseRecord.messagingBinding?.landlord?.userId,
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
    const landlordBinding = caseRecord.messagingBinding?.landlord;
    if (attempt.delivery === "sent" && landlordBinding && attempt.providerConversationId && attempt.sendingLine) {
      landlordBinding.conversationId = attempt.providerConversationId;
      landlordBinding.sendingLine = attempt.sendingLine;
    }
  } catch (error) { messageFailure(caseRecord, attempt, error, true); }
  event(caseRecord, attempt.delivery === "demo" ? "Notice saved in demo" : "Notice sent", attempt.body, "message");
  updateStatus(caseRecord);
  return { case: caseRecord };
}

function participantSendFailure(caseRecord: CaseRecord, message: CaseMessage, error: unknown, dispatched: boolean): void {
  const uncertain = dispatched && (!(error instanceof IntegrationError) || error.code === "uncertain_delivery");
  message.delivery = uncertain ? "uncertain" : "failed";
  message.failureReason = uncertain
    ? error instanceof SpectrumLineUncertainError ? error.message
      : "Delivery could not be confirmed. Check the provider conversation; this attempt will not be retried automatically."
    : error instanceof IntegrationError ? error.message : "The messaging provider could not start this send.";
  event(caseRecord, uncertain ? "Agent relay delivery uncertain" : "Agent relay not sent", message.failureReason, "message");
}

async function sendAgentParticipantMessage(
  caseRecord: CaseRecord,
  role: MessagingRole,
  body: string,
  triggerMessageId: string,
  mutation: SessionMutationContext,
  messaging: ParticipantMessagingDependencies,
  originatingAgent: MessagingRole = role,
): Promise<CaseMessage> {
  const participant = caseRecord.messagingBinding?.[role];
  const existing = caseRecord.messages.find((message) => message.sender === "agent"
    && message.triggerMessageId === triggerMessageId
    && (!participant || message.recipientUserId === participant.userId));
  if (existing) return existing;
  if (caseRecord.messages.length >= 200) throw new ApiError(409, "This case has reached its message limit.");
  const attempt: CaseMessage = {
    id: randomUUID(), sender: "agent", originatingAgent, body: body.trim(), createdAt: now(), attemptedAt: now(),
    delivery: "pending", provider: process.env.PHOTON_LIVE_SEND === "true" ? "spectrum" : "demo",
    caseId: caseRecord.id, recipient: normalizeMessagingContact(participant?.phone) ?? "",
    recipientUserId: participant?.userId, triggerMessageId,
  };
  try {
    const { role: _preparedRole, ...prepared } = messaging.prepare(caseRecord, role, body);
    Object.assign(attempt, prepared);
  } catch (error) {
    caseRecord.messages.push(attempt);
    participantSendFailure(caseRecord, attempt, error, false);
    return attempt;
  }
  caseRecord.messages.push(attempt);
  event(caseRecord, "Agent relay reserved", "The mediated participant message was recorded before delivery.", "message");
  await mutation.checkpoint();
  try {
    const { role: _resultRole, ...result } = await messaging.send(caseRecord, role, body);
    Object.assign(attempt, result);
    delete attempt.failureReason;
    if (attempt.delivery === "sent" && participant && attempt.providerConversationId && attempt.sendingLine) {
      participant.conversationId = attempt.providerConversationId;
      participant.sendingLine = attempt.sendingLine;
    }
    event(caseRecord, attempt.delivery === "demo" ? "Agent relay saved in demo" : "Agent relay sent",
      `The ${role} participant notification was recorded.`, "message");
  } catch (error) {
    participantSendFailure(caseRecord, attempt, error, true);
  }
  updateStatus(caseRecord);
  return attempt;
}

function caseCreationNotice(caseRecord: CaseRecord): string {
  const tenant = caseRecord.tenantDisplayName ?? caseRecord.tenantName ?? caseRecord.tenant?.name ?? "The tenant";
  const temperature = [...caseRecord.evidence].reverse().find((item) => item.temperatureF !== undefined)?.temperatureF;
  const location = `${caseRecord.building.address}${caseRecord.apartment ? `, Apt ${caseRecord.apartment}` : ""}`;
  return `RentEscrow case ${caseRecord.id}: ${tenant} reported ${caseRecord.title || caseRecord.issue} at ${location}. ${caseRecord.description}`
    + `${temperature !== undefined ? ` Current evidence includes an indoor reading of ${temperature}°F.` : ""}`
    + " When can maintenance inspect the unit?";
}

function canAutoNotifyLandlord(document: SessionDocument, caseRecord: CaseRecord): boolean {
  const binding = caseRecord.messagingBinding;
  return Boolean(document.tenantUserId && binding && binding.ownerId === document.ownerId && binding.caseId === caseRecord.id
    && caseRecord.tenantUserId === binding.tenant.userId && caseRecord.landlordUserId === binding.landlord.userId
    && caseRecord.case_type !== "self_documentation");
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
    policy?: PolicyResult; actor?: "tenant" | "settlement_agent";
  } = {},
) {
  const settlement = caseRecord.xrplSettlement;
  const { policy, actor, ...receipt } = options;
  const createdAt = now();
  caseRecord.escrow.audit.push({
    id: randomUUID(), action: "Payment", status, createdAt, timestamp: createdAt, network: "testnet",
    caseId: caseRecord.id, amountCents: intent.amountUsdCents, source: intent.source,
    attemptedCaseId: intent.caseId, settlementId: intent.settlementId,
    requestedAction: intent.requestedAction, requestedTransactionType: intent.transactionType,
    requestedNetwork: intent.network,
    destination: intent.destination, amountDrops: intent.amountDrops,
    approvedAmountDrops: settlement?.amountDrops,
    ...(intent.agentId ? { agentId: intent.agentId } : {}),
    ...(intent.policyVersion ? { policyVersion: intent.policyVersion } : {}),
    ...(intent.asset ? { asset: intent.asset } : {}),
    ...(intent.amount ? { amount: intent.amount } : {}),
    ...(settlement?.amount ? { approvedAmount: settlement.amount } : {}),
    ...(intent.issuer ? { issuer: intent.issuer } : {}),
    ...(intent.currency ? { currency: intent.currency } : {}),
    ...(intent.contractId ? { contractId: intent.contractId, contractPolicyVersion: intent.contractPolicyVersion,
      policyHash: intent.policyHash, triggeringEvent: intent.triggeringEvent,
      evaluatedRules: caseRecord.contractEvaluation ? contractRuleChecks(caseRecord.contractEvaluation) : undefined,
      contractDecision: caseRecord.contractEvaluation } : {}),
    ...(options.hash ? { transactionHash: options.hash } : {}),
    ...(options.result ? { validatedResult: options.result } : {}),
    detail, ...receipt,
    ...(policy ? { policyDecision: structuredClone(policy) } : {}),
    ...(actor ? { actor } : {}),
  });
  caseRecord.updatedAt = now();
}

function applyXrplReceipt(
  caseRecord: CaseRecord,
  receipt: XrplReceipt,
  context: { policy?: PolicyResult; actor?: "tenant" | "settlement_agent" } = {},
) {
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
  settlement.requestedAction = settlement.contractId ? "RELEASE_RENT" : settlement.agentId ? "REQUEST_SETTLEMENT" : settlement.requestedAction;
  settlement.policyDecision = context.policy ? structuredClone(context.policy) : settlement.policyDecision;
  settlement.transactionHash = receipt.hash;
  settlement.validatedResult = receipt.result;
  settlement.timestamp = receipt.validatedAt;
  settlement.detail = "Validated tesSUCCESS on XRPL Testnet.";
  delete settlement.errorCode;
  caseRecord.escrow.status = "released";
  caseRecord.escrow.finishHash = receipt.hash;
  caseRecord.escrow.releasedAt = receipt.validatedAt;
  const disputeClosed = Boolean(caseRecord.contractId && caseRecord.contractDispute === "open");
  if (disputeClosed) caseRecord.contractDispute = "resolved";
  const intent = makeXrplIntent(caseRecord);
  if (!caseRecord.escrow.audit.some((entry) => entry.action === "Payment"
    && entry.status === "validated" && entry.hash === receipt.hash)) {
    appendXrplAudit(caseRecord, intent, "validated",
      `A real XRPL Testnet Payment delivering ${formatSettlementAsset(settlement)} reached a validated tesSUCCESS ledger result.`, {
      hash: receipt.hash, ledgerIndex: receipt.ledgerIndex, result: receipt.result,
      validated: true, signed: true, submitted: true, ...context,
    });
    event(caseRecord, "XRPL Testnet settlement validated",
      `${formatSettlementAsset(settlement)} reached the authorized recipient. Transaction ${receipt.hash}.`, "escrow");
  }
  if (disputeClosed && caseRecord.contractSnapshot) {
    // A closure event is evaluated for its audit only. Keep the original release
    // decision and receipt visible; the completed obligation must never run again.
    const closed = evaluateContractPolicy(caseRecord.contractSnapshot, caseRecord, { fundsAvailable: false }, new Date());
    recordContractEvaluation(caseRecord, closed, "dispute_closed", false);
    event(caseRecord, "Agreement dispute closed", "The validated settlement closed the dispute. Policy now blocks another execution of this obligation.", "case");
  }
  updateStatus(caseRecord);
}

function rejectXrplPolicy(
  caseRecord: CaseRecord,
  intent: XrplSettlementIntent,
  policy: PolicyResult,
  explicitCode?: string,
  actor?: "tenant" | "settlement_agent",
): never {
  const code = explicitCode ?? failedPolicyCode(policy);
  const detail = policyReason(policy);
  appendXrplAudit(caseRecord, intent, "rejected", detail, {
    code, signed: false, submitted: false, policy, actor,
  });
  throw new ApiError(409, detail, true, code, policy, caseRecord);
}

function throwXrplError(
  caseRecord: CaseRecord,
  intent: XrplSettlementIntent,
  error: unknown,
  context: { policy?: PolicyResult; actor?: "tenant" | "settlement_agent" } = {},
): never {
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
    detail, { code, hash: xrplError?.submittedHash, signed: xrplError?.signed === true || pending || Boolean(xrplError?.submittedHash),
      submitted: Boolean(xrplError?.submittedHash), validated: Boolean(xrplError?.ledgerResult),
      result: xrplError?.ledgerResult, policy: xrplError?.policy ?? context.policy, actor: context.actor });
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
    caseRecord.financialProfile = failedFinancialProfile(caseRecord, error);
  }
  if (caseRecord.financialProfile?.binding.source === "nessie") {
    caseRecord.financialPolicyContext = nessiePolicyContext(caseRecord);
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

/** Load authority from the same locked aggregate as the case, never from request data. */
function hydrateContractAuthority(document: SessionDocument, record: CaseRecord) {
  const contract = document.contracts?.find((item) => item.id === record.contractId);
  if (!contract || !isActiveContract(contract) || !contract.policy) {
    throw new ApiError(409, "Both assigned parties must sign an active RentEscrow Agreement before this financial workflow.", false, "ACTIVE_CONTRACT_REQUIRED");
  }
  const policy = contract.policy;
  if (contract.caseId !== record.id || document.tenantUserId !== policy.tenantUserId
    || record.tenantUserId !== policy.tenantUserId || record.landlordUserId !== policy.landlordUserId
    || record.propertyId !== policy.property.id || document.managedProperty?.landlordUserId !== policy.landlordUserId
    || record.monthlyRentCents !== policy.monthlyRentCents || record.disputedAmountCents !== policy.monthlyRentCents
    || record.escrow.amountCents !== policy.monthlyRentCents) {
    throw new ApiError(409, "This case, parties, property or amount no longer match the signed agreement.", false, "CASE_CONTRACT_MISMATCH");
  }
  record.contractSnapshot = structuredClone(contract);
  return contract;
}

function contractRuleChecks(decision: ContractPolicyDecision): PolicyResult["checks"] {
  return decision.evaluatedRules.map((rule) => ({ key: rule.code, label: rule.code, passed: rule.passed, detail: rule.detail }));
}

function recordContractEvaluation(record: CaseRecord, decision: ContractPolicyDecision, trigger: string, rememberDecision = true) {
  const timestamp = now();
  // The cap prevents new evaluations/payments. Receipt-driven closure is exempt
  // so a completed ledger transaction can always persist its recovery/audit state.
  if (rememberDecision) {
    record.contractEvaluation = decision;
    record.contractEvaluatedAt = timestamp;
    record.contractTrigger = trigger;
    record.contractEffects = { ...record.contractEffects, ...decision.effects };
    const fingerprint = createHash("sha256").update(JSON.stringify({ decision, trigger })).digest("hex");
    if (record.contractEvaluationFingerprint === fingerprint) return;
    record.contractEvaluationFingerprint = fingerprint;
    if (record.escrow.audit.length >= 500) throw new ApiError(409, "The prototype agreement audit limit has been reached.", false, "CONTRACT_AUDIT_CAPACITY");
  }
  record.escrow.audit.push({
    id: randomUUID(), action: "PolicyCheck", createdAt: timestamp, timestamp,
    status: decision.allowed ? "validated" : "rejected", network: "demo",
    amountCents: decision.effects.lateFeeCents ?? record.escrow.amountCents,
    agentId: "rentescrow-settlement-v1", contractId: decision.contractId, caseId: record.id,
    policyVersion: decision.policyVersion, contractPolicyVersion: decision.policyVersion, policyHash: decision.policyHash,
    triggeringEvent: trigger, evaluatedRules: contractRuleChecks(decision), contractDecision: decision,
    requestedAction: decision.action, asset: decision.asset, amount: decision.action === "RELEASE_RENT" ? decision.amount : "0",
    destination: record.contractSnapshot!.policy!.settlement.destination,
    policyDecision: { approved: decision.allowed, checks: contractRuleChecks(decision) },
    actor: "settlement_agent", signed: false, submitted: false, code: decision.reason,
    detail: `Contract-configured demo policy: ${decision.reason}. ${decision.action === "RELEASE_RENT"
      ? "Release is eligible for the guarded settlement boundary; this evaluation is not a ledger receipt."
      : "Only the signed prototype's simulated record/hold rule was applied. No payment was signed or submitted."}`,
  });
}

/** One evaluator for application events and the scheduled worker, under the existing session lock. */
async function evaluateContractInSession(
  document: SessionDocument, record: CaseRecord, mutation: SessionMutationContext,
  trigger: string, execute = true,
): Promise<CaseActionResult> {
  const contract = hydrateContractAuthority(document, record);
  if (execute && document.xrplAuthorized !== true) {
    throw new ApiError(403, "This tenant workspace is not bound to the configured XRPL signer.", false, "XRPL_ACCOUNT_NOT_AUTHORIZED");
  }
  if (execute && record.xrplSettlement?.status === "pending") {
    // Recovery is read-only and uses the original signed intent, even when current eligibility changed.
    try { return await applyAction(document, record, { action: "reconcile_xrpl" }, mutation, defaultMessaging, "settlement_agent"); }
    catch (error) { if (error instanceof ApiError && error.persistAudit) return { case: record, policy: error.policy }; throw error; }
  }
  const decision = evaluateContractPolicy(contract, record, { fundsAvailable: record.escrow.status === "locked" }, new Date());
  recordContractEvaluation(record, decision, trigger);
  if (execute && record.escrow.status === "locked" && !record.xrplSettlement) {
    record.xrplSettlement = createXrplSettlement(record);
  }
  if (!execute || !decision.allowed || decision.action !== "RELEASE_RENT" || record.xrplSettlement?.hash) {
    return { case: record, policy: { approved: decision.allowed, checks: contractRuleChecks(decision) } };
  }
  const scope = contract.policy!;
  const otherExecution = document.cases.find((other) => other.id !== record.id
    && other.contractSnapshot?.policy?.tenantUserId === scope.tenantUserId
    && other.contractSnapshot.policy.property.id === scope.property.id
    && other.contractSnapshot.policy.obligationPeriod === scope.obligationPeriod
    && (other.xrplSettlement?.hash || other.escrow.status === "released"));
  if (otherExecution) throw new ApiError(409, "This rental obligation already has a recorded execution.", true, "SETTLEMENT_ALREADY_COMPLETED");
  if (!record.xrplSettlement) record.xrplSettlement = createXrplSettlement(record);
  const settlement = record.xrplSettlement;
  if (settlement.contractId !== contract.id || settlement.policyHash !== contract.policyHash) {
    throw new ApiError(409, "Existing payment permission is not this agreement's permission. It cannot be silently replaced.", true, "CONTRACT_BINDING_MISMATCH");
  }
  if (settlement.agentRequestedAt) {
    // A new evaluation may retry a proven pre-sign availability failure. A signed,
    // uncertain or dispatched attempt is never automatically replaced.
    const last = [...record.escrow.audit].reverse().find((item) => item.action === "Payment");
    const safeRetry = last?.signed === false && last.submitted === false && settlement.status === "failed"
      && ["INSUFFICIENT_RLUSD_FUNDS", "INSUFFICIENT_XRPL_FUNDS", "XRPL_UNAVAILABLE", "RLUSD_TRUSTLINE_REQUIRED"].includes(settlement.errorCode ?? "")
      && Date.now() - Date.parse(settlement.agentRequestedAt) >= 60_000;
    if (!safeRetry) return { case: record };
    settlement.status = "ready";
    delete settlement.agentRequestedAt;
  }
  settlement.triggeringEvent = trigger;
  settlement.agentAuthorizedAt = contract.acceptances.map((acceptance) => acceptance.acceptedAt).sort().at(-1);
  const request = proposeContractAgentSettlement(record);
  if (!request) return { case: record };
  // The only request fields are contractId, caseId and RELEASE_RENT.
  settlement.agentRequestedAt = now();
  event(record, "Contract settlement agent requested rent release",
    `Agreement ${request.contractId}, ${contract.policyVersion}, policy ${contract.policyHash}; trigger ${trigger}. No individual payment approval is required.`, "escrow");
  await mutation.checkpoint();
  try { return await applyAction(document, record, { action: "settle_xrpl" }, mutation, defaultMessaging, "settlement_agent"); }
  catch (error) {
    // Keep the fact/event and its audited settlement outcome. A fact confirmation
    // must never be rolled back because a ledger service is temporarily unavailable.
    if (error instanceof ApiError && error.persistAudit) return { case: record, policy: error.policy };
    throw error;
  }
}

/** Scheduled entry point: no caller-supplied dates, amounts, wallets or actions. */
export async function evaluateActiveContracts(ownerId: string, options: { dryRun?: boolean } = {}) {
  if (options.dryRun) {
    const document = await readSession(ownerId);
    if (!document) return [];
    return (document.contracts ?? []).filter((contract) => contract.status === "active" && contract.policy && contract.caseId)
      .flatMap((contract) => {
        const record = document.cases.find((item) => item.id === contract.caseId && item.contractId === contract.id);
        if (!record) return [];
        hydrateContractAuthority(document, record);
        const decision = evaluateContractPolicy(contract, record, { fundsAvailable: record.escrow.status === "locked" }, new Date());
        return [{ contractId: contract.id, caseId: record.id, reason: decision.reason, status: record.xrplSettlement?.status }];
      });
  }
  return mutateSession(ownerId, async (document, mutation) => {
    const results: { contractId: string; caseId: string; reason: string; status?: string }[] = [];
    for (const contract of document.contracts ?? []) {
      if (contract.status !== "active" || !contract.policy || !contract.caseId) continue;
      const record = document.cases.find((item) => item.id === contract.caseId);
      if (!record || record.contractId !== contract.id) continue;
      await evaluateContractInSession(document, record, mutation, "scheduled_evaluation");
      results.push({ contractId: contract.id, caseId: record.id, reason: record.contractEvaluation?.reason ?? "RECONCILIATION", status: record.xrplSettlement?.status });
    }
    return results;
  });
}

export async function createCase(
  ownerId: string,
  input: z.infer<typeof newCaseSchema>,
  messaging: ParticipantMessagingDependencies = defaultParticipantMessaging,
) {
  const building = { ...await getBuildingContext(input.address, input.borough), address: input.address, borough: input.borough };
  return mutateSession(ownerId, async (document, mutation) => {
    await assertSessionNoPendingSettlement(document);
    if (document.cases.length >= 20) throw new ApiError(409, "This demo allows up to 20 cases per session.");
    const caseRecord = assignDemoParticipants(createNewCase(ownerId, { ...input, building }));
    assignCaseOwnership(document, caseRecord);
    caseRecord.accountBalanceCents = document.accountBalanceCents;
    document.cases.push(caseRecord);
    if (canAutoNotifyLandlord(document, caseRecord)) {
      await sendAgentParticipantMessage(caseRecord, "landlord", caseCreationNotice(caseRecord),
        `case-created:${caseRecord.id}`, mutation, messaging, "tenant");
    }
    return caseRecord;
  });
}

/** Creates a case only after contracts.ts has checked the current session's acceptance record. */
export async function createContractCase(
  ownerId: string,
  input: z.infer<typeof newCaseSchema>,
  contractId: string,
  mode: "rent" | "dispute" = "dispute",
) {
  const building = { ...await getBuildingContext(input.address, input.borough), address: input.address, borough: input.borough };
  return mutateSession(ownerId, async (document, mutation) => {
    await assertSessionNoPendingSettlement(document);
    if (document.cases.length >= 20) throw new ApiError(409, "This demo allows up to 20 cases per session.");
    const contract = document.contracts?.find((item) => item.id === contractId);
    if (!contract || contract.status !== "active" || contract.caseId) {
      throw new ApiError(409, "A fully accepted unused contract is required before creating a case.");
    }
    if (contract.policy) {
      if (!isActiveContract(contract) || document.tenantUserId !== contract.tenantUserId
        || document.managedProperty?.id !== contract.policy.property.id
        || document.managedProperty.landlordUserId !== contract.landlordUserId
        || input.monthlyRentCents !== contract.policy.monthlyRentCents || input.disputedAmountCents !== contract.policy.monthlyRentCents
        || input.address !== contract.policy.property.address || input.borough !== contract.policy.property.borough) {
        throw new ApiError(409, "Signed agreement terms and assigned parties must match this case.", false, "CASE_CONTRACT_MISMATCH");
      }
      if (document.cases.some((item) => item.contractSnapshot?.policy?.property.id === contract.policy!.property.id
        && item.contractSnapshot.policy.obligationPeriod === contract.policy!.obligationPeriod)) {
        throw new ApiError(409, "This prototype already has a case for this property and obligation period. A new agreement version cannot duplicate its payment.", false, "CONTRACT_OBLIGATION_EXISTS");
      }
    }
    const caseRecord = createNewCase(ownerId, { ...input, building });
    caseRecord.case_type = contract.case_type;
    assignCaseOwnership(document, caseRecord);
    if (contract.case_type === "self_documentation") {
      // No destination wallet is recorded or approved for a tenant-only case.
      caseRecord.escrow.destination = "";
      delete caseRecord.landlordUserId;
      delete caseRecord.messagingBinding;
    }
    caseRecord.accountBalanceCents = document.accountBalanceCents;
    document.cases.push(caseRecord);
    if (!contract.policy) contract.status = "used";
    contract.caseId = caseRecord.id;
    if (contract.policy) {
      caseRecord.contractId = contract.id;
      caseRecord.escrow.destination = contract.policy.settlement.destination;
      caseRecord.contractSnapshot = structuredClone(contract);
      caseRecord.contractDispute = mode === "rent" ? "none" : "open";
      caseRecord.title = mode === "rent" ? "Agreement rent obligation" : "Agreement repair dispute";
      await evaluateContractInSession(document, caseRecord, mutation, mode === "rent" ? "case_created" : "dispute_opened");
    }
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
    if (caseRecord.contractId) await evaluateContractInSession(document, caseRecord, mutation, "evidence_analyzed");
    return caseRecord;
  });
}

export type LandlordAction =
  | { action: "message"; body: string }
  | { action: "schedule"; scheduledFor: string; notes: string }
  | { action: "report_complete"; notes: string };

/** The role is rechecked inside the same serialized mutation as case assignment. */
export async function performLandlordAction(ownerId: string, caseId: string, user: AuthUser, action: LandlordAction) {
  return mutateSession(ownerId, async (document, mutation) => {
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
    if (record.contractId && action.action === "report_complete") {
      await evaluateContractInSession(document, record, mutation, "repair_reported");
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

async function requestAgentSettlementIfEligible(
  document: SessionDocument,
  caseRecord: CaseRecord,
  mutation: SessionMutationContext,
  messaging: MessagingDependencies,
): Promise<CaseActionResult | null> {
  if (caseRecord.contractId || document.tenantUserId) return null;
  const request = proposeXrplAgentSettlement(caseRecord);
  if (!request) return null;

  // Reserve the only autonomous request before any financial refresh or ledger
  // access. A denied or interrupted attempt therefore cannot be auto-retried.
  caseRecord.xrplSettlement!.agentRequestedAt = now();
  event(caseRecord, "XRPL settlement agent requested payment",
    "The authorized agent requested the server-owned settlement action. Wallet, amount, network, transaction type and signing credentials remain pinned by the server.",
    "escrow");
  await mutation.checkpoint();
  return applyAction(document, caseRecord, { action: "settle_xrpl" }, mutation, messaging, "settlement_agent");
}

async function applyAction(
  document: SessionDocument,
  caseRecord: CaseRecord,
  action: CaseAction,
  mutation: SessionMutationContext,
  messaging: MessagingDependencies,
  settlementActor?: "tenant" | "settlement_agent",
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
      insufficient_funds: caseRecord.xrplSettlement.asset === "RLUSD"
        ? "INSUFFICIENT_RLUSD_FUNDS" : "INSUFFICIENT_XRPL_FUNDS",
      duplicate: "SETTLEMENT_ALREADY_COMPLETED",
      wrong_network: "WRONG_NETWORK",
      wrong_case: "WRONG_CASE",
      unsupported_action: "ACTION_OUTSIDE_PERMISSION_SCOPE",
      issuer_tamper: "ASSET_DEFINITION_MISMATCH",
      wrong_asset: "ASSET_NOT_APPROVED",
    };
    const targeted = demonstration.policy.checks.find((check) => check.key === scenarioCode[action.scenario] && !check.passed);
    if (targeted) {
      demonstration.policy.checks = [targeted, ...demonstration.policy.checks.filter((check) => check !== targeted)];
    }
    const status = demonstration.policy.approved ? "validated" : "rejected";
    appendXrplAudit(caseRecord, demonstration.intent, status,
      `Security demo only. ${demonstration.detail}`, {
        code: demonstration.policy.approved ? undefined : scenarioCode[action.scenario],
        signed: false, submitted: false, policy: demonstration.policy,
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
    if (caseRecord.contractId && settlementActor !== "settlement_agent") throw new ApiError(409,
      "Only the contract-governed runtime agent executes this financial action. Confirm facts or let the scheduled evaluator run.", false, "AGENT_RUNTIME_REQUIRED");
    if (caseRecord.contractId) {
      const contract = hydrateContractAuthority(document, caseRecord);
      // A fresh clock evaluation precedes the existing policy and signing checks.
      caseRecord.contractEvaluation = evaluateContractPolicy(contract, caseRecord,
        { fundsAvailable: caseRecord.escrow.status === "locked" }, new Date());
    } else if (document.tenantUserId && !caseRecord.xrplSettlement?.hash) {
      throw new ApiError(409, "Sign a bilateral agreement before starting a financial workflow.", false, "ACTIVE_CONTRACT_REQUIRED");
    }
    const settlement = caseRecord.xrplSettlement;
    if (!settlement) throw new ApiError(409, "Enable XRPL Testnet settlement first.", false, "XRPL_NOT_ENABLED");
    if (settlement.status !== "pending" && settlement.status !== "validated") {
      // Refresh trusted customer/account ownership at the last server boundary before policy and signing.
      // The adapter rechecks the resulting immutable snapshot immediately before it signs.
      await refreshFinancialProfile(caseRecord);
      // Autonomous settlement requires live financial verification, even in an otherwise explicit demo workspace.
      if (settlementActor === "settlement_agent") caseRecord.financialPolicyContext = nessiePolicyContext(caseRecord);
    }
    return withXrplWalletLock(settlement.source, async () => {
      const journal = await readXrplJournal(settlement);
      if (journal?.status === "validated" && journal.receipt) {
        applyXrplReceipt(caseRecord, journal.receipt, {
          policy: journal.pending.policyDecision,
          actor: journal.pending.actor ?? settlementActor,
        });
        const duplicatePolicy = evaluateXrplPolicy(caseRecord, makeXrplIntent(caseRecord), document.ownerId);
        rejectXrplPolicy(caseRecord, makeXrplIntent(caseRecord), duplicatePolicy,
          "SETTLEMENT_ALREADY_COMPLETED", settlementActor);
      }
      if (journal?.status === "pending") {
        Object.assign(settlement, {
          status: "pending", hash: journal.pending.hash, sequence: journal.pending.sequence,
          lastLedgerSequence: journal.pending.lastLedgerSequence,
          detail: "A durable pending transaction must be reconciled before any signing retry.",
        });
        const pendingPolicy = evaluateXrplPolicy(caseRecord, makeXrplIntent(caseRecord), document.ownerId);
        rejectXrplPolicy(caseRecord, makeXrplIntent(caseRecord), pendingPolicy, "SETTLEMENT_PENDING", settlementActor);
      }
      await assertXrplWalletAvailable(settlement.source);
      const intent = Object.freeze(makeXrplIntent(caseRecord));
      const policy = evaluateXrplPolicy(caseRecord, intent, document.ownerId);
      if (!policy.approved) rejectXrplPolicy(caseRecord, intent, policy, undefined, settlementActor);
      let persistedPending: XrplPending | undefined;
      try {
        const receipt = await executeXrplSettlement({
          ownerId: document.ownerId,
          actor: settlementActor ?? "tenant",
          loadCase: async () => {
            if (caseRecord.contractId) hydrateContractAuthority(document, caseRecord);
            return structuredClone(caseRecord);
          },
          beforeSubmit: async (pending) => {
            const finalPolicy = evaluateXrplPolicy(caseRecord, pending.intent, document.ownerId);
            // Signing already happened. A time-sensitive check can expire here;
            // do not emit the pre-sign rejection audit or dispatch this blob.
            if (!finalPolicy.approved) throw new XrplError(failedPolicyCode(finalPolicy), policyReason(finalPolicy),
              finalPolicy, undefined, undefined, true);
            await recordXrplPending(settlement, pending);
            persistedPending = pending;
            Object.assign(settlement, {
              status: "pending", hash: pending.hash, transactionHash: pending.hash, sequence: pending.sequence,
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
        const finalPolicy = persistedPending.policyDecision ?? policy;
        applyXrplReceipt(caseRecord, receipt, {
          policy: finalPolicy,
          actor: persistedPending.actor ?? settlementActor,
        });
        return { case: caseRecord, policy: finalPolicy };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throwXrplError(caseRecord, intent, error, {
          policy: persistedPending?.policyDecision ?? policy,
          actor: persistedPending?.actor ?? settlementActor,
        });
      }
    });
  }
  if (action.action === "reconcile_xrpl") {
    const settlement = caseRecord.xrplSettlement;
    if (!settlement) throw new ApiError(409, "Enable XRPL Testnet settlement first.", false, "XRPL_NOT_ENABLED");
    return withXrplWalletLock(settlement.source, async () => {
      const journal = await readXrplJournal(settlement);
      if (journal?.status === "validated" && journal.receipt) {
        applyXrplReceipt(caseRecord, journal.receipt, {
          policy: journal.pending.policyDecision,
          actor: journal.pending.actor,
        });
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
        applyXrplReceipt(caseRecord, receipt, {
          policy: journal.pending.policyDecision,
          actor: journal.pending.actor,
        });
        return { case: caseRecord };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throwXrplError(caseRecord, intent, error, {
          policy: journal.pending.policyDecision,
          actor: journal.pending.actor,
        });
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
      if (document.tenantUserId || caseRecord.contractId) {
        const contract = hydrateContractAuthority(document, caseRecord);
        caseRecord.contractEvaluation = evaluateContractPolicy(contract, caseRecord,
          { fundsAvailable: caseRecord.escrow.status === "locked" }, new Date());
      }
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
      if (!caseRecord.tenantConfirmed) {
        caseRecord.tenantConfirmed = true;
        updateStatus(caseRecord);
        event(caseRecord, "Tenant confirmed resolution", "The tenant confirmed the real-world repair condition. Any financial consequence is determined by the signed agreement policy.", "verification");
      }
      const agentResult = await requestAgentSettlementIfEligible(document, caseRecord, mutation, messaging);
      if (agentResult) return agentResult;
      break;
    }
    case "release_escrow": {
      if (document.tenantUserId || caseRecord.contractId) throw new ApiError(409,
        "The signed agreement governs autonomous RLUSD release. Simulated manual release cannot bypass it.", false, "CONTRACT_SETTLEMENT_REQUIRED");
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
            code: "XRPL_SETTLEMENT_REQUIRED", signed: false, submitted: false, policy,
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
      if (document.tenantUserId || caseRecord.contractId) {
        hydrateContractAuthority(document, caseRecord);
        caseRecord.contractTrigger ??= "escrow_funded";
      }
      const existing = caseRecord.xrplSettlement;
      if (existing) {
        // Old unsubmitted authorizations can explicitly refresh participant binding.
        // Never rewrite an existing transaction or silently change its payment terms.
        if (existing.status === "ready" && !existing.hash && !existing.tenantUserId
          && !existing.landlordUserId && !existing.landlordWallet && !await readXrplJournal(existing)) {
          let pinned;
          try { pinned = createXrplSettlement(caseRecord); }
          catch (error) {
            if (error instanceof XrplError) throw new ApiError(409, error.message, false, error.reason);
            throw error;
          }
          if (existing.source !== pinned.source || existing.destination !== pinned.destination
            || !sameAssetPermission(existing, pinned) || existing.amountUsdCents !== pinned.amountUsdCents
            || existing.ownerId !== pinned.ownerId || existing.caseId !== pinned.caseId
            || existing.escrowId !== pinned.escrowId || existing.network !== pinned.network
            || existing.transactionType !== pinned.transactionType) {
            throw new ApiError(409, "The original settlement terms changed; participant refresh cannot replace them.", false, "XRPL_CONFIG_CHANGED");
          }
          Object.assign(existing, { tenantUserId: pinned.tenantUserId, landlordUserId: pinned.landlordUserId,
            landlordWallet: pinned.landlordWallet });
          event(caseRecord, "XRPL participant authorization refreshed",
            "Trusted case participants were pinned to the original, unchanged payment permission. Nothing signed. Nothing submitted.", "escrow");
        }
        return { case: caseRecord };
      }
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
        `${formatSettlementAsset(caseRecord.xrplSettlement)} is pinned to the authorized source and recipient for this case.`,
        "escrow");
      break;
    }
    case "authorize_xrpl_agent": {
      if (document.tenantUserId || caseRecord.contractId) {
        throw new ApiError(409, "Agent authority comes from both agreement signatures. Individual payment authorization is not supported.", false, "CONTRACT_AUTHORITY_REQUIRED");
      }
      const settlement = caseRecord.xrplSettlement;
      if (!settlement) {
        throw new ApiError(409, "Enable XRPL Testnet settlement before authorizing its settlement agent.", false,
          "XRPL_NOT_ENABLED");
      }
      if (settlement.status !== "ready" || settlement.hash) {
        throw new ApiError(409, "Only a ready, never-submitted XRPL settlement can authorize the settlement agent.",
          false, settlement.status === "failed" ? "XRPL_AGENT_RETRY_BLOCKED" : "XRPL_AGENT_NOT_READY");
      }
      if (!settlement.agentAuthorizedAt) {
        settlement.agentAuthorizedAt = now();
        event(caseRecord, "XRPL settlement agent authorized",
          "The tenant authorized one autonomous settlement request after all server-owned case conditions pass.",
          "escrow");
      }
      const agentResult = await requestAgentSettlementIfEligible(document, caseRecord, mutation, messaging);
      if (agentResult) return agentResult;
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

export interface IncomingParticipantMessage {
  id: string;
  conversationId: string;
  sender: string;
  body: string;
  createdAt: string;
  sendingLine?: string;
  replyToMessageId?: string;
}

export type IncomingLandlordMessage = IncomingParticipantMessage;

export type PhotonBindingDiagnostic = ReturnType<typeof photonBindingChecks> & {
  caseId: string;
  senderRole: MessagingRole;
  configuredCaseMatch: boolean;
  workspaceOwnerMatch: boolean;
  workspaceTenantUserIdMatch: boolean;
  workspaceLandlordUserIdMatch: boolean;
  senderPhoneMatch: boolean;
  sendingLineMatch: boolean;
  conversationMatch: boolean;
  conversationBindingExists: boolean;
  firstConversationAllowed: boolean;
  knownRouteExists: boolean;
  quoteMatch: boolean;
  timestampMatch: boolean;
};

export class PhotonCaseBindingRejectedError extends ApiError {
  constructor(public readonly reason: "workspace_mismatch" | "unapproved_sender" | "no_matching_conversation" | "ambiguous_conversation",
    public readonly diagnostics: PhotonBindingDiagnostic[] = []) {
    super(403, "No unambiguous approved participant conversation matches this reply.", false, "MESSAGE_BINDING_REJECTED");
  }
}

export interface ParticipantReceiveResult {
  case: CaseRecord;
  processing: {
    caseId: string;
    providerEventId: string;
    inboundMessageId: string;
    role: MessagingRole;
    senderMasked: string;
    duplicate: boolean;
    intent?: ParticipantMessageInterpretation["intent"];
    interpretationSource?: ParticipantMessageInterpretation["source"];
    eventType?: NonNullable<CaseRecord["messagingEvents"]>[number]["type"];
    caseStateUpdated: boolean;
    relay: {
      role: MessagingRole;
      generated: boolean;
      attempted: boolean;
      recipientMasked: string;
      status: CaseMessage["delivery"] | "not_required";
      conversation: "reused" | "cold-start-created" | "reuse-requested" | "cold-start-requested" | "not-started";
      providerMessageId?: string;
      reason?: string;
    };
  };
}

function participantReceiveResult(record: CaseRecord, message: CaseMessage, role: MessagingRole,
  duplicate: boolean, caseStateUpdated: boolean, relay: CaseMessage | undefined,
  attempted: boolean, hadConversation: boolean): ParticipantReceiveResult {
  const recipientRole = role === "landlord" ? "tenant" : "landlord";
  const participant = record.messagingBinding?.[recipientRole];
  const confirmed = relay?.delivery === "sent";
  return { case: record, processing: {
    caseId: record.id, providerEventId: message.providerMessageId!, inboundMessageId: message.id,
    role, senderMasked: maskMessagingContact(record.messagingBinding?.[role]?.phone), duplicate,
    intent: message.interpretation?.intent, interpretationSource: message.interpretation?.source,
    eventType: record.messagingEvents?.find((item) => item.messageId === message.id)?.type,
    caseStateUpdated,
    relay: { role: recipientRole, generated: Boolean(relay), attempted,
      recipientMasked: maskMessagingContact(participant?.phone), status: relay?.delivery ?? "not_required",
      conversation: !attempted ? "not-started" : hadConversation
        ? confirmed ? "reused" : "reuse-requested" : confirmed ? "cold-start-created" : "cold-start-requested",
      providerMessageId: relay?.providerMessageId,
      reason: relay?.failureReason ?? (!relay ? "No relay required for this processed event." : undefined),
    },
  } };
}

function validateIncomingParticipantMessage(incoming: IncomingParticipantMessage): string {
  const body = typeof incoming.body === "string" ? incoming.body.trim() : "";
  const validIdentifier = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 500
    && !/[\u0000-\u001f\u007f]/.test(value);
  if (!validIdentifier(incoming.id) || !validIdentifier(incoming.conversationId) || !body || body.length > 5_000
    || (incoming.replyToMessageId !== undefined && !validIdentifier(incoming.replyToMessageId))
    || typeof incoming.createdAt !== "string" || !Number.isFinite(Date.parse(incoming.createdAt))
    || Date.parse(incoming.createdAt) > Date.now() + 5 * 60_000) {
    throw new ApiError(400, "The incoming message has invalid provider metadata.", false, "MESSAGE_INVALID_EVENT");
  }
  return body;
}

function appendMessagingEvent(
  caseRecord: CaseRecord,
  message: CaseMessage,
  interpretation: ParticipantMessageInterpretation,
  type: NonNullable<CaseRecord["messagingEvents"]>[number]["type"],
): void {
  const events = caseRecord.messagingEvents ??= [];
  if (events.some((item) => item.messageId === message.id && item.type === type)) return;
  if (events.length >= 200) throw new ApiError(409, "This case has reached its messaging event limit.");
  events.push({ id: randomUUID(), type, actor: message.sender === "landlord" ? "landlord" : "tenant",
    messageId: message.id, createdAt: message.createdAt, summary: interpretation.summary,
    ...(interpretation.scheduledFor ? { scheduledFor: interpretation.scheduledFor } : {}) });
}

function applyParticipantInterpretation(
  caseRecord: CaseRecord,
  role: MessagingRole,
  message: CaseMessage,
  interpretation: ParticipantMessageInterpretation,
): boolean {
  message.interpretation = interpretation;
  let shouldRelay = true;
  const scheduledFor = interpretation.scheduledFor?.trim();
  const schedule = (status: NonNullable<CaseRecord["maintenanceSchedule"]>["status"]) => {
    if (!scheduledFor || scheduledFor.length > 80) return false;
    const previousAt = Date.parse(caseRecord.maintenanceSchedule?.updatedAt ?? "");
    const incomingAt = Date.parse(message.createdAt);
    if (Number.isFinite(previousAt) && Number.isFinite(incomingAt) && incomingAt < previousAt) return false;
    caseRecord.maintenanceSchedule = { scheduledFor, status, updatedAt: message.createdAt, sourceMessageId: message.id };
    return true;
  };
  if (role === "landlord") {
    if ((interpretation.intent === "scheduled" || interpretation.intent === "rescheduled") && scheduledFor) {
      const applied = schedule("scheduled");
      appendMessagingEvent(caseRecord, message, interpretation,
        interpretation.intent === "scheduled" ? "MAINTENANCE_SCHEDULED" : "MAINTENANCE_RESCHEDULED");
      if (applied) {
        (caseRecord.repairs ??= []).push({ id: randomUUID(), caseId: caseRecord.id,
          landlordUserId: message.participantUserId ?? caseRecord.landlordUserId ?? "unknown",
          kind: "scheduled", createdAt: message.createdAt, notes: interpretation.summary, scheduledFor });
      } else shouldRelay = false;
    } else if (interpretation.intent === "repair_complete") {
      appendMessagingEvent(caseRecord, message, interpretation, "REPAIR_REPORTED_COMPLETE");
      if (!caseRecord.repairReported) {
        caseRecord.repairReported = true;
        (caseRecord.repairs ??= []).push({ id: randomUUID(), caseId: caseRecord.id,
          landlordUserId: message.participantUserId ?? caseRecord.landlordUserId ?? "unknown",
          kind: "reported_complete", createdAt: message.createdAt, notes: interpretation.summary });
      }
    } else if (interpretation.intent === "repair_update") {
      appendMessagingEvent(caseRecord, message, interpretation, "REPAIR_UPDATE");
    }
  } else if (interpretation.intent === "reschedule_request") {
    if (scheduledFor && !schedule("reschedule_requested")) shouldRelay = false;
    appendMessagingEvent(caseRecord, message, interpretation, "RESCHEDULE_REQUESTED");
  } else if (interpretation.intent === "schedule_confirmed") {
    if (scheduledFor && !schedule("confirmed")) shouldRelay = false;
    appendMessagingEvent(caseRecord, message, interpretation, "SCHEDULE_CONFIRMED");
  } else if (interpretation.intent === "no_show") {
    if (caseRecord.maintenanceSchedule && Date.parse(message.createdAt) >= Date.parse(caseRecord.maintenanceSchedule.updatedAt)) {
      caseRecord.maintenanceSchedule = { ...caseRecord.maintenanceSchedule, status: "no_show",
        updatedAt: message.createdAt, sourceMessageId: message.id };
    } else if (caseRecord.maintenanceSchedule) shouldRelay = false;
    appendMessagingEvent(caseRecord, message, interpretation, "MAINTENANCE_NO_SHOW");
  } else if (interpretation.intent === "unresolved") {
    appendMessagingEvent(caseRecord, message, interpretation, "CONDITION_UNRESOLVED");
  }
  // Messaging can record repair coordination only. It never clears or grants tenant confirmation or verification.
  updateStatus(caseRecord);
  event(caseRecord, "Participant message interpreted", interpretation.summary, "message");
  return shouldRelay;
}

/** Authenticated Spectrum worker entry point. Case routing is derived only from persisted participant bindings. */
export async function receiveParticipantMessage(
  ownerId: string,
  incoming: IncomingParticipantMessage,
  messaging: ParticipantMessagingDependencies = defaultParticipantMessaging,
): Promise<ParticipantReceiveResult> {
  const config = getPhotonConfig();
  if (!config || ownerId !== config.tenantId) {
    throw new PhotonCaseBindingRejectedError("workspace_mismatch");
  }
  const body = validateIncomingParticipantMessage(incoming);
  const sender = normalizeMessagingContact(incoming.sender);
  const senderRole: MessagingRole | undefined = sender === config.tenantPhone ? "tenant"
    : sender === config.allowedRecipient ? "landlord" : undefined;
  if (!sender || !senderRole) throw new PhotonCaseBindingRejectedError("unapproved_sender");
  return mutateSession(ownerId, async (document, mutation) => {
    const candidates: { record: CaseRecord; role: MessagingRole;
      participant: NonNullable<CaseRecord["messagingBinding"]>[MessagingRole]; earliestAllowedAt: number }[] = [];
    const diagnostics: PhotonBindingDiagnostic[] = [];
    // A known route anywhere in this workspace must not be reassigned to a
    // different case just because its ID appears in the configured seed slot.
    const knownRouteExists = document.cases.some((record) =>
      (["tenant", "landlord"] as const).some((role) => {
        const participant = record.messagingBinding?.[role];
        return normalizeMessagingContact(participant?.phone) === sender && Boolean(participant?.conversationId);
      }) || record.messages.some((message) => message.provider === "spectrum" && message.delivery === "sent"
        && (message.sender === "agent" || message.sender === "tenant")
        && normalizeMessagingContact(message.recipient) === sender && Boolean(message.providerConversationId)));
    for (const record of document.cases) {
      for (const role of [senderRole]) {
        const participant = record.messagingBinding?.[role];
        const bindingChecks = photonBindingChecks(record, config);
        const workspaceOwnerMatch = document.ownerId === ownerId && record.ownerId === document.ownerId;
        const workspaceTenantUserIdMatch = !document.tenantUserId || record.tenantUserId === document.tenantUserId;
        const workspaceLandlordUserIdMatch = !document.managedProperty || record.landlordUserId === document.managedProperty.landlordUserId;
        const senderPhoneMatch = normalizeMessagingContact(participant?.phone) === sender;
        const sendingLineMatch = (!participant?.sendingLine || incoming.sendingLine === participant.sendingLine)
          && matchesSpectrumSendingLine(incoming.sendingLine, config.sendingLine);
        const matchingOutbound = record.messages.filter((message) => (message.sender === "agent" || (role === "landlord" && message.sender === "tenant"))
          && message.provider === "spectrum" && message.delivery === "sent"
          && ((participant && message.recipientUserId === participant.userId) || normalizeMessagingContact(message.recipient) === sender)
          && message.providerConversationId === incoming.conversationId && message.sendingLine === incoming.sendingLine
          && (!incoming.replyToMessageId || message.providerMessageId === incoming.replyToMessageId));
        const conversationMatch = participant?.conversationId === incoming.conversationId || matchingOutbound.length > 0;
        // The authenticated SDK event may be the first proof of this participant's
        // DM. Restrict this to the configured case, both trusted identities, the
        // configured route, and a canonical DM addressed to the exact sender.
        const firstConversationAllowed = record.id === config.caseId && !knownRouteExists
          && !participant?.conversationId && !incoming.replyToMessageId
          && isPhotonDirectConversation(incoming.conversationId, sender)
          && isPhotonParticipantBound(record, "tenant", config) && isPhotonParticipantBound(record, "landlord", config);
        const quoteMatch = !incoming.replyToMessageId || matchingOutbound.length > 0;
        const anchorTimes = matchingOutbound.map((message) => Date.parse(message.sentAt ?? message.createdAt))
          .filter(Number.isFinite);
        const earliestAllowedAt = anchorTimes.length ? Math.min(...anchorTimes) : Date.parse(record.createdAt);
        const timestampMatch = Number.isFinite(earliestAllowedAt) && Date.parse(incoming.createdAt) >= earliestAllowedAt;
        diagnostics.push({ caseId: record.id, senderRole: role, ...bindingChecks, configuredCaseMatch: record.id === config.caseId,
          workspaceOwnerMatch, workspaceTenantUserIdMatch, workspaceLandlordUserIdMatch, senderPhoneMatch, sendingLineMatch,
          conversationMatch, conversationBindingExists: Boolean(participant?.conversationId), firstConversationAllowed,
          knownRouteExists, quoteMatch, timestampMatch });
        if (!participant || !workspaceOwnerMatch || !workspaceTenantUserIdMatch || !workspaceLandlordUserIdMatch
          || !senderPhoneMatch || !sendingLineMatch || !isPhotonParticipantBound(record, role, config)
          || (!conversationMatch && !firstConversationAllowed) || !quoteMatch || !timestampMatch) continue;
        candidates.push({ record, role, participant, earliestAllowedAt });
      }
    }
    if (candidates.length !== 1) {
      throw new PhotonCaseBindingRejectedError(candidates.length > 1 ? "ambiguous_conversation" : "no_matching_conversation", diagnostics);
    }
    const { record: caseRecord, role, participant } = candidates[0];
    const recipientRole: MessagingRole = role === "landlord" ? "tenant" : "landlord";
    const hadConversation = Boolean(caseRecord.messagingBinding?.[recipientRole]?.conversationId);
    const existing = document.cases.flatMap((record) => record.messages.map((message) => ({ record, message })))
      .find(({ message }) => message.provider === "spectrum" && message.providerMessageId === incoming.id);
    let message: CaseMessage;
    if (existing) {
      if (existing.record.id !== caseRecord.id || existing.message.sender !== role || existing.message.body !== body
        || existing.message.providerConversationId !== incoming.conversationId
        || existing.message.participantUserId !== participant.userId) {
        throw new ApiError(409, "The provider message ID is already bound to different content.", false, "MESSAGE_EVENT_CONFLICT");
      }
      message = existing.message;
      // A migrated event may predate its participant route. Pin only after
      // verifying that its provider ID belongs to this exact participant/event.
      participant.conversationId ??= incoming.conversationId;
      if (incoming.sendingLine) participant.sendingLine ??= incoming.sendingLine;
      const relay = caseRecord.messages.find((item) => item.sender === "agent" && item.triggerMessageId === message.id);
      if (relay) {
        if (relay?.delivery === "pending") {
          relay.delivery = "uncertain";
          relay.failureReason = "A reserved relay was interrupted before delivery could be confirmed. Inspect the provider conversation; it will not be retried automatically.";
          event(caseRecord, "Agent relay delivery uncertain", relay.failureReason, "message");
        }
        return participantReceiveResult(caseRecord, message, role, true, false, relay, false, hadConversation);
      }
      await assertSessionNoPendingSettlement(document);
      assertMutable(caseRecord);
    } else {
      await assertSessionNoPendingSettlement(document);
      assertMutable(caseRecord);
      if (caseRecord.messages.length >= 200) throw new ApiError(409, "This case has reached its message limit.");
      message = { id: randomUUID(), sender: role, participantUserId: participant.userId,
        recipientUserId: caseRecord.messagingBinding?.[role === "tenant" ? "landlord" : "tenant"]?.userId,
        body, createdAt: new Date(incoming.createdAt).toISOString(), delivery: "received", provider: "spectrum",
        caseId: caseRecord.id, providerMessageId: incoming.id,
        providerConversationId: incoming.conversationId, sendingLine: incoming.sendingLine };
      caseRecord.messages.push(message);
      participant.conversationId ??= incoming.conversationId;
      if (incoming.sendingLine) participant.sendingLine ??= incoming.sendingLine;
      event(caseRecord, "Participant message received", `A bound ${role} message was recorded for interpretation.`, "message");
      // The original provider event is durable before any model call or relay reservation.
      await mutation.checkpoint();
    }
    let shouldRelay = message.relayRequired !== false;
    let caseStateUpdated = false;
    let contractRepairReported = false;
    const shortReplyRelay = buildShortReplyRelay(body, role, caseRecord);
    // A stored inbound/interpretation alone is not proof that a relay was ever
    // reserved. Recover old `other` records through the corrected classifier;
    // known interpretations already applied to the case must not be applied twice.
    if (!message.processedAt) {
      const previous = message.interpretation;
      if (!previous || previous.intent === "other") {
        const before = JSON.stringify([caseRecord.maintenanceSchedule, caseRecord.repairReported, caseRecord.messagingEvents?.length]);
        const repairWasReported = caseRecord.repairReported;
        const interpretation = await messaging.classify(body, role, caseRecord, new Date(incoming.createdAt));
        shouldRelay = applyParticipantInterpretation(caseRecord, role, message, interpretation);
        if (caseRecord.contractId && role === "landlord" && interpretation.intent === "repair_complete"
          && !repairWasReported && caseRecord.repairReported) {
          // A provider message establishes only the landlord's report. Any old
          // evidence comparison and tenant confirmation must be refreshed before
          // the signed contract can permit a payment.
          invalidateVerification(caseRecord);
          contractRepairReported = true;
        }
        caseStateUpdated = before !== JSON.stringify([caseRecord.maintenanceSchedule, caseRecord.repairReported, caseRecord.messagingEvents?.length]);
      } else if (["scheduled", "rescheduled", "reschedule_request", "schedule_confirmed", "no_show"].includes(previous.intent)
        && caseRecord.maintenanceSchedule
        && Date.parse(message.createdAt) < Date.parse(caseRecord.maintenanceSchedule.updatedAt)) {
        shouldRelay = false;
      }
    }
    const relayBody = shouldRelay && message.interpretation
      ? shortReplyRelay ?? messaging.relay(role, message.interpretation, caseRecord.id) : undefined;
    message.processedAt ??= now();
    message.relayRequired = Boolean(relayBody);
    let relay: CaseMessage | undefined;
    if (relayBody) {
      relay = await sendAgentParticipantMessage(caseRecord, recipientRole, relayBody, message.id, mutation, messaging);
    }
    if (contractRepairReported) {
      await evaluateContractInSession(document, caseRecord, mutation, "repair_reported");
    }
    return participantReceiveResult(caseRecord, message, role, Boolean(existing), caseStateUpdated,
      relay, Boolean(relayBody), hadConversation);
  });
}

/** Server worker only: its authenticated SDK stream must already exclude outbound and group messages. */
async function receiveLegacyLandlordMessage(ownerId: string, caseId: string | undefined, incoming: IncomingLandlordMessage) {
  const config = getPhotonConfig();
  if (!config || ownerId !== config.tenantId) {
    throw new ApiError(403, "The incoming message is not bound to the configured tenant and case.", false, "MESSAGE_BINDING_REJECTED");
  }
  const body = validateIncomingParticipantMessage(incoming);
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
      || !matchesSpectrumSendingLine(incoming.sendingLine, config.sendingLine)) {
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

/** Compatibility wrapper for the original one-way landlord listener and fixtures. */
export async function receiveLandlordMessage(ownerId: string, caseId: string | undefined, incoming: IncomingLandlordMessage) {
  const document = await readSession(ownerId);
  if (document?.cases.some((record) => record.messagingBinding)) return receiveParticipantMessage(ownerId, incoming);
  return receiveLegacyLandlordMessage(ownerId, caseId, incoming);
}

export async function performCaseAction(ownerId: string, caseId: string, action: CaseAction, messaging = defaultMessaging) {
  return mutateSession(ownerId, async (document, mutation) => {
    const caseRecord = findCase(document, caseId);
    if (document.tenantUserId && (action.action === "simulate_landlord_reply" || action.action === "record_landlord_reply")) {
      throw new ApiError(403, "Landlord replies and repair reports must come from the assigned property manager.", false, "ROLE_NOT_ALLOWED");
    }
    const xrplAction = action.action === "enable_xrpl" || action.action === "authorize_xrpl_agent"
      || action.action === "settle_xrpl" || action.action === "reconcile_xrpl"
      || action.action === "xrpl_security_demo"
      || (action.action === "confirm_resolution" && Boolean(caseRecord.xrplSettlement?.agentAuthorizedAt));
    if (xrplAction && document.tenantUserId && document.xrplAuthorized !== true) {
      throw new ApiError(403, "This tenant workspace is not authorized to use the configured XRPL signer.", false,
        "XRPL_ACCOUNT_NOT_AUTHORIZED");
    }
    if (action.action === "enable_xrpl") assertXrplStorageCapability();
    if (action.action === "contract_security_demo") {
      hydrateContractAuthority(document, caseRecord);
      const permission = caseRecord.xrplSettlement;
      if (!permission) throw new ApiError(409, "Fund the agreement's simulated rent before running its payment attacks.", false, "XRPL_NOT_ENABLED");
      const snapshot = structuredClone(caseRecord);
      let demonstration;
      if (action.scenario === "excess_fee") {
        const fee = evaluateContractFeeRequest(snapshot.contractSnapshot!, 50_000);
        demonstration = { intent: makeXrplIntent(snapshot), policy: { approved: fee.allowed, checks: [{ key: fee.reason,
          label: "Contract late-fee maximum", passed: fee.allowed, detail: `Agent requested a $500 simulated fee. The signed maximum is $${(fee.maximumFeeCents / 100).toFixed(2)}; only the exact configured fee may be recorded.` }] },
          detail: "BLOCKED BEFORE SIGNING. Nothing signed. Nothing submitted." };
      } else if (action.scenario === "mutate_terms") {
        snapshot.contractSnapshot!.policy!.monthlyRentCents += 1;
        const changed = evaluateContractPolicy(snapshot.contractSnapshot!, snapshot, { fundsAvailable: snapshot.escrow.status === "locked" }, new Date());
        demonstration = { intent: makeXrplIntent(snapshot), policy: { approved: false, checks: contractRuleChecks(changed) },
          detail: "Changing signed terms invalidates the canonical policy hash. A new agreement and both signatures are required. BLOCKED BEFORE SIGNING. Nothing signed. Nothing submitted." };
      } else {
        demonstration = runXrplSecurityDemo(snapshot, document.ownerId, action.scenario);
      }
      const scenarioCode: Record<typeof action.scenario, string> = {
        wallet_switch: "DESTINATION_WALLET_MISMATCH", amount_tamper: "AMOUNT_OUTSIDE_AUTHORIZATION",
        issuer_tamper: "ASSET_DEFINITION_MISMATCH", wrong_network: "WRONG_NETWORK",
        duplicate: "SETTLEMENT_ALREADY_COMPLETED", excess_fee: "FEE_EXCEEDS_CONTRACT_POLICY",
        unsupported_action: "ACTION_OUTSIDE_PERMISSION_SCOPE", mutate_terms: "CONTRACT_HASH_MISMATCH",
        prompt_injection: "DESTINATION_WALLET_MISMATCH", insufficient_funds: "INSUFFICIENT_RLUSD_FUNDS",
        wrong_case: "WRONG_CASE", wrong_asset: "ASSET_NOT_APPROVED",
      };
      const targeted = demonstration.policy.checks.find((check) => !check.passed && check.key === scenarioCode[action.scenario]);
      if (targeted) demonstration.policy.checks = [targeted, ...demonstration.policy.checks.filter((check) => check !== targeted)];
      const code = action.scenario === "unsupported_action" ? "ACTION_NOT_PERMITTED_BY_CONTRACT" : scenarioCode[action.scenario];
      if (demonstration.policy.approved) throw new ApiError(500, "The attack fixture unexpectedly passed policy.", false, "INVALID_SECURITY_DEMO");
      appendXrplAudit(caseRecord, demonstration.intent, "rejected", `Contract attack dry run. ${demonstration.detail}`, {
        code, signed: false, submitted: false, policy: demonstration.policy, actor: "settlement_agent",
      });
      return { case: caseRecord, policy: demonstration.policy };
    }
    if (action.action === "evaluate_contract") {
      return evaluateContractInSession(document, caseRecord, mutation, "case_evaluation_requested");
    }
    if (action.action === "open_contract_dispute") {
      hydrateContractAuthority(document, caseRecord);
      await assertSessionNoPendingSettlement(document);
      assertMutable(caseRecord);
      if (caseRecord.xrplSettlement?.hash || caseRecord.escrow.status === "released") throw new ApiError(409,
        "An already executed obligation cannot be reopened to change its payment.", false, "SETTLEMENT_ALREADY_COMPLETED");
      caseRecord.contractDispute = "open";
      invalidateVerification(caseRecord);
      event(caseRecord, "Qualifying agreement dispute opened", "The signed HOLD_ALL demo policy holds this obligation until its required repair facts pass.", "case");
      return evaluateContractInSession(document, caseRecord, mutation, "dispute_opened");
    }
    const result = await applyAction(document, caseRecord, action, mutation, messaging);
    const triggers: Partial<Record<CaseAction["action"], string>> = {
      create_escrow: "escrow_funded", verify_repair: "evidence_verified", confirm_resolution: "tenant_confirmed_repair",
      analyze_evidence: "evidence_analyzed", add_demo_evidence: "evidence_added", sync_finances: "financial_state_updated",
    };
    const trigger = triggers[action.action];
    if (caseRecord.contractId && trigger) return evaluateContractInSession(document, caseRecord, mutation, trigger);
    return result;
  });
}
