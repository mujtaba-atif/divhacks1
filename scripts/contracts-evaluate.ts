import { contractWorkspaceOwners } from "../src/lib/server/store";
import { evaluateActiveContracts } from "../src/lib/server/cases";
import { closeMongoConnection } from "../src/lib/server/mongodb";
import { assertXrplTestnetEnvironment } from "../src/lib/integrations/xrpl-settlement";

async function run() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--dry-run") || args.length > 1) throw new Error("Unknown option");
  assertXrplTestnetEnvironment();
  for (const ownerId of await contractWorkspaceOwners()) {
    try {
      const results = await evaluateActiveContracts(ownerId, { dryRun: args.includes("--dry-run") });
      for (const result of results) console.log(JSON.stringify({ ...result, dryRun: args.includes("--dry-run") }));
    } catch {
      // Never print provider errors, case contents, credentials, or environment values.
      console.error("A contract workspace could not be evaluated safely. Review its agreement, audit and any pending receipt; no unsafe replacement will be signed.");
      process.exitCode = 1;
    }
  }
}
run().catch(() => {
  console.error("Contract evaluation stopped. Use pnpm contracts:evaluate [--dry-run] with the existing Testnet-only server configuration.");
  process.exitCode = 1;
}).finally(closeMongoConnection);
