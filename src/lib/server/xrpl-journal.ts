import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { MongoServerError, type Db } from "mongodb";
import { isValidClassicAddress } from "xrpl";
import { z } from "zod";
import type { XrplPending, XrplReceipt } from "@/lib/integrations/xrpl-settlement";
import type { XrplSettlement } from "@/lib/types";
import { ApiError } from "./errors";
import { getMongoDatabase, mongoStorageEnabled } from "./mongodb";

export interface XrplJournalRecord {
  version: 1;
  ownerId: string;
  caseId: string;
  escrowId: string;
  settlementId: string;
  status: "pending" | "validated";
  pending: XrplPending;
  receipt?: XrplReceipt;
  updatedAt: string;
}

interface MongoJournalRecord extends XrplJournalRecord { _id: string }

export const XRPL_JOURNAL_COLLECTION = "xrpl_journal";
const journalDirectory = path.join(process.cwd(), ".data", "xrpl-journal");
const journalIdentity = z.string().min(1);
const journalHash = z.string().regex(/^[A-F0-9]{64}$/);
const journalWallet = z.string().refine(isValidClassicAddress);
const journalDate = z.string().datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)));
const intentSchema = z.object({
  ownerId: journalIdentity, caseId: journalIdentity, escrowId: journalIdentity, settlementId: journalIdentity,
  requestedAction: z.literal("REQUEST_SETTLEMENT_REVIEW"), transactionType: z.literal("Payment"),
  network: z.literal("testnet"), source: journalWallet, destination: journalWallet,
  amountDrops: z.string().regex(/^[1-9]\d*$/), amountUsdCents: z.number().int().positive().safe(),
}).strict();
const pendingSchema = z.object({
  hash: journalHash, sequence: z.number().int().positive().safe(),
  lastLedgerSequence: z.number().int().positive().safe(), preparedLedgerIndex: z.number().int().positive().safe(),
  intent: intentSchema,
}).strict().superRefine((pending, context) => {
  if (pending.lastLedgerSequence <= pending.preparedLedgerIndex) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid ledger range" });
  }
});
const receiptSchema = z.object({
  hash: journalHash, caseId: journalIdentity, settlementId: journalIdentity,
  source: journalWallet, destination: journalWallet, amountDrops: z.string().regex(/^[1-9]\d*$/),
  validated: z.literal(true), result: z.literal("tesSUCCESS"), ledgerIndex: z.number().int().positive().safe(),
  validatedAt: journalDate,
}).strict();
const walletJournalSchema = z.object({
  version: z.literal(1), ownerId: journalIdentity, caseId: journalIdentity,
  escrowId: journalIdentity, settlementId: journalIdentity, status: z.enum(["pending", "validated"]),
  pending: pendingSchema, receipt: receiptSchema.optional(), updatedAt: journalDate,
}).strict().superRefine((record, context) => {
  const intent = record.pending.intent;
  if (record.ownerId !== intent.ownerId || record.caseId !== intent.caseId
    || record.escrowId !== intent.escrowId || record.settlementId !== intent.settlementId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Journal identity mismatch" });
  }
  if (record.status === "pending" && record.receipt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Pending journal cannot contain a receipt" });
  }
  if (record.status === "validated") {
    const receipt = record.receipt;
    if (!receipt || receipt.hash !== record.pending.hash || receipt.caseId !== record.caseId
      || receipt.settlementId !== record.settlementId || receipt.source !== intent.source
      || receipt.destination !== intent.destination || receipt.amountDrops !== intent.amountDrops
      || receipt.ledgerIndex <= record.pending.preparedLedgerIndex
      || receipt.ledgerIndex > record.pending.lastLedgerSequence) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Journal receipt mismatch" });
    }
  }
});

function journalKey(ownerId: string, caseId: string, escrowId: string, settlementId: string) {
  return createHash("sha256").update(ownerId).update("\0").update(caseId).update("\0")
    .update(escrowId).update("\0").update(settlementId).digest("hex");
}
function journalFilename(ownerId: string, caseId: string, escrowId: string, settlementId: string) {
  return path.join(journalDirectory, `${journalKey(ownerId, caseId, escrowId, settlementId)}.json`);
}
function filenameFor(settlement: XrplSettlement) {
  return journalFilename(settlement.ownerId, settlement.caseId, settlement.escrowId, settlement.id);
}
function keyFor(settlement: XrplSettlement) {
  return journalKey(settlement.ownerId, settlement.caseId, settlement.escrowId, settlement.id);
}

function assertJournalIdentity(record: XrplJournalRecord, settlement: XrplSettlement) {
  if (record.ownerId !== settlement.ownerId || record.caseId !== settlement.caseId
    || record.escrowId !== settlement.escrowId || record.settlementId !== settlement.id
    || record.pending.intent.settlementId !== settlement.id || record.pending.intent.caseId !== settlement.caseId
    || record.pending.intent.ownerId !== settlement.ownerId || record.pending.intent.escrowId !== settlement.escrowId
    || record.pending.intent.source !== settlement.source || record.pending.intent.destination !== settlement.destination
    || record.pending.intent.amountDrops !== settlement.amountDrops
    || record.pending.intent.amountUsdCents !== settlement.amountUsdCents) {
    throw new ApiError(500, "The durable XRPL journal does not match this case authorization.", false,
      "XRPL_JOURNAL_MISMATCH");
  }
}
function parseJournal(value: unknown): XrplJournalRecord {
  try {
    walletJournalSchema.parse(value);
    // Validation must not reorder the signed intent; reconciliation compares the
    // original server-created structure byte-for-byte before any network read.
    return value as XrplJournalRecord;
  }
  catch { throw new ApiError(500, "The durable XRPL journal could not be read safely.", false, "XRPL_JOURNAL_INVALID"); }
}

async function durableWrite(target: string, value: unknown) {
  await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    const directory = await open(journalDirectory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

const initializedDatabases = new WeakMap<Db, Promise<void>>();
async function mongoJournal(database?: Db) {
  const activeDatabase = database ?? await getMongoDatabase();
  let initialization = initializedDatabases.get(activeDatabase);
  if (!initialization) {
    initialization = activeDatabase.collection<MongoJournalRecord>(XRPL_JOURNAL_COLLECTION).createIndex(
      { "pending.intent.source": 1 },
      { unique: true, partialFilterExpression: { status: "pending" }, name: "xrpl_journal_pending_source_unique" },
    ).then(() => undefined).catch(() => {
      throw new ApiError(503, "MongoDB could not initialize the durable XRPL journal.", false,
        "XRPL_JOURNAL_UNAVAILABLE");
    });
    initializedDatabases.set(activeDatabase, initialization);
    initialization.catch(() => {
      if (initializedDatabases.get(activeDatabase) === initialization) initializedDatabases.delete(activeDatabase);
    });
  }
  await initialization;
  return activeDatabase.collection<MongoJournalRecord>(XRPL_JOURNAL_COLLECTION);
}
function withoutMongoId(document: MongoJournalRecord): XrplJournalRecord {
  const { _id: _id, ...record } = document;
  return parseJournal(record);
}

export async function readXrplJournal(settlement: XrplSettlement): Promise<XrplJournalRecord | null> {
  if (mongoStorageEnabled()) {
    try {
      const document = await (await mongoJournal()).findOne({ _id: keyFor(settlement) });
      if (!document) return null;
      const record = withoutMongoId(document);
      assertJournalIdentity(record, settlement);
      return record;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "MongoDB could not read the durable XRPL journal.", false, "XRPL_JOURNAL_UNAVAILABLE");
    }
  }
  try {
    const record = parseJournal(JSON.parse(await readFile(filenameFor(settlement), "utf8")));
    assertJournalIdentity(record, settlement);
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, "The durable XRPL journal could not be read safely.", false, "XRPL_JOURNAL_INVALID");
  }
}

/** Call while holding the source wallet lock. */
export async function assertXrplWalletAvailable(source: string): Promise<void> {
  if (mongoStorageEnabled()) {
    let documents: MongoJournalRecord[];
    try { documents = await (await mongoJournal()).find({ status: "pending" }).toArray(); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "MongoDB could not read XRPL wallet reservations.", false,
        "XRPL_JOURNAL_UNAVAILABLE");
    }
    for (const document of documents) {
      const record = withoutMongoId(document);
      if (document._id !== journalKey(record.ownerId, record.caseId, record.escrowId, record.settlementId)) {
        throw new ApiError(500, "The durable XRPL wallet reservations could not be read safely.", false,
          "XRPL_JOURNAL_INVALID");
      }
      if (record.pending.intent.source === source) {
        throw new ApiError(409,
          "This source wallet has an unresolved XRPL transaction. Reconcile its recorded hash before signing another case settlement.",
          false, "XRPL_WALLET_PENDING");
      }
    }
    return;
  }
  let entries;
  try { entries = await readdir(journalDirectory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new ApiError(500, "The durable XRPL wallet reservations could not be read safely.", false,
      "XRPL_JOURNAL_INVALID");
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    let record: XrplJournalRecord;
    try {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) throw new Error("Invalid journal file");
      record = parseJournal(JSON.parse(await readFile(path.join(journalDirectory, entry.name), "utf8")));
      if (path.basename(journalFilename(record.ownerId, record.caseId, record.escrowId, record.settlementId)) !== entry.name) {
        throw new Error("Journal filename mismatch");
      }
    } catch {
      throw new ApiError(500, "The durable XRPL wallet reservations could not be read safely.", false,
        "XRPL_JOURNAL_INVALID");
    }
    if (record.status === "pending" && record.pending.intent.source === source) {
      throw new ApiError(409,
        "This source wallet has an unresolved XRPL transaction. Reconcile its recorded hash before signing another case settlement.",
        false, "XRPL_WALLET_PENDING");
    }
  }
}

function samePending(record: XrplJournalRecord, pending: XrplPending): boolean {
  return record.pending.hash === pending.hash && JSON.stringify(record.pending.intent) === JSON.stringify(pending.intent);
}

export async function recordXrplPending(settlement: XrplSettlement, pending: XrplPending) {
  const existing = await readXrplJournal(settlement);
  if (existing?.status === "validated") {
    throw new ApiError(409, "This settlement already has a validated durable receipt.", false,
      "SETTLEMENT_ALREADY_COMPLETED");
  }
  if (existing) {
    if (!samePending(existing, pending)) {
      throw new ApiError(409,
        "A different XRPL transaction is already pending for this settlement. Reconcile it before any retry.", false,
        "SETTLEMENT_PENDING");
    }
    return existing;
  }
  const parsed = parseJournal({
    version: 1, ownerId: settlement.ownerId, caseId: settlement.caseId, escrowId: settlement.escrowId,
    settlementId: settlement.id, status: "pending", pending, updatedAt: new Date().toISOString(),
  });
  assertJournalIdentity(parsed, settlement);
  if (mongoStorageEnabled()) {
    try {
      await (await mongoJournal()).insertOne({ _id: keyFor(settlement), ...parsed });
      return parsed;
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 11000)) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(503, "MongoDB could not record the pending XRPL transaction.", false,
          "XRPL_JOURNAL_UNAVAILABLE");
      }
      const raced = await readXrplJournal(settlement);
      if (raced?.status === "pending" && samePending(raced, pending)) return raced;
      await assertXrplWalletAvailable(settlement.source);
      throw new ApiError(409, "A different XRPL transaction is already pending.", false, "SETTLEMENT_PENDING");
    }
  }
  await durableWrite(filenameFor(settlement), parsed);
  return parsed;
}

export async function recordXrplValidated(
  settlement: XrplSettlement, pending: XrplPending, receipt: XrplReceipt,
) {
  const existing = await readXrplJournal(settlement);
  if (!existing || existing.pending.hash !== pending.hash) {
    throw new ApiError(500,
      "A validated XRPL receipt cannot be recorded without its matching durable pending transaction.", false,
      "XRPL_JOURNAL_MISMATCH");
  }
  if (receipt.hash !== pending.hash || receipt.caseId !== settlement.caseId || receipt.settlementId !== settlement.id
    || receipt.source !== settlement.source || receipt.destination !== settlement.destination
    || receipt.amountDrops !== settlement.amountDrops || receipt.result !== "tesSUCCESS" || receipt.validated !== true) {
    throw new ApiError(500, "The validated XRPL receipt does not match the authorized pending transaction.", false,
      "XRPL_RECEIPT_MISMATCH");
  }
  if (existing.status === "validated") return existing;
  const validated = parseJournal({ ...existing, status: "validated", receipt, updatedAt: new Date().toISOString() });
  if (mongoStorageEnabled()) {
    let matched: number;
    try {
      const result = await (await mongoJournal()).updateOne(
        { _id: keyFor(settlement), status: "pending", "pending.hash": pending.hash },
        { $set: { status: "validated", receipt: validated.receipt, updatedAt: validated.updatedAt } },
      );
      matched = result.matchedCount;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "MongoDB could not record the validated XRPL receipt.", false,
        "XRPL_JOURNAL_UNAVAILABLE");
    }
    if (matched === 1) return validated;
    const raced = await readXrplJournal(settlement);
    if (raced?.status === "validated" && raced.receipt?.hash === receipt.hash) return raced;
    throw new ApiError(500, "The durable XRPL journal changed before validation was recorded.", false,
      "XRPL_JOURNAL_MISMATCH");
  }
  await durableWrite(filenameFor(settlement), validated);
  return validated;
}
