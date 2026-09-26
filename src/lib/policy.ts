import type { CaseRecord, PolicyCheck, PolicyResult, TransactionIntent } from "./types";

export function makeIntent(record: CaseRecord, transactionType: string): TransactionIntent {
  return {
    caseId: record.id, escrowId: record.escrow.id, transactionType,
    destination: record.escrow.destination, amountCents: record.disputedAmountCents,
    network: record.escrow.network,
  };
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
  return { approved: checks.every((item) => item.passed), checks };
}
