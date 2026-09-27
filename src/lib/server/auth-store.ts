import "server-only";

import { ObjectId, type Db } from "mongodb";
import type { UserRole } from "./auth";
import { ApiError } from "./errors";
import { getMongoDatabase } from "./mongodb";

export const USERS_COLLECTION = "users";
export const AUTH_SESSIONS_COLLECTION = "auth_sessions";

export interface AuthUserRecord {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  role: UserRole;
  displayName: string;
  /** Operator-configured E.164 contact, never a login credential. */
  phoneContact?: string;
  phoneContactConfiguredAt?: Date;
  createdAt: Date;
  updatedAt?: Date;
}

export interface AuthSessionRecord {
  _id?: ObjectId;
  sessionTokenHash: string;
  userId: ObjectId;
  expiresAt: Date;
  createdAt: Date;
}

export interface AuthStorage {
  findUserByEmail(email: string): Promise<AuthUserRecord | null>;
  findUserBySessionTokenHash(sessionTokenHash: string, now: Date): Promise<AuthUserRecord | null>;
  createSession(session: AuthSessionRecord): Promise<void>;
  revokeSession(sessionTokenHash: string): Promise<void>;
}

export async function ensureAuthIndexes(database: Db): Promise<void> {
  try {
    await Promise.all([
      database.collection(USERS_COLLECTION).createIndex(
        { email: 1 },
        { unique: true, name: "users_email_unique" },
      ),
      database.collection(AUTH_SESSIONS_COLLECTION).createIndex(
        { sessionTokenHash: 1 },
        { unique: true, name: "auth_sessions_token_hash_unique" },
      ),
      database.collection(AUTH_SESSIONS_COLLECTION).createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0, name: "auth_sessions_expiry_ttl" },
      ),
      database.collection(AUTH_SESSIONS_COLLECTION).createIndex(
        { userId: 1 },
        { name: "auth_sessions_user_id" },
      ),
    ]);
  } catch {
    throw new ApiError(503,
      "MongoDB authentication indexes could not be initialized. Check database permissions and duplicate user emails.");
  }
}

export function createMongoAuthStorage(database: Db): AuthStorage {
  return {
    async findUserByEmail(email) {
      return database.collection<AuthUserRecord>(USERS_COLLECTION).findOne({ email });
    },

    async findUserBySessionTokenHash(sessionTokenHash, now) {
      const [result] = await database.collection<AuthSessionRecord>(AUTH_SESSIONS_COLLECTION).aggregate<AuthUserRecord>([
        { $match: { sessionTokenHash, expiresAt: { $gt: now } } },
        { $limit: 1 },
        {
          $lookup: {
            from: USERS_COLLECTION,
            localField: "userId",
            foreignField: "_id",
            as: "authenticatedUser",
          },
        },
        { $unwind: "$authenticatedUser" },
        { $replaceWith: "$authenticatedUser" },
      ]).toArray();
      return result ?? null;
    },

    async createSession(session) {
      await database.collection<AuthSessionRecord>(AUTH_SESSIONS_COLLECTION).insertOne(session);
    },

    async revokeSession(sessionTokenHash) {
      await database.collection<AuthSessionRecord>(AUTH_SESSIONS_COLLECTION).deleteOne({ sessionTokenHash });
    },
  };
}

export async function getMongoAuthStorage(): Promise<AuthStorage> {
  const database = await getMongoDatabase();
  await ensureAuthIndexesOnce(database);
  return createMongoAuthStorage(database);
}

const initializedDatabases = new WeakMap<Db, Promise<void>>();

async function ensureAuthIndexesOnce(database: Db): Promise<void> {
  let initialization = initializedDatabases.get(database);
  if (!initialization) {
    initialization = ensureAuthIndexes(database);
    initializedDatabases.set(database, initialization);
    initialization.catch(() => {
      if (initializedDatabases.get(database) === initialization) initializedDatabases.delete(database);
    });
  }
  await initialization;
}
