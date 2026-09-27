import assert from "node:assert/strict";
import { test } from "node:test";
import { getBuildingSummary, getRelatedComplaints } from "../src/lib/building-context";
import { lookupBuilding, normalizeBuildingAddress, publicBuildingSchema } from "../src/lib/integrations/nyc-open-data";
import type { BuildingRecord, HousingRecord } from "../src/lib/types";

const buildingRow = (overrides: Record<string, string> = {}) => ({
  buildingid: "12345", boro: "BROOKLYN", housenumber: "100", streetname: "MAIN STREET",
  zip: "11201", block: "42", lot: "7", bin: "3000123", lifecycle: "Building", recordstatus: "Active",
  ...overrides,
});

const complaintRow = (overrides: Record<string, string> = {}) => ({
  problem_id: "7001", complaint_id: "8001", building_id: "12345",
  received_date: "2026-09-20T10:00:00.000", major_category: "HEAT/HOT WATER",
  minor_category: "BUILDING-WIDE", problem_code: "NO HEAT", complaint_status: "OPEN",
  post_code: "11201", bin: "3000123", bbl: "3000420007", ...overrides,
});

const violationRow = (overrides: Record<string, unknown> = {}) => ({
  violationid: "9001", buildingid: "12345", class: "C",
  novdescription: "REPAIR THE WATER LEAK LOCATED AT APT 4B, 2nd STORY, REAR ROOM",
  currentstatus: "NOV SENT OUT", violationstatus: "Open", inspectiondate: "2026-09-18T00:00:00.000",
  zip: "11201", block: "42", lot: "7", bin: "3000123", ...overrides,
});

test("address normalization canonicalizes NYC aliases, suffixes, ordinals, ZIP, and punctuation", () => {
  assert.deepEqual(normalizeBuildingAddress(" 100   Main St. ", "bk"), {
    houseNumber: "100", streetName: "MAIN STREET", borough: "BROOKLYN",
  });
  assert.deepEqual(normalizeBuildingAddress("35-01 E 14th Ave 11106", "Queens"), {
    houseNumber: "35-01", streetName: "EAST 14 AVENUE", borough: "QUEENS", zip: "11106",
  });
  assert.deepEqual(normalizeBuildingAddress("10 St. Nicholas Ave.", "New York"), {
    houseNumber: "10", streetName: "ST NICHOLAS AVENUE", borough: "MANHATTAN",
  });
  assert.equal(normalizeBuildingAddress("Main Street", "Brooklyn"), null);
  assert.equal(normalizeBuildingAddress("100 Main Street", "Albany"), null);
});

test("lookup resolves an HPD building, deduplicates complaint IDs, redacts units, and maps identifiers", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    const url = new URL(input);
    if (url.pathname.includes("kj4p-ruqc")) {
      assert.match(url.searchParams.get("$where") ?? "", /recordstatus='Active'/);
      return Response.json([buildingRow()]);
    }
    assert.equal(url.searchParams.get("$where"), url.pathname.includes("ygpa-z7cr") ? "building_id=12345" : "buildingid=12345");
    if (url.pathname.includes("ygpa-z7cr")) return Response.json([
      complaintRow(),
      complaintRow({ problem_id: "7002", minor_category: "BOILER", problem_code: "BROKEN RADIATOR" }),
      complaintRow({ problem_id: "7003", complaint_id: "8002", major_category: "MOLD", minor_category: "MOISTURE", problem_code: "MOLD", complaint_status: "CLOSE" }),
    ]);
    return Response.json([
      violationRow(),
      violationRow({ violationid: "9002", currentstatus: "VIOLATION CLOSED", violationstatus: "Close", novdescription: "REPAIR PUBLIC HALL CEILING" }),
      violationRow({ violationid: "9003", novdescription: null }),
    ]);
  });

  const record = await lookupBuilding("100 Main St", "Brooklyn");
  assert.equal(record.lookupStatus, "ok");
  assert.equal(record.buildingId, "hpd:12345");
  assert.deepEqual(record.identifiers, { hpdBuildingId: "12345", bin: "3000123", bbl: "3000420007" });
  assert.deepEqual(record.normalizedAddress, { houseNumber: "100", streetName: "MAIN STREET", borough: "BROOKLYN", zip: "11201" });
  assert.equal(record.complaints.length, 2, "problem rows with one complaint ID must collapse to one public record");
  assert.equal(record.complaints[0].id, "8001");
  assert.equal(record.complaints[0].complaintId, "8001");
  assert.match(record.complaints[0].description, /BROKEN RADIATOR/);
  assert.equal(record.violations[0].normalizedStatus, "open");
  assert.doesNotMatch(record.violations[0].description, /4B|APT|APARTMENT/i);
  assert.equal(record.violations.find((row) => row.id === "9003")?.description, "Housing violation details unavailable");
  assert.equal(record.cache, undefined, "caching belongs to the building context service");
});

test("ZIP constraints apply to fallback histories and inconsistent returned ZIPs cannot supply a building identity", async (t) => {
  let inconsistent = false;
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    const url = new URL(input);
    const complaints = url.pathname.includes("ygpa-z7cr");
    assert.match(url.searchParams.get("$where") ?? "", complaints ? /post_code='99999'/ : /zip='99999'/);
    if (url.pathname.includes("kj4p-ruqc") || !inconsistent) return Response.json([]);
    return Response.json(complaints ? [complaintRow()] : [violationRow()]);
  });
  const missing = await lookupBuilding("100 Main Street 99999", "Brooklyn");
  assert.equal(missing.lookupStatus, "not_found");
  inconsistent = true;
  const mismatched = await lookupBuilding("100 Main Street 99999", "Brooklyn");
  assert.equal(mismatched.lookupStatus, "unavailable");
  assert.equal(mismatched.identifiers?.hpdBuildingId, undefined);
  assert.deepEqual(mismatched.complaints, []);
  assert.deepEqual(mismatched.violations, []);
});

test("capped responses disclose incomplete totals and oversized provider arrays fail safely", async (t) => {
  let count = 100;
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    const url = new URL(input);
    if (url.pathname.includes("kj4p-ruqc")) return Response.json([buildingRow()]);
    return Response.json(Array.from({ length: count }, (_, index) => url.pathname.includes("ygpa-z7cr")
      ? complaintRow({ problem_id: String(index + 1), complaint_id: String(1000 + Math.floor(index / 2)) })
      : violationRow({ violationid: String(index + 1) })));
  });
  const capped = await lookupBuilding("100 Main Street", "Brooklyn");
  assert.equal(capped.complaints.length, 50);
  assert.equal(capped.violations.length, 100);
  assert.match(capped.warning!, /latest 100 complaint problems/);
  assert.match(capped.warning!, /latest 100 violations/);
  count = 101;
  const oversized = await lookupBuilding("100 Main Street", "Brooklyn");
  assert.equal(oversized.lookupStatus, "unavailable");
  assert.deepEqual(oversized.complaints, []);
  assert.deepEqual(oversized.violations, []);
});

test("matching is recent, deterministic, issue-specific, and avoids substring false positives", () => {
  const now = new Date("2026-09-26T12:00:00.000Z");
  const complaint = (id: string, category: string, description: string, date = "2026-09-20T00:00:00.000Z"): HousingRecord => ({
    id, category, description, status: "OPEN", normalizedStatus: "open", date,
  });
  const building: BuildingRecord = {
    address: "100 Main Street", borough: "Brooklyn", zip: "11201", source: "nyc-open-data", fetchedAt: now.toISOString(),
    complaints: [
      complaint("heat", "TEMPERATURE", "Heating system failure"),
      complaint("mold", "MOISTURE", "Mold on wall"),
      complaint("leak", "PLUMBING", "Pipe leak at ceiling"),
      complaint("pests", "RODENT", "Rats reported"),
      complaint("elevator", "ELEVATOR", "Lift out of service"),
      complaint("decor", "PAINT", "Elevated decorative trim is peeling"),
      complaint("old", "HEAT", "No heat", "2025-09-25T00:00:00.000Z"),
    ],
    violations: [
      { id: "v1", category: "Class C", description: "Heat", status: "OPEN", date: "2026-01-01T00:00:00.000Z" },
      { id: "v2", category: "Class B", description: "Paint", status: "VIOLATION CLOSED", date: "2026-01-01T00:00:00.000Z" },
    ],
  };
  assert.deepEqual(getRelatedComplaints(building, "heating", now).map((row) => row.id), ["heat"]);
  assert.deepEqual(getRelatedComplaints(building, "mold", now).map((row) => row.id), ["mold"]);
  assert.deepEqual(getRelatedComplaints(building, "leak", now).map((row) => row.id), ["leak"]);
  assert.deepEqual(getRelatedComplaints(building, "pests", now).map((row) => row.id), ["pests"]);
  assert.deepEqual(getRelatedComplaints(building, "elevator", now).map((row) => row.id), ["elevator"]);
  assert.deepEqual(getRelatedComplaints(building, "other", now), []);
  assert.deepEqual(getBuildingSummary(building, now), {
    recentComplaints: 6, openViolations: 1, heatingComplaints: 1, recentSince: "2025-09-26T12:00:00.000Z",
  });
});

test("lookup distinguishes no result, ambiguous address, malformed data, and total outage", async (t) => {
  let mode: "none" | "ambiguous" | "malformed" | "outage" = "none";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    calls++;
    const url = new URL(input);
    if (mode === "outage") return new Response("Unavailable", { status: 503 });
    if (url.pathname.includes("kj4p-ruqc")) {
      if (mode === "ambiguous") return Response.json([buildingRow(), buildingRow({ buildingid: "54321", bin: "3000999" })]);
      if (mode === "malformed") return Response.json([buildingRow()]);
      return Response.json([]);
    }
    if (mode === "malformed" && url.pathname.includes("ygpa-z7cr")) return Response.json([{ ...complaintRow(), received_date: "not-a-date" }]);
    if (mode === "malformed") return Response.json([violationRow()]);
    return Response.json([]);
  });

  const none = await lookupBuilding("404 Missing Road", "Bronx");
  assert.equal(none.lookupStatus, "not_found");
  assert.equal(none.buildingId, "address:BRONX|404|MISSING ROAD");
  assert.equal(calls, 3);

  mode = "ambiguous"; calls = 0;
  const ambiguous = await lookupBuilding("100 Main Street", "Brooklyn");
  assert.equal(ambiguous.lookupStatus, "ambiguous");
  assert.equal(calls, 1, "do not combine history for ambiguous building identities");

  mode = "malformed"; calls = 0;
  const malformed = await lookupBuilding("100 Main Street", "Brooklyn");
  assert.equal(malformed.lookupStatus, "partial");
  assert.deepEqual(malformed.datasets, { complaints: "unavailable", violations: "ok" });
  assert.equal(malformed.complaints.length, 0);
  assert.equal(malformed.violations.length, 1);
  assert.match(malformed.warning ?? "", /Complaint records are currently unavailable/);

  mode = "outage"; calls = 0;
  const outage = await lookupBuilding("100 Main Street", "Brooklyn");
  assert.equal(outage.lookupStatus, "unavailable");
  assert.deepEqual(outage.datasets, { complaints: "unavailable", violations: "unavailable" });
  assert.equal(calls, 3);
});

test("timeout and mismatched provider identities fail the affected dataset closed", async (t) => {
  let mode: "timeout" | "mismatch" = "timeout";
  t.mock.method(globalThis, "fetch", async (input: URL, init?: RequestInit) => {
    const url = new URL(input);
    assert.ok(init?.signal instanceof AbortSignal, "every NYC request must carry a bounded abort signal");
    if (url.pathname.includes("kj4p-ruqc")) return Response.json([buildingRow()]);
    if (url.pathname.includes("ygpa-z7cr")) {
      if (mode === "timeout") throw new DOMException("Timed out", "TimeoutError");
      return Response.json([complaintRow({ building_id: "99999" })]);
    }
    return Response.json([violationRow()]);
  });

  const timedOut = await lookupBuilding("100 Main Street", "Brooklyn");
  assert.equal(timedOut.lookupStatus, "partial");
  assert.deepEqual(timedOut.datasets, { complaints: "unavailable", violations: "ok" });
  assert.deepEqual(timedOut.complaints, []);

  mode = "mismatch";
  const mismatched = await lookupBuilding("100 Main Street", "Brooklyn");
  assert.equal(mismatched.lookupStatus, "partial");
  assert.deepEqual(mismatched.datasets, { complaints: "unavailable", violations: "ok" });
  assert.deepEqual(mismatched.complaints, [], "never attach history for another HPD building ID");
});

test("demo fallback is exact and labeled, invalid input makes no provider request, and public schema strips unknown keys", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Provider must not be called"); });
  const demo = await lookupBuilding("123 Example St.", "BK");
  assert.equal(demo.lookupStatus, "demo");
  assert.match(demo.warning ?? "", /DEMO DATA/);
  assert.equal(demo.source, "demo");
  const invalid = await lookupBuilding("Example Street", "Brooklyn");
  assert.equal(invalid.lookupStatus, "invalid_address");
  assert.equal(fetch.mock.callCount(), 0);

  const parsed = publicBuildingSchema.parse({ ...demo, privateOwner: "remove", identifiers: { ...demo.identifiers, privateOwner: "remove" } });
  assert.equal("privateOwner" in parsed, false);
  assert.equal("privateOwner" in (parsed.identifiers ?? {}), false);
});
