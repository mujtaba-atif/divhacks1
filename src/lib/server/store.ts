import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDemoCase } from "@/lib/seed";
import type { CaseRecord } from "@/lib/types";
import type { RegisteredUser } from "./auth";
import type { DigitalContract } from "./contracts";
import { ApiError } from "./errors";
import { assertSessionSize, readMongoSession, saveMongoSession } from "./mongodb-store";

export interface SessionDocument {
  ownerId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  accountBalanceCents: number;
  simulatedDebitsCents: number;
  cases: CaseRecord[];
  uncertainDeliveries?: { caseId: string; messageHash: string; createdAt: string }[];
  /** Optional so existing anonymous demo sessions retain their original shape. */
  users?: RegisteredUser[];
  contracts?: DigitalContract[];
}

const sharedRuntime = globalThis as typeof globalThis & { rentEscrowSessionLocks?: Map<string, Promise<void>> };
const sessionLocks = sharedRuntime.rentEscrowSessionLocks ??= new Map<string, Promise<void>>();
const dataDirectory = path.join(process.cwd(), ".data", "sessions");

function mongoEnabled() {
  const mode = process.env.RENTESCROW_STORAGE || "local";
  if (mode !== "local" && mode !== "mongodb") throw new ApiError(503, "RENTESCROW_STORAGE must be local or mongodb.");
  return mode === "mongodb";
}

function filename(ownerId: string) {
  const digest = createHash("sha256").update(ownerId).digest("hex");
  return path.join(dataDirectory, `${digest}.json`);
}

export async function readSession(ownerId: string): Promise<SessionDocument | null> {
  if (mongoEnabled()) {
    return readMongoSession(ownerId);
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
  assertSessionSize(document);
  if (mongoEnabled()) {
    return saveMongoSession(document, expectedRevision);
  }
  const serialized = JSON.stringify(document);
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
    delete document.users;
    delete document.contracts;
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
