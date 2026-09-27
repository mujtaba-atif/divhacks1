import "server-only";

import { z } from "zod";
import type { CaseRecord, MessagingRole } from "../types";
import { normalizeMessagingContact } from "../messaging-contact";
import { assertServer, DeliveryUncertainError, IntegrationError } from "./shared";
import { createSpectrumClient, isSpectrumSendingLine, isUnavailableSpectrumLineError, matchesSpectrumSendingLine, SpectrumLineUncertainError, stopSpectrumClient, withSpectrumTimeout, type SpectrumClient } from "./spectrum";

export interface PhotonConfig {
  provider: "spectrum";
  projectId: string;
  projectSecret: string;
  allowedRecipient: string;
  tenantPhone?: string;
  tenantId: string;
  caseId: string;
  sendingLine?: string;
}

export interface PreparedLandlordMessage {
  provider: "demo" | "spectrum";
  recipient: string;
  body: string;
}

export interface PreparedParticipantMessage extends PreparedLandlordMessage {
  role: MessagingRole;
  recipientUserId?: string;
}

export interface LandlordMessageResult extends PreparedLandlordMessage {
  delivery: "demo" | "sent";
  providerMessageId?: string;
  providerConversationId?: string;
  sendingLine?: string;
  sentAt?: string;
}

export interface ParticipantMessageResult extends LandlordMessageResult {
  role: MessagingRole;
  recipientUserId?: string;
}

export interface PhotonDependencies {
  createApp?: (config: PhotonConfig) => Promise<SpectrumClient>;
  timeoutMs?: number;
  shutdownTimeoutMs?: number;
}

const sendReceiptSchema = z.object({
  id: z.string().min(1).max(500),
  platform: z.literal("imessage"),
  direction: z.literal("outbound"),
  content: z.object({ type: z.literal("text"), text: z.string() }),
  space: z.object({ id: z.string().min(1), phone: z.string().optional() }),
  timestamp: z.date().refine((value) => Number.isFinite(value.getTime())),
  isSent: z.boolean().optional(),
  sendErrorCode: z.number().optional(),
});

export function getPhotonConfig(): PhotonConfig | undefined {
  assertServer();
  if (process.env.PHOTON_LIVE_SEND !== "true") return undefined;
  const projectId = process.env.SPECTRUM_PROJECT_ID?.trim();
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET?.trim();
  const allowedRecipient = normalizeMessagingContact(process.env.PHOTON_ALLOWED_RECIPIENT);
  const configuredTenantPhone = process.env.PHOTON_TENANT_PHONE?.trim();
  const tenantPhone = normalizeMessagingContact(configuredTenantPhone);
  const tenantId = process.env.PHOTON_TENANT_ID?.trim();
  const caseId = process.env.PHOTON_CASE_ID?.trim();
  const sendingLine = process.env.SPECTRUM_SENDING_LINE?.trim() || undefined;
  if (sendingLine && !isSpectrumSendingLine(sendingLine)) {
    throw new IntegrationError("Photon sending line must be an E.164 phone number or shared. Check SPECTRUM_SENDING_LINE.", "Photon", "invalid_input");
  }
  if (!projectId || !projectSecret || !allowedRecipient || (configuredTenantPhone && !tenantPhone)
    || !tenantId || !caseId) {
    throw new IntegrationError(
      "Photon live sending requires Spectrum project credentials and an approved tenant, case, recipient, and valid optional sending line.",
      "Photon",
    );
  }
  return { provider: "spectrum", projectId, projectSecret, allowedRecipient, tenantId, caseId,
    ...(tenantPhone ? { tenantPhone } : {}), ...(sendingLine ? { sendingLine } : {}) };
}

export function photonBindingChecks(record: CaseRecord, config: PhotonConfig) {
  const binding = record.messagingBinding;
  return {
    ownerMatch: record.ownerId === config.tenantId,
    bindingOwnerMatch: binding?.ownerId === record.ownerId,
    bindingCaseMatch: binding?.caseId === record.id,
    tenantBindingExists: Boolean(binding?.tenant),
    tenantUserIdMatch: Boolean(record.tenantUserId && binding?.tenant?.userId === record.tenantUserId),
    tenantPhoneMatch: Boolean(config.tenantPhone && normalizeMessagingContact(binding?.tenant?.phone) === config.tenantPhone),
    landlordBindingExists: Boolean(binding?.landlord),
    landlordUserIdMatch: Boolean(record.landlordUserId && binding?.landlord?.userId === record.landlordUserId),
    landlordPhoneMatch: normalizeMessagingContact(binding?.landlord?.phone) === config.allowedRecipient,
    landlordContactMatch: normalizeMessagingContact(record.landlordContact) === config.allowedRecipient,
    supportedCase: record.case_type !== "self_documentation",
  };
}

export function isPhotonParticipantBound(record: CaseRecord, role: MessagingRole, config: PhotonConfig): boolean {
  if (record.messagingBinding) {
    const checks = photonBindingChecks(record, config);
    return checks.ownerMatch && checks.bindingOwnerMatch && checks.bindingCaseMatch && checks.supportedCase
      && (role === "tenant"
        ? checks.tenantBindingExists && checks.tenantUserIdMatch && checks.tenantPhoneMatch
        : checks.landlordBindingExists && checks.landlordUserIdMatch && checks.landlordPhoneMatch && checks.landlordContactMatch);
  }
  if (role !== "landlord") return false;
  const recipient = normalizeMessagingContact(record.landlordContact);
  const binding = record.demoMessagingBinding;
  const approvedCase = record.id === config.caseId || (record.case_type === undefined
    && binding?.ownerId === record.ownerId && binding.caseId === record.id
    && binding.recipient === recipient);
  return record.ownerId === config.tenantId && approvedCase && recipient === config.allowedRecipient;
}

/** Used only to establish a first authenticated DM, never to infer a case from text. */
export function isPhotonDirectConversation(conversationId: string, recipient: string): boolean {
  const [service, kind, address, extra] = conversationId.split(";");
  return ["any", "iMessage", "SMS", "RCS"].includes(service) && kind === "-" && address === recipient && extra === undefined;
}

export function isPhotonCaseBound(record: CaseRecord, config: PhotonConfig): boolean {
  return isPhotonParticipantBound(record, "landlord", config);
}

function prepareWithConfig(record: CaseRecord, role: MessagingRole, body: string, config: PhotonConfig | undefined): PreparedParticipantMessage {
  const text = body.trim();
  if (!text || text.length > 10_000 || record.status === "resolved" || !/^[a-zA-Z0-9-]{1,80}$/.test(record.id)) {
    throw new IntegrationError("A nonempty message, valid case reference, and active case are required.", "Photon", "invalid_input");
  }
  const participant = record.messagingBinding?.[role];
  const recipient = normalizeMessagingContact(participant?.phone ?? (role === "landlord" ? record.landlordContact : undefined));
  if (!recipient) {
    throw new IntegrationError("This case has no valid landlord contact. Configure its recipient before sending.", "Photon", "rejected");
  }
  if (config && !isPhotonParticipantBound(record, role, config)) {
    throw new IntegrationError("This owner, case, participant, or contact is not the approved Photon messaging binding.", "Photon", "rejected");
  }
  const reference = `\n\nRentEscrow case: ${record.id}`;
  const preparedBody = text.endsWith(reference) ? text : `${text}${reference}`;
  if (preparedBody.length > 10_000) {
    throw new IntegrationError("The message and its case reference must fit within 10,000 characters.", "Photon", "invalid_input");
  }
  return { provider: config ? "spectrum" : "demo", recipient, body: preparedBody, role,
    ...(participant?.userId ? { recipientUserId: participant.userId } : {}) };
}

export function prepareLandlordMessage(record: CaseRecord, body: string): PreparedLandlordMessage {
  assertServer();
  const { role: _role, recipientUserId: _recipientUserId, ...prepared } = prepareWithConfig(record, "landlord", body, getPhotonConfig());
  return prepared;
}

export function prepareParticipantMessage(record: CaseRecord, role: MessagingRole, body: string): PreparedParticipantMessage {
  assertServer();
  return prepareWithConfig(record, role, body, getPhotonConfig());
}

async function sendPreparedParticipantMessage(
  record: CaseRecord,
  role: MessagingRole,
  body: string,
  dependencies: PhotonDependencies,
): Promise<ParticipantMessageResult> {
  const config = getPhotonConfig();
  const prepared = prepareWithConfig(record, role, body, config);
  if (!config) return { ...prepared, delivery: "demo" };
  const participant = record.messagingBinding?.[role];
  const sendingLine = participant?.sendingLine ?? config.sendingLine;
  const expectedConversation = participant?.conversationId;
  if (sendingLine && !matchesSpectrumSendingLine(sendingLine, config.sendingLine)) {
    throw new IntegrationError("The case's Photon sending line does not match the configured route. No message was dispatched.", "Photon", "invalid_input");
  }
  const timeoutMs = dependencies.timeoutMs ?? 20_000;
  const shutdownTimeoutMs = dependencies.shutdownTimeoutMs ?? 5_000;
  let app: SpectrumClient | undefined;
  let dispatched = false;
  try {
    const initializing = (dependencies.createApp ?? createSpectrumClient)(config);
    try {
      app = await withSpectrumTimeout(initializing, timeoutMs);
    } catch {
      void initializing.then((late) => stopSpectrumClient(late, shutdownTimeoutMs)).catch(() => undefined);
      throw new IntegrationError("Photon could not initialize its Spectrum connection. No message was dispatched.", "Photon");
    }
    const dm = await withSpectrumTimeout(app.openDirectMessage(prepared.recipient, sendingLine, expectedConversation), timeoutMs);
    if (!matchesSpectrumSendingLine(dm.phone, sendingLine)) {
      throw new IntegrationError("Photon resolved an invalid or different sending line. Check SPECTRUM_SENDING_LINE. No message was dispatched.", "Photon", "invalid_response");
    }
    if (!isPhotonDirectConversation(dm.id, prepared.recipient) || dm.type !== "dm"
      || (expectedConversation && dm.id !== expectedConversation)) {
      throw new IntegrationError("Photon did not resolve the approved direct-message conversation. No message was dispatched.", "Photon", "invalid_response");
    }
    dispatched = true;
    const receipt = sendReceiptSchema.safeParse(await withSpectrumTimeout(dm.send(prepared.body), timeoutMs));
    if (!receipt.success || receipt.data.space.id !== dm.id || receipt.data.content.text !== prepared.body
      || (receipt.data.space.phone !== undefined && receipt.data.space.phone !== dm.phone)
      || receipt.data.isSent === false || (receipt.data.sendErrorCode !== undefined && receipt.data.sendErrorCode !== 0)) {
      throw new DeliveryUncertainError();
    }
    return { ...prepared, delivery: "sent", providerMessageId: receipt.data.id,
      providerConversationId: receipt.data.space.id, sendingLine: dm.phone, sentAt: receipt.data.timestamp.toISOString() };
  } catch (error) {
    if (dispatched) {
      throw isUnavailableSpectrumLineError(error) ? new SpectrumLineUncertainError() : new DeliveryUncertainError();
    }
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError("Photon could not prepare its Spectrum conversation. No message was dispatched.", "Photon");
  } finally {
    if (app) await stopSpectrumClient(app, shutdownTimeoutMs);
  }
}

export async function sendParticipantMessage(record: CaseRecord, role: MessagingRole, body: string,
  dependencies: PhotonDependencies = {}): Promise<ParticipantMessageResult> {
  assertServer();
  return sendPreparedParticipantMessage(record, role, body, dependencies);
}

export async function sendLandlordMessage(
  record: CaseRecord,
  body: string,
  dependencies: PhotonDependencies = {},
): Promise<LandlordMessageResult> {
  assertServer();
  const result = await sendPreparedParticipantMessage(record, "landlord", body, dependencies);
  const { role: _role, recipientUserId: _recipientUserId, ...legacy } = result;
  return legacy;
}
