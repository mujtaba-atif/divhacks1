import { z } from "zod";
import { demoBuilding } from "../seed";
import type { BuildingRecord, HousingRecord } from "../types";
import { assertServer, fetchJson } from "./shared";

const complaintSchema = z.object({
  unique_key: z.string(), complaint_id: z.string(), received_date: z.string(),
  major_category: z.string().optional(), problem_code: z.string().optional(),
  complaint_status: z.string(), post_code: z.string().optional(),
});
const violationSchema = z.object({
  violationid: z.string(), class: z.string().optional(), novdescription: z.string(),
  currentstatus: z.string(), inspectiondate: z.string(), zip: z.string().optional(),
});
const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toUpperCase();
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const boroughs = ["MANHATTAN", "BRONX", "BROOKLYN", "QUEENS", "STATEN ISLAND"];

function dataUrl(dataset: string, where: string, order: string): URL {
  const url = new URL(`https://data.cityofnewyork.us/resource/${dataset}.json`);
  url.searchParams.set("$where", where);
  url.searchParams.set("$order", order);
  url.searchParams.set("$limit", "100");
  return url;
}

export async function lookupBuilding(address: string, borough: string): Promise<BuildingRecord> {
  assertServer();
  const normalizedAddress = normalize(address);
  const normalizedBorough = normalize(borough);
  const fixture = demoBuilding();
  if (normalizedAddress === normalize(fixture.address) && normalizedBorough === normalize(fixture.borough)) {
    return fixture;
  }
  const result: BuildingRecord = {
    address: address.trim(), borough: borough.trim(), zip: "", source: "nyc-open-data",
    complaints: [], violations: [], fetchedAt: new Date().toISOString(),
  };
  const match = /^(\d[\dA-Z/-]*)\s+(.{2,140})$/.exec(normalizedAddress);
  if (!match || !boroughs.includes(normalizedBorough)) {
    return { ...result, warning: "Enter a house number, full street name, and a New York City borough to look up public records." };
  }
  const [, house, street] = match;
  const headers: HeadersInit = process.env.NYC_OPEN_DATA_APP_TOKEN
    ? { "X-App-Token": process.env.NYC_OPEN_DATA_APP_TOKEN }
    : {};
  const [complaints, violations] = await Promise.allSettled([
    fetchJson(dataUrl("ygpa-z7cr", `upper(house_number)=${quote(house)} AND upper(street_name)=${quote(street)} AND upper(borough)=${quote(normalizedBorough)}`, "received_date DESC"), "NYC complaints", { headers })
      .then((payload) => z.array(complaintSchema).parse(payload)),
    fetchJson(dataUrl("wvxf-dwi5", `upper(housenumber)=${quote(house)} AND upper(streetname)=${quote(street)} AND upper(boro)=${quote(normalizedBorough)}`, "inspectiondate DESC"), "NYC violations", { headers })
      .then((payload) => z.array(violationSchema).parse(payload)),
  ]);
  const warnings: string[] = [];
  if (complaints.status === "fulfilled") {
    result.complaints = complaints.value.map((row): HousingRecord => ({
      id: row.unique_key, category: row.major_category ?? "Housing complaint",
      description: row.problem_code ?? `Complaint ${row.complaint_id}`,
      status: row.complaint_status, date: row.received_date,
    }));
    result.zip = complaints.value.find((row) => row.post_code)?.post_code ?? "";
    if (complaints.value.length === 100) warnings.push("Showing the latest 100 complaint problem records; one complaint can contain multiple problems.");
  } else warnings.push("Complaint records are currently unavailable; the empty list does not mean no complaints exist.");
  if (violations.status === "fulfilled") {
    result.violations = violations.value.map((row): HousingRecord => ({
      id: row.violationid, category: row.class ? `Class ${row.class}` : "Housing violation",
      description: row.novdescription, status: row.currentstatus, date: row.inspectiondate,
    }));
    result.zip ||= violations.value.find((row) => row.zip)?.zip ?? "";
    if (violations.value.length === 100) warnings.push("Showing the latest 100 violations.");
  } else warnings.push("Violation records are currently unavailable; the empty list does not mean no violations exist.");
  if (complaints.status === "fulfilled" && violations.status === "fulfilled" && !result.complaints.length && !result.violations.length) {
    warnings.push("No records matched this exact address. Check the full street spelling; this is not a building clearance or proof of no issues.");
  }
  if (warnings.length) result.warning = warnings.join(" ");
  return result;
}
