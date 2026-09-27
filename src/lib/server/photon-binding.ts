import "server-only";

import { createHash } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import type { CaseMessagingBindingParticipant, CaseRecord } from "@/lib/types";
import { normalizeMessagingContact } from "@/lib/messaging-contact";
import { isSpectrumSendingLine } from "@/lib/integrations/spectrum";
import { USERS_COLLECTION, type AuthUserRecord } from "./auth-store";
import type { SessionDocument } from "./store";

export interface PhotonBindingSettings {
  tenantId: string;
  caseId: string;
  tenantPhone?: string;
  allowedRecipient: string;
}

export interface CanonicalPhotonParticipants {
  tenant: { userId: string; phone: string };
  landlord: { userId: string; phone: string };
  propertyId: string;
}

interface PropertyRecord {
  _id: string;
  address: string;
  borough: string;
  landlordUserId: string;
}

function workspaceOwnerId(userId: string): string {
  return createHash("sha256").update(userId).digest("hex");
}

function normalizedPlace(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function bindingError(message: string): never {
  throw new Error(`Photon participant binding rejected: ${message}`);
}

/**
 * Resolve identities from MongoDB auth/property records. Environment contacts
 * may narrow the operator command, but never create a participant identity.
 */
export async function resolveCanonicalPhotonParticipants(
  database: Db,
  document: SessionDocument,
  record: CaseRecord,
  settings: PhotonBindingSettings,
): Promise<CanonicalPhotonParticipants> {
  if (document.ownerId !== settings.tenantId || record.ownerId !== document.ownerId || record.id !== settings.caseId) {
    bindingError("the configured owner or case does not match the persisted workspace");
  }
  const tenantPhone = normalizeMessagingContact(settings.tenantPhone);
  const landlordPhone = normalizeMessagingContact(settings.allowedRecipient);
  if (!tenantPhone || !landlordPhone || tenantPhone === landlordPhone) {
    bindingError("both distinct configured participant contacts are required");
  }

  let tenantUserId = document.tenantUserId ?? record.tenantUserId;
  if (!tenantUserId) {
    const candidates = await database.collection<AuthUserRecord>(USERS_COLLECTION)
      .find({ role: "tenant" }).toArray();
    const matching = candidates.filter((candidate) => workspaceOwnerId(candidate._id.toHexString()) === document.ownerId);
    if (matching.length !== 1) bindingError("the workspace does not resolve to one canonical tenant user");
    tenantUserId = matching[0]._id.toHexString();
  }
  if (!ObjectId.isValid(tenantUserId) || workspaceOwnerId(tenantUserId) !== document.ownerId
    || (document.tenantUserId && document.tenantUserId !== tenantUserId)
    || (record.tenantUserId && record.tenantUserId !== tenantUserId)) {
    bindingError("the tenant user does not own the configured workspace and case");
  }

  const managedProperty = document.managedProperty;
  const propertyId = record.propertyId ?? managedProperty?.id;
  if (!managedProperty || !propertyId || managedProperty.id !== propertyId
    || normalizedPlace(managedProperty.address) !== normalizedPlace(record.building.address)
    || normalizedPlace(managedProperty.borough) !== normalizedPlace(record.building.borough)) {
    bindingError("the case is not assigned to the workspace managed property");
  }
  const property = await database.collection<PropertyRecord>("properties").findOne({ _id: propertyId });
  if (!property || normalizedPlace(property.address) !== normalizedPlace(record.building.address)
    || normalizedPlace(property.borough) !== normalizedPlace(record.building.borough)
    || managedProperty.landlordUserId !== property.landlordUserId
    || (record.landlordUserId && record.landlordUserId !== property.landlordUserId)) {
    bindingError("the assigned property does not resolve to the case landlord");
  }
  if (!ObjectId.isValid(property.landlordUserId)) bindingError("the assigned landlord user ID is invalid");

  const ids = [new ObjectId(tenantUserId), new ObjectId(property.landlordUserId)];
  const users = await database.collection<AuthUserRecord>(USERS_COLLECTION).find({ _id: { $in: ids } }).toArray();
  const tenant = users.find((user) => user._id.equals(ids[0]));
  const landlord = users.find((user) => user._id.equals(ids[1]));
  if (!tenant || tenant.role !== "tenant" || !tenant.phoneContactConfiguredAt
    || normalizeMessagingContact(tenant.phoneContact) !== tenantPhone) {
    bindingError("the configured tenant contact does not match the canonical tenant user");
  }
  if (!landlord || landlord.role !== "landlord" || !landlord.phoneContactConfiguredAt
    || normalizeMessagingContact(landlord.phoneContact) !== landlordPhone) {
    bindingError("the configured landlord contact does not match the canonical landlord user");
  }
  return {
    tenant: { userId: tenantUserId, phone: tenantPhone },
    landlord: { userId: property.landlordUserId, phone: landlordPhone },
    propertyId,
  };
}

function repairedParticipant(
  current: unknown,
  expected: { userId: string; phone: string },
  role: "tenant" | "landlord",
): CaseMessagingBindingParticipant {
  if (current === undefined) return expected;
  if (!current || typeof current !== "object") bindingError(`the existing ${role} binding is malformed`);
  const candidate = current as Partial<CaseMessagingBindingParticipant>;
  if (candidate.userId !== expected.userId || normalizeMessagingContact(candidate.phone) !== expected.phone) {
    bindingError(`the existing ${role} binding conflicts with the canonical user or contact`);
  }
  if (candidate.conversationId !== undefined
    && (typeof candidate.conversationId !== "string" || !candidate.conversationId.trim() || candidate.conversationId.length > 500)) {
    bindingError(`the existing ${role} conversation identifier is malformed`);
  }
  if (candidate.sendingLine !== undefined
    && (typeof candidate.sendingLine !== "string" || !isSpectrumSendingLine(candidate.sendingLine))) {
    bindingError(`the existing ${role} sending line is malformed`);
  }
  return {
    ...expected,
    ...(candidate.conversationId ? { conversationId: candidate.conversationId } : {}),
    ...(candidate.sendingLine ? { sendingLine: candidate.sendingLine } : {}),
  };
}

function assertLiveHistoryIdentities(record: CaseRecord, expected: CanonicalPhotonParticipants): void {
  const users = new Set([expected.tenant.userId, expected.landlord.userId]);
  const phones = new Set([expected.tenant.phone, expected.landlord.phone]);
  for (const message of record.messages) {
    if ((message.provider !== "spectrum" && message.provider !== "photon")
      || !["sent", "received", "pending", "uncertain"].includes(message.delivery)) continue;
    if (message.participantUserId && !users.has(message.participantUserId)) {
      bindingError("existing live history contains an unknown participant user");
    }
    if (message.sender === "tenant" && message.participantUserId
      && message.participantUserId !== expected.tenant.userId) {
      bindingError("existing live history assigns a tenant message to another user");
    }
    if (message.sender === "landlord" && message.participantUserId
      && message.participantUserId !== expected.landlord.userId) {
      bindingError("existing live history assigns a landlord message to another user");
    }
    if (message.recipientUserId && !users.has(message.recipientUserId)) {
      bindingError("existing live history contains an unknown recipient user");
    }
    if (message.recipient) {
      const recipient = normalizeMessagingContact(message.recipient);
      if (!recipient || !phones.has(recipient)) {
        bindingError("existing live history contains an unknown recipient contact");
      }
    }
  }
}

/** Upgrade an absent/one-sided binding without replacing established identity or route metadata. */
export function repairPhotonParticipantBinding(
  document: SessionDocument,
  record: CaseRecord,
  expected: CanonicalPhotonParticipants,
): boolean {
  assertLiveHistoryIdentities(record, expected);
  const current = record.messagingBinding as unknown as {
    ownerId?: unknown;
    caseId?: unknown;
    tenant?: unknown;
    landlord?: unknown;
  } | undefined;
  if (current && (typeof current !== "object"
    || (current.ownerId !== undefined && current.ownerId !== document.ownerId)
    || (current.caseId !== undefined && current.caseId !== record.id))) {
    bindingError("the existing binding belongs to another owner or case");
  }
  if ((document.tenantUserId && document.tenantUserId !== expected.tenant.userId)
    || (record.tenantUserId && record.tenantUserId !== expected.tenant.userId)
    || (record.landlordUserId && record.landlordUserId !== expected.landlord.userId)) {
    bindingError("persisted case participant IDs conflict with the canonical users");
  }
  const contacts = document.messagingContacts;
  if ((contacts?.tenantPhone && normalizeMessagingContact(contacts.tenantPhone) !== expected.tenant.phone)
    || (contacts?.landlordPhone && normalizeMessagingContact(contacts.landlordPhone) !== expected.landlord.phone)) {
    bindingError("persisted messaging contacts conflict with the canonical users");
  }

  const next = {
    ownerId: document.ownerId,
    caseId: record.id,
    tenant: repairedParticipant(current?.tenant, expected.tenant, "tenant"),
    landlord: repairedParticipant(current?.landlord, expected.landlord, "landlord"),
  };
  const demoBinding = { ownerId: document.ownerId, caseId: record.id, recipient: expected.landlord.phone };
  const changed = JSON.stringify(record.messagingBinding) !== JSON.stringify(next)
    || JSON.stringify(record.demoMessagingBinding) !== JSON.stringify(demoBinding)
    || document.tenantUserId !== expected.tenant.userId
    || record.tenantUserId !== expected.tenant.userId
    || record.landlordUserId !== expected.landlord.userId
    || record.propertyId !== expected.propertyId
    || normalizeMessagingContact(document.messagingContacts?.tenantPhone) !== expected.tenant.phone
    || normalizeMessagingContact(document.messagingContacts?.landlordPhone) !== expected.landlord.phone;
  if (!changed) return false;
  document.tenantUserId = expected.tenant.userId;
  document.messagingContacts = { tenantPhone: expected.tenant.phone, landlordPhone: expected.landlord.phone };
  record.tenantUserId = expected.tenant.userId;
  record.landlordUserId = expected.landlord.userId;
  record.propertyId = expected.propertyId;
  record.messagingBinding = next;
  record.demoMessagingBinding = demoBinding;
  return true;
}
