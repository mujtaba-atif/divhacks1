import type { BuildingRecord, HousingRecord, IssueType } from "./types";

const RECENT_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

const issuePatterns: Record<IssueType, readonly RegExp[]> = {
  heating: [/\bheat(?:ing)?\b/i, /\bhot\s+water\b/i, /\bboilers?\b/i, /\bradiators?\b/i, /\btemperatures?\b/i],
  mold: [/\bmou?lds?\b/i, /\bmoisture\b/i, /\bmildew\b/i],
  leak: [/\bwater\s+leaks?\b/i, /\bleaks?\b/i, /\bceilings?\b/i, /\bplumb(?:ing|ers?)\b/i, /\bpipes?\b/i, /\bfaucets?\b/i, /\bwater\b/i],
  pests: [/\bpests?\b/i, /\brodents?\b/i, /\brats?\b/i, /\b(?:mouse|mice)\b/i, /\bcockroach(?:es)?\b/i, /\broaches?\b/i, /\bvermin\b/i],
  elevator: [/\belevators?\b/i, /\blifts?\b/i],
  other: [],
};

export const issueContextLabels: Record<IssueType, string> = {
  heating: "heat / hot-water",
  mold: "mold / moisture",
  leak: "leak / water / plumbing",
  pests: "pest / vermin",
  elevator: "elevator",
  other: "related",
};

function recentBoundary(now: Date): Date {
  return new Date(now.getTime() - RECENT_DAYS * DAY_MS);
}

function isRecent(record: HousingRecord, since: Date, now: Date): boolean {
  const timestamp = Date.parse(record.date);
  return Number.isFinite(timestamp) && timestamp >= since.getTime() && timestamp <= now.getTime();
}

function isRelated(record: HousingRecord, issue: IssueType): boolean {
  const searchable = `${record.category} ${record.description}`;
  return issuePatterns[issue].some((pattern) => pattern.test(searchable));
}

function isOpen(record: HousingRecord): boolean {
  if (record.normalizedStatus) return record.normalizedStatus === "open";
  return /\b(?:OPEN|ACTIVE|PENDING)\b|NOV SENT|REINSPECT|CERTIF/i.test(record.status)
    && !/\bCLOSE(?:D)?\b|DISMISS|COMPLIED|RESCIND/i.test(record.status);
}

function newestFirst(left: HousingRecord, right: HousingRecord): number {
  return Date.parse(right.date) - Date.parse(left.date) || left.id.localeCompare(right.id);
}

/** Returns public complaint records from the explicitly labeled last 365 days. */
export function getRelatedComplaints(building: BuildingRecord, issue: IssueType, now = new Date()): HousingRecord[] {
  const since = recentBoundary(now);
  return building.complaints
    .filter((record) => isRecent(record, since, now) && isRelated(record, issue))
    .sort(newestFirst);
}

export function getBuildingSummary(building: BuildingRecord, now = new Date()): NonNullable<BuildingRecord["summary"]> {
  const since = recentBoundary(now);
  const recentComplaints = building.complaints.filter((record) => isRecent(record, since, now));
  return {
    recentComplaints: recentComplaints.length,
    openViolations: building.violations.filter(isOpen).length,
    heatingComplaints: recentComplaints.filter((record) => isRelated(record, "heating")).length,
    recentSince: since.toISOString(),
  };
}
