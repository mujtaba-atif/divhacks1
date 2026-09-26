import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { isValidClassicAddress } from "xrpl";
import { z } from "zod";
import type { XrplPending, XrplReceipt } from "@/lib/integrations/xrpl-settlement";
import type { XrplSettlement } from "@/lib/types";
import { ApiError } from "./errors";

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

const journalDirectory = path.join(process.cwd(), ".data", "xrpl-journal");

const journalIdentity = z.string().min(1);
const journalHash = z.string().regex(/^[A-F0-9]{64}$/);
const journalWallet = z.string().refine(isValidClassicAddress);
const walletJournalSchema = z.object({
  version: z.literal(1),
  ownerId: journalIdentity,
  caseId: journalIdentity,
  escrowId: journalIdentity,
  settlementId: journalIdentity,
  status: z.enum(["pending", "validated"]),
  pending: z.object({
    hash: journalHash,
    intent: z.object({
      ownerId: journalIdentity,
      caseId: journalIdentity,
      escrowId: journalIdentity,
      settlementId: journalIdentity,
      source: journalWallet,
      destination: journalWallet,
      amountDrops: z.string().regex(/^[1-9]\d*$/),
    }),
  }),
  receipt: z.object({
    hash: journalHash,
    caseId: journalIdentity,
    settlementId: journalIdentity,
    source: journalWallet,
    destination: journalWallet,
    amountDrops: z.string().regex(/^[1-9]\d*$/),
    validated: z.literal(true),
    result: z.literal("tesSUCCESS"),
    ledgerIndex: z.number().int().positive().safe(),
    validatedAt: z.string().datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value))),
  }).optional(),
}).superRefine((record, context) => {
  const intent = record.pending.intent;
  if (record.ownerId !== intent.ownerId || record.caseId !== intent.caseId
    || record.escrowId !== intent.escrowId || record.settlementId !== intent.settlementId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Journal identity mismatch" });
  }
  if (record.status === "validated") {
    const receipt = record.receipt;
    if (!receipt || receipt.hash !== record.pending.hash || receipt.caseId !== record.caseId
      || receipt.settlementId !== record.settlementId || receipt.source !== intent.source
      || receipt.destination !== intent.destination || receipt.amountDrops !== intent.amountDrops) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Journal receipt mismatch" });
    }
  }
});

function journalFilename(ownerId: string, caseId: string, escrowId: string, settlementId: string) {
  const digest = createHash("sha256")
    .update(ownerId).update("\0").update(caseId).update("\0")
    .update(escrowId).update("\0").update(settlementId).digest("hex");
  return path.join(journalDirectory, `${digest}.json`);
}

function filenameFor(settlement: XrplSettlement) {
  return journalFilename(settlement.ownerId, settlement.caseId, settlement.escrowId, settlement.id);
}

function assertJournalIdentity(record: XrplJournalRecord, settlement: XrplSettlement) {
  if (record.version !== 1 || record.ownerId !== settlement.ownerId || record.caseId !== settlement.caseId
    || record.escrowId !== settlement.escrowId || record.settlementId !== settlement.id
    || record.pending.intent.settlementId !== settlement.id || record.pending.intent.caseId !== settlement.caseId
    || record.pending.intent.ownerId !== settlement.ownerId || record.pending.intent.escrowId !== settlement.escrowId
    || record.pending.intent.source !== settlement.source || record.pending.intent.destination !== settlement.destination
    || record.pending.intent.amountDrops !== settlement.amountDrops) {
    throw new ApiError(500, "The durable XRPL journal does not match this case authorization.", false, "XRPL_JOURNAL_MISMATCH");
  }
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

export async function readXrplJournal(settlement: XrplSettlement): Promise<XrplJournalRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(filenameFor(settlement), "utf8")) as XrplJournalRecord;
    walletJournalSchema.parse(parsed);
    assertJournalIdentity(parsed, settlement);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, "The durable XRPL journal could not be read safely.", false, "XRPL_JOURNAL_INVALID");
  }
}

/** Call while holding the source wallet lock, before signing a new transaction. */
export async function assertXrplWalletAvailable(source: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(journalDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new ApiError(500, "The durable XRPL wallet reservations could not be read safely.", false, "XRPL_JOURNAL_INVALID");
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    let record: z.infer<typeof walletJournalSchema>;
    try {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) throw new Error("Invalid journal file");
      record = walletJournalSchema.parse(JSON.parse(await readFile(path.join(journalDirectory, entry.name), "utf8")));
      if (path.basename(journalFilename(record.ownerId, record.caseId, record.escrowId, record.settlementId)) !== entry.name) {
        throw new Error("Journal filename mismatch");
      }
    } catch {
      // An unreadable reservation cannot safely be attributed to another wallet.
      throw new ApiError(500, "The durable XRPL wallet reservations could not be read safely.", false, "XRPL_JOURNAL_INVALID");
    }
    if (record.status === "pending" && record.pending.intent.source === source) {
      throw new ApiError(409,
        "This source wallet has an unresolved XRPL transaction. Reconcile its recorded hash before signing another case settlement.",
        false, "XRPL_WALLET_PENDING");
    }
  }
}

export async function recordXrplPending(settlement: XrplSettlement, pending: XrplPending) {
  const existing = await readXrplJournal(settlement);
  if (existing?.status === "validated") {
    throw new ApiError(409, "This settlement already has a validated durable receipt.", false, "SETTLEMENT_ALREADY_COMPLETED");
  }
  if (existing && (existing.pending.hash !== pending.hash
    || JSON.stringify(existing.pending.intent) !== JSON.stringify(pending.intent))) {
    throw new ApiError(409, "A different XRPL transaction is already pending for this settlement. Reconcile it before any retry.", false, "SETTLEMENT_PENDING");
  }
  const record: XrplJournalRecord = existing ?? {
    version: 1,
    ownerId: settlement.ownerId,
    caseId: settlement.caseId,
    escrowId: settlement.escrowId,
    settlementId: settlement.id,
    status: "pending",
    pending,
    updatedAt: new Date().toISOString(),
  };
  assertJournalIdentity(record, settlement);
  await durableWrite(filenameFor(settlement), record);
  return record;
}

export async function recordXrplValidated(
  settlement: XrplSettlement,
  pending: XrplPending,
  receipt: XrplReceipt,
) {
  const existing = await readXrplJournal(settlement);
  if (!existing || existing.pending.hash !== pending.hash) {
    throw new ApiError(500, "A validated XRPL receipt cannot be recorded without its matching durable pending transaction.", false, "XRPL_JOURNAL_MISMATCH");
  }
  if (receipt.hash !== pending.hash || receipt.caseId !== settlement.caseId || receipt.settlementId !== settlement.id
    || receipt.source !== settlement.source || receipt.destination !== settlement.destination
    || receipt.amountDrops !== settlement.amountDrops || receipt.result !== "tesSUCCESS" || receipt.validated !== true) {
    throw new ApiError(500, "The validated XRPL receipt does not match the authorized pending transaction.", false, "XRPL_RECEIPT_MISMATCH");
  }
  if (existing.status === "validated") return existing;
  const validated: XrplJournalRecord = {
    ...existing, status: "validated", receipt, updatedAt: new Date().toISOString(),
  };
  await durableWrite(filenameFor(settlement), validated);
  return validated;
}
