import type { CaseRecord, NessieReasonCode, PolicyCheck, PolicyResult, TransactionIntent, XrplSettlementIntent } from "./types";

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
    finishing ? record.status === "verified" : record.status !== "resolved",
    finishing ? "The case must be verified before settlement." : "A resolved case cannot authorize new transactions.");
  if (finishing) {
    const latestAfter = record.evidence.filter((item) => item.stage === "after").at(-1);
    check("repair", "Repair reported complete", record.repairReported, "A repair completion report is required.");
    check("evidence", "Updated evidence analyzed", latestAfter?.analysis?.verified === true, "The latest after-repair evidence must have a passing analysis.");
    check("verification", "Repair verification passed", record.verification?.verified === true, "The current evidence comparison must pass.");
    check("confirmation", "Tenant confirmed resolution", record.tenantConfirmed, "Only the tenant can confirm the issue is resolved.");
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
    settlementId: settlement?.id ?? "", requestedAction: "REQUEST_SETTLEMENT_REVIEW",
    transactionType: "Payment", network: settlement?.network ?? "testnet",
    source: settlement?.source ?? "", destination: settlement?.destination ?? "",
    amountDrops: settlement?.amountDrops ?? "0", amountUsdCents: record.disputedAmountCents,
    ...(settlement?.tenantUserId ? { tenantUserId: settlement.tenantUserId } : {}),
    ...(settlement?.landlordUserId ? { landlordUserId: settlement.landlordUserId } : {}),
    ...(settlement?.landlordWallet ? { landlordWallet: settlement.landlordWallet } : {}),
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
  check("ACTION_OUTSIDE_PERMISSION_SCOPE", "Settlement review only", intent.requestedAction === "REQUEST_SETTLEMENT_REVIEW"
    && intent.transactionType === "Payment" && settlement?.transactionType === "Payment",
  "Only the bound RentEscrow Testnet settlement Payment is permitted.");
  check("WRONG_NETWORK", "Testnet only", intent.network === "testnet" && settlement?.network === "testnet"
    && record.escrow.network === "demo", "Only Test XRP settles on-chain; the application escrow remains simulated USD.");
  check("SOURCE_WALLET_MISMATCH", "Authorized tenant wallet", !!settlement?.source && intent.source === settlement.source,
    "The source must match the case's pinned tenant wallet.");
  check("DESTINATION_WALLET_MISMATCH", "Authorized landlord wallet", !!settlement?.destination
    && intent.destination === settlement.destination && intent.source !== intent.destination,
  `The destination must match the authorized counterparty for ${record.id}.`);
  check("AMOUNT_OUTSIDE_AUTHORIZATION", "Exact approved Test XRP amount", !!settlement
    && /^[1-9]\d{0,8}$/.test(intent.amountDrops) && BigInt(intent.amountDrops) <= 100_000_000n
    && intent.amountDrops === settlement.amountDrops && intent.amountUsdCents === settlement.amountUsdCents
    && intent.amountUsdCents === record.escrow.amountCents && intent.amountUsdCents === record.disputedAmountCents,
  "The native Test XRP amount and simulated USD business amount are separately authorized and cannot change.");
  check("SETTLEMENT_ALREADY_COMPLETED", "Not previously settled", settlement?.status !== "validated",
    "A validated settlement cannot execute again.");
  check("SETTLEMENT_PENDING", "No unresolved transaction", settlement?.status !== "pending" && !settlement?.hash,
    "Reconcile the recorded transaction hash before any new signing attempt.");
  check("REPAIR_NOT_VERIFIED", "Original evidence present", record.evidence.some((item) => item.stage === "before" && !!item.analysis),
    "Analyzed original evidence must be present along with the verified after-repair evidence.");
  for (const [field, value] of Object.entries(record.financialPolicyContext ?? {})) {
    check("FINANCIAL_CONTEXT_NOT_VERIFIED", `Trusted financial context: ${field}`, value === true,
      "A supplied tenant, customer, account binding, or financial readiness check must pass.");
  }
  return { approved: checks.every((item) => item.passed), checks };
}
