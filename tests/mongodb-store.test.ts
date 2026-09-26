import assert from "node:assert/strict";
import { test } from "node:test";
import { createDemoCase } from "../src/lib/seed";
import type { EvidenceRecord } from "../src/lib/types";
import {
  readMongoSession, saveMongoSession, MAX_EVIDENCE_BYTES, MAX_MONGO_METADATA_BYTES,
  type MongoSessionStorage, type StoredSessionDocument, type EvidenceFileMetadata,
} from "../src/lib/server/mongodb-store";
import type { SessionDocument } from "../src/lib/server/store";

class MemoryStorage implements MongoSessionStorage {
  sessions = new Map<string, StoredSessionDocument>();
  files = new Map<string, { bytes: Buffer; length: number; metadata: EvidenceFileMetadata }>();
  uploads: string[] = [];
  downloads: string[] = [];
  removals: string[] = [];
  failWrite: "cas" | "before" | "after" | undefined;
  failUpload = false;
  partialChunks = new Set<string>();
  failPartialUpload = false;

  async read(ownerId: string) { return structuredClone(this.sessions.get(ownerId) ?? null); }
  async insert(document: StoredSessionDocument) {
    if (this.failWrite === "before") throw new Error("mongodb://secret-user:secret-password@example.test");
    this.sessions.set(document.ownerId, structuredClone(document));
    if (this.failWrite === "after") throw new Error("Unknown write acknowledgement with secret-password");
  }
  async replace(ownerId: string, revision: number, document: StoredSessionDocument) {
    if (this.failWrite === "cas" || this.sessions.get(ownerId)?.revision !== revision) return false;
    await this.insert(document);
    return true;
  }
  async findFile(fileId: string, binding: Parameters<MongoSessionStorage["findFile"]>[1]) {
    const file = this.files.get(fileId);
    if (!file || Object.entries(binding).some(([key, value]) => file.metadata[key as keyof EvidenceFileMetadata] !== value)) return null;
    return { length: file.length, metadata: { ...file.metadata } };
  }
  async upload(fileId: string, _filename: string, bytes: Buffer, metadata: EvidenceFileMetadata) {
    this.uploads.push(fileId);
    if (this.failPartialUpload) {
      this.partialChunks.add(fileId);
      throw new Error("Upload stopped before authenticated file metadata was inserted");
    }
    this.files.set(fileId, { bytes: Buffer.from(bytes), length: bytes.length, metadata: { ...metadata } });
    if (this.failUpload) throw new Error("A GridFS upload failed with secret-password");
  }
  async *download(fileId: string) {
    this.downloads.push(fileId);
    const file = this.files.get(fileId);
    if (!file) throw new Error("Missing file");
    yield file.bytes;
  }
  async removeOwned(fileId: string, uploadAttemptId: string) {
    if (this.files.get(fileId)?.metadata.uploadAttemptId !== uploadAttemptId) return;
    this.removals.push(fileId);
    this.files.delete(fileId);
  }
}

function upload(id: string, bytes = Buffer.from("tenant evidence bytes")): EvidenceRecord {
  return { id, name: `${id}.png`, mimeType: "image/png", stage: "before", note: "Tenant upload",
    createdAt: new Date().toISOString(), isDemo: false, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
}

function session(ownerId = "owner-a", evidence = [upload("upload-a")]): SessionDocument {
  const record = createDemoCase(ownerId);
  record.evidence.push(...evidence);
  return { ownerId, revision: 0, createdAt: record.createdAt, updatedAt: record.updatedAt,
    accountBalanceCents: record.accountBalanceCents, simulatedDebitsCents: 0, cases: [record] };
}

test("GridFS externalizes large evidence while hydrated API records remain unchanged", async () => {
  const storage = new MemoryStorage();
  const bytes = Buffer.alloc(4 * 1024 * 1024, 65);
  const document = session("owner-a", [upload("one", bytes), upload("two", bytes), upload("three", bytes)]);
  assert.ok(Buffer.byteLength(JSON.stringify(document)) > 16 * 1024 * 1024);
  await saveMongoSession(document, undefined, storage);
  const metadata = storage.sessions.get(document.ownerId)!;
  assert.ok(Buffer.byteLength(JSON.stringify(metadata)) < 20_000);
  assert.equal(metadata.cases[0].evidence[1].dataUrl, undefined);
  assert.equal(storage.files.size, 3);
  assert.equal(storage.files.get(metadata.cases[0].evidence[1].blob!.fileId)?.metadata.ownerId, "owner-a");
  assert.equal("blob" in document.cases[0].evidence[1], false);
  assert.deepEqual(await readMongoSession(document.ownerId, storage), document);

  document.revision = 1;
  await saveMongoSession(document, 0, storage);
  assert.equal(storage.uploads.length, 3, "Unchanged evidence must reuse its owned immutable blob");
});

test("GridFS hydration isolates owners and rejects a foreign evidence reference before download", async () => {
  const storage = new MemoryStorage();
  const document = session();
  await saveMongoSession(document, undefined, storage);
  assert.equal(await readMongoSession("owner-b", storage), null);
  const forged = structuredClone(storage.sessions.get("owner-a")!);
  forged.ownerId = "owner-b";
  forged.cases[0].ownerId = "owner-b";
  storage.sessions.set("owner-b", forged);
  await assert.rejects(readMongoSession("owner-b", storage), /another session/);
  assert.equal(storage.downloads.length, 0);
});

test("CAS failure removes only newly uploaded files and preserves the previous dossier", async () => {
  const storage = new MemoryStorage();
  const document = session();
  await saveMongoSession(document, undefined, storage);
  const original = structuredClone(storage.sessions.get(document.ownerId)!);
  const originalFileId = original.cases[0].evidence[1].blob!.fileId;
  document.cases[0].evidence.push(upload("new-upload"));
  document.revision = 1;
  storage.failWrite = "cas";
  await assert.rejects(saveMongoSession(document, 0, storage), /changed in another request/);
  assert.deepEqual(storage.sessions.get(document.ownerId), original);
  assert.deepEqual([...storage.files.keys()], [originalFileId]);
  assert.equal(storage.removals.length, 1);
  assert.notEqual(storage.removals[0], originalFileId);
});

test("upload failure preserves existing files and leaves session metadata unchanged", async () => {
  const storage = new MemoryStorage();
  const document = session();
  await saveMongoSession(document, undefined, storage);
  const original = structuredClone(storage.sessions.get(document.ownerId)!);
  document.cases[0].evidence.push(upload("failed-upload"));
  document.revision = 1;
  storage.failUpload = true;
  await assert.rejects(saveMongoSession(document, 0, storage), (error: Error) => {
    assert.equal(error.message.includes("secret-password"), false);
    return /Atlas could not complete/.test(error.message);
  });
  assert.deepEqual(storage.sessions.get(document.ownerId), original);
  assert.equal(storage.files.size, 1);
});

test("an uncertain metadata acknowledgement never deletes evidence from a committed write", async () => {
  const storage = new MemoryStorage();
  const document = session();
  storage.failWrite = "after";
  await assert.rejects(saveMongoSession(document, undefined, storage), /Atlas could not complete/);
  assert.equal(storage.removals.length, 0);
  assert.equal(storage.files.size, 1);
  assert.deepEqual(await readMongoSession(document.ownerId, storage), document);
});

test("partial chunks without ownership metadata are retained for operator reconciliation", async () => {
  const storage = new MemoryStorage();
  storage.failPartialUpload = true;
  await assert.rejects(saveMongoSession(session(), undefined, storage), /Atlas could not complete/);
  assert.equal(storage.sessions.size, 0);
  assert.equal(storage.files.size, 0);
  assert.equal(storage.partialChunks.size, 1);
  assert.equal(storage.removals.length, 0);
});

test("metadata write failure retains only possible orphans without replacing existing data", async () => {
  const storage = new MemoryStorage();
  const document = session();
  await saveMongoSession(document, undefined, storage);
  const original = structuredClone(storage.sessions.get(document.ownerId)!);
  document.cases[0].evidence.push(upload("new-upload"));
  document.revision = 1;
  storage.failWrite = "before";
  await assert.rejects(saveMongoSession(document, 0, storage), /Atlas could not complete/);
  assert.deepEqual(storage.sessions.get(document.ownerId), original);
  assert.equal(storage.removals.length, 0);
  assert.equal(storage.files.size, 2, "Uncertain writes retain immutable blobs for later reconciliation");
});

test("superseded evidence remains readable for readers holding older metadata", async () => {
  const storage = new MemoryStorage();
  const document = session();
  await saveMongoSession(document, undefined, storage);
  const originalFileId = storage.sessions.get(document.ownerId)!.cases[0].evidence[1].blob!.fileId;
  document.cases[0].evidence[1] = upload("upload-a", Buffer.from("replacement bytes"));
  document.revision = 1;
  await saveMongoSession(document, 0, storage);
  assert.equal(storage.files.size, 2);
  assert.ok(storage.files.has(originalFileId));
  assert.deepEqual(await readMongoSession(document.ownerId, storage), document);
  document.cases[0].evidence = [];
  document.revision = 2;
  await saveMongoSession(document, 1, storage);
  assert.equal(storage.files.size, 2, "Reset/removal does not race prior readers by deleting their blobs");
});

test("upload and metadata limits fail before any bytes are written", async () => {
  const oversized = new MemoryStorage();
  await assert.rejects(saveMongoSession(session("owner-a", [upload("huge", Buffer.alloc(MAX_EVIDENCE_BYTES + 1))]), undefined, oversized), /5 MiB/);
  assert.equal(oversized.uploads.length, 0);
  const metadata = new MemoryStorage();
  const document = session();
  document.cases[0].description = "a".repeat(MAX_MONGO_METADATA_BYTES);
  await assert.rejects(saveMongoSession(document, undefined, metadata), /metadata exceeds/);
  assert.equal(metadata.uploads.length, 0);
});

test("hydration enforces aggregate bounds and rejects corrupted bytes", async () => {
  const storage = new MemoryStorage();
  const document = session();
  await saveMongoSession(document, undefined, storage);
  const metadata = storage.sessions.get(document.ownerId)!;
  const existing = metadata.cases[0].evidence[1];
  const originalLength = existing.blob!.byteLength;
  metadata.cases[0].evidence = Array.from({ length: 5 }, (_, index) => ({
    ...existing, id: `large-${index}`, blob: { ...existing.blob!, byteLength: MAX_EVIDENCE_BYTES },
  }));
  await assert.rejects(readMongoSession(document.ownerId, storage), /32 MiB/);
  assert.equal(storage.downloads.length, 0);
  metadata.cases[0].evidence = [existing];
  existing.blob!.byteLength = originalLength;
  storage.files.get(existing.blob!.fileId)!.bytes = Buffer.alloc(originalLength, 0);
  await assert.rejects(readMongoSession(document.ownerId, storage), /could not be verified/);
});
