import "server-only";

import { createHash } from "node:crypto";
import type { AuthUser, BuildingRecord } from "@/lib/types";
import { lookupBuilding, normalizeBuildingAddress, publicBuildingSchema } from "@/lib/integrations/nyc-open-data";
import { getMongoDatabase, mongoStorageEnabled } from "./mongodb";
import { findCase, mutateSession, readSession } from "./store";
import { requireCaseAccess } from "./case-access";
import { landlordCaseOwner } from "./landlord";
import { ApiError } from "./errors";

export const BUILDING_CACHE_TTL_MS = 15 * 60 * 1000;
export const BUILDING_RETRY_MS = 60 * 1000;
export const BUILDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const BUILDING_CACHE_COLLECTION = "nyc_buildings";
const MAX_MEMORY_ENTRIES = 200;

function publicSnapshot(value: unknown): BuildingRecord {
  // MongoDB otherwise serializes explicitly undefined optional fields as null,
  // which would make a normalized snapshot fail validation after a reconnect.
  return JSON.parse(JSON.stringify(publicBuildingSchema.parse(value))) as BuildingRecord;
}

export interface BuildingCacheEntry {
  key: string;
  building: BuildingRecord;
  expiresAt: number;
  retainUntil: number;
}

export interface BuildingCacheStorage {
  read(key: string): Promise<BuildingCacheEntry | null>;
  write(entry: BuildingCacheEntry): Promise<void>;
}

interface StoredBuilding extends Omit<BuildingCacheEntry, "retainUntil"> { purgeAt: Date }

/** Only normalized public data is shared. No owner, case, apartment, or finance identifiers. */
export const mongoBuildingCache: BuildingCacheStorage = {
  async read(key) {
    if (!mongoStorageEnabled()) return null;
    const database = await getMongoDatabase();
    const stored = await database.collection<StoredBuilding>(BUILDING_CACHE_COLLECTION).findOne({ key });
    if (!stored || !(stored.purgeAt instanceof Date) || stored.purgeAt.getTime() <= Date.now()
      || !Number.isFinite(stored.expiresAt)) return null;
    const parsed = publicBuildingSchema.safeParse(stored.building);
    if (!parsed.success) return null;
    return { key, building: parsed.data, expiresAt: stored.expiresAt, retainUntil: stored.purgeAt.getTime() };
  },
  async write(entry) {
    if (!mongoStorageEnabled()) return;
    const database = await getMongoDatabase();
    const building = publicBuildingSchema.parse(entry.building);
    await database.collection<StoredBuilding>(BUILDING_CACHE_COLLECTION).updateOne(
      { key: entry.key },
      { $set: { key: entry.key, building, expiresAt: entry.expiresAt, purgeAt: new Date(entry.retainUntil) } },
      { upsert: true, ignoreUndefined: true },
    );
  },
};

const warning = (building: BuildingRecord, message: string): BuildingRecord => ({
  ...building, warning: building.warning?.includes(message) ? building.warning
    : [building.warning, message].filter(Boolean).join(" ").slice(0, 4_000),
});

export function buildingCacheKey(address: string, borough: string): string {
  const normalized = normalizeBuildingAddress(address, borough);
  // The provider resolves stable HPD identifiers; this index also lets address-only
  // clients reuse that resolution without making another provider request.
  return createHash("sha256").update(JSON.stringify(normalized ?? [address.trim().toUpperCase(), borough.trim().toUpperCase()])).digest("hex");
}

/** Factory allows isolated clocks/provider/storage in tests without real NYC requests. */
export function createBuildingContextService(options: {
  lookup?: typeof lookupBuilding;
  storage?: BuildingCacheStorage;
  now?: () => number;
} = {}) {
  const lookup = options.lookup ?? lookupBuilding;
  const storage = options.storage ?? mongoBuildingCache;
  const now = options.now ?? Date.now;
  const memory = new Map<string, BuildingCacheEntry>();
  const inFlight = new Map<string, Promise<BuildingRecord>>();
  const retries = new Map<string, { retryAt: number; building: BuildingRecord }>();

  function remember(entry: BuildingCacheEntry) {
    memory.delete(entry.key);
    memory.set(entry.key, entry);
    while (memory.size > MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value!);
  }
  function cached(entry: BuildingCacheEntry, state: "cached" | "stale") {
    return { ...structuredClone(entry.building), cache: { state, expiresAt: new Date(entry.expiresAt).toISOString() } };
  }

  async function resolve(key: string, address: string, borough: string): Promise<BuildingRecord> {
    const timestamp = now();
    const retry = retries.get(key);
    if (retry && retry.retryAt > timestamp) return structuredClone(retry.building);
    retries.delete(key);
    let entry = memory.get(key);
    let persistenceUnavailable = false;
    if (!entry) {
      try { entry = await storage.read(key) ?? undefined; }
      catch { persistenceUnavailable = true; }
    }
    if (entry && entry.retainUntil <= timestamp) { memory.delete(key); entry = undefined; }
    if (entry && entry.expiresAt > timestamp) {
      remember(entry);
      return cached(entry, "cached");
    }

    let building = publicBuildingSchema.parse(await lookup(address, borough));
    const failed = building.lookupStatus === "unavailable" || building.lookupStatus === "partial";
    if (failed && entry && ["ok", "demo"].includes(entry.building.lookupStatus ?? "")) {
      const stale = warning(cached(entry, "stale"),
        "NYC data could not be fully refreshed. Showing previously retrieved public records; see the original retrieval time.");
      retries.set(key, { retryAt: timestamp + BUILDING_RETRY_MS, building: stale });
      return stale;
    }

    const ttl = failed ? BUILDING_RETRY_MS : BUILDING_CACHE_TTL_MS;
    const expiresAt = timestamp + ttl;
    const cacheable = ["ok", "demo", "partial", "not_found"].includes(building.lookupStatus ?? "");
    building = { ...building, cache: cacheable ? { state: "fresh", expiresAt: new Date(expiresAt).toISOString() } : undefined };
    if (persistenceUnavailable) building = warning(building, "The shared building cache is unavailable; these records are cached only in this server process.");
    // Failed/ambiguous/invalid lookups are short-lived responses, not successful
    // building history. Never replace the last good persistent snapshot with them.
    if (!cacheable) {
      retries.set(key, { retryAt: timestamp + BUILDING_RETRY_MS, building });
    } else {
      const next: BuildingCacheEntry = { key, building, expiresAt, retainUntil: timestamp + BUILDING_RETENTION_MS };
      if (!failed) {
        try { await storage.write(next); }
        catch { building = warning(building, "The shared building cache could not be saved; these records are cached only in this server process."); next.building = building; }
      }
      remember(next);
    }
    while (retries.size > MAX_MEMORY_ENTRIES) retries.delete(retries.keys().next().value!);
    return structuredClone(building);
  }

  return async function getBuilding(address: string, borough: string): Promise<BuildingRecord> {
    const key = buildingCacheKey(address, borough);
    let pending = inFlight.get(key);
    if (!pending) {
      pending = resolve(key, address, borough);
      inFlight.set(key, pending);
    }
    try { return publicSnapshot(await pending); }
    finally { if (inFlight.get(key) === pending) inFlight.delete(key); }
  };
}

const runtime = globalThis as typeof globalThis & { rentEscrowBuildings?: ReturnType<typeof createBuildingContextService> };
export const getBuildingContext = runtime.rentEscrowBuildings ??= createBuildingContextService();

/** Refreshing public context cannot assign evidence, authorization, or case status. */
export async function getCaseBuildingContext(
  user: AuthUser,
  caseId: string,
  lookup: typeof getBuildingContext = getBuildingContext,
): Promise<BuildingRecord> {
  const ownerId = user.role === "tenant" ? user.workspaceOwnerId : await landlordCaseOwner(user, caseId);
  const document = await readSession(ownerId);
  if (!document) throw new ApiError(403, "Case access denied.", false, "CASE_ACCESS_DENIED");
  const record = findCase(document, caseId);
  requireCaseAccess(user, record);
  const { address, borough } = record.building;
  let building = publicSnapshot(await lookup(address, borough));
  const previous = publicBuildingSchema.safeParse(record.building);
  if (["partial", "unavailable"].includes(building.lookupStatus ?? "") && previous.success
    && previous.data.source === "nyc-open-data" && previous.data.lookupStatus === "ok"
    && Date.parse(previous.data.fetchedAt) + BUILDING_RETENTION_MS > Date.now()) {
    // Local storage retains case snapshots even when its process cache was lost.
    // Treat those snapshots exactly like stale shared-cache records after an outage.
    building = warning({ ...previous.data, cache: { state: "stale",
      expiresAt: previous.data.cache?.expiresAt ?? new Date(Date.parse(previous.data.fetchedAt) + BUILDING_CACHE_TTL_MS).toISOString() } },
    "NYC data could not be fully refreshed. Showing the last saved case building context with its original retrieval time.");
  }
  return mutateSession(ownerId, (current) => {
    const latest = findCase(current, caseId);
    requireCaseAccess(user, latest);
    if (latest.building.address !== address || latest.building.borough !== borough) {
      throw new ApiError(409, "The case address changed during lookup. Refresh the building history.");
    }
    // Preserve the address used for trusted property assignment. Provider identity
    // lives in buildingId/identifiers, and never changes landlord assignment.
    latest.building = { ...building, address, borough };
    return latest.building;
  });
}
