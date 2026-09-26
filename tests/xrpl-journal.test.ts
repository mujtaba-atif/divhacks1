import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { Wallet } from "xrpl";
import type { XrplPending, XrplReceipt } from "../src/lib/integrations/xrpl-settlement";
import type { XrplSettlement } from "../src/lib/types";
import { ApiError } from "../src/lib/server/errors";

const originalDirectory = process.cwd();
let temporaryDirectory: string;
let journalDirectory: string;
let journal: typeof import("../src/lib/server/xrpl-journal");

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "rentescrow-wallet-journal-"));
  process.chdir(temporaryDirectory);
  journalDirectory = path.join(temporaryDirectory, ".data", "xrpl-journal");
  journal = await import("../src/lib/server/xrpl-journal");
});
beforeEach(async () => { await rm(journalDirectory, { recursive: true, force: true }); });
after(async () => {
  process.chdir(originalDirectory);
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function authorization(source: string, ownerId = randomUUID()) {
  const settlement: XrplSettlement = {
    id: randomUUID(), ownerId, caseId: randomUUID(), escrowId: randomUUID(),
    network: "testnet", transactionType: "Payment", source,
    destination: Wallet.generate().classicAddress, amountDrops: "1000000", amountUsdCents: 40000,
    status: "ready", createdAt: new Date().toISOString(),
  };
  const pending: XrplPending = {
    hash: createHash("sha256").update(settlement.id).digest("hex").toUpperCase(),
    sequence: 123, preparedLedgerIndex: 1000, lastLedgerSequence: 1020,
    intent: {
      caseId: settlement.caseId, ownerId, escrowId: settlement.escrowId, settlementId: settlement.id,
      requestedAction: "REQUEST_SETTLEMENT_REVIEW", transactionType: "Payment", network: "testnet",
      source, destination: settlement.destination, amountDrops: settlement.amountDrops,
      amountUsdCents: settlement.amountUsdCents,
    },
  };
  return { settlement, pending };
}

test("unresolved transactions reserve the shared wallet across cases and sessions", async () => {
  const source = Wallet.generate().classicAddress;
  const first = authorization(source);
  const second = authorization(source);
  assert.notEqual(first.settlement.ownerId, second.settlement.ownerId);
  assert.notEqual(first.settlement.caseId, second.settlement.caseId);
  await journal.assertXrplWalletAvailable(source);
  await journal.recordXrplPending(first.settlement, first.pending);
  await assert.rejects(journal.assertXrplWalletAvailable(second.settlement.source),
    (error: unknown) => error instanceof ApiError && error.code === "XRPL_WALLET_PENDING");
  assert.equal((await journal.readXrplJournal(first.settlement))?.pending.hash, first.pending.hash);
  assert.equal(await journal.readXrplJournal(second.settlement), null);
});

test("an unresolved transaction does not reserve a different source wallet", async () => {
  const first = authorization(Wallet.generate().classicAddress);
  const second = authorization(Wallet.generate().classicAddress);
  await journal.recordXrplPending(first.settlement, first.pending);
  await journal.assertXrplWalletAvailable(second.settlement.source);
});

test("a matching durable validated receipt releases the wallet reservation", async () => {
  const { settlement, pending } = authorization(Wallet.generate().classicAddress);
  await journal.recordXrplPending(settlement, pending);
  const receipt: XrplReceipt = {
    hash: pending.hash, ledgerIndex: 1001, result: "tesSUCCESS", validated: true,
    amountDrops: settlement.amountDrops, destination: settlement.destination, source: settlement.source,
    caseId: settlement.caseId, settlementId: settlement.id, validatedAt: new Date().toISOString(),
  };
  await journal.recordXrplValidated(settlement, pending, receipt);
  await journal.assertXrplWalletAvailable(settlement.source);
  assert.equal((await journal.readXrplJournal(settlement))?.status, "validated");
});

test("unreadable reservations fail closed without exposing another case's records", async () => {
  await mkdir(journalDirectory, { recursive: true });
  await writeFile(path.join(journalDirectory, `${"a".repeat(64)}.json`), "not valid JSON");
  await assert.rejects(journal.assertXrplWalletAvailable(Wallet.generate().classicAddress),
    (error: unknown) => error instanceof ApiError && error.code === "XRPL_JOURNAL_INVALID"
      && !error.message.includes("not valid JSON"));
});

test("a validated status without a matching receipt cannot release the reservation", async () => {
  const { settlement, pending } = authorization(Wallet.generate().classicAddress);
  const record = await journal.recordXrplPending(settlement, pending);
  const filename = createHash("sha256")
    .update(settlement.ownerId).update("\0").update(settlement.caseId).update("\0")
    .update(settlement.escrowId).update("\0").update(settlement.id).digest("hex");
  await writeFile(path.join(journalDirectory, `${filename}.json`), JSON.stringify({ ...record, status: "validated" }));
  await assert.rejects(journal.assertXrplWalletAvailable(settlement.source),
    (error: unknown) => error instanceof ApiError && error.code === "XRPL_JOURNAL_INVALID");
});

test("unknown versions, statuses and malformed source bindings fail closed", async () => {
  const { settlement, pending } = authorization(Wallet.generate().classicAddress);
  const record = await journal.recordXrplPending(settlement, pending);
  const filename = createHash("sha256")
    .update(settlement.ownerId).update("\0").update(settlement.caseId).update("\0")
    .update(settlement.escrowId).update("\0").update(settlement.id).digest("hex");
  for (const change of [
    { version: 2 },
    { status: "unknown" },
    { pending: { ...record.pending, intent: { ...record.pending.intent, source: "invalid-wallet" } } },
  ]) {
    await writeFile(path.join(journalDirectory, `${filename}.json`), JSON.stringify({ ...record, ...change }));
    await assert.rejects(journal.assertXrplWalletAvailable(settlement.source),
      (error: unknown) => error instanceof ApiError && error.code === "XRPL_JOURNAL_INVALID");
  }
});

test("direct case journal reads reject malformed receipts and preserve full valid records", async () => {
  const { settlement, pending } = authorization(Wallet.generate().classicAddress);
  const record = await journal.recordXrplPending(settlement, pending);
  const filename = createHash("sha256")
    .update(settlement.ownerId).update("\0").update(settlement.caseId).update("\0")
    .update(settlement.escrowId).update("\0").update(settlement.id).digest("hex");
  const target = path.join(journalDirectory, `${filename}.json`);
  const receipt: XrplReceipt = {
    hash: pending.hash, ledgerIndex: 1001, result: "tesSUCCESS", validated: true,
    amountDrops: settlement.amountDrops, destination: settlement.destination, source: settlement.source,
    caseId: settlement.caseId, settlementId: settlement.id, validatedAt: new Date().toISOString(),
  };
  const validated = { ...record, status: "validated", receipt };
  for (const change of [
    { ledgerIndex: 0 }, { ledgerIndex: 1.5 }, { ledgerIndex: Number.MAX_SAFE_INTEGER + 1 },
    { validatedAt: "not-a-date" }, { validatedAt: undefined },
    { validated: false }, { result: "tecUNFUNDED_PAYMENT" }, { hash: "B".repeat(64) },
  ]) {
    await writeFile(target, JSON.stringify({ ...validated, receipt: { ...receipt, ...change } }));
    await assert.rejects(journal.readXrplJournal(settlement),
      (error: unknown) => error instanceof ApiError && error.code === "XRPL_JOURNAL_INVALID");
  }
  for (const change of [
    { source: Wallet.generate().classicAddress },
    { destination: Wallet.generate().classicAddress },
    { amountDrops: "2000000" },
  ]) {
    await writeFile(target, JSON.stringify({
      ...validated, receipt: { ...receipt, ...change },
      pending: { ...pending, intent: { ...pending.intent, ...change } },
    }));
    await assert.rejects(journal.readXrplJournal(settlement),
      (error: unknown) => error instanceof ApiError && error.code === "XRPL_JOURNAL_MISMATCH");
  }
  await writeFile(target, JSON.stringify(validated));
  assert.deepEqual(await journal.readXrplJournal(settlement), validated);
});
