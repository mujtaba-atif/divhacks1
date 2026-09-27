import type { CaseRecord, NessieReasonCode, PolicyCheck, PolicyResult, TransactionIntent, XrplSettlementIntent } from "./types";
import {
  SETTLEMENT_AGENT_ID,
  SETTLEMENT_POLICY_VERSION,
  sameAssetPermission,
  settlementAmount,
  validAssetPermission,
} from "./xrpl-assets";

export function makeIntent(record: CaseRecord, transactionType: string): TransactionIntent {
  return {
    caseId: record.id, escrowId: record.escrow.id, transactionType,
    destination: record.escrow.destination, amountCents: record.disputedAmountCents,
    network: record.escrow.network,
    tenantId: record.ownerId,
    nessieCustomerId: record.financialProfile?.binding.customerId,
    nessieAccountId: record.financialProfile?.binding.accountId,
  };
}

export function evaluateFinancialBinding(record: CaseRecord, intent: TransactionIntent): PolicyResult {
  const profile = record.financialProfile;
  const binding = profile?.binding;
  const checks: PolicyCheck[] = [];
  const reasonCodes: NessieReasonCode[] = [];
  const check = (code: NessieReasonCode, label: string, passed: boolean, detail: string) => {
    checks.push({ key: code, label, passed, detail });
    if (!passed) reasonCodes.push(code);
  };
  check("NESSIE_TENANT_MISMATCH", "Expected tenant", binding?.tenantId === record.ownerId
    && (intent.tenantId === undefined || intent.tenantId === record.ownerId), "The financial account must belong to the case's authorized tenant.");
  check("NESSIE_CASE_MISMATCH", "Account bound to case", binding?.caseId === record.id && intent.caseId === record.id,
    `Customer/account binding must match Case ${record.id}.`);
  check("NESSIE_CUSTOMER_MISMATCH", "Expected customer", !!binding?.customerId
    && (intent.nessieCustomerId === undefined || intent.nessieCustomerId === binding.customerId), "Untrusted instructions cannot replace the approved customer.");
  check("NESSIE_ACCOUNT_MISMATCH", "Expected account", !!binding?.accountId
    && (intent.nessieAccountId === undefined || intent.nessieAccountId === binding.accountId), "Untrusted instructions cannot replace the approved account. No settlement action is initiated by this check.");
  check(profile?.reasonCode ?? "NESSIE_VERIFICATION_REQUIRED", profile?.binding.source === "demo" ? "Demo fixture verified" : "Nessie account verified",
    profile?.status === "verified" && profile.customerVerified && profile.accountVerified,
    profile?.detail ?? "Customer and account verification is required before financial authorization.");
  check("NESSIE_OWNERSHIP_MISMATCH", "Customer owns account", profile?.ownershipVerified === true,
    "The account must belong to the expected Nessie customer.");
  check("NESSIE_VERIFICATION_STALE", "Verification is current", !!profile?.expiresAt && Date.parse(profile.expiresAt) > Date.now(),
    "Banking verification expires after 60 seconds and is refreshed before every financial action.");
  if (intent.network === "testnet") {
    check("NESSIE_LIVE_VERIFICATION_REQUIRED", "API-backed binding", binding?.source === "nessie", "A local fixture cannot authorize a testnet settlement.");
  }
  if (intent.transactionType === "EscrowCreate") {
    check("NESSIE_INSUFFICIENT_BALANCE", "Banking balance sufficient", Number.isSafeInteger(profile?.accountBalanceCents)
      && profile!.accountBalanceCents! >= intent.amountCents, "The verified sandbox bank balance must cover the proposed USD amount; it does not fund or convert to XRP.");
  }
  return { approved: checks.every((item) => item.passed), checks, reasonCodes: [...new Set(reasonCodes)] };
}

export function evaluatePolicy(record: CaseRecord, intent: TransactionIntent): PolicyResult {
  const finishing = intent.transactionType === "EscrowFinish";
  const checks: PolicyCheck[] = [];
  const check = (key: string, label: string, passed: boolean, detail: string) => checks.push({ key, label, passed, detail });
  // Additive safeguard for contract-gated tenant-only documentation cases. Legacy
  // cases have no case_type and therefore retain the bilateral policy unchanged.
  if (record.case_type === "self_documentation") {
    check("case", "Case matches", intent.caseId === record.id, `Only ${record.id} can authorize this action.`);
    check("type", "Transaction type allowed", false, "Self-documentation cases do not support escrow funding or fund release.");
    check("escrow", "Escrow matches", Boolean(record.escrow.id) && intent.escrowId === record.escrow.id, "The escrow must belong to this case.");
    check("destination", "No landlord destination", intent.destination === "" && record.escrow.destination === "", "Self-documentation cases never approve a landlord or tenant wallet destination.");
    check("amount", "Approved amount", Number.isSafeInteger(intent.amountCents) && intent.amountCents > 0
      && intent.amountCents === record.disputedAmountCents && intent.amountCents === record.escrow.amountCents,
    "The exact documented amount is required; amounts cannot be changed by an agent.");
    check("network", "Expected network", intent.network === "demo" && record.escrow.network === "demo", "Self-documentation cases are limited to simulated demo deposits.");
    check("state", "No escrow transfer state", record.escrow.status === "unfunded", "Self-documentation cases never authorize escrow transfers.");
    check("status", "Case is active", record.status !== "resolved", "A resolved case cannot authorize a new deposit.");
    return { approved: checks.every((item) => item.passed), checks };
  }
  check("case", "Case matches", intent.caseId === record.id, `Only ${record.id} can authorize this action.`);
  check("type", "Transaction type allowed", ["EscrowCreate", "EscrowFinish"].includes(intent.transactionType), "Only escrow creation and release are supported.");
  check("escrow", "Escrow matches", Boolean(record.escrow.id) && intent.escrowId === record.escrow.id, "The escrow must belong to this case.");
  check("destination", "Approved destination", Boolean(record.escrow.destination) && intent.destination === record.escrow.destination, "The destination must match the case's approved landlord wallet.");
  check("amount", "Approved amount", Number.isSafeInteger(intent.amountCents) && intent.amountCents > 0
    && intent.amountCents === record.disputedAmountCents && intent.amountCents === record.escrow.amountCents,
  "The exact approved amount is required; amounts cannot be changed by an agent.");
  check("network", "Expected network", intent.network === record.escrow.network && ["demo", "testnet"].includes(intent.network), "Mainnet and unexpected networks are not permitted.");
  check("state", finishing ? "Escrow is locked" : "Escrow is unfunded",
    finishing ? record.escrow.status === "locked" : record.escrow.status === "unfunded",
    "An escrow can only be funded once and released once.");
  check("status", finishing ? "Case is verified" : "Case is active",
    finishing ? (record.contractId ? record.status !== "resolved" : record.status === "verified") : record.status !== "resolved",
    finishing ? "The case must be verified before settlement." : "A resolved case cannot authorize new transactions.");
  if (record.contractId) {
    const agreement = record.contractSnapshot;
    check("contract", "Active signed agreement", agreement?.id === record.contractId && agreement.status === "active"
      && agreement.policyHash === record.contractEvaluation?.policyHash,
    "Financial authority comes from the immutable agreement accepted by both parties.");
    if (finishing) check("contract-policy", "Signed contract allows release", record.contractEvaluation?.allowed === true
      && record.contractEvaluation.action === "RELEASE_RENT", record.contractEvaluation?.reason ?? "Contract evaluation is required.");
  }
  if (finishing && (!record.contractId || record.contractDispute !== "none")) {
    const rules = record.contractSnapshot?.policy?.repairRules;
    const latestAfter = record.evidence.filter((item) => item.stage === "after").at(-1);
    check("repair", "Repair reported complete", rules?.repairReportedRequired === false || record.repairReported, "A repair completion report is required.");
    check("evidence", "Updated evidence analyzed", rules?.evidenceVerifiedRequired === false || latestAfter?.analysis?.verified === true, "The latest after-repair evidence must have a passing analysis.");
    check("verification", "Repair verification passed", rules?.evidenceVerifiedRequired === false || record.verification?.verified === true, "The current evidence comparison must pass.");
    check("confirmation", "Tenant confirmed resolution", rules?.tenantConfirmationRequired === false || record.tenantConfirmed, "Only the tenant can confirm the issue is resolved.");
    if (record.escrow.network === "testnet") {
      check("live-evidence", "Non-demo evidence verified", record.verification?.source === "gemini"
        && !!latestAfter && !latestAfter.isDemo && latestAfter.analysis?.source === "gemini" && latestAfter.analysis.verified,
      "Simulated evidence cannot authorize a testnet transaction.");
    }
  } else {
    check("balance", "Sufficient available balance", Number.isSafeInteger(record.accountBalanceCents)
      && record.accountBalanceCents >= intent.amountCents, "Available funds must cover the escrow amount.");
  }
  const financial = evaluateFinancialBinding(record, intent);
  checks.push(...financial.checks);
  return { approved: checks.every((item) => item.passed), checks, reasonCodes: financial.reasonCodes };
}

/** The requester names a case/action; trusted state supplies every payment field. */
export function makeXrplIntent(record: CaseRecord): XrplSettlementIntent {
  const settlement = record.xrplSettlement;
  return {
    caseId: record.id, ownerId: record.ownerId, escrowId: record.escrow.id,
    settlementId: settlement?.id ?? "", requestedAction: settlement?.contractId ? "RELEASE_RENT" : settlement?.agentId ? "REQUEST_SETTLEMENT" : "REQUEST_SETTLEMENT_REVIEW",
    transactionType: "Payment", network: settlement?.network ?? "testnet",
    source: settlement?.source ?? "", destination: settlement?.destination ?? "",
    amountDrops: settlement?.amountDrops ?? "0", amountUsdCents: record.disputedAmountCents,
    ...(settlement?.tenantUserId ? { tenantUserId: settlement.tenantUserId } : {}),
    ...(settlement?.landlordUserId ? { landlordUserId: settlement.landlordUserId } : {}),
    ...(settlement?.landlordWallet ? { landlordWallet: settlement.landlordWallet } : {}),
    // Append new fields after the historical intent shape so an old durable
    // journal remains byte-for-byte comparable during recovery.
    ...(settlement?.agentId ? { agentId: settlement.agentId } : {}),
    ...(settlement?.policyVersion ? { policyVersion: settlement.policyVersion } : {}),
    ...(settlement?.asset ? { asset: settlement.asset } : {}),
    ...(settlement?.amount ? { amount: settlement.amount } : {}),
    ...(settlement?.issuer ? { issuer: settlement.issuer } : {}),
    ...(settlement?.currency ? { currency: settlement.currency } : {}),
    ...(settlement?.contractId ? { contractId: settlement.contractId, contractPolicyVersion: settlement.contractPolicyVersion,
      policyHash: settlement.policyHash, triggeringEvent: settlement.triggeringEvent } : {}),
  };
}

export function evaluateXrplPolicy(record: CaseRecord, intent: XrplSettlementIntent, ownerId: string): PolicyResult {
  const settlement = record.xrplSettlement;
  // Reuse the application's repair/release rules while keeping USD and XRP distinct.
  const release = evaluatePolicy(record, makeIntent(record, "EscrowFinish"));
  const codes: Record<string, string> = {
    case: "WRONG_CASE", type: "ACTION_OUTSIDE_PERMISSION_SCOPE", escrow: "WRONG_ESCROW",
    destination: "DESTINATION_WALLET_MISMATCH", amount: "AMOUNT_OUTSIDE_AUTHORIZATION",
    network: "WRONG_NETWORK", state: "ESCROW_NOT_FUNDED", status: "REPAIR_NOT_VERIFIED",
    repair: "REPAIR_NOT_REPORTED", evidence: "REPAIR_NOT_VERIFIED",
    verification: "REPAIR_NOT_VERIFIED", confirmation: "TENANT_CONFIRMATION_REQUIRED",
  };
  const checks = release.checks.map((check) => ({ ...check, key: codes[check.key] ?? check.key }));
  const check = (key: string, label: string, passed: boolean, detail: string) => checks.push({ key, label, passed, detail });
  check("WRONG_CASE", "Case and authorization match", !!settlement && intent.caseId === record.id
    && settlement.caseId === record.id && settlement.escrowId === record.escrow.id
    && intent.escrowId === record.escrow.id && intent.settlementId === settlement.id,
  `This permission applies only to case ${record.id} and its bound settlement.`);
  check("TENANT_MISMATCH", "Authorized tenant", !!ownerId && ownerId === record.ownerId
    && intent.ownerId === ownerId && settlement?.ownerId === ownerId, "The session must own this case and settlement.");
  check("TENANT_MISMATCH", "Pinned tenant identity", !!settlement?.tenantUserId
    && settlement.tenantUserId === (record.tenantUserId ?? record.ownerId)
    && intent.tenantUserId === settlement.tenantUserId,
  "The authorized tenant identity cannot change after the payment is enabled.");
  check("LANDLORD_MISMATCH", "Pinned landlord identity", !!settlement?.landlordUserId
    && (!record.tenantUserId || !!record.landlordUserId)
    && settlement.landlordUserId === (record.landlordUserId ?? record.escrow.destination)
    && intent.landlordUserId === settlement.landlordUserId
    && !!settlement.landlordWallet && settlement.landlordWallet === record.escrow.destination
    && intent.landlordWallet === settlement.landlordWallet,
  "The assigned landlord and approved case beneficiary must match the pinned Testnet recipient authorization.");
  const isLegacyPermission = !settlement?.agentId;
  check("ACTION_OUTSIDE_PERMISSION_SCOPE", "Case settlement only",
    intent.requestedAction === (settlement?.contractId ? "RELEASE_RENT" : isLegacyPermission ? "REQUEST_SETTLEMENT_REVIEW" : "REQUEST_SETTLEMENT")
    && (isLegacyPermission ? settlement?.requestedAction === undefined : settlement?.requestedAction === (settlement?.contractId ? "RELEASE_RENT" : "REQUEST_SETTLEMENT"))
    && intent.transactionType === "Payment" && settlement?.transactionType === "Payment",
  "Only the bound RentEscrow Testnet settlement Payment is permitted.");
  check("AGENT_IDENTITY_MISMATCH", "Approved settlement agent", isLegacyPermission
    ? intent.agentId === undefined && settlement?.policyVersion === undefined && intent.policyVersion === undefined
    : settlement?.agentId === SETTLEMENT_AGENT_ID && intent.agentId === settlement.agentId,
  "Only the server-configured RentEscrow settlement agent may request this case action.");
  check("POLICY_VERSION_MISMATCH", "Approved settlement policy", isLegacyPermission
    ? intent.policyVersion === undefined
    : settlement?.policyVersion === SETTLEMENT_POLICY_VERSION && intent.policyVersion === settlement.policyVersion,
  "The settlement must use the server-approved deterministic policy version.");
  check("WRONG_NETWORK", "Testnet only", intent.network === "testnet" && settlement?.network === "testnet"
    && record.escrow.network === "demo", "Only XRPL Testnet settles on-chain; the application escrow remains simulated USD.");
  check("SOURCE_WALLET_MISMATCH", "Authorized tenant wallet", !!settlement?.source && intent.source === settlement.source,
    "The source must match the case's pinned tenant wallet.");
  check("DESTINATION_WALLET_MISMATCH", "Authorized landlord wallet", !!settlement?.destination
    && intent.destination === settlement.destination && intent.source !== intent.destination,
  `The destination must match the authorized counterparty for ${record.id}.`);
  const settlementAssetValid = !!settlement && (isLegacyPermission
    ? validAssetPermission({ amountDrops: settlement.amountDrops })
    : validAssetPermission(settlement));
  check("ASSET_NOT_APPROVED", "Approved settlement asset", settlementAssetValid
    && (intent.asset ?? "XRP") === (settlement?.asset ?? "XRP"),
  "Only the asset pinned in trusted case state is permitted for this settlement.");
  check("ASSET_DEFINITION_MISMATCH", "Trusted issuer and currency", !!settlement && settlementAssetValid
    && sameAssetPermission(intent, settlement),
  "The amount, currency, and issuer must exactly match the server-pinned asset definition.");
  check("AMOUNT_OUTSIDE_AUTHORIZATION", "Exact approved on-chain amount", !!settlement
    && settlementAssetValid && settlementAmount(intent) === settlementAmount(settlement)
    && intent.amountDrops === settlement.amountDrops && intent.amountUsdCents === settlement.amountUsdCents
    && intent.amountUsdCents === record.escrow.amountCents && intent.amountUsdCents === record.disputedAmountCents,
  "The configured Testnet asset amount and simulated USD business amount are separately authorized and cannot change.");
  check("SETTLEMENT_ALREADY_COMPLETED", "Not previously settled", settlement?.status !== "validated",
    "A validated settlement cannot execute again.");
  check("SETTLEMENT_PENDING", "No unresolved transaction", settlement?.status !== "pending" && !settlement?.hash,
    "Reconcile the recorded transaction hash before any new signing attempt.");
  check("REPAIR_NOT_VERIFIED", "Original evidence present", (Boolean(record.contractId) && (record.contractDispute === "none"
    || record.contractSnapshot?.policy?.repairRules.evidenceVerifiedRequired === false))
    || record.evidence.some((item) => item.stage === "before" && !!item.analysis),
    "Analyzed original evidence must be present along with the verified after-repair evidence.");
  check("CONTRACT_REQUIRED", "Signed financial authority", !record.tenantUserId || !!record.contractId,
    "Authenticated settlement requires an active bilateral agreement; per-payment approval cannot replace it.");
  if (record.contractId || settlement?.contractId) {
    const agreement = record.contractSnapshot;
    const authority = agreement?.policy?.settlement;
    check("CONTRACT_BINDING_MISMATCH", "Agreement and policy hash match", !!agreement && agreement.status === "active"
      && record.contractId === agreement.id && settlement?.contractId === agreement.id && intent.contractId === agreement.id
      && agreement.policyHash === settlement?.policyHash && intent.policyHash === agreement.policyHash
      && settlement?.contractPolicyVersion === agreement.policyVersion && intent.contractPolicyVersion === agreement.policyVersion
      && !!settlement?.triggeringEvent && intent.triggeringEvent === settlement.triggeringEvent,
      "Case, immutable signed policy hash and triggering event must match the approved permission.");
    check("CONTRACT_SETTLEMENT_MISMATCH", "Signed payment terms match", !!authority && intent.asset === authority.asset
      && intent.amount === authority.amountRlusd && intent.source === authority.source && intent.destination === authority.destination
      && intent.network === authority.network && intent.issuer === authority.issuer && intent.currency === authority.currency,
      "Only the asset, issuer, network, wallets and amount in the signed agreement can settle.");
  }
  for (const [field, value] of Object.entries(record.financialPolicyContext ?? {})) {
    check("FINANCIAL_CONTEXT_NOT_VERIFIED", `Trusted financial context: ${field}`, value === true,
      "A supplied tenant, customer, account binding, or financial readiness check must pass.");
  }
  return { approved: checks.every((item) => item.passed), checks };
}
