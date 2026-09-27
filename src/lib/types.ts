export type IssueType = "heating" | "mold" | "leak" | "pests" | "elevator" | "other";
export type CaseType = "bilateral" | "self_documentation";
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

export type LandlordReplyIntent = "scheduled" | "repair_complete" | "question" | "refusal" | "other";

export interface LandlordReplyClassification {
  intent: LandlordReplyIntent;
  scheduledFor?: string;
  summary: string;
  source: "demo" | "rules" | "gemini";
}

export interface CaseMessage {
  id: string;
  sender: "tenant" | "agent" | "landlord";
  body: string;
  createdAt: string;
  delivery: "demo" | "sent" | "received" | "pending" | "failed" | "uncertain";
  provider?: "demo" | "spectrum" | "photon";
  caseId?: string;
  recipient?: string;
  providerMessageId?: string;
  providerConversationId?: string;
  sendingLine?: string;
  requestId?: string;
  attemptedAt?: string;
  sentAt?: string;
  failureReason?: string;
  classification?: LandlordReplyClassification;
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
  transactionId?: string;
}

export type NessieReasonCode = "NESSIE_NOT_CONFIGURED" | "NESSIE_API_UNAVAILABLE" | "NESSIE_INVALID_RESPONSE"
  | "NESSIE_INVALID_ID" | "NESSIE_CUSTOMER_NOT_FOUND" | "NESSIE_ACCOUNT_NOT_FOUND"
  | "NESSIE_CUSTOMER_MISMATCH" | "NESSIE_ACCOUNT_MISMATCH" | "NESSIE_TENANT_MISMATCH"
  | "NESSIE_CASE_MISMATCH" | "NESSIE_OWNERSHIP_MISMATCH" | "NESSIE_INSUFFICIENT_BALANCE"
  | "NESSIE_VERIFICATION_REQUIRED" | "NESSIE_VERIFICATION_STALE" | "NESSIE_LIVE_VERIFICATION_REQUIRED";

export interface FinancialBinding {
  tenantId: string;
  caseId: string;
  customerId: string;
  accountId: string;
  source: "demo" | "nessie";
}

export interface FinancialTransaction {
  id: string;
  label: string;
  amountCents: number;
  date: string;
  category: string;
  source: "demo" | "nessie";
  relatedStatus: "suggested" | "confirmed" | "dismissed";
  suggestionReason?: string;
  providerStatus?: "changed" | "missing";
  reviewNote?: string;
  confirmedAmountCents?: number;
}

export interface FinancialProfile {
  binding: FinancialBinding;
  status: "unverified" | "verified" | "unavailable" | "rejected";
  reasonCode?: NessieReasonCode;
  detail: string;
  checkedAt?: string;
  expiresAt?: string;
  accountBalanceCents?: number;
  customerVerified: boolean;
  accountVerified: boolean;
  ownershipVerified: boolean;
  transactions: FinancialTransaction[];
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
  reasonCodes?: NessieReasonCode[];
}

export interface AuditRecord {
  id: string;
  action: "EscrowCreate" | "EscrowFinish" | "PolicyCheck" | "Payment";
  createdAt: string;
  status: "validated" | "rejected" | "failed";
  network: "demo" | "testnet";
  amountCents: number;
  destination: string;
  hash?: string;
  detail: string;
  caseId?: string;
  attemptedCaseId?: string;
  settlementId?: string;
  requestedAction?: string;
  requestedTransactionType?: string;
  requestedNetwork?: string;
  source?: string;
  amountDrops?: string;
  approvedAmountDrops?: string;
  ledgerIndex?: number;
  result?: string;
  validated?: boolean;
  code?: string;
  signed?: boolean;
  submitted?: boolean;
}

/** Public authorization and receipt only. Never store signing keys here. */
export interface XrplSettlement {
  id: string;
  caseId: string;
  ownerId: string;
  escrowId: string;
  network: "testnet";
  transactionType: "Payment";
  source: string;
  destination: string;
  amountDrops: string;
  amountUsdCents: number;
  status: "ready" | "pending" | "validated" | "failed";
  createdAt: string;
  hash?: string;
  sequence?: number;
  lastLedgerSequence?: number;
  ledgerIndex?: number;
  result?: string;
  validatedAt?: string;
  errorCode?: string;
  detail?: string;
}

export interface XrplSettlementIntent {
  caseId: string;
  ownerId: string;
  escrowId: string;
  settlementId: string;
  requestedAction: string;
  transactionType: string;
  network: string;
  source: string;
  destination: string;
  amountDrops: string;
  amountUsdCents: number;
}

/** Optional trusted normalized context; no dependency on a banking provider. */
export interface FinancialPolicyContext {
  tenantVerified?: boolean;
  customerVerified?: boolean;
  accountVerified?: boolean;
  accountCustomerBound?: boolean;
  financiallyReady?: boolean;
}

export type XrplSecurityScenario = "wallet_switch" | "amount_tamper" | "prompt_injection"
  | "insufficient_funds" | "duplicate" | "wrong_network" | "wrong_case" | "unsupported_action";

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
  /** Demo participant details, separate from the authenticated workspace owner ID. */
  tenant?: { name: string; phone: string };
  tenantName?: string;
  tenantPhone?: string;
  /** Assigned only by server-side demo creation, never accepted from an API caller. */
  demoMessagingBinding?: { ownerId: string; caseId: string; recipient: string };
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
  financialProfile?: FinancialProfile;
  evidence: EvidenceRecord[];
  messages: CaseMessage[];
  timeline: TimelineEvent[];
  expenses: ExpenseRecord[];
  rentHistory: RentPayment[];
  escrow: EscrowRecord;
  repairReported: boolean;
  tenantConfirmed: boolean;
  /** Omitted for pre-registration demo cases; bilateral is the legacy behavior. */
  case_type?: CaseType;
  verification?: EvidenceAnalysis;
  xrplSettlement?: XrplSettlement;
  financialPolicyContext?: FinancialPolicyContext;
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
  tenantId?: string;
  nessieCustomerId?: string;
  nessieAccountId?: string;
}

export type CaseAction =
  | { action: "add_demo_evidence"; stage: "before" | "after" }
  | { action: "analyze_evidence"; evidenceId: string }
  | { action: "send_message"; body: string; approved: true; requestId: string }
  | { action: "simulate_landlord_reply"; variant: "scheduled" | "completed" }
  | { action: "record_landlord_reply"; body: string }
  | { action: "create_escrow" }
  | { action: "verify_repair" }
  | { action: "confirm_resolution" }
  | { action: "release_escrow" }
  | { action: "enable_xrpl" }
  | { action: "settle_xrpl" }
  | { action: "reconcile_xrpl" }
  | { action: "xrpl_security_demo"; scenario: XrplSecurityScenario }
  | { action: "add_expense"; label: string; amountCents: number; category: string }
  | { action: "sync_finances" }
  | { action: "confirm_transaction"; transactionId: string }
  | { action: "dismiss_transaction"; transactionId: string }
  | { action: "check_financial_binding"; scenario: "valid" | "substitution" }
  | { action: "policy_check"; intent: TransactionIntent };
