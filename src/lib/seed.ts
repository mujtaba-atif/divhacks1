import type { BuildingRecord, CaseRecord, IssueType } from "./types";
import { getBuildingSummary } from "./building-context";
import { demoFinancialProfile, demoRentHistory } from "./financial-fixture";

export const DEMO_PARTICIPANTS = {
  tenant: { name: "Rayaan", phone: "+19736060558" },
  landlord: { name: "Alex Morgan", phone: "+12018567033" },
} as const;

const at = (daysAgo = 0, hour = 10) => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
};

export function demoBuilding(now = new Date()): BuildingRecord {
  const demoAt = (daysAgo = 0, hour = 10) => {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);
    date.setHours(hour, 0, 0, 0);
    return date.toISOString();
  };
  const record: BuildingRecord = {
    address: "123 Example Street",
    borough: "Brooklyn",
    zip: "11201",
    source: "demo",
    fetchedAt: now.toISOString(),
    warning: "DEMO DATA: fictional building and sample records for the demonstration.",
    buildingId: "address:BROOKLYN|123|EXAMPLE STREET",
    identifiers: {},
    normalizedAddress: { houseNumber: "123", streetName: "EXAMPLE STREET", borough: "BROOKLYN", zip: "11201" },
    lookupStatus: "demo",
    datasets: { complaints: "ok", violations: "ok" },
    complaints: [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `DEMO-HPD-${3001 + i}`, complaintId: `DEMO-HPD-${3001 + i}`, category: "HEAT/HOT WATER",
        description: "Building-wide insufficient heat", status: i < 4 ? "OPEN" : "CLOSED",
        normalizedStatus: i < 4 ? "open" as const : "closed" as const,
        date: demoAt(i + 1),
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `DEMO-HPD-${4001 + i}`, complaintId: `DEMO-HPD-${4001 + i}`, category: "HOT WATER",
        description: "No hot water reported", status: i === 0 ? "OPEN" : "CLOSED",
        normalizedStatus: i === 0 ? "open" as const : "closed" as const,
        date: demoAt(i + 8),
      })),
    ],
    violations: [
      { id: "DEMO-V-101", category: "Class C", description: "Restore adequate heat.", status: "OPEN", normalizedStatus: "open", date: demoAt(2) },
      { id: "DEMO-V-102", category: "Class C", description: "Restore hot water supply to the building.", status: "OPEN", normalizedStatus: "open", date: demoAt(5) },
    ],
  };
  record.summary = getBuildingSummary(record, now);
  return record;
}

export interface NewCaseInput {
  issue: IssueType;
  description: string;
  noticedAt: string;
  address: string;
  borough: string;
  apartment: string;
  landlordName: string;
  landlordContact: string;
  monthlyRentCents: number;
  disputedAmountCents: number;
  building?: BuildingRecord;
}

const issueTitles: Record<IssueType, string> = {
  heating: "No heat in apartment", mold: "Mold in apartment", leak: "Water leak in apartment",
  pests: "Pest issue in apartment", elevator: "Elevator out of service", other: "Housing repair request",
};

export function createNewCase(ownerId: string, input: NewCaseInput): CaseRecord {
  const id = `RE-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();
  return {
    id, ownerId, title: issueTitles[input.issue], issue: input.issue,
    description: input.description, noticedAt: input.noticedAt, createdAt: now, updatedAt: now,
    status: "open", apartment: input.apartment, landlordName: input.landlordName,
    landlordContact: input.landlordContact, monthlyRentCents: input.monthlyRentCents,
    disputedAmountCents: input.disputedAmountCents, accountBalanceCents: 245000,
    financialProfile: demoFinancialProfile(ownerId, id),
    building: input.building ?? {
      address: input.address, borough: input.borough, zip: "", source: "nyc-open-data",
      fetchedAt: now, complaints: [], violations: [], warning: "Building history has not been fetched yet.",
    },
    evidence: [], messages: [], expenses: [], rentHistory: [],
    timeline: [{ id: crypto.randomUUID(), title: "Case opened", detail: input.description, createdAt: now, kind: "case" }],
    escrow: {
      id: `ESC-${id}`, status: "unfunded", amountCents: input.disputedAmountCents,
      network: "demo", destination: "DEMO_LANDLORD_WALLET", ownerAddress: "DEMO_TENANT_WALLET", audit: [],
    },
    repairReported: false, tenantConfirmed: false,
  };
}

export function createDemoCase(ownerId: string): CaseRecord {
  const record = createNewCase(ownerId, {
    issue: "heating", description: "My apartment has had no heat for three days. The living room is 54 degrees even with the windows closed.",
    noticedAt: at(3), address: "123 Example Street", borough: "Brooklyn", apartment: "4B",
    landlordName: DEMO_PARTICIPANTS.landlord.name, landlordContact: DEMO_PARTICIPANTS.landlord.phone, monthlyRentCents: 185000,
    disputedAmountCents: 40000, building: demoBuilding(),
  });
  record.id = "RE-1042";
  record.tenant = { ...DEMO_PARTICIPANTS.tenant };
  record.tenantName = DEMO_PARTICIPANTS.tenant.name;
  record.tenantPhone = DEMO_PARTICIPANTS.tenant.phone;
  record.financialProfile = demoFinancialProfile(ownerId, record.id);
  record.escrow.id = "ESC-RE-1042";
  record.createdAt = at(3, 9);
  record.updatedAt = at(0, 9);
  record.evidence = [{
    id: "DEMO-EVIDENCE-BEFORE", name: "Living room - before repair.png", mimeType: "image/png",
    stage: "before", note: "Sample thermometer reading from the demo scenario.",
    createdAt: at(3, 10), temperatureF: 54, isDemo: true,
    analysis: {
      summary: "The sample evidence records a 54 F indoor temperature and a reported three-day loss of heat.",
      severity: "high", temperatureF: 54, verified: false, source: "demo",
      issueType: "heating", evidenceType: "thermometer_photo", confidence: 1,
      observations: ["Sample thermometer displays approximately 54°F."], requiresHumanConfirmation: true,
      reasons: ["Demo fixture, not a live Gemini analysis.", "Six sample heating complaints appear in the building history."],
    },
  }];
  record.timeline = [
    { id: "DEMO-T-1", title: "Case opened", detail: "No heat reported in apartment 4B.", createdAt: at(3, 9), kind: "case" },
    { id: "DEMO-T-2", title: "Initial evidence added", detail: "Sample thermometer photo records 54 F.", createdAt: at(3, 10), kind: "evidence" },
    { id: "DEMO-T-3", title: "Evidence summary prepared", detail: "Heating issue identified in demo analysis. Repair is still unverified.", createdAt: at(3, 11), kind: "evidence" },
  ];
  record.expenses = [];
  record.rentHistory = demoRentHistory();
  return record;
}
