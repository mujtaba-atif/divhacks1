export type IssueType = "heating" | "mold" | "leak" | "pests" | "elevator" | "other";
export type CaseStatus = "open" | "awaiting_repair" | "verification" | "verified" | "resolved";
export type EvidenceStage = "before" | "after" | "receipt" | "other";

export interface BuildingRecord {
  address: string;
  borough: string;
  zip: string;
  source: "demo" | "nyc-open-data";
  complaints: HousingRecord[];
  violations: HousingRecord[];
  fetchedAt: string;
  warning?: string;
}

export interface HousingRecord {
  id: string;
  category: string;
  description: string;
  status: string;
  date: string;
}

export interface EvidenceAnalysis {
  summary: string;
  severity: "low" | "medium" | "high";
  temperatureF?: number;
  verified: boolean;
  reasons: string[];
  source: "demo" | "gemini";
}

export interface EvidenceRecord {
  id: string;
  name: string;
  mimeType: string;
  stage: EvidenceStage;
  note: string;
  createdAt: string;
  dataUrl?: string;
  temperatureF?: number;
  isDemo: boolean;
  analysis?: EvidenceAnalysis;
}

export interface CaseMessage {
  id: string;
  sender: "tenant" | "agent" | "landlord";
  body: string;
  createdAt: string;
  delivery: "demo" | "sent" | "received";
}

export interface TimelineEvent {
  id: string;
  title: string;
  detail: string;
  createdAt: string;
  kind: "case" | "evidence" | "message" | "escrow" | "verification";
}

export interface ExpenseRecord {
  id: string;
  label: string;
  amountCents: number;
  date: string;
  category: string;
  source: "demo" | "manual" | "nessie";
}

export interface RentPayment {
  id: string;
  month: string;
  amountCents: number;
  status: "paid" | "upcoming";
  source: "demo" | "nessie";
}

export interface PolicyCheck {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface PolicyResult {
  approved: boolean;
  checks: PolicyCheck[];
}

export interface AuditRecord {
  id: string;
  action: "EscrowCreate" | "EscrowFinish" | "PolicyCheck";
  createdAt: string;
  status: "validated" | "rejected" | "failed";
  network: "demo" | "testnet";
  amountCents: number;
  destination: string;
  hash?: string;
  detail: string;
}

export interface EscrowRecord {
  id: string;
  status: "unfunded" | "locked" | "released";
  amountCents: number;
  network: "demo" | "testnet";
  destination: string;
  ownerAddress: string;
  sequence?: number;
  createHash?: string;
  finishHash?: string;
  lockedAt?: string;
  releasedAt?: string;
  audit: AuditRecord[];
}

export interface CaseRecord {
  id: string;
  ownerId: string;
  title: string;
  issue: IssueType;
  description: string;
  noticedAt: string;
  createdAt: string;
  updatedAt: string;
  status: CaseStatus;
  building: BuildingRecord;
  apartment: string;
  landlordName: string;
  landlordContact: string;
  monthlyRentCents: number;
  disputedAmountCents: number;
  accountBalanceCents: number;
  evidence: EvidenceRecord[];
  messages: CaseMessage[];
  timeline: TimelineEvent[];
  expenses: ExpenseRecord[];
  rentHistory: RentPayment[];
  escrow: EscrowRecord;
  repairReported: boolean;
  tenantConfirmed: boolean;
  verification?: EvidenceAnalysis;
}

export interface IntegrationStatus {
  id: string;
  name: string;
  status: "demo" | "configured" | "public" | "unavailable";
  detail: string;
}

export interface DashboardData {
  cases: CaseRecord[];
  integrations: IntegrationStatus[];
  mode: "demo";
}

export interface TransactionIntent {
  caseId: string;
  escrowId: string;
  transactionType: string;
  destination: string;
  amountCents: number;
  network: string;
}

export type CaseAction =
  | { action: "add_demo_evidence"; stage: "before" | "after" }
  | { action: "analyze_evidence"; evidenceId: string }
  | { action: "send_message"; body: string }
  | { action: "simulate_landlord_reply"; variant: "scheduled" | "completed" }
  | { action: "create_escrow" }
  | { action: "verify_repair" }
  | { action: "confirm_resolution" }
  | { action: "release_escrow" }
  | { action: "add_expense"; label: string; amountCents: number; category: string }
  | { action: "sync_finances" }
  | { action: "policy_check"; intent: TransactionIntent };
