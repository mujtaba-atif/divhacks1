import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { closeMongoConnection, ensureMongoIndexes, getMongoDatabase } from "../src/lib/server/mongodb";

function environment(t: TestContext, values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function indexedDatabase() {
  const calls: { collection: string; keys: Record<string, number>; options: { unique?: boolean; name: string } }[] = [];
  const database = { collection: (name: string) => ({
    createIndex: async (keys: Record<string, number>, options: { unique?: boolean; name: string }) => {
      calls.push({ collection: name, keys, options });
      return options.name;
    },
  }) } as unknown as Db;
  return { database, calls };
}

test("MongoDB initializes session, public building cache, and GridFS indexes", async () => {
  const { database, calls } = indexedDatabase();
  await ensureMongoIndexes(database);
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.find((call) => call.collection === "sessions"), {
    collection: "sessions", keys: { ownerId: 1 }, options: { unique: true, name: "sessions_ownerId_unique" },
  });
  assert.equal(calls.find((call) => call.collection === "evidence.chunks")?.options.unique, true);
  assert.deepEqual(calls.find((call) => call.options.name === "nyc_building_address_unique"), {
    collection: "nyc_buildings", keys: { key: 1 }, options: { unique: true, name: "nyc_building_address_unique" },
  });
  assert.deepEqual(calls.find((call) => call.options.name === "nyc_building_retention"), {
    collection: "nyc_buildings", keys: { purgeAt: 1 }, options: { expireAfterSeconds: 0, name: "nyc_building_retention" },
  });
  assert.deepEqual(calls.find((call) => call.options.name === "evidence_owner_case_item_hash")?.keys,
    { "metadata.ownerId": 1, "metadata.caseId": 1, "metadata.evidenceId": 1, "metadata.sha256": 1 });
});

test("MongoDB connection caching coalesces callers with bounded pools and supports CLI cleanup", async (t) => {
  environment(t, { MONGODB_URI: "mongodb://test-user:test-password@localhost:27017", MONGODB_DATABASE: "rentescrow_test" });
  await closeMongoConnection();
  const { database, calls } = indexedDatabase();
  const connect = t.mock.method(MongoClient.prototype, "connect", async function (this: MongoClient) {
    assert.equal(this.options.maxPoolSize, 10);
    assert.equal(this.options.minPoolSize, 0);
    assert.equal(this.options.maxConnecting, 2);
    assert.equal(this.options.waitQueueTimeoutMS, 5000);
    assert.equal(this.options.serverSelectionTimeoutMS, 8000);
    return this;
  });
  t.mock.method(MongoClient.prototype, "db", () => database);
  const close = t.mock.method(MongoClient.prototype, "close", async () => undefined);
  try {
    const [first, second] = await Promise.all([getMongoDatabase(), getMongoDatabase()]);
    assert.equal(first, database);
    assert.equal(second, database);
    assert.equal(connect.mock.callCount(), 1);
    assert.equal(calls.length, 6);
  } finally {
    await closeMongoConnection();
  }
  assert.equal(close.mock.callCount(), 1);
});

test("connection and index errors never disclose URI credentials and failed clients can retry", async (t) => {
  environment(t, { MONGODB_URI: "mongodb://secret-user:secret-password@localhost:27017", MONGODB_DATABASE: "rentescrow_test" });
  await closeMongoConnection();
  const connect = t.mock.method(MongoClient.prototype, "connect", async () => {
    throw new Error("Could not connect mongodb://secret-user:secret-password@localhost:27017");
  });
  const close = t.mock.method(MongoClient.prototype, "close", async () => undefined);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(getMongoDatabase(), (error: Error) => {
      assert.equal(error.message.includes("secret-user"), false);
      assert.equal(error.message.includes("secret-password"), false);
      return /Atlas is unavailable/.test(error.message);
    });
  }
  assert.equal(connect.mock.callCount(), 2);
  assert.equal(close.mock.callCount(), 2);
  const database = { collection: () => ({ createIndex: async () => { throw new Error("secret-password"); } }) } as unknown as Db;
  await assert.rejects(ensureMongoIndexes(database), (error: Error) => {
    assert.equal(error.message.includes("secret-password"), false);
    return /indexes could not be initialized/.test(error.message);
  });
});

test("missing or invalid configuration fails before any MongoDB network connection", async (t) => {
  environment(t, { MONGODB_URI: undefined, MONGODB_DATABASE: "rentescrow" });
  const connect = t.mock.method(MongoClient.prototype, "connect", async () => { throw new Error("Network must not be used"); });
  await assert.rejects(getMongoDatabase(), /MONGODB_URI is missing/);
  process.env.MONGODB_URI = "https://example.test/secret-password";
  await assert.rejects(getMongoDatabase(), /MongoDB connection string/);
  process.env.MONGODB_URI = "mongodb://localhost:27017";
  process.env.MONGODB_DATABASE = "bad/database";
  await assert.rejects(getMongoDatabase(), /MONGODB_DATABASE must contain/);
  assert.equal(connect.mock.callCount(), 0);
});
