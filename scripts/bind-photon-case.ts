import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getPhotonConfig } from "../src/lib/integrations/photon";
import { DEMO_PARTICIPANTS } from "../src/lib/seed";
import { findCase, mutateSession } from "../src/lib/server/store";
import { closeMongoConnection } from "../src/lib/server/mongodb";

export async function bindPhotonCase() {
  const config = getPhotonConfig();
  if (!config) throw new Error("Live configuration required");
  return mutateSession(config.tenantId, (document) => {
    const record = findCase(document, config.caseId);
    const isDemo = record.id === "RE-1042";
    if (isDemo && config.allowedRecipient !== DEMO_PARTICIPANTS.landlord.phone) {
      throw new Error("The demo recipient must be Rayyan's own number");
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
      detail: isDemo ? "Demo roles corrected: Mujtaba Atif is the tenant; Rayyan Khan is the approved landlord recipient. No message or payment was sent."
        : "The operator bound this case to the approved Spectrum demo recipient. No message or payment was sent." });
    return record;
  });
}

async function main() {
  try {
    if (existsSync(".env.local")) process.loadEnvFile(".env.local");
    await bindPhotonCase();
    console.log("The configured case is bound to the approved Spectrum test recipient. No message or payment was sent.");
  } catch {
    console.error("Case binding failed. Verify tenant/case configuration and database access; existing live history cannot be rebound.");
    process.exitCode = 1;
  } finally { await closeMongoConnection(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
