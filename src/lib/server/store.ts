import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDemoCase } from "@/lib/seed";
import type { AuthUser, CaseRecord } from "@/lib/types";
import type { RegisteredUser } from "./auth";
import type { DigitalContract } from "./contracts";
import { ApiError } from "./errors";
import { readXrplJournal } from "./xrpl-journal";
import { assertSessionSize, readMongoSession, saveMongoSession } from "./mongodb-store";
import { getMongoDatabase, mongoStorageEnabled } from "./mongodb";
import { acquireMongoLock } from "./mongodb-lock";

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
  tenantUserId?: string;
  tenantDisplayName?: string;
  demoAccount?: "tenant1" | "tenant2";
  /** Server-seeded signer binding. Browser input can never grant this authority. */
  xrplAuthorized?: true;
  managedProperty?: { id: string; address: string; borough: string; landlordUserId: string };
}

const sharedRuntime = globalThis as typeof globalThis & { rentEscrowLocks?: Map<string, Promise<void>> };
const runtimeLocks = sharedRuntime.rentEscrowLocks ??= new Map<string, Promise<void>>();
const dataDirectory = path.join(process.cwd(), ".data", "sessions");
const lockDirectory = path.join(process.cwd(), ".data", "locks");

function mongoEnabled() {
  return mongoStorageEnabled();
}

function filename(ownerId: string) {
  const digest = createHash("sha256").update(ownerId).digest("hex");
  return path.join(dataDirectory, `${digest}.json`);
}

function normalizeEvidenceVerification(document: SessionDocument | null): SessionDocument | null {
  if (!document) return null;
  for (const record of document.cases) {
    // Old Gemini comparisons contained a model-provided verified flag. They must
    // be reviewed under the application rule before any new authorization.
    // Completed/pending payments retain their receipts and reconciliation state.
    if (record.status === "resolved" || record.escrow.status === "released"
      || record.xrplSettlement?.status === "pending" || record.xrplSettlement?.status === "validated"
      || record.verification?.source !== "gemini") continue;
    const comparison = record.verification.comparison;
    const before = record.evidence.filter((item) => item.stage === "before").at(-1);
    const after = record.evidence.filter((item) => item.stage === "after").at(-1);
    if (comparison?.rule === "heating-evidence-v1"
      && comparison.passed === record.verification.verified
      && comparison.beforeEvidenceId === before?.id && comparison.afterEvidenceId === after?.id) continue;
    delete record.verification;
    record.tenantConfirmed = false;
    for (const evidence of record.evidence) if (evidence.analysis) evidence.analysis.verified = false;
    record.status = record.repairReported ? "verification"
      : record.messages.length || record.escrow.status === "locked" ? "awaiting_repair" : "open";
  }
  return document;
}

export async function readSession(ownerId: string): Promise<SessionDocument | null> {
  if (mongoEnabled()) {
    return normalizeEvidenceVerification(await readMongoSession(ownerId));
  }
  try {
    return normalizeEvidenceVerification(JSON.parse(await readFile(filename(ownerId), "utf8")) as SessionDocument);
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

/** Bind authority from the persisted workspace, never from a request body. */
export function assignCaseOwnership(document: SessionDocument, record: CaseRecord): void {
  if (!document.tenantUserId) return; // Legacy fixtures used by provider/domain tests.
  record.tenantUserId = document.tenantUserId;
  record.tenantDisplayName = document.tenantDisplayName;
  const normalized = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  const property = document.managedProperty;
  const matches = property && normalized(record.building.address) === normalized(property.address)
    && normalized(record.building.borough) === normalized(property.borough);
  record.propertyId = matches ? property.id : `property-${createHash("sha256")
    .update(`${normalized(record.building.address)}|${normalized(record.building.borough)}`).digest("hex").slice(0, 24)}`;
  if (matches) record.landlordUserId = property.landlordUserId;
  else delete record.landlordUserId;
  record.repairs ??= [];
}

/** Idempotent seed: never replace an existing user's case or financial history. */
export async function initializeUserWorkspace(user: AuthUser, landlordUserId: string): Promise<void> {
  if (user.role !== "tenant") return;
  const existing = await readMongoSession(user.workspaceOwnerId);
  if (existing) {
    if (existing.tenantUserId !== user.id) {
      throw new ApiError(409, "The existing workspace belongs to a different user.", false, "CASE_ACCESS_DENIED");
    }
    const shouldAuthorizeXrpl = user.email === "tenant1@rentescrow.demo";
    if (shouldAuthorizeXrpl !== (existing.xrplAuthorized === true)) {
      const expectedRevision = existing.revision;
      if (shouldAuthorizeXrpl) existing.xrplAuthorized = true;
      else delete existing.xrplAuthorized;
      existing.revision = expectedRevision + 1;
      await saveMongoSession(existing, expectedRevision);
    }
    return;
  }
  const document = seedSession(user.workspaceOwnerId);
  document.tenantUserId = user.id;
  document.tenantDisplayName = user.displayName;
  document.demoAccount = user.email === "tenant1@rentescrow.demo" ? "tenant1" : "tenant2";
  if (document.demoAccount === "tenant1") document.xrplAuthorized = true;
  document.managedProperty = { id: "demo-123-example", address: "123 Example Street", borough: "Brooklyn", landlordUserId };
  if (document.demoAccount === "tenant2") document.cases = [];
  for (const record of document.cases) assignCaseOwnership(document, record);
  await saveMongoSession(document);
}

/** Find candidate aggregates by assignment; callers must re-check each case after loading. */
export async function assignedWorkspaceOwners(landlordUserId: string): Promise<string[]> {
  if (mongoEnabled()) {
    const database = await getMongoDatabase();
    const documents = await database.collection<SessionDocument>("sessions")
      .find({ "cases.landlordUserId": landlordUserId }, { projection: { ownerId: 1 } }).toArray();
    return documents.map((document) => document.ownerId);
  }
  let entries: string[];
  try { entries = await readdir(dataDirectory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const owners: string[] = [];
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
    const document = JSON.parse(await readFile(path.join(dataDirectory, entry), "utf8")) as SessionDocument;
    if (document.cases.some((record) => record.landlordUserId === landlordUserId)) owners.push(document.ownerId);
  }
  return owners;
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
  let releaseStorageLock: (() => Promise<void>) | undefined;
  try {
    releaseStorageLock = mongoEnabled()
      ? await acquireMongoLock(kind, key)
      : await acquireFileLock(kind, key);
    return await operation();
  } finally {
    try {
      await releaseStorageLock?.();
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
    if (!document) throw new ApiError(401, "Your workspace is unavailable. Sign in again or ask an operator to check the account seed.");
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
  // Validates the configured storage mode. Both local filesystem locking and
  // MongoDB non-expiring distributed locks preserve the settlement boundary.
  mongoEnabled();
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
      throw new ApiError(409, "This workspace contains live messaging records and cannot be reset. Create another case to preserve delivery and reply history.", false, "MESSAGE_HISTORY_PRESERVED");
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
      throw new ApiError(409, "This workspace contains a validated on-chain receipt and cannot be reset. Create another case to preserve its audit record.", false, "SETTLEMENT_ALREADY_COMPLETED");
    }
    const fresh = seedSession(ownerId);
    if (document.demoAccount === "tenant2") fresh.cases = [];
    for (const record of fresh.cases) assignCaseOwnership(document, record);
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
  const caseRecord = document.cases.find((item) => item.id === caseId && item.ownerId === document.ownerId
    && (!document.tenantUserId || item.tenantUserId === document.tenantUserId));
  if (!caseRecord) throw new ApiError(document.tenantUserId ? 403 : 404,
    document.tenantUserId ? "Case access denied." : "Case not found in this demo session.", false, "CASE_ACCESS_DENIED");
  return caseRecord;
}

export function updateSharedBalance(document: SessionDocument, balanceCents: number) {
  document.accountBalanceCents = balanceCents;
  // Resolved dossiers retain their settlement-time financial snapshot.
  for (const caseRecord of document.cases) {
    if (caseRecord.status !== "resolved") caseRecord.accountBalanceCents = balanceCents;
  }
}
