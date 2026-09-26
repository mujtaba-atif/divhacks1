import type { BuildingRecord, CaseRecord, IssueType } from "./types";

const at = (daysAgo = 0, hour = 10) => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
};

export function demoBuilding(): BuildingRecord {
  return {
    address: "123 Example Street",
    borough: "Brooklyn",
    zip: "11201",
    source: "demo",
    fetchedAt: new Date().toISOString(),
    warning: "Fictional building and sample records for the demonstration.",
    complaints: [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `DEMO-HPD-${3001 + i}`, category: "HEAT/HOT WATER",
        description: "Entire building - insufficient heat", status: i < 4 ? "OPEN" : "CLOSED",
        date: at(i + 1),
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `DEMO-HPD-${4001 + i}`, category: "HOT WATER",
        description: "Apartment - no hot water", status: i === 0 ? "OPEN" : "CLOSED",
        date: at(i + 8),
      })),
    ],
    violations: [
      { id: "DEMO-V-101", category: "Class C", description: "Restore adequate heat to the apartment.", status: "OPEN", date: at(2) },
      { id: "DEMO-V-102", category: "Class C", description: "Restore hot water supply to the building.", status: "OPEN", date: at(5) },
    ],
  };
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
    landlordName: "Alex Morgan", landlordContact: "", monthlyRentCents: 185000,
    disputedAmountCents: 40000, building: demoBuilding(),
  });
  record.id = "RE-1042";
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
      reasons: ["Demo fixture, not a live Gemini analysis.", "Six sample heating complaints appear in the building history."],
    },
  }];
  record.timeline = [
    { id: "DEMO-T-1", title: "Case opened", detail: "No heat reported in apartment 4B.", createdAt: at(3, 9), kind: "case" },
    { id: "DEMO-T-2", title: "Initial evidence added", detail: "Sample thermometer photo records 54 F.", createdAt: at(3, 10), kind: "evidence" },
    { id: "DEMO-T-3", title: "Evidence summary prepared", detail: "Heating issue identified in demo analysis. Repair is still unverified.", createdAt: at(3, 11), kind: "evidence" },
  ];
  record.expenses = [
    { id: "DEMO-EXP-1", label: "Portable space heater", amountCents: 4799, date: at(2), category: "Equipment", source: "demo" },
    { id: "DEMO-EXP-2", label: "Additional electricity", amountCents: 2400, date: at(1), category: "Utilities", source: "demo" },
    { id: "DEMO-EXP-3", label: "Temporary accommodation", amountCents: 11000, date: at(1), category: "Accommodation", source: "demo" },
  ];
  record.rentHistory = [
    { id: "DEMO-RENT-1", month: "August 2026", amountCents: 185000, status: "paid", source: "demo" },
    { id: "DEMO-RENT-2", month: "September 2026", amountCents: 185000, status: "paid", source: "demo" },
    { id: "DEMO-RENT-3", month: "October 2026", amountCents: 185000, status: "upcoming", source: "demo" },
  ];
  return record;
}
