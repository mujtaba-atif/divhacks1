import type { DigitalContract, ContractPolicyDecision } from "./contract-types";

export type IssueType = "heating" | "mold" | "leak" | "pests" | "elevator" | "other";
export type CaseType = "bilateral" | "self_documentation";
export type CaseStatus = "open" | "awaiting_repair" | "verification" | "verified" | "resolved";
export type EvidenceStage = "before" | "after" | "receipt" | "other";

export interface AuthUser {
  id: string;
  email: string;
  role: "tenant" | "landlord";
  displayName: string;
  workspaceOwnerId: string;
  /** Safe account projection; the full contact is stored only on the server. */
  maskedPhone?: string;
}

export interface RepairAction {
  id: string;
  caseId: string;
  landlordUserId: string;
  kind: "scheduled" | "reported_complete" | "evidence_uploaded";
  createdAt: string;
  notes: string;
  scheduledFor?: string;
  evidenceId?: string;
}

/** Explicit public projection; never send a CaseRecord to a landlord client. */
export interface LandlordCase {
  id: string;
  title: string;
  issue: IssueType;
  description: string;
  noticedAt: string;
  createdAt: string;
  updatedAt: string;
  status: CaseStatus;
  property: { id: string; address: string; borough: string; apartment: string };
  tenant: { displayName: string };
  evidence: EvidenceRecord[];
  messages: Pick<CaseMessage, "id" | "sender" | "body" | "createdAt" | "delivery" | "originatingAgent"
    | "interpretation" | "provider" | "failureReason">[];
  timeline: TimelineEvent[];
  repairReported: boolean;
  repairs: RepairAction[];
  financialSummary: {
    disputedAmountCents: number;
    escrowStatus: "unfunded" | "locked" | "released";
    settlementStatus: "pending" | "complete";
  };
  verification?: EvidenceAnalysis;
}

export interface BuildingRecord {
  address: string;
  borough: string;
  zip: string;
  source: "demo" | "nyc-open-data";
  complaints: HousingRecord[];
  violations: HousingRecord[];
  fetchedAt: string;
  warning?: string;
  /** Stable HPD identifier when resolved, otherwise a canonical address key. */
  buildingId?: string;
  identifiers?: {
    hpdBuildingId?: string;
    bin?: string;
    bbl?: string;
  };
  normalizedAddress?: {
    houseNumber: string;
    streetName: string;
    borough: string;
    zip?: string;
  };
  lookupStatus?: "ok" | "partial" | "unavailable" | "not_found" | "ambiguous" | "invalid_address" | "demo";
  datasets?: {
    complaints: "ok" | "unavailable";
    violations: "ok" | "unavailable";
  };
  cache?: {
    state: "fresh" | "cached" | "stale";
    expiresAt: string;
  };
  summary?: {
    recentComplaints: number;
    openViolations: number;
    heatingComplaints: number;
    recentSince: string;
  };
}

export interface HousingRecord {
  id: string;
  category: string;
  description: string;
  status: string;
  date: string;
  /** Complaint-level identifier; multiple provider problem rows are deduplicated to it. */
  complaintId?: string;
  normalizedStatus?: "open" | "closed" | "unknown";
}

export interface EvidenceAnalysis {
  summary: string;
  severity: "low" | "medium" | "high";
  temperatureF?: number;
  verified: boolean;
  reasons: string[];
  source: "demo" | "gemini";
  /** Optional for records saved before structured Gemini analysis was introduced. */
  issueType?: IssueType;
  observations?: string[];
  evidenceType?: "thermometer_photo" | "condition_photo" | "document" | "other";
  confidence?: number;
  requiresHumanConfirmation?: true;
  model?: string;
  analyzedAt?: string;
  /** Application-generated comparison, never a model-provided authorization. */
  comparison?: {
    beforeEvidenceId: string;
    afterEvidenceId: string;
    beforeTemperatureF?: number;
    afterTemperatureF?: number;
    rule: "heating-evidence-v1" | "demo-heating-v1";
    passed: boolean;
  };
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
  uploadedByRole?: "tenant" | "landlord";
  uploadedByUserId?: string;
  analysis?: EvidenceAnalysis;
  analysisError?: {
    message: string;
    code: string;
    retryable: boolean;
    attemptedAt: string;
  };
}

export type LandlordReplyIntent = "scheduled" | "repair_complete" | "question" | "refusal" | "other";

export interface LandlordReplyClassification {
  intent: LandlordReplyIntent;
  scheduledFor?: string;
  summary: string;
  source: "demo" | "rules" | "gemini";
}

export type MessagingRole = "tenant" | "landlord";
export type MessagingIntent = "scheduled" | "rescheduled" | "repair_complete" | "repair_update" | "question"
  | "refusal" | "other" | "reschedule_request" | "schedule_confirmed" | "no_show" | "unresolved";

export interface ParticipantMessageInterpretation {
  intent: MessagingIntent;
  summary: string;
  scheduledFor?: string;
  source: "rules" | "gemini";
}

export interface CaseMessagingBindingParticipant {
  userId: string;
  phone: string;
  conversationId?: string;
  sendingLine?: string;
}

export interface CaseMessagingBinding {
  ownerId: string;
  caseId: string;
  tenant: CaseMessagingBindingParticipant;
  landlord: CaseMessagingBindingParticipant;
}

export interface CaseMessagingEvent {
  id: string;
  type: "MAINTENANCE_SCHEDULED" | "MAINTENANCE_RESCHEDULED" | "REPAIR_REPORTED_COMPLETE"
    | "REPAIR_UPDATE" | "RESCHEDULE_REQUESTED" | "SCHEDULE_CONFIRMED" | "MAINTENANCE_NO_SHOW"
    | "CONDITION_UNRESOLVED";
  actor: MessagingRole;
  messageId: string;
  createdAt: string;
  summary: string;
  scheduledFor?: string;
}

export interface MaintenanceSchedule {
  scheduledFor: string;
  status: "scheduled" | "reschedule_requested" | "confirmed" | "no_show";
  updatedAt: string;
  sourceMessageId: string;
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
  originatingAgent?: MessagingRole;
  participantUserId?: string;
  recipientUserId?: string;
  triggerMessageId?: string;
  interpretation?: ParticipantMessageInterpretation;
  /** Inbound processing is separate from receipt persistence and relay delivery. */
  processedAt?: string;
  relayRequired?: boolean;
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

export interface ContractSettlementReference {
  contractId?: string;
  contractPolicyVersion?: string;
  policyHash?: string;
  triggeringEvent?: string;
}

export interface AuditRecord extends ContractSettlementReference {
  evaluatedRules?: PolicyCheck[];
  contractDecision?: ContractPolicyDecision;
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
  policyDecision?: PolicyResult;
  actor?: "tenant" | "settlement_agent";
  agentId?: string;
  policyVersion?: string;
  asset?: string;
  amount?: string;
  approvedAmount?: string;
  issuer?: string;
  currency?: string;
  transactionHash?: string;
  validatedResult?: string;
  timestamp?: string;
}

/** Public authorization and receipt only. Never store signing keys here. */
export interface XrplSettlement extends ContractSettlementReference {
  id: string;
  caseId: string;
  ownerId: string;
  /** Optional only to preserve historical XRP permissions and receipts. */
  agentId?: string;
  policyVersion?: string;
  asset?: "XRP" | "RLUSD";
  amount?: string;
  issuer?: string;
  currency?: string;
  requestedAction?: "REQUEST_SETTLEMENT" | "RELEASE_RENT";
  policyDecision?: PolicyResult;
  transactionHash?: string;
  validatedResult?: string;
  timestamp?: string;
  /** Pinned participant identities; optional only for reading historical receipts. */
  tenantUserId?: string;
  landlordUserId?: string;
  landlordWallet?: string;
  agentAuthorizedAt?: string;
  agentRequestedAt?: string;
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

export interface XrplSettlementIntent extends ContractSettlementReference {
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
  agentId?: string;
  policyVersion?: string;
  asset?: string;
  amount?: string;
  issuer?: string;
  currency?: string;
  tenantUserId?: string;
  landlordUserId?: string;
  landlordWallet?: string;
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
  | "insufficient_funds" | "duplicate" | "wrong_network" | "wrong_case" | "unsupported_action"
  | "issuer_tamper" | "wrong_asset";

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
  contractId?: string;
  /** Server-refreshed copy of the immutable signed agreement; never accepted from request JSON. */
  contractSnapshot?: DigitalContract;
  contractDispute?: "none" | "open" | "resolved";
  contractEvaluation?: ContractPolicyDecision;
  contractEvaluatedAt?: string;
  contractEvaluationFingerprint?: string;
  contractTrigger?: string;
  contractEffects?: { lateFeeCents?: number; monetaryDefault?: boolean; nonMonetaryDefault?: boolean };
  id: string;
  ownerId: string;
  tenantUserId?: string;
  tenantDisplayName?: string;
  landlordUserId?: string;
  propertyId?: string;
  repairs?: RepairAction[];
  /** Demo participant details, separate from the authenticated workspace owner ID. */
  tenant?: { name: string; phone: string };
  tenantName?: string;
  tenantPhone?: string;
  /** Assigned only by server-side demo creation, never accepted from an API caller. */
  demoMessagingBinding?: { ownerId: string; caseId: string; recipient: string };
  /** Trusted server-side participant routing authority for two-sided messaging. */
  messagingBinding?: CaseMessagingBinding;
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
  messagingEvents?: CaseMessagingEvent[];
  maintenanceSchedule?: MaintenanceSchedule;
  pendingMaintenanceRequest?: {
    scheduledFor?: string;
    previousScheduledFor?: string;
    messageId: string;
    createdAt: string;
  };
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

export type ContractSecurityScenario = "wallet_switch" | "amount_tamper" | "issuer_tamper" | "wrong_network"
  | "duplicate" | "excess_fee" | "unsupported_action" | "mutate_terms"
  | "prompt_injection" | "insufficient_funds" | "wrong_case" | "wrong_asset";

export type CaseAction =
  | { action: "open_contract_dispute" }
  | { action: "evaluate_contract" }
  | { action: "contract_security_demo"; scenario: ContractSecurityScenario }
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
  | { action: "authorize_xrpl_agent" }
  | { action: "settle_xrpl" }
  | { action: "reconcile_xrpl" }
  | { action: "xrpl_security_demo"; scenario: XrplSecurityScenario }
  | { action: "add_expense"; label: string; amountCents: number; category: string }
  | { action: "sync_finances" }
  | { action: "confirm_transaction"; transactionId: string }
  | { action: "dismiss_transaction"; transactionId: string }
  | { action: "check_financial_binding"; scenario: "valid" | "substitution" }
  | { action: "policy_check"; intent: TransactionIntent };
