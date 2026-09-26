import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { MongoClient } from "mongodb";
import { createDemoCase } from "@/lib/seed";
import type { CaseRecord } from "@/lib/types";
import { ApiError } from "./errors";

export interface SessionDocument {
  ownerId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  accountBalanceCents: number;
  simulatedDebitsCents: number;
  cases: CaseRecord[];
  uncertainDeliveries?: { caseId: string; messageHash: string; createdAt: string }[];
}

const sharedRuntime = globalThis as typeof globalThis & { rentEscrowSessionLocks?: Map<string, Promise<void>> };
const sessionLocks = sharedRuntime.rentEscrowSessionLocks ??= new Map<string, Promise<void>>();
let mongoClient: Promise<MongoClient> | undefined;
const dataDirectory = path.join(process.cwd(), ".data", "sessions");

function mongoEnabled() {
  return process.env.RENTESCROW_STORAGE === "mongodb";
}

async function collection() {
  if (!process.env.MONGODB_URI) {
    throw new ApiError(503, "MongoDB storage is selected but MONGODB_URI is missing.");
  }
  if (!mongoClient) {
    const connection = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
    }).connect();
    mongoClient = connection;
    connection.catch(() => { mongoClient = undefined; });
  }
  const client = await mongoClient;
  return client.db(process.env.MONGODB_DATABASE || "rentescrow").collection<SessionDocument>("sessions");
}

function filename(ownerId: string) {
  const digest = createHash("sha256").update(ownerId).digest("hex");
  return path.join(dataDirectory, `${digest}.json`);
}

export async function readSession(ownerId: string): Promise<SessionDocument | null> {
  if (mongoEnabled()) {
    const document = await (await collection()).findOne({ ownerId }, { projection: { _id: 0 } });
    return document as SessionDocument | null;
  }
  try {
    return JSON.parse(await readFile(filename(ownerId), "utf8")) as SessionDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function saveSession(document: SessionDocument, expectedRevision?: number) {
  document.updatedAt = new Date().toISOString();
  const serialized = JSON.stringify(document);
  const maximum = (mongoEnabled() ? 12 : 32) * 1024 * 1024;
  if (Buffer.byteLength(serialized) > maximum) {
    throw new ApiError(413, "This demo session has reached its evidence storage limit. Export your cases and reset the demo to continue.");
  }
  if (mongoEnabled()) {
    const sessions = await collection();
    if (expectedRevision === undefined) {
      await sessions.insertOne(document);
    } else {
      const result = await sessions.replaceOne(
        { ownerId: document.ownerId, revision: expectedRevision }, document,
      );
      if (result.matchedCount !== 1) {
        throw new ApiError(409, "This session changed in another request. Refresh and try again.");
      }
    }
    return;
  }
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const target = filename(document.ownerId);
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function seedSession(ownerId: string): SessionDocument {
  const demoCase = createDemoCase(ownerId);
  const now = new Date().toISOString();
  return {
    ownerId,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    accountBalanceCents: demoCase.accountBalanceCents,
    simulatedDebitsCents: demoCase.escrow.status === "unfunded" ? 0 : demoCase.escrow.amountCents,
    cases: [demoCase],
  };
}

export async function createSession() {
  const token = randomBytes(32).toString("hex");
  const ownerId = ownerIdFromToken(token);
  const document = seedSession(ownerId);
  await saveSession(document);
  return { document, token };
}

export function ownerIdFromToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// Session-level serialization also protects the shared balance across different cases.
async function serialize<T>(ownerId: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(ownerId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  sessionLocks.set(ownerId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sessionLocks.get(ownerId) === current) sessionLocks.delete(ownerId);
  }
}

export async function mutateSession<T>(
  ownerId: string,
  operation: (document: SessionDocument) => Promise<T> | T,
): Promise<T> {
  return serialize(ownerId, async () => {
    const document = await readSession(ownerId);
    if (!document) throw new ApiError(401, "Your demo session expired. Reload the page to start again.");
    const revision = document.revision;
    try {
      const result = await operation(document);
      document.revision = revision + 1;
      await saveSession(document, revision);
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.persistAudit) {
        document.revision = revision + 1;
        await saveSession(document, revision);
      }
      throw error;
    }
  });
}

export async function resetSession(ownerId: string) {
  return mutateSession(ownerId, (document) => {
    const fresh = seedSession(ownerId);
    document.cases = fresh.cases;
    document.accountBalanceCents = fresh.accountBalanceCents;
    document.simulatedDebitsCents = fresh.simulatedDebitsCents;
    document.uncertainDeliveries = [];
    return document.cases;
  });
}

export function findCase(document: SessionDocument, caseId: string) {
  const caseRecord = document.cases.find((item) => item.id === caseId && item.ownerId === document.ownerId);
  if (!caseRecord) throw new ApiError(404, "Case not found in this demo session.");
  return caseRecord;
}

export function updateSharedBalance(document: SessionDocument, balanceCents: number) {
  document.accountBalanceCents = balanceCents;
  // Resolved dossiers retain their settlement-time financial snapshot.
  for (const caseRecord of document.cases) {
    if (caseRecord.status !== "resolved") caseRecord.accountBalanceCents = balanceCents;
  }
}
