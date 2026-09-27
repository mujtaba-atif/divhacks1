import { randomUUID } from "node:crypto";
import { createDemoCase } from "../src/lib/seed";
import { demoFinancialProfile } from "../src/lib/financial-fixture";
import { getXrplConfig } from "../src/lib/integrations/xrpl-settlement";
import { authUserFromRecord } from "../src/lib/server/auth";
import { performLandlordAction } from "../src/lib/server/cases";
import type { AuthUserRecord } from "../src/lib/server/auth-store";
import { closeMongoConnection, getMongoDatabase } from "../src/lib/server/mongodb";
import { assignCaseOwnership, mutateSession } from "../src/lib/server/store";

/** Add a labeled fixture without resetting existing cases or sending messages. */
async function prepare() {
  if (process.argv.slice(2).some((value) => value !== "--reported")) throw new Error("Unknown demo option");
  if (process.env.RENTESCROW_STORAGE !== "mongodb" || !getXrplConfig()) {
    throw new Error("Configure MongoDB and run pnpm xrpl:setup-testnet first.");
  }
  const db = await getMongoDatabase();
  const tenant = await db.collection<AuthUserRecord>("users").findOne({ email: "tenant1@rentescrow.demo", role: "tenant" });
  if (!tenant) throw new Error("Run pnpm seed:users first.");
  const user = authUserFromRecord(tenant);
  const landlord = process.argv.includes("--reported")
    ? await db.collection<AuthUserRecord>("users").findOne({ email: "landlord@rentescrow.demo", role: "landlord" }) : null;
  if (process.argv.includes("--reported") && !landlord) throw new Error("Seed the assigned demo landlord first");
  const caseId = await mutateSession(user.workspaceOwnerId, (document) => {
    if (!document.xrplAuthorized || document.tenantUserId !== user.id || !document.managedProperty?.landlordUserId) {
      throw new Error("The seeded tenant workspace needs its trusted XRPL and landlord bindings.");
    }
    if (document.cases.length >= 20) throw new Error("The demo workspace already has 20 cases.");
    const record = createDemoCase(document.ownerId);
    record.id = `RE-XRP-${randomUUID().slice(0, 8).toUpperCase()}`;
    record.title = "XRPL agent demo: no heat";
    record.description = "Labeled sample repair case for the agent's real Testnet Payment. The $400 dispute and 54 F / 72 F evidence are simulated.";
    record.escrow.id = `ESC-${record.id}`;
    record.financialProfile = demoFinancialProfile(document.ownerId, record.id);
    record.accountBalanceCents = document.accountBalanceCents;
    record.createdAt = record.updatedAt = new Date().toISOString();
    assignCaseOwnership(document, record);
    if (!record.landlordUserId) throw new Error("Sample property has no assigned landlord.");
    document.cases.push(record);
    return record.id;
  });
  if (landlord) {
    await performLandlordAction(user.workspaceOwnerId, caseId, authUserFromRecord(landlord), {
      action: "report_complete",
      notes: "Labeled XRPL judge fixture: sample heater repair reported complete by the demo property manager. Tenant evidence verification and confirmation are still required; this is not a real repair report.",
    });
  }
  console.log(`Prepared ${caseId}: XRPL agent demo: no heat. Sign in as tenant1@rentescrow.demo and select this case. No payment or external message was sent. Follow docs/xrpl-demo.md.`);
  if (landlord) console.log("Sample landlord completion recorded through the assigned-role service. Repair verification and tenant confirmation remain incomplete.");
}

prepare().catch(() => {
  // Provider and environment errors must never disclose credentials.
  console.error("XRPL demo preparation failed. Check MongoDB, seeded tenant/landlord bindings, Testnet configuration, and the 20-case limit. Existing cases were preserved.");
  process.exitCode = 1;
}).finally(closeMongoConnection);
