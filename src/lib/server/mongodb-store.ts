import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GridFSBucket, ObjectId, type Db, type GridFSFile } from "mongodb";
import type { CaseRecord, EvidenceRecord } from "@/lib/types";
import { ApiError } from "./errors";
import { getMongoDatabase, MONGO_EVIDENCE_BUCKET } from "./mongodb";
import type { SessionDocument } from "./store";

export const MAX_SESSION_BYTES = 32 * 1024 * 1024;
export const MAX_MONGO_METADATA_BYTES = 12 * 1024 * 1024;
export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

interface EvidenceBlob {
  fileId: string;
  byteLength: number;
  sha256: string;
  mimeType: string;
}

interface FileBinding {
  ownerId: string;
  caseId: string;
  evidenceId: string;
  sha256: string;
  mimeType: string;
}

export interface EvidenceFileMetadata extends FileBinding {
  uploadAttemptId: string;
}

export type StoredEvidence = EvidenceRecord & { blob?: EvidenceBlob };
export type StoredSessionDocument = Omit<SessionDocument, "cases"> & {
  cases: (Omit<CaseRecord, "evidence"> & { evidence: StoredEvidence[] })[];
};

export interface MongoSessionStorage {
  read(ownerId: string): Promise<StoredSessionDocument | null>;
  insert(document: StoredSessionDocument): Promise<void>;
  replace(ownerId: string, revision: number, document: StoredSessionDocument): Promise<boolean>;
  findFile(fileId: string, binding: FileBinding): Promise<{ length: number; metadata: EvidenceFileMetadata } | null>;
  upload(fileId: string, filename: string, bytes: Buffer, metadata: EvidenceFileMetadata): Promise<void>;
  download(fileId: string): AsyncIterable<Uint8Array>;
  removeOwned(fileId: string, uploadAttemptId: string): Promise<void>;
}

function storageFor(database: Db): MongoSessionStorage {
  const sessions = database.collection<StoredSessionDocument>("sessions");
  const files = database.collection<GridFSFile>(`${MONGO_EVIDENCE_BUCKET}.files`);
  const bucket = new GridFSBucket(database, {
    bucketName: MONGO_EVIDENCE_BUCKET, writeConcern: { w: "majority" }, timeoutMS: 20_000,
  });
  return {
    async read(ownerId) {
      return await sessions.findOne({ ownerId }, { projection: { _id: 0 } }) as StoredSessionDocument | null;
    },
    async insert(document) { await sessions.insertOne(document); },
    async replace(ownerId, revision, document) {
      return (await sessions.replaceOne({ ownerId, revision }, document)).matchedCount === 1;
    },
    async findFile(fileId, binding) {
      const file = await files.findOne({ _id: new ObjectId(fileId),
        "metadata.ownerId": binding.ownerId, "metadata.caseId": binding.caseId,
        "metadata.evidenceId": binding.evidenceId, "metadata.sha256": binding.sha256,
        "metadata.mimeType": binding.mimeType });
      return file ? { length: file.length, metadata: file.metadata as EvidenceFileMetadata } : null;
    },
    async upload(fileId, filename, bytes, metadata) {
      await pipeline(Readable.from([bytes]), bucket.openUploadStreamWithId(new ObjectId(fileId), filename, { metadata }));
    },
    download(fileId) { return bucket.openDownloadStream(new ObjectId(fileId)); },
    async removeOwned(fileId, uploadAttemptId) {
      const file = await files.findOne({ _id: new ObjectId(fileId), "metadata.uploadAttemptId": uploadAttemptId });
      if (file) await bucket.delete(file._id);
    },
  };
}

function byteLength(document: unknown) { return Buffer.byteLength(JSON.stringify(document)); }
function digest(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
function unavailable(): never {
  throw new ApiError(503, "MongoDB Atlas could not complete the storage request. Existing case data was not discarded; refresh before retrying.");
}
function missingEvidence(): never {
  throw new ApiError(503, "Stored evidence could not be verified for this case. No evidence from another session will be returned.");
}

export function assertSessionSize(document: SessionDocument): void {
  if (byteLength(document) > MAX_SESSION_BYTES) {
    throw new ApiError(413, "This session has reached its 32 MiB evidence limit. Export your cases before resetting the demo.");
  }
}

function checkedInlineEvidence(evidence: EvidenceRecord): Buffer | null {
  if (!evidence.dataUrl?.startsWith("data:")) return null;
  if (evidence.dataUrl.length > Math.ceil(MAX_EVIDENCE_BYTES / 3) * 4 + 100) {
    throw new ApiError(413, "Evidence files must be 5 MiB or smaller.");
  }
  const match = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/.exec(evidence.dataUrl);
  if (!match || match[1] !== evidence.mimeType) throw new ApiError(400, "Evidence contains an invalid encoded file.");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > MAX_EVIDENCE_BYTES) throw new ApiError(413, "Evidence files must be 5 MiB or smaller.");
  if (bytes.length === 0 || bytes.toString("base64") !== match[2]) {
    throw new ApiError(400, "Evidence contains an invalid encoded file.");
  }
  return bytes;
}

function fileBinding(ownerId: string, caseId: string, evidence: StoredEvidence, blob: EvidenceBlob): FileBinding {
  return { ownerId, caseId, evidenceId: evidence.id, sha256: blob.sha256, mimeType: blob.mimeType };
}

function assertBlobShape(blob: EvidenceBlob) {
  if (!ObjectId.isValid(blob.fileId) || !Number.isSafeInteger(blob.byteLength) || blob.byteLength < 1
    || blob.byteLength > MAX_EVIDENCE_BYTES || !/^[a-f0-9]{64}$/.test(blob.sha256)
    || !/^(?:image\/(?:jpeg|png|webp)|application\/pdf)$/.test(blob.mimeType)) missingEvidence();
}

async function assertOwnedFile(storage: MongoSessionStorage, blob: EvidenceBlob, binding: FileBinding) {
  assertBlobShape(blob);
  const file = await storage.findFile(blob.fileId, binding);
  if (!file || file.length !== blob.byteLength || Object.entries(binding).some(
    ([key, value]) => file.metadata[key as keyof FileBinding] !== value,
  )) missingEvidence();
}

export async function readMongoSession(ownerId: string, storage?: MongoSessionStorage): Promise<SessionDocument | null> {
  try {
    storage ??= storageFor(await getMongoDatabase());
    const document = await storage.read(ownerId);
    if (!document) return null;
    if (document.ownerId !== ownerId || document.cases.some((record) => record.ownerId !== ownerId)) missingEvidence();
    let projectedBytes = byteLength(document);
    if (projectedBytes > MAX_MONGO_METADATA_BYTES) missingEvidence();
    for (const record of document.cases) {
      for (const evidence of record.evidence) {
        if (!evidence.blob) continue;
        assertBlobShape(evidence.blob);
        projectedBytes += Math.ceil(evidence.blob.byteLength / 3) * 4 + evidence.blob.mimeType.length + 13;
      }
    }
    if (projectedBytes > MAX_SESSION_BYTES) throw new ApiError(413, "The stored session exceeds the 32 MiB evidence limit.");
    for (const record of document.cases) {
      for (const evidence of record.evidence) {
        if (!evidence.blob) {
          checkedInlineEvidence(evidence);
          continue;
        }
        const blob = evidence.blob;
        if (blob.mimeType !== evidence.mimeType) missingEvidence();
        await assertOwnedFile(storage, blob, fileBinding(ownerId, record.id, evidence, blob));
        const chunks: Buffer[] = [];
        let downloadedBytes = 0;
        for await (const chunk of storage.download(blob.fileId)) {
          downloadedBytes += chunk.byteLength;
          if (downloadedBytes > blob.byteLength) missingEvidence();
          chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks, downloadedBytes);
        if (downloadedBytes !== blob.byteLength || digest(bytes) !== blob.sha256) missingEvidence();
        evidence.dataUrl = `data:${blob.mimeType};base64,${bytes.toString("base64")}`;
        delete evidence.blob;
      }
    }
    assertSessionSize(document);
    return document;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    unavailable();
  }
}

export async function saveMongoSession(document: SessionDocument, expectedRevision?: number, storage?: MongoSessionStorage): Promise<void> {
  const createdFiles: { fileId: string; uploadAttemptId: string }[] = [];
  let metadataWriteStarted = false;
  let definitelyUncommitted = false;
  try {
    assertSessionSize(document);
    storage ??= storageFor(await getMongoDatabase());
    const previous = await storage.read(document.ownerId);
    if ((expectedRevision === undefined && previous) || (expectedRevision !== undefined && previous?.revision !== expectedRevision)) {
      throw new ApiError(409, "This session changed in another request. Refresh and try again.");
    }
    if (document.cases.some((record) => record.ownerId !== document.ownerId)) missingEvidence();
    const stored: StoredSessionDocument = {
      ...document,
      cases: document.cases.map((record) => ({ ...record, evidence: record.evidence.map((evidence) => ({ ...evidence })) })),
    };
    const uploads: { evidence: EvidenceRecord; binding: FileBinding; blob: EvidenceBlob }[] = [];
    for (const record of stored.cases) {
      for (const evidence of record.evidence) {
        delete evidence.blob;
        const bytes = checkedInlineEvidence(evidence);
        if (!bytes) continue;
        const sha256 = digest(bytes);
        const old = previous?.cases.find((item) => item.id === record.id)?.evidence.find((item) => item.id === evidence.id)?.blob;
        const reuse = old?.sha256 === sha256 && old.byteLength === bytes.length && old.mimeType === evidence.mimeType;
        const blob: EvidenceBlob = reuse ? old : {
          fileId: new ObjectId().toHexString(), byteLength: bytes.length, sha256, mimeType: evidence.mimeType,
        };
        const binding = fileBinding(document.ownerId, record.id, evidence, blob);
        if (reuse) await assertOwnedFile(storage, blob, binding);
        else uploads.push({ evidence: { ...evidence }, binding, blob });
        evidence.blob = blob;
        delete evidence.dataUrl;
      }
    }
    if (byteLength(stored) > MAX_MONGO_METADATA_BYTES) {
      throw new ApiError(413, "Case metadata exceeds MongoDB's 12 MiB application limit.");
    }
    for (const upload of uploads) {
      const uploadAttemptId = randomUUID();
      createdFiles.push({ fileId: upload.blob.fileId, uploadAttemptId });
      const bytes = checkedInlineEvidence(upload.evidence)!;
      await storage.upload(upload.blob.fileId, upload.evidence.name, bytes, { ...upload.binding, uploadAttemptId });
    }
    metadataWriteStarted = true;
    if (expectedRevision === undefined) await storage.insert(stored);
    else if (!await storage.replace(document.ownerId, expectedRevision, stored)) {
      definitelyUncommitted = true;
      throw new ApiError(409, "This session changed in another request. Refresh and try again.");
    }
    // Retain superseded blobs: an in-flight reader may still hold the previous metadata.
  } catch (error) {
    const activeStorage = storage;
    if (activeStorage && (!metadataWriteStarted || definitelyUncommitted)) {
      await Promise.allSettled(createdFiles.map((file) => activeStorage.removeOwned(file.fileId, file.uploadAttemptId)));
    }
    // A failed acknowledgement can follow a committed write. Preserve its new blobs for reconciliation.
    if (error instanceof ApiError) throw error;
    unavailable();
  }
}
