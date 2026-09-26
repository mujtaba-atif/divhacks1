import { existsSync } from "node:fs";
import { getFinancialContext, NessieError } from "../src/lib/integrations/nessie";

async function main() {
  try {
    if (existsSync(".env.local")) process.loadEnvFile(".env.local");
    if (process.env.NESSIE_ENABLED !== "true") {
      console.error("Nessie API verification requires NESSIE_ENABLED=true. Fixtures do not count as a live connection.");
      process.exitCode = 1;
      return;
    }
    const result = await getFinancialContext({
      id: process.env.NESSIE_CASE_ID || "RE-1042", ownerId: process.env.NESSIE_TENANT_ID || "",
    });
    if (result.profile.status !== "verified" || result.profile.binding.source !== "nessie") {
      throw new Error("Verification did not complete.");
    }
    console.log("Nessie API check passed: customer, account, ownership, and balance verified over HTTPS.");
    console.log(`Loaded ${result.rentHistory.length} rent records and ${result.profile.transactions.length} transactions. No payments or provider writes were made.`);
  } catch (error) {
    console.error(error instanceof NessieError ? `${error.reasonCode}: ${error.message}` : "Nessie verification failed. Check private environment configuration and docs/nessie.md.");
    process.exitCode = 1;
  }
}

void main();
