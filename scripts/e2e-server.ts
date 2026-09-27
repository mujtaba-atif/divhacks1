import { spawn, type ChildProcess } from "node:child_process";
import { MongoMemoryServer } from "mongodb-memory-server";

const host = "127.0.0.1";
const port = process.env.E2E_PORT || "3100";
const database = "rentescrow_e2e";
let next: ChildProcess | undefined;
let mongo: MongoMemoryServer | undefined;

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Command ${command} exited with ${code ?? signal ?? "an unknown error"}.`));
    });
  });
}

async function shutdown(exitCode = 0) {
  if (next && !next.killed) next.kill("SIGTERM");
  await mongo?.stop();
  process.exit(exitCode);
}

async function main() {
  mongo = await MongoMemoryServer.create({ instance: { dbName: database } });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MONGODB_URI: mongo.getUri(),
    MONGODB_DATABASE: database,
    RENTESCROW_STORAGE: "mongodb",
    RENTESCROW_E2E: "true",
    NEXT_DIST_DIR: ".next-e2e",
    NEXT_TELEMETRY_DISABLED: "1",
    NESSIE_ENABLED: "false",
    GEMINI_API_KEY: "",
    PHOTON_LIVE_SEND: "false",
    XRPL_TESTNET_ENABLED: "false",
    XRPL_SETTLEMENT_ENABLED: "false",
  };

  await run(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/seed-users.ts"], env);
  next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", host, "--port", port], {
    env,
    stdio: "inherit",
  });
  next.once("exit", async (code) => { await mongo?.stop(); process.exit(code ?? 1); });
  next.once("error", async (error) => { console.error(error); await shutdown(1); });
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
void main().catch(async (error) => { console.error(error); await shutdown(1); });
