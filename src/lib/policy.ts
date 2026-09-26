import type { CaseRecord, NessieReasonCode, PolicyCheck, PolicyResult, TransactionIntent } from "./types";

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
