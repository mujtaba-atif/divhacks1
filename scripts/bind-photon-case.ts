import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getPhotonConfig } from "../src/lib/integrations/photon";
import { DEMO_PARTICIPANTS } from "../src/lib/seed";
import { normalizeMessagingContact } from "../src/lib/messaging-contact";
import { findCase, mutateSession } from "../src/lib/server/store";
import { closeMongoConnection, getMongoDatabase, mongoStorageEnabled } from "../src/lib/server/mongodb";
import { repairPhotonParticipantBinding, resolveCanonicalPhotonParticipants } from "../src/lib/server/photon-binding";

export async function bindPhotonCase() {
  const config = getPhotonConfig();
  if (!config) throw new Error("Live configuration required");
  return mutateSession(config.tenantId, async (document) => {
    const record = findCase(document, config.caseId);
    if (mongoStorageEnabled()) {
      const database = await getMongoDatabase();
      const expected = await resolveCanonicalPhotonParticipants(database, document, record, config);
      if (normalizeMessagingContact(record.landlordContact) !== expected.landlord.phone) {
        throw new Error("Configured Photon landlord must match the assigned case contact");
      }
      if (repairPhotonParticipantBinding(document, record, expected)) {
        record.updatedAt = new Date().toISOString();
        record.timeline.push({ id: randomUUID(), createdAt: record.updatedAt, kind: "message",
          title: "Participant messaging binding configured",
          detail: "The operator verified and bound both persisted participant users and contacts. Existing provider routes and financial state were preserved." });
      }
      return record;
    }
    const isDemo = record.id === "RE-1042";
    if (isDemo && config.allowedRecipient !== DEMO_PARTICIPANTS.landlord.phone) {
      throw new Error("The demo recipient must match the configured demo landlord");
    }
    if (record.landlordContact === config.allowedRecipient && (!isDemo
      || (record.landlordName === DEMO_PARTICIPANTS.landlord.name
        && record.tenant?.name === DEMO_PARTICIPANTS.tenant.name
        && record.tenant.phone === DEMO_PARTICIPANTS.tenant.phone))) return record;
    if (record.status === "resolved" || record.xrplSettlement?.status === "pending"
      || document.uncertainDeliveries?.some((attempt) => attempt.caseId === record.id)
      || record.messages.some((message) => ["sent", "received", "pending", "uncertain"].includes(message.delivery))) {
      throw new Error("Existing live history cannot be rebound");
    }
    const createdAt = new Date().toISOString();
    record.landlordContact = config.allowedRecipient;
    if (isDemo) {
      record.landlordName = DEMO_PARTICIPANTS.landlord.name;
      record.tenant = { ...DEMO_PARTICIPANTS.tenant };
    }
    record.updatedAt = createdAt;
    record.timeline.push({ id: randomUUID(), createdAt, kind: "message", title: "Test messaging recipient configured",
      detail: isDemo ? `${DEMO_PARTICIPANTS.tenant.name} is the tenant; ${DEMO_PARTICIPANTS.landlord.name} is the approved landlord recipient. No message or payment was sent.`
        : "The operator bound this case to the approved Spectrum demo recipient. No message or payment was sent." });
    return record;
  });
}

async function main() {
  try {
    if (existsSync(".env.local")) process.loadEnvFile(".env.local");
    const record = await bindPhotonCase();
    console.log(record.messagingBinding
      ? "The configured case is bound to both approved Spectrum participants (tenant and landlord). No message or payment was sent."
      : "The legacy demo case is bound to the approved Spectrum landlord recipient. No message or payment was sent.");
  } catch (error) {
    const detail = error instanceof Error && (error.message.startsWith("Photon participant binding rejected:")
      || error.message === "Configured Photon landlord must match the assigned case contact")
      ? ` ${error.message}` : " Verify tenant/case configuration and database access.";
    console.error(`Case binding failed.${detail}`);
    process.exitCode = 1;
  } finally { await closeMongoConnection(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
