import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { MongoServerError, type Db } from "mongodb";
import { ApiError } from "./errors";
import { getMongoDatabase } from "./mongodb";

export type MongoLockKind = "session" | "wallet";
export const MONGO_LOCKS_COLLECTION = "operation_locks";

interface MongoLockDocument {
  _id: string;
  kind: MongoLockKind;
  keyHash: string;
  ownerToken: string;
  acquiredAt: Date;
}

export interface MongoLockStorage {
  tryInsert(document: MongoLockDocument): Promise<boolean>;
  release(id: string, ownerToken: string): Promise<boolean>;
}

function lockId(kind: MongoLockKind, key: string): string {
  return createHash("sha256").update(kind).update("\0").update(key).digest("hex");
}

export function createMongoLockStorage(database: Db): MongoLockStorage {
  const collection = database.collection<MongoLockDocument>(MONGO_LOCKS_COLLECTION);
  return {
    async tryInsert(document) {
      try {
        await collection.insertOne(document);
        return true;
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) return false;
        throw error;
      }
    },
    async release(id, ownerToken) {
      const result = await collection.deleteOne({ _id: id, ownerToken });
      return result.deletedCount === 1;
    },
  };
}

export interface MongoLockOptions {
  storage?: MongoLockStorage;
  waitMs?: number;
  pollMs?: number;
}

/**
 * Acquires a non-expiring distributed lock. A process crash intentionally leaves
 * a stale lock for manual recovery after an operator verifies XRPL state.
 */
export async function acquireMongoLock(
  kind: MongoLockKind,
  key: string,
  options: MongoLockOptions = {},
): Promise<() => Promise<void>> {
  const storage = options.storage ?? createMongoLockStorage(await getMongoDatabase());
  const id = lockId(kind, key);
  const ownerToken = randomBytes(32).toString("hex");
  const deadline = Date.now() + (options.waitMs ?? 15_000);
  const document: MongoLockDocument = {
    _id: id,
    kind,
    keyHash: createHash("sha256").update(key).digest("hex"),
    ownerToken,
    acquiredAt: new Date(),
  };

  while (true) {
    let acquired: boolean;
    try {
      acquired = await storage.tryInsert(document);
    } catch {
      throw new ApiError(503, "MongoDB could not acquire the settlement operation lock.", false,
        "XRPL_LOCK_UNAVAILABLE");
    }
    if (acquired) break;
    if (Date.now() >= deadline) {
      throw new ApiError(423,
        `This ${kind} is locked by another settlement operation. If its process stopped unexpectedly, an operator must verify XRPL state before removing the MongoDB lock.`,
        false, "XRPL_OPERATION_LOCKED");
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 50));
  }

  let released = false;
  return async () => {
    if (released) return;
    let owned: boolean;
    try {
      owned = await storage.release(id, ownerToken);
    } catch {
      throw new ApiError(503,
        "MongoDB could not release the settlement operation lock. Operator recovery may be required.", false,
        "XRPL_LOCK_RELEASE_FAILED");
    }
    if (!owned) {
      throw new ApiError(503,
        "The settlement operation lock ownership changed unexpectedly. Verify XRPL state before recovery.", false,
        "XRPL_LOCK_OWNERSHIP_LOST");
    }
    released = true;
  };
}
