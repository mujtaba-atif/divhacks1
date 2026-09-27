import { z } from "zod";
import { getBuildingSummary } from "../building-context";
import { demoBuilding } from "../seed";
import type { BuildingRecord, HousingRecord } from "../types";
import { assertServer, IntegrationError } from "./shared";

const BUILDINGS_DATASET = "kj4p-ruqc";
const COMPLAINTS_DATASET = "ygpa-z7cr";
const VIOLATIONS_DATASET = "wvxf-dwi5";
const RESULT_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 8_000;

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const providerIdSchema = z.union([z.string(), z.number().int().nonnegative()])
  .transform(String)
  .refine((value) => /^\d+$/.test(value), "Expected a numeric identifier");
const providerDateSchema = boundedText(64)
  .refine((value) => Number.isFinite(Date.parse(value)), "Expected a valid provider date")
  .transform((value) => new Date(value).toISOString());

const buildingRowSchema = z.object({
  buildingid: providerIdSchema,
  boro: boundedText(32),
  housenumber: boundedText(32),
  streetname: boundedText(160),
  zip: boundedText(10).optional(),
  block: providerIdSchema.optional(),
  lot: providerIdSchema.optional(),
  bin: providerIdSchema.optional(),
  lifecycle: boundedText(64).optional(),
  recordstatus: boundedText(64),
});

const complaintRowSchema = z.object({
  problem_id: providerIdSchema,
  complaint_id: providerIdSchema,
  building_id: providerIdSchema,
  received_date: providerDateSchema,
  major_category: boundedText(160).optional(),
  minor_category: boundedText(160).optional(),
  problem_code: boundedText(500).optional(),
  complaint_status: boundedText(80),
  post_code: boundedText(10).optional(),
  bin: providerIdSchema.optional(),
  bbl: providerIdSchema.optional(),
});

const violationRowSchema = z.object({
  violationid: providerIdSchema,
  buildingid: providerIdSchema,
  class: boundedText(8).optional(),
  novdescription: boundedText(2_000).nullish(),
  currentstatus: boundedText(160),
  violationstatus: boundedText(80).optional(),
  inspectiondate: providerDateSchema,
  zip: boundedText(10).optional(),
  block: providerIdSchema.optional(),
  lot: providerIdSchema.optional(),
  bin: providerIdSchema.optional(),
});

const housingRecordSchema = z.object({
  id: boundedText(128),
  category: boundedText(240),
  description: boundedText(2_000),
  status: boundedText(160),
  date: z.string().datetime(),
  complaintId: boundedText(128).optional(),
  normalizedStatus: z.enum(["open", "closed", "unknown"]).optional(),
});

/** Cache-safe public projection. Zod objects strip provider-only and unknown fields. */
export const publicBuildingSchema = z.object({
  address: boundedText(240),
  borough: boundedText(32),
  zip: z.string().trim().max(10),
  source: z.enum(["demo", "nyc-open-data"]),
  complaints: z.array(housingRecordSchema).max(RESULT_LIMIT),
  violations: z.array(housingRecordSchema).max(RESULT_LIMIT),
  fetchedAt: z.string().datetime(),
  warning: z.string().trim().max(4_000).optional(),
  buildingId: boundedText(300).optional(),
  identifiers: z.object({
    hpdBuildingId: providerIdSchema.optional(),
    bin: providerIdSchema.optional(),
    bbl: providerIdSchema.optional(),
  }).optional(),
  normalizedAddress: z.object({
    houseNumber: boundedText(32),
    streetName: boundedText(160),
    borough: boundedText(32),
    zip: boundedText(10).optional(),
  }).optional(),
  lookupStatus: z.enum(["ok", "partial", "unavailable", "not_found", "ambiguous", "invalid_address", "demo"]).optional(),
  datasets: z.object({
    complaints: z.enum(["ok", "unavailable"]),
    violations: z.enum(["ok", "unavailable"]),
  }).optional(),
  cache: z.object({
    state: z.enum(["fresh", "cached", "stale"]),
    expiresAt: z.string().datetime(),
  }).optional(),
  summary: z.object({
    recentComplaints: z.number().int().nonnegative(),
    openViolations: z.number().int().nonnegative(),
    heatingComplaints: z.number().int().nonnegative(),
    recentSince: z.string().datetime(),
  }).optional(),
});

export type NormalizedBuildingAddress = NonNullable<BuildingRecord["normalizedAddress"]>;

const boroughAliases: Record<string, string> = {
  MANHATTAN: "MANHATTAN", MN: "MANHATTAN", NEW_YORK: "MANHATTAN",
  BRONX: "BRONX", BX: "BRONX",
  BROOKLYN: "BROOKLYN", BK: "BROOKLYN", BKLYN: "BROOKLYN",
  QUEENS: "QUEENS", QN: "QUEENS",
  STATEN_ISLAND: "STATEN ISLAND", SI: "STATEN ISLAND",
};

const streetSuffixes: Record<string, string> = {
  AV: "AVENUE", AVE: "AVENUE", BLVD: "BOULEVARD", CIR: "CIRCLE", CT: "COURT",
  DR: "DRIVE", EXPY: "EXPRESSWAY", HWY: "HIGHWAY", LN: "LANE", PKWY: "PARKWAY",
  PL: "PLACE", RD: "ROAD", SQ: "SQUARE", ST: "STREET", TER: "TERRACE", TPKE: "TURNPIKE",
};
const directions: Record<string, string> = { E: "EAST", W: "WEST", N: "NORTH", S: "SOUTH" };

function canonicalText(value: string): string {
  return value.normalize("NFKC").replace(/[‘’]/g, "'").trim().replace(/\s+/g, " ").toLocaleUpperCase("en-US");
}

export function normalizeBuildingAddress(address: string, borough: string): NormalizedBuildingAddress | null {
  if (typeof address !== "string" || typeof borough !== "string") return null;
  const canonicalBorough = boroughAliases[canonicalText(borough).replace(/\s+/g, "_")];
  if (!canonicalBorough) return null;

  let canonicalAddress = canonicalText(address);
  let zip: string | undefined;
  const zipMatch = /(?:,?\s+)(\d{5})(?:-\d{4})?$/.exec(canonicalAddress);
  if (zipMatch) {
    zip = zipMatch[1];
    canonicalAddress = canonicalAddress.slice(0, zipMatch.index).trim();
  }
  const match = /^(\d+[A-Z]?(?:-\d+[A-Z]?)?(?:\/\d+[A-Z]?)?)\s+(.{2,160})$/.exec(canonicalAddress);
  if (!match) return null;
  const houseNumber = match[1];
  const streetParts = match[2].replace(/\./g, "").replace(/,+$/g, "").split(" ").filter(Boolean);
  if (!streetParts.length) return null;
  streetParts[0] = directions[streetParts[0]] ?? streetParts[0];
  const lastIndex = streetParts.length - 1;
  streetParts[lastIndex] = streetSuffixes[streetParts[lastIndex]] ?? streetParts[lastIndex];
  for (let index = 0; index < streetParts.length; index++) {
    streetParts[index] = streetParts[index].replace(/^(\d+)(?:ST|ND|RD|TH)$/, "$1");
  }
  const streetName = streetParts.join(" ");
  if (!/^[A-Z0-9][A-Z0-9 '&/.-]*$/.test(streetName)) return null;
  return { houseNumber, streetName, borough: canonicalBorough, ...(zip ? { zip } : {}) };
}

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

function dataUrl(dataset: string, where: string, order?: string, select?: string): URL {
  const url = new URL(`https://data.cityofnewyork.us/resource/${dataset}.json`);
  if (select) url.searchParams.set("$select", select);
  url.searchParams.set("$where", where);
  if (order) url.searchParams.set("$order", order);
  url.searchParams.set("$limit", String(RESULT_LIMIT));
  return url;
}

async function fetchNycJson(url: URL, label: string, headers: HeadersInit): Promise<unknown> {
  try {
    const response = await fetch(url, {
      headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new IntegrationError(`${label} is unavailable (HTTP ${response.status}).`, label);
    return await response.json();
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError(`${label} could not complete the request.`, label);
  }
}

function addressWhere(address: NormalizedBuildingAddress, fields: { house: string; street: string; borough: string }): string {
  return `${fields.house}=${quote(address.houseNumber)} AND ${fields.street}=${quote(address.streetName)} AND ${fields.borough}=${quote(address.borough)}`;
}

function addressBuildingId(address: NormalizedBuildingAddress): string {
  return `address:${address.borough}|${address.houseNumber}|${address.streetName}`;
}

function usableProviderId(value?: string): string | undefined {
  return value && value !== "0" ? value : undefined;
}

function bblFromParts(borough: string, block?: string, lot?: string): string | undefined {
  const boroId = { MANHATTAN: "1", BRONX: "2", BROOKLYN: "3", QUEENS: "4", "STATEN ISLAND": "5" }[borough];
  if (!boroId || !block || !lot || block.length > 5 || lot.length > 4) return undefined;
  return `${boroId}${block.padStart(5, "0")}${lot.padStart(4, "0")}`;
}

function normalizeStatus(status: string): HousingRecord["normalizedStatus"] {
  const value = status.toLocaleUpperCase("en-US");
  if (/CLOSE|DISMISS|COMPLIED|RESCIND/.test(value)) return "closed";
  if (/OPEN|NOV SENT|ACTIVE|PENDING|REINSPECT|CERTIF/.test(value)) return "open";
  return "unknown";
}

function redactUnitDetails(description: string): string {
  const withoutLocation = description.replace(/\s+LOCATED AT\s+(?:APT\.?|APARTMENT|UNIT)\b.*$/i, ".");
  return withoutLocation.replace(/\b(?:APT\.?|APARTMENT|UNIT)\s*(?:NO\.?\s*)?[A-Z0-9-]+\b/gi, "unit").trim();
}

function mapComplaints(rows: z.infer<typeof complaintRowSchema>[]): HousingRecord[] {
  const byComplaint = new Map<string, z.infer<typeof complaintRowSchema>[]>();
  for (const row of rows) {
    const existing = byComplaint.get(row.complaint_id);
    if (existing) existing.push(row);
    else byComplaint.set(row.complaint_id, [row]);
  }
  return [...byComplaint.entries()].map(([complaintId, records]) => {
    const sorted = records.sort((left, right) => Date.parse(right.received_date) - Date.parse(left.received_date));
    const first = sorted[0];
    const categories = [...new Set(sorted.map((row) => row.major_category).filter((value): value is string => Boolean(value)))];
    const descriptions = [...new Set(sorted.flatMap((row) => [row.minor_category, row.problem_code]).filter((value): value is string => Boolean(value)))];
    return {
      id: complaintId,
      complaintId,
      category: (categories.join(" / ") || "Housing complaint").slice(0, 240),
      description: (descriptions.join("; ") || "Housing maintenance complaint").slice(0, 2_000),
      status: first.complaint_status,
      normalizedStatus: normalizeStatus(first.complaint_status),
      date: first.received_date,
    };
  }).sort((left, right) => Date.parse(right.date) - Date.parse(left.date) || left.id.localeCompare(right.id));
}

function mapViolations(rows: z.infer<typeof violationRowSchema>[]): HousingRecord[] {
  return rows.map((row) => ({
    id: row.violationid,
    category: row.class ? `Class ${row.class}` : "Housing violation",
    description: row.novdescription ? redactUnitDetails(row.novdescription) : "Housing violation details unavailable",
    status: row.currentstatus,
    normalizedStatus: normalizeStatus(row.violationstatus ?? row.currentstatus),
    date: row.inspectiondate,
  }));
}

function baseRecord(address: string, borough: string, normalized: NormalizedBuildingAddress | null, now: Date): BuildingRecord {
  return {
    address: address.trim(), borough: borough.trim(), zip: normalized?.zip ?? "", source: "nyc-open-data",
    complaints: [], violations: [], fetchedAt: now.toISOString(),
    buildingId: normalized ? addressBuildingId(normalized) : undefined,
    identifiers: {}, normalizedAddress: normalized ?? undefined,
    lookupStatus: normalized ? "unavailable" : "invalid_address",
    datasets: { complaints: "unavailable", violations: "unavailable" },
  };
}

function withSummary(record: BuildingRecord, now: Date): BuildingRecord {
  record.summary = getBuildingSummary(record, now);
  return publicBuildingSchema.parse(record) as BuildingRecord;
}

function uniqueIds(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(usableProviderId).filter((value): value is string => Boolean(value)))];
}

export async function lookupBuilding(address: string, borough: string): Promise<BuildingRecord> {
  assertServer();
  const now = new Date();
  const normalized = normalizeBuildingAddress(address, borough);
  const result = baseRecord(address, borough, normalized, now);
  if (!normalized) {
    result.warning = "Enter a house number, full street name, and a New York City borough to look up public records.";
    return withSummary(result, now);
  }

  if (normalized.houseNumber === "123" && normalized.streetName === "EXAMPLE STREET" && normalized.borough === "BROOKLYN") {
    return publicBuildingSchema.parse(demoBuilding(now)) as BuildingRecord;
  }

  const headers: HeadersInit = process.env.NYC_OPEN_DATA_APP_TOKEN
    ? { "X-App-Token": process.env.NYC_OPEN_DATA_APP_TOKEN }
    : {};
  const zipPredicate = normalized.zip ? ` AND zip=${quote(normalized.zip)}` : "";
  const buildingWhere = `${addressWhere(normalized, { house: "housenumber", street: "streetname", borough: "boro" })}${zipPredicate} AND recordstatus='Active'`;
  const buildingLookup = await fetchNycJson(dataUrl(
    BUILDINGS_DATASET, buildingWhere, "buildingid ASC",
    "buildingid,boro,housenumber,streetname,zip,block,lot,bin,lifecycle,recordstatus",
  ), "NYC HPD buildings", headers)
    .then((payload) => z.array(buildingRowSchema).max(RESULT_LIMIT).parse(payload))
    .then((rows) => {
      const mismatched = rows.some((row) => canonicalText(row.housenumber) !== normalized.houseNumber
        || canonicalText(row.streetname) !== normalized.streetName
        || canonicalText(row.boro) !== normalized.borough
        || canonicalText(row.recordstatus) !== "ACTIVE"
        || (normalized.zip !== undefined && row.zip !== normalized.zip));
      if (mismatched) throw new IntegrationError("NYC HPD buildings returned an inconsistent address.", "NYC HPD buildings", "invalid_response");
      return rows;
    })
    .then((rows) => ({ status: "ok" as const, rows }))
    .catch(() => ({ status: "unavailable" as const, rows: [] }));

  const buildingIds = uniqueIds(buildingLookup.rows.map((row) => row.buildingid));
  if (buildingIds.length > 1) {
    result.lookupStatus = "ambiguous";
    result.warning = "More than one active HPD building matches this address. Add the exact principal house number before using its history.";
    return withSummary(result, now);
  }

  const buildingRow = buildingLookup.rows[0];
  if (buildingRow) {
    const hpdBuildingId = buildingRow.buildingid;
    const bbl = bblFromParts(normalized.borough, buildingRow.block, buildingRow.lot);
    result.buildingId = `hpd:${hpdBuildingId}`;
    result.identifiers = {
      hpdBuildingId,
      ...(usableProviderId(buildingRow.bin) ? { bin: buildingRow.bin } : {}),
      ...(bbl ? { bbl } : {}),
    };
    result.zip = buildingRow.zip ?? result.zip;
    result.normalizedAddress = { ...normalized, ...(result.zip ? { zip: result.zip } : {}) };
  }

  const complaintWhere = buildingRow
    ? `building_id=${buildingRow.buildingid}`
    : `${addressWhere(normalized, { house: "house_number", street: "street_name", borough: "borough" })}${normalized.zip ? ` AND post_code=${quote(normalized.zip)}` : ""}`;
  const violationWhere = buildingRow
    ? `buildingid=${buildingRow.buildingid}`
    : `${addressWhere(normalized, { house: "housenumber", street: "streetname", borough: "boro" })}${zipPredicate}`;

  const [complaintLookup, violationLookup] = await Promise.allSettled([
    fetchNycJson(dataUrl(
      COMPLAINTS_DATASET, complaintWhere, "received_date DESC",
      "problem_id,complaint_id,building_id,received_date,major_category,minor_category,problem_code,complaint_status,post_code,bin,bbl",
    ), "NYC complaints", headers).then((payload) => z.array(complaintRowSchema).max(RESULT_LIMIT).parse(payload)),
    fetchNycJson(dataUrl(
      VIOLATIONS_DATASET, violationWhere, "inspectiondate DESC",
      "violationid,buildingid,class,novdescription,currentstatus,violationstatus,inspectiondate,zip,block,lot,bin",
    ), "NYC violations", headers).then((payload) => z.array(violationRowSchema).max(RESULT_LIMIT).parse(payload)),
  ]);

  let complaintRows = complaintLookup.status === "fulfilled" ? complaintLookup.value : [];
  let violationRows = violationLookup.status === "fulfilled" ? violationLookup.value : [];
  let complaintsAvailable = complaintLookup.status === "fulfilled";
  let violationsAvailable = violationLookup.status === "fulfilled";
  if (!buildingRow && normalized.zip && complaintRows.some((row) => row.post_code !== normalized.zip)) {
    complaintRows = []; complaintsAvailable = false;
  }
  if (!buildingRow && normalized.zip && violationRows.some((row) => row.zip !== normalized.zip)) {
    violationRows = []; violationsAvailable = false;
  }
  if (buildingRow && complaintRows.some((row) => row.building_id !== buildingRow.buildingid)) {
    complaintRows = [];
    complaintsAvailable = false;
  }
  if (buildingRow && violationRows.some((row) => row.buildingid !== buildingRow.buildingid)) {
    violationRows = [];
    violationsAvailable = false;
  }
  result.datasets = {
    complaints: complaintsAvailable ? "ok" : "unavailable",
    violations: violationsAvailable ? "ok" : "unavailable",
  };

  if (!buildingRow) {
    const historyBuildingIds = uniqueIds([
      ...complaintRows.map((row) => row.building_id),
      ...violationRows.map((row) => row.buildingid),
    ]);
    if (historyBuildingIds.length > 1) {
      result.lookupStatus = "ambiguous";
      result.warning = "Public history maps this address to more than one HPD building. No combined record was returned.";
      return withSummary(result, now);
    }
    const historyBuildingId = historyBuildingIds[0];
    if (historyBuildingId) {
      const complaintIdentity = complaintRows.find((row) => row.building_id === historyBuildingId);
      const violationIdentity = violationRows.find((row) => row.buildingid === historyBuildingId);
      const bin = usableProviderId(complaintIdentity?.bin ?? violationIdentity?.bin);
      const bbl = usableProviderId(complaintIdentity?.bbl);
      result.buildingId = `hpd:${historyBuildingId}`;
      result.identifiers = { hpdBuildingId: historyBuildingId, ...(bin ? { bin } : {}), ...(bbl ? { bbl } : {}) };
    }
  }

  if (complaintsAvailable) {
    result.complaints = mapComplaints(complaintRows);
    result.zip ||= complaintRows.find((row) => row.post_code)?.post_code ?? "";
  }
  if (violationsAvailable) {
    result.violations = mapViolations(violationRows);
    result.zip ||= violationRows.find((row) => row.zip)?.zip ?? "";
  }
  if (result.normalizedAddress && result.zip) result.normalizedAddress.zip = result.zip;

  const warnings: string[] = [];
  if (!complaintsAvailable) warnings.push("Complaint records are currently unavailable; the empty list does not mean no complaints exist.");
  else if (complaintRows.length === RESULT_LIMIT) warnings.push(`Showing records deduplicated from the latest ${RESULT_LIMIT} complaint problems.`);
  if (!violationsAvailable) warnings.push("Violation records are currently unavailable; the empty list does not mean no violations exist.");
  else if (violationRows.length === RESULT_LIMIT) warnings.push(`Showing the latest ${RESULT_LIMIT} violations.`);

  const hasHistory = complaintRows.length > 0 || violationRows.length > 0;
  const allHistoryAvailable = complaintsAvailable && violationsAvailable;
  if (buildingRow) result.lookupStatus = allHistoryAvailable ? "ok" : complaintsAvailable || violationsAvailable ? "partial" : "unavailable";
  else if (buildingLookup.status === "ok" && !hasHistory && allHistoryAvailable) {
    result.lookupStatus = "not_found";
    warnings.push("No HPD building or housing records matched this exact address. Check the principal house number and full street spelling.");
  } else if (hasHistory) {
    result.lookupStatus = "partial";
    warnings.push("History matched this address, but the HPD building identifier could not be confirmed from the building file.");
  } else {
    result.lookupStatus = "unavailable";
    warnings.push("The HPD building could not be confirmed while public records were unavailable. Try again later.");
  }
  if (warnings.length) result.warning = warnings.join(" ");
  return withSummary(result, now);
}
