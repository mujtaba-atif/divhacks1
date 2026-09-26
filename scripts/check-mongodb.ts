import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Collection } from "mongodb";
import { closeMongoConnection, getMongoDatabase } from "../src/lib/server/mongodb";

const SETUP_HELP = "See docs/mongodb-atlas.md, then run pnpm db:check from the project directory.";
const OPERATION_TIMEOUT_MS = 8_000;

interface ConnectionProbe {
  _id: string;
  purpose: "rentescrow-db-check";
  nonce: string;
  createdAt: Date;
}

class ConfigurationError extends Error {}

function loadConfiguration(): "local" | "mongodb" {
  if (typeof process.loadEnvFile !== "function") {
    throw new ConfigurationError("This command requires Node.js with process.loadEnvFile(). Use Node.js 22 or newer, then retry.");
  }
  if (existsSync(".env.local")) {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      throw new ConfigurationError(`Could not load .env.local. Check that it is readable and contains valid environment settings. ${SETUP_HELP}`);
    }
  }
  const mode = process.env.RENTESCROW_STORAGE || "local";
  if (mode !== "local" && mode !== "mongodb") {
    throw new ConfigurationError(`RENTESCROW_STORAGE must be local or mongodb. ${SETUP_HELP}`);
  }
  return mode;
}

async function main(): Promise<void> {
  let phase = "configuration";
  let failed = false;
  let collection: Collection<ConnectionProbe> | undefined;
  let probe: ConnectionProbe | undefined;
  let insertAttempted = false;
  let insertAcknowledged = false;

  try {
    const mode = loadConfiguration();
    console.log(`Application storage mode: ${mode}.`);
    if (mode === "local") console.log("This check does not change the application's local storage setting.");

    const uri = process.env.MONGODB_URI?.trim();
    if (!uri) {
      throw new ConfigurationError(`MONGODB_URI is missing. Set it in .env.local without sharing it in chat. ${SETUP_HELP}`);
    }
    if (!/^mongodb(?:\+srv)?:\/\//.test(uri)) {
      throw new ConfigurationError(`MONGODB_URI must begin with mongodb:// or mongodb+srv://. ${SETUP_HELP}`);
    }
    if (!/^[a-zA-Z0-9_-]{1,63}$/.test(process.env.MONGODB_DATABASE || "rentescrow")) {
      throw new ConfigurationError(`MONGODB_DATABASE must contain 1-63 letters, numbers, underscores, or hyphens. ${SETUP_HELP}`);
    }

    phase = "connection and required index setup";
    const database = await getMongoDatabase();
    phase = "ping";
    await database.command({ ping: 1, maxTimeMS: OPERATION_TIMEOUT_MS });

    collection = database.collection<ConnectionProbe>("_connection_checks");
    probe = {
      _id: `check-${randomUUID()}`,
      purpose: "rentescrow-db-check",
      nonce: randomUUID(),
      createdAt: new Date(),
    };
    phase = "probe write";
    insertAttempted = true;
    const inserted = await collection.insertOne(probe, { maxTimeMS: OPERATION_TIMEOUT_MS });
    if (!inserted.acknowledged) throw new Error("Probe write was not acknowledged.");
    insertAcknowledged = true;

    phase = "probe read verification";
    const fetched = await collection.findOne({ _id: probe._id, purpose: probe.purpose, nonce: probe.nonce }, { maxTimeMS: OPERATION_TIMEOUT_MS });
    if (!fetched || fetched.createdAt.getTime() !== probe.createdAt.getTime()) {
      throw new Error("Probe did not round-trip correctly.");
    }
  } catch (error) {
    failed = true;
    // Driver errors may contain connection details; only our own configuration messages are printed.
    console.error(error instanceof ConfigurationError ? error.message : `MongoDB check failed during ${phase}. Check the URI, Atlas network access, database user readWrite permissions, and existing indexes. ${SETUP_HELP}`);
  } finally {
    // Attempt cleanup even when the write acknowledgement was lost, scoped to this invocation only.
    if (collection && probe && insertAttempted) {
      try {
        const filter = { _id: probe._id, purpose: probe.purpose, nonce: probe.nonce };
        const deleted = await collection.deleteOne(filter, { maxTimeMS: OPERATION_TIMEOUT_MS });
        if (!deleted.acknowledged || (insertAcknowledged && deleted.deletedCount !== 1)) {
          throw new Error("Probe removal was not confirmed.");
        }
        if (await collection.findOne(filter, { maxTimeMS: OPERATION_TIMEOUT_MS })) {
          throw new Error("Probe still exists after removal.");
        }
      } catch {
        failed = true;
        console.error("MongoDB probe cleanup could not be verified. A document from this check may remain in _connection_checks. Check delete permissions and network access; no other documents were targeted.");
      }
    }
    try {
      await closeMongoConnection();
    } catch {
      failed = true;
      console.error("MongoDB connection close could not be verified. The connection check did not pass.");
    }
  }

  if (!failed) {
    console.log("MongoDB connection check passed: required indexes, ping, probe write/read, probe cleanup, and connection close verified.");
  }
  process.exitCode = failed ? 1 : 0;
}

void main();
