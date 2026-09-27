import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Wallet } from "xrpl";
import type { XrplPending, XrplReceipt } from "../src/lib/integrations/xrpl-settlement";
import type { XrplSettlement } from "../src/lib/types";
import { ApiError } from "../src/lib/server/errors";
import { closeMongoConnection, getMongoDatabase } from "../src/lib/server/mongodb";
import { acquireMongoLock, MONGO_LOCKS_COLLECTION } from "../src/lib/server/mongodb-lock";
import {
  assertXrplWalletAvailable,
  readXrplJournal,
  recordXrplPending,
  recordXrplValidated,
  XRPL_JOURNAL_COLLECTION,
} from "../src/lib/server/xrpl-journal";

let server: MongoMemoryServer;
const previousEnvironment = {
  MONGODB_URI: process.env.MONGODB_URI,
  MONGODB_DATABASE: process.env.MONGODB_DATABASE,
  RENTESCROW_STORAGE: process.env.RENTESCROW_STORAGE,
};

before(async () => {
  server = await MongoMemoryServer.create();
  process.env.MONGODB_URI = server.getUri();
  process.env.MONGODB_DATABASE = `xrpl_test_${randomUUID().replaceAll("-", "")}`;
  process.env.RENTESCROW_STORAGE = "mongodb";
});

after(async () => {
  await closeMongoConnection();
  await server.stop();
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

test("Mongo operation locks never expire and only their owner token can release them", async () => {
  const release = await acquireMongoLock("wallet", "shared-wallet", { waitMs: 20, pollMs: 5 });
  await assert.rejects(
    acquireMongoLock("wallet", "shared-wallet", { waitMs: 20, pollMs: 5 }),
    (error: unknown) => error instanceof ApiError && error.code === "XRPL_OPERATION_LOCKED",
  );

  const database = await getMongoDatabase();
  const locks = database.collection(MONGO_LOCKS_COLLECTION);
  assert.equal(await locks.countDocuments(), 1);
  const indexes = await locks.listIndexes().toArray();
  assert.equal(indexes.some((index) => index.expireAfterSeconds !== undefined), false);

  await locks.updateOne({}, { $set: { ownerToken: "operator-changed-token" } });
  await assert.rejects(release(),
    (error: unknown) => error instanceof ApiError && error.code === "XRPL_LOCK_OWNERSHIP_LOST");
  assert.equal(await locks.countDocuments(), 1, "a release with the wrong token must preserve the lock");
  await locks.deleteMany({});

  const releaseAfterRecovery = await acquireMongoLock("wallet", "shared-wallet", { waitMs: 20, pollMs: 5 });
  await releaseAfterRecovery();
  assert.equal(await locks.countDocuments(), 0);
});

test("Mongo journal persists pending identity globally and releases the wallet only after validation", async () => {
  const source = Wallet.generate().classicAddress;
  const first = authorization(source);
  const second = authorization(source);
  await recordXrplPending(first.settlement, first.pending);
  await assert.rejects(assertXrplWalletAvailable(source),
    (error: unknown) => error instanceof ApiError && error.code === "XRPL_WALLET_PENDING");
  await assert.rejects(recordXrplPending(second.settlement, second.pending),
    (error: unknown) => error instanceof ApiError && error.code === "XRPL_WALLET_PENDING");

  await closeMongoConnection();
  assert.equal((await readXrplJournal(first.settlement))?.pending.hash, first.pending.hash,
    "pending authorization must survive a client reconnect");

  const receipt: XrplReceipt = {
    hash: first.pending.hash, ledgerIndex: 1001, result: "tesSUCCESS", validated: true,
    amountDrops: first.settlement.amountDrops, destination: first.settlement.destination, source,
    caseId: first.settlement.caseId, settlementId: first.settlement.id, validatedAt: new Date().toISOString(),
  };
  await recordXrplValidated(first.settlement, first.pending, receipt);
  await assertXrplWalletAvailable(source);
  await recordXrplPending(second.settlement, second.pending);

  const database = await getMongoDatabase();
  const journals = database.collection(XRPL_JOURNAL_COLLECTION);
  assert.equal(await journals.countDocuments({ status: "pending" }), 1);
  const pendingSourceIndex = (await journals.listIndexes().toArray())
    .find((index) => index.name === "xrpl_journal_pending_source_unique");
  assert.equal(pendingSourceIndex?.unique, true);
  assert.deepEqual(pendingSourceIndex?.partialFilterExpression, { status: "pending" });
});
