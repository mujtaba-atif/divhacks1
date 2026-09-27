import "server-only";

import { createHash } from "node:crypto";
import { MongoClient, type Db } from "mongodb";
import { ApiError } from "./errors";

export const MONGO_EVIDENCE_BUCKET = "evidence";
const CONNECTION_ERROR = "MongoDB Atlas is unavailable. Check the connection URI, database user permissions, and Atlas network access settings.";

interface Connection {
  client: MongoClient;
  database: Db;
}

const runtime = globalThis as typeof globalThis & {
  rentEscrowMongoConnections?: Map<string, Promise<Connection>>;
};
const connections = runtime.rentEscrowMongoConnections ??= new Map<string, Promise<Connection>>();

export function mongoStorageEnabled(): boolean {
  const mode = process.env.RENTESCROW_STORAGE || (process.env.MONGODB_URI ? "mongodb" : "local");
  if (mode !== "local" && mode !== "mongodb") {
    throw new ApiError(503, "RENTESCROW_STORAGE must be local or mongodb.");
  }
  return mode === "mongodb";
}

export async function ensureMongoIndexes(database: Db): Promise<void> {
  try {
    await Promise.all([
      database.collection("sessions").createIndex({ ownerId: 1 }, { unique: true, name: "sessions_ownerId_unique" }),
      database.collection("nyc_buildings").createIndex({ key: 1 }, { unique: true, name: "nyc_building_address_unique" }),
      database.collection("nyc_buildings").createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0, name: "nyc_building_retention" }),
      database.collection(`${MONGO_EVIDENCE_BUCKET}.files`).createIndex(
        { "metadata.ownerId": 1, "metadata.caseId": 1, "metadata.evidenceId": 1, "metadata.sha256": 1 },
        { name: "evidence_owner_case_item_hash" },
      ),
      database.collection(`${MONGO_EVIDENCE_BUCKET}.files`).createIndex(
        { filename: 1, uploadDate: 1 }, { name: "filename_1_uploadDate_1" },
      ),
      database.collection(`${MONGO_EVIDENCE_BUCKET}.chunks`).createIndex(
        { files_id: 1, n: 1 }, { unique: true, name: "files_id_1_n_1" },
      ),
    ]);
  } catch {
    throw new ApiError(503, "MongoDB Atlas indexes could not be initialized. Check database permissions and existing duplicate session owners.");
  }
}

export async function getMongoDatabase(): Promise<Db> {
  const uri = process.env.MONGODB_URI?.trim();
  const databaseName = process.env.MONGODB_DATABASE || "rentescrow";
  if (!uri) throw new ApiError(503, "MongoDB storage is selected but MONGODB_URI is missing.");
  if (!/^mongodb(?:\+srv)?:\/\//.test(uri)) {
    throw new ApiError(503, "MONGODB_URI must be a MongoDB connection string.");
  }
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(databaseName)) {
    throw new ApiError(503, "MONGODB_DATABASE must contain only letters, numbers, underscores, and hyphens (up to 63 characters).");
  }
  const key = createHash("sha256").update(uri).update("\0").update(databaseName).digest("hex");
  let connection = connections.get(key);
  if (!connection) {
    connection = (async () => {
      let client: MongoClient | undefined;
      try {
        client = new MongoClient(uri, {
          appName: "RentEscrow NYC", maxPoolSize: 10, minPoolSize: 0, maxConnecting: 2,
          maxIdleTimeMS: 60_000, waitQueueTimeoutMS: 5_000,
          serverSelectionTimeoutMS: 8_000, connectTimeoutMS: 8_000, socketTimeoutMS: 30_000,
          timeoutMS: 20_000,
          retryWrites: true, writeConcern: { w: "majority" },
        });
        await client.connect();
        const database = client.db(databaseName);
        await ensureMongoIndexes(database);
        return { client, database };
      } catch (error) {
        await client?.close().catch(() => undefined);
        if (error instanceof ApiError) throw error;
        throw new ApiError(503, CONNECTION_ERROR);
      }
    })();
    connections.set(key, connection);
    connection.catch(() => {
      if (connections.get(key) === connection) connections.delete(key);
    });
  }
  return (await connection).database;
}

export async function closeMongoConnection(): Promise<void> {
  const pending = [...connections.values()];
  connections.clear();
  const results = await Promise.allSettled(pending.map(async (connection) => (await connection).client.close()));
  if (results.some((result) => result.status === "rejected")) {
    throw new ApiError(503, "The MongoDB connection could not be closed cleanly.");
  }
}
