import "server-only";

import { z } from "zod";
import type { CaseRecord } from "../types";
import { normalizeMessagingContact } from "../messaging-contact";
import { assertServer, DeliveryUncertainError, IntegrationError } from "./shared";
import { createSpectrumClient, stopSpectrumClient, withSpectrumTimeout, type SpectrumClient } from "./spectrum";

export interface PhotonConfig {
  provider: "spectrum";
  projectId: string;
  projectSecret: string;
  allowedRecipient: string;
  tenantId: string;
  caseId: string;
  sendingLine?: string;
}

export interface PreparedLandlordMessage {
  provider: "demo" | "spectrum";
  recipient: string;
  body: string;
}

export interface LandlordMessageResult extends PreparedLandlordMessage {
  delivery: "demo" | "sent";
  providerMessageId?: string;
  providerConversationId?: string;
  sendingLine?: string;
  sentAt?: string;
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
  const tenantId = process.env.PHOTON_TENANT_ID?.trim();
  const caseId = process.env.PHOTON_CASE_ID?.trim();
  const sendingLine = process.env.SPECTRUM_SENDING_LINE?.trim() || undefined;
  if (!projectId || !projectSecret || !allowedRecipient
    || !tenantId || !caseId || (sendingLine && sendingLine !== "shared" && !/^\+[1-9]\d{7,14}$/.test(sendingLine))) {
    throw new IntegrationError(
      "Photon live sending requires Spectrum project credentials and an approved tenant, case, recipient, and valid optional sending line.",
      "Photon",
    );
  }
  return { provider: "spectrum", projectId, projectSecret, allowedRecipient, tenantId, caseId, ...(sendingLine ? { sendingLine } : {}) };
}

function prepareWithConfig(record: CaseRecord, body: string, config: PhotonConfig | undefined): PreparedLandlordMessage {
  const text = body.trim();
  if (!text || text.length > 10_000 || record.status === "resolved" || !/^[a-zA-Z0-9-]{1,80}$/.test(record.id)) {
    throw new IntegrationError("A nonempty message, valid case reference, and active case are required.", "Photon", "invalid_input");
  }
  const recipient = normalizeMessagingContact(record.landlordContact);
  if (!recipient) {
    throw new IntegrationError("This case has no valid landlord contact. Configure its recipient before sending.", "Photon", "rejected");
  }
  if (config && (record.ownerId !== config.tenantId || record.id !== config.caseId
    || recipient !== config.allowedRecipient)) {
    throw new IntegrationError("This tenant, case, or landlord contact is not the approved Photon messaging binding.", "Photon", "rejected");
  }
  const reference = `\n\nRentEscrow case: ${record.id}`;
  const preparedBody = text.endsWith(reference) ? text : `${text}${reference}`;
  if (preparedBody.length > 10_000) {
    throw new IntegrationError("The message and its case reference must fit within 10,000 characters.", "Photon", "invalid_input");
  }
  return { provider: config ? "spectrum" : "demo", recipient, body: preparedBody };
}

export function prepareLandlordMessage(record: CaseRecord, body: string): PreparedLandlordMessage {
  assertServer();
  return prepareWithConfig(record, body, getPhotonConfig());
}

export async function sendLandlordMessage(
  record: CaseRecord,
  body: string,
  dependencies: PhotonDependencies = {},
): Promise<LandlordMessageResult> {
  assertServer();
  const config = getPhotonConfig();
  const prepared = prepareWithConfig(record, body, config);
  if (!config) return { ...prepared, delivery: "demo" };
  const timeoutMs = dependencies.timeoutMs ?? 20_000;
  const shutdownTimeoutMs = dependencies.shutdownTimeoutMs ?? 5_000;
  let app: SpectrumClient | undefined;
  let dispatched = false;
  try {
    const initializing = (dependencies.createApp ?? createSpectrumClient)(config);
    try {
      app = await withSpectrumTimeout(initializing, timeoutMs);
    } catch {
      // A late initialization must not leave a client or token-renewal timer running.
      void initializing.then((late) => stopSpectrumClient(late, shutdownTimeoutMs)).catch(() => undefined);
      throw new IntegrationError("Photon could not initialize its Spectrum connection. No message was dispatched.", "Photon");
    }
    const dm = await withSpectrumTimeout(app.createDirectMessage(prepared.recipient, config.sendingLine), timeoutMs);
    const [service, kind, address, extra] = dm.id.split(";");
    if (!["any", "iMessage", "SMS", "RCS"].includes(service) || kind !== "-" || address !== prepared.recipient
      || extra !== undefined || dm.type !== "dm" || !dm.phone || (config.sendingLine && dm.phone !== config.sendingLine)) {
      throw new IntegrationError("Photon did not resolve the approved direct-message conversation. No message was dispatched.", "Photon", "invalid_response");
    }
    dispatched = true;
    const receipt = sendReceiptSchema.safeParse(await withSpectrumTimeout(dm.send(prepared.body), timeoutMs));
    if (!receipt.success || receipt.data.space.id !== dm.id || receipt.data.content.text !== prepared.body
      || (receipt.data.space.phone !== undefined && receipt.data.space.phone !== dm.phone)
      || receipt.data.isSent === false || (receipt.data.sendErrorCode !== undefined && receipt.data.sendErrorCode !== 0)) {
      throw new DeliveryUncertainError();
    }
    return {
      ...prepared, delivery: "sent", providerMessageId: receipt.data.id,
      providerConversationId: dm.id, sendingLine: dm.phone, sentAt: receipt.data.timestamp.toISOString(),
    };
  } catch (error) {
    if (dispatched) throw new DeliveryUncertainError();
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError("Photon could not prepare its Spectrum conversation. No message was dispatched.", "Photon");
  } finally {
    // A confirmed receipt remains valid even if connection teardown fails.
    if (app) await stopSpectrumClient(app, shutdownTimeoutMs);
  }
}
