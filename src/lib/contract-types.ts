export const CONTRACT_POLICY_VERSION = "CONTRACT_POLICY_V1" as const;
export const CONTRACT_AGENT_ID = "rentescrow-settlement-v1" as const;

export type ContractStatus = "draft" | "pending_landlord" | "active" | "used";
export type ContractRole = "tenant" | "landlord";

export interface ContractAcceptance {
  role: ContractRole;
  userId: string;
  acceptedAt: string;
  termsHash: string;
  /** Present on contract-governed bilateral agreements. */
  policyHash?: string;
  method: "stored_acceptance";
}

export interface ContractPolicy {
  contractId: string;
  policyVersion: typeof CONTRACT_POLICY_VERSION;
  tenantUserId: string;
  tenantDisplayName: string;
  landlordUserId: string;
  landlordDisplayName: string;
  property: {
    id: string;
    address: string;
    borough: string;
  };
  monthlyRentCents: number;
  dueDay: number;
  /** The single YYYY-MM obligation period covered by this prototype agreement. */
  obligationPeriod: string;
  effectiveDate: string;
  gracePeriodDays: number;
  disputedFunds: {
    mode: "HOLD_ALL";
    allowUndisputedRelease: false;
  };
  repairRules: {
    repairReportedRequired: boolean;
    evidenceVerifiedRequired: boolean;
    tenantConfirmationRequired: boolean;
  };
  lateFeeRule: {
    feeCents: number;
    maxLateFeeCents: number;
  };
  monetaryDefault: {
    afterDays: number;
    remedy: "RECORD_ONLY";
  };
  nonMonetaryDefault: {
    obligation: "REPAIR_BY_DEADLINE";
    deadlineDays: number;
    remedy: "RECORD_ONLY";
  };
  settlement: {
    asset: "RLUSD";
    network: "testnet";
    source: string;
    destination: string;
    issuer: string;
    currency: string;
    amountRlusd: string;
    maxAutonomousAmountRlusd: string;
  };
  agentId: typeof CONTRACT_AGENT_ID;
}

export interface DigitalContract {
  id: string;
  /** Alias retained explicitly in financial audit records and UI. */
  contractId?: string;
  case_type: "bilateral" | "self_documentation";
  terms: string;
  termsHash: string;
  tenantUserId: string;
  landlordUserId?: string;
  tenantDisplayName?: string;
  landlordDisplayName?: string;
  propertyId?: string;
  effectiveDate?: string;
  policyVersion?: typeof CONTRACT_POLICY_VERSION;
  policy?: ContractPolicy;
  policyHash?: string;
  createdAt: string;
  acceptances: ContractAcceptance[];
  status: ContractStatus;
  caseId?: string;
}

export interface ContractPolicyCheck {
  code: string;
  passed: boolean;
  detail: string;
}

export type ContractPolicyAction =
  | "RELEASE_RENT"
  | "RECORD_LATE_PAYMENT"
  | "RECORD_MONETARY_DEFAULT"
  | "RECORD_NON_MONETARY_DEFAULT"
  | "NONE";

export interface ContractPolicyDecision {
  allowed: boolean;
  action: ContractPolicyAction;
  contractId: string;
  policyVersion: typeof CONTRACT_POLICY_VERSION;
  policyHash: string;
  reason: string;
  amount: string;
  asset: "RLUSD";
  evaluatedRules: ContractPolicyCheck[];
  effects: {
    lateFeeCents?: number;
    monetaryDefault?: true;
    nonMonetaryDefault?: true;
  };
}

/** Minimal persisted case facts consumed by the synchronous policy evaluator. */
export interface ContractCaseState {
  id: string;
  contractId?: string;
  tenantUserId?: string;
  landlordUserId?: string;
  propertyId?: string;
  contractDispute?: "none" | "open" | "resolved";
  monthlyRentCents?: number;
  disputedAmountCents?: number;
  escrow: { status: "unfunded" | "locked" | "released"; amountCents?: number };
  repairReported?: boolean;
  repairs?: { kind: string; createdAt: string; landlordUserId?: string }[];
  evidence?: {
    stage: string;
    createdAt: string;
    uploadedByRole?: string;
    analysis?: { verified: boolean; analyzedAt?: string };
  }[];
  verification?: { verified: boolean };
  tenantConfirmed?: boolean;
}

export interface ContractFinancialState {
  /** Trusted server-side fact. The browser and agent cannot supply this value. */
  fundsAvailable: boolean;
}

export interface ContractFeeDecision {
  allowed: boolean;
  reason: "FEE_ALLOWED" | "FEE_EXCEEDS_CONTRACT_POLICY" | "FEE_NOT_AUTHORIZED"
    | "CONTRACT_NOT_ACTIVE" | "CONTRACT_INTEGRITY_FAILED";
  configuredFeeCents: number;
  maximumFeeCents: number;
}
