import "server-only";

import { DEMO_PARTICIPANTS } from "@/lib/seed";
import { normalizeMessagingContact } from "@/lib/messaging-contact";
import type { CaseRecord } from "@/lib/types";
import { ApiError } from "./errors";

/** Only the demo creation/reset paths may assign these participants and binding. */
export function assignDemoParticipants(record: CaseRecord): CaseRecord {
  const recipient = normalizeMessagingContact(process.env.PHOTON_ALLOWED_RECIPIENT || DEMO_PARTICIPANTS.landlord.phone);
  if (!recipient || !/^\+[1-9]\d{7,14}$/.test(recipient)) {
    throw new ApiError(503, "The demo landlord must have a valid configured phone number.");
  }
  record.tenantName = DEMO_PARTICIPANTS.tenant.name;
  record.tenantPhone = DEMO_PARTICIPANTS.tenant.phone;
  record.tenant = { name: record.tenantName, phone: record.tenantPhone };
  record.landlordName = DEMO_PARTICIPANTS.landlord.name;
  record.landlordContact = recipient;
  record.demoMessagingBinding = { ownerId: record.ownerId, caseId: record.id, recipient };
  return record;
}
