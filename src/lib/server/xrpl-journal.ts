import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
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
    || record.pending.intent.ownerId !== settlement.ownerId || record.pending.intent.escrowId !== settlement.escrowId) {
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
    assertJournalIdentity(parsed, settlement);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, "The durable XRPL journal could not be read safely.", false, "XRPL_JOURNAL_INVALID");
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
