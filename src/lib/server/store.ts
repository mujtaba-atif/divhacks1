import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDemoCase } from "@/lib/seed";
import type { CaseRecord } from "@/lib/types";
import type { RegisteredUser } from "./auth";
import type { DigitalContract } from "./contracts";
import { ApiError } from "./errors";
import { readXrplJournal } from "./xrpl-journal";
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

const sharedRuntime = globalThis as typeof globalThis & { rentEscrowLocks?: Map<string, Promise<void>> };
const runtimeLocks = sharedRuntime.rentEscrowLocks ??= new Map<string, Promise<void>>();
const dataDirectory = path.join(process.cwd(), ".data", "sessions");
const lockDirectory = path.join(process.cwd(), ".data", "locks");

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
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
    const directory = await open(dataDirectory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
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
function lockPath(kind: "session" | "wallet", key: string) {
  const digest = createHash("sha256").update(`${kind}\0${key}`).digest("hex");
  return path.join(lockDirectory, `${kind}-${digest}.lock`);
}

async function acquireFileLock(kind: "session" | "wallet", key: string) {
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const target = lockPath(kind, key);
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      await mkdir(target, { mode: 0o700 });
      try {
        await writeFile(path.join(target, "owner"), `${process.pid}\n${new Date().toISOString()}\n`, {
          mode: 0o600, flag: "wx",
        });
      } catch (error) {
        await rmdir(target).catch(() => undefined);
        throw error;
      }
      return async () => {
        await unlink(path.join(target, "owner")).catch(() => undefined);
        await rmdir(target).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new ApiError(423,
          `This ${kind} is locked by another settlement operation. If its process stopped unexpectedly, an operator must remove the recorded lock after checking XRPL.`,
          false, "XRPL_OPERATION_LOCKED");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function serialize<T>(kind: "session" | "wallet", key: string, operation: () => Promise<T>): Promise<T> {
  const runtimeKey = `${kind}:${key}`;
  const previous = runtimeLocks.get(runtimeKey) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  runtimeLocks.set(runtimeKey, current);
  await previous;
  let releaseFile: (() => Promise<void>) | undefined;
  try {
    if (!mongoEnabled()) releaseFile = await acquireFileLock(kind, key);
    return await operation();
  } finally {
    try {
      await releaseFile?.();
    } finally {
      release();
      if (runtimeLocks.get(runtimeKey) === current) runtimeLocks.delete(runtimeKey);
    }
  }
}

export interface SessionMutationContext {
  /** Atomically persists the current mutation before an external side effect. */
  checkpoint(): Promise<void>;
}

export async function mutateSession<T>(
  ownerId: string,
  operation: (document: SessionDocument, context: SessionMutationContext) => Promise<T> | T,
): Promise<T> {
  return serialize("session", ownerId, async () => {
    const document = await readSession(ownerId);
    if (!document) throw new ApiError(401, "Your demo session expired. Reload the page to start again.");
    let expectedRevision = document.revision;
    const checkpoint = async () => {
      document.revision = expectedRevision + 1;
      await saveSession(document, expectedRevision);
      expectedRevision = document.revision;
    };
    try {
      const result = await operation(document, { checkpoint });
      await checkpoint();
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.persistAudit) {
        await checkpoint();
      }
      throw error;
    }
  });
}

export function assertXrplStorageCapability(): void {
  if (mongoEnabled()) {
    throw new ApiError(503,
      "Live XRPL settlement is disabled with MongoDB session storage until a shared distributed wallet lock is configured. Use local storage for this single-host demo.",
      false, "XRPL_DISTRIBUTED_LOCK_REQUIRED");
  }
}

/** Lock order is always session first, then wallet. Call only from mutateSession. */
export async function withXrplWalletLock<T>(source: string, operation: () => Promise<T>): Promise<T> {
  assertXrplStorageCapability();
  return serialize("wallet", source, operation);
}

export async function resetSession(ownerId: string) {
  return mutateSession(ownerId, async (document) => {
    if (document.uncertainDeliveries?.length || document.cases.some((item) => item.messages.some((message) =>
      (message.provider === "spectrum" || message.provider === "photon" || message.provider === undefined)
      && ["sent", "received", "pending", "uncertain"].includes(message.delivery)))) {
      throw new ApiError(409, "This session contains live messaging records and cannot be reset. Start a new browser session to preserve delivery and reply history.", false, "MESSAGE_HISTORY_PRESERVED");
    }
    for (const item of document.cases) {
      const journal = item.xrplSettlement ? await readXrplJournal(item.xrplSettlement) : null;
      if (item.xrplSettlement?.status === "pending" || journal?.status === "pending") {
        throw new ApiError(409, "Reconcile the pending XRPL transaction before resetting this session.", false, "SETTLEMENT_PENDING");
      }
      if (journal?.status === "validated") {
        const receipt = journal.receipt;
        const applied = receipt && item.xrplSettlement?.status === "validated"
          && item.xrplSettlement.hash === receipt.hash && item.xrplSettlement.ledgerIndex === receipt.ledgerIndex
          && item.xrplSettlement.result === "tesSUCCESS" && item.escrow.status === "released" && item.status === "resolved";
        if (!applied) {
          throw new ApiError(409, "Apply the durable validated XRPL receipt before resetting this session.", false,
            "XRPL_RECEIPT_RECONCILIATION_REQUIRED");
        }
      }
    }
    if (document.cases.some((item) => item.xrplSettlement?.status === "validated")) {
      throw new ApiError(409, "This session contains a validated on-chain receipt and cannot be reset. Start a new browser session to preserve its audit record.", false, "SETTLEMENT_ALREADY_COMPLETED");
    }
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
