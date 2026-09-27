import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getPhotonConfig } from "../src/lib/integrations/photon";
import { findCase, mutateSession } from "../src/lib/server/store";
import { closeMongoConnection } from "../src/lib/server/mongodb";

async function main() {
  try {
    if (existsSync(".env.local")) process.loadEnvFile(".env.local");
    const config = getPhotonConfig();
    if (!config) throw new Error("Live configuration required");
    await mutateSession(config.tenantId, (document) => {
      const record = findCase(document, config.caseId);
      if (record.landlordContact === config.allowedRecipient) return;
      if (record.status === "resolved" || record.xrplSettlement?.status === "pending"
        || record.messages.some((message) => message.provider === "spectrum" && message.delivery !== "failed")) {
        throw new Error("Existing live history cannot be rebound");
      }
      const createdAt = new Date().toISOString();
      record.landlordContact = config.allowedRecipient;
      record.updatedAt = createdAt;
      record.timeline.push({ id: randomUUID(), createdAt, kind: "message", title: "Test messaging recipient configured",
        detail: "The operator bound this case to the approved Spectrum demo recipient. No message or payment was sent." });
    });
    console.log("The configured case is bound to the approved Spectrum test recipient. No message or payment was sent.");
  } catch {
    console.error("Case binding failed. Verify tenant/case configuration and database access; existing live history cannot be rebound.");
    process.exitCode = 1;
  } finally { await closeMongoConnection(); }
}

void main();
