import { expect, test } from "./auth-fixtures";
import type { Page } from "@playwright/test";
import { createDemoCase } from "../../src/lib/seed";
import type { AuditRecord, CaseAction, CaseRecord, DashboardData, IntegrationStatus, PolicyResult, XrplSettlement } from "../../src/lib/types";
import { RLUSD_CURRENCY, RLUSD_TESTNET_ISSUER, SETTLEMENT_AGENT_ID, SETTLEMENT_POLICY_VERSION } from "../../src/lib/xrpl-assets";
import { CONTRACT_POLICY_VERSION, type DigitalContract } from "../../src/lib/contract-types";

const tenant = "rTenantTestnet111111111111111111111";
const landlord = "rLandlordTestnet222222222222222222";
const attacker = "rAttackerTestnet999999999999999999";
const hash = "A7BFC5B975F8366F4B3A71D65A0A1E4F2A1D82AF4FAD0AF3863D46A4A209F996";
const policyHash = "b".repeat(64);

function governedAgreement(record: CaseRecord): DigitalContract {
  const createdAt = new Date().toISOString();
  return {
    id: "2bd595d3-c05a-47fb-b3ed-13a9c8586516", contractId: "2bd595d3-c05a-47fb-b3ed-13a9c8586516",
    case_type: "bilateral", terms: "Prototype governed settlement agreement.", termsHash: "a".repeat(64),
    tenantUserId: record.ownerId, landlordUserId: "landlord-fixture-user", tenantDisplayName: "Rayaan", landlordDisplayName: "Alex Morgan",
    propertyId: record.building.buildingId || record.building.address, effectiveDate: "2026-09-01",
    policyVersion: CONTRACT_POLICY_VERSION, policyHash, createdAt, status: "active",
    acceptances: [
      { role: "tenant", userId: record.ownerId, acceptedAt: createdAt, termsHash: "a".repeat(64), policyHash, method: "stored_acceptance" },
      { role: "landlord", userId: "landlord-fixture-user", acceptedAt: createdAt, termsHash: "a".repeat(64), policyHash, method: "stored_acceptance" },
    ],
    policy: {
      contractId: "2bd595d3-c05a-47fb-b3ed-13a9c8586516", policyVersion: CONTRACT_POLICY_VERSION,
      tenantUserId: record.ownerId, tenantDisplayName: "Rayaan", landlordUserId: "landlord-fixture-user", landlordDisplayName: "Alex Morgan",
      property: { id: record.building.buildingId || record.building.address, address: record.building.address, borough: record.building.borough },
      monthlyRentCents: 40_000, dueDay: 1, obligationPeriod: "2026-09", effectiveDate: "2026-09-01", gracePeriodDays: 3,
      disputedFunds: { mode: "HOLD_ALL", allowUndisputedRelease: false },
      repairRules: { repairReportedRequired: true, evidenceVerifiedRequired: true, tenantConfirmationRequired: true },
      lateFeeRule: { feeCents: 2_500, maxLateFeeCents: 2_500 }, monetaryDefault: { afterDays: 10, remedy: "RECORD_ONLY" },
      nonMonetaryDefault: { obligation: "REPAIR_BY_DEADLINE", deadlineDays: 30, remedy: "RECORD_ONLY" },
      settlement: { asset: "RLUSD", network: "testnet", source: tenant, destination: landlord, issuer: RLUSD_TESTNET_ISSUER,
        currency: RLUSD_CURRENCY, amountRlusd: "10", maxAutonomousAmountRlusd: "10" },
      agentId: SETTLEMENT_AGENT_ID,
    },
  };
}

function settlement(record: CaseRecord, status: XrplSettlement["status"], asset: "XRP" | "RLUSD" = "XRP"): XrplSettlement {
  return {
    id: `xrpl-${record.id}`,
    caseId: record.id,
    ownerId: record.ownerId,
    escrowId: record.escrow.id,
    network: "testnet",
    transactionType: "Payment",
    source: tenant,
    destination: landlord,
    agentId: SETTLEMENT_AGENT_ID,
    policyVersion: SETTLEMENT_POLICY_VERSION,
    requestedAction: "REQUEST_SETTLEMENT",
    asset,
    amount: "10",
    amountDrops: asset === "RLUSD" ? "0" : "10000000",
    currency: asset === "RLUSD" ? RLUSD_CURRENCY : "XRP",
    ...(asset === "RLUSD" ? { issuer: RLUSD_TESTNET_ISSUER } : {}),
    tenantUserId: record.ownerId,
    landlordUserId: "landlord-fixture-user",
    landlordWallet: landlord,
    amountUsdCents: record.disputedAmountCents,
    status,
    createdAt: new Date().toISOString(),
    ...(status !== "ready" ? { hash } : {}),
  };
}

async function mockXrpl(page: Page, initial: "unbound" | "ready" | "pending" | "failed", options: { integration?: IntegrationStatus; submissionFailure?: boolean; awaitingConfirmation?: boolean; asset?: "XRP" | "RLUSD"; contractBound?: boolean } = {}) {
  const actions: CaseAction[] = [];
  const base = createDemoCase("xrpl-browser-fixture");
  const now = new Date().toISOString();
  const after = { ...base.evidence[0], id: "evidence-after-xrpl", name: "After repair - 72F.png", stage: "after" as const, createdAt: now, analysis: { summary: "The repaired apartment is warm.", severity: "low" as const, temperatureF: 72, verified: true, reasons: ["Temperature recovered"], source: "demo" as const } };
  let current: CaseRecord = {
    ...base,
    status: "verified",
    repairReported: true,
    tenantConfirmed: !options.awaitingConfirmation,
    verification: after.analysis,
    evidence: [...base.evidence, after],
    escrow: { ...base.escrow, status: "locked", lockedAt: now, audit: [] },
  };
  if (initial !== "unbound") current.xrplSettlement = settlement(current, initial, options.asset);
  if (options.contractBound) {
    const contract = governedAgreement(current);
    current = { ...current, contractId: contract.id, contractSnapshot: contract, contractDispute: "open", contractTrigger: "dispute_opened",
      contractEvaluation: { allowed: false, action: "NONE", contractId: contract.id, policyVersion: CONTRACT_POLICY_VERSION, policyHash,
        reason: "ACTIVE_DISPUTE", amount: "10", asset: "RLUSD", evaluatedRules: [{ code: "ACTIVE_DISPUTE", passed: false, detail: "The signed HOLD_ALL rule keeps disputed funds held." }], effects: {} },
      xrplSettlement: current.xrplSettlement ? { ...current.xrplSettlement, contractId: contract.id, contractPolicyVersion: CONTRACT_POLICY_VERSION, policyHash } : undefined };
  }
  if (initial === "pending") {
    current.escrow.audit.push({ id: "uncertain-submission", action: "Payment", createdAt: now,
      status: "failed", network: "testnet", amountCents: 40000, amountDrops: "10000000",
      destination: landlord, hash, code: "XRPL_SUBMISSION_UNCERTAIN", signed: true, submitted: true,
      detail: "Submission may have reached Testnet. Reconcile the recorded hash." });
  }
  // Presentation fixtures never reach Atlas, XRPL, or another provider.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return route.abort();
    return route.continue();
  });
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/dashboard", async (route) => {
    const dashboard: DashboardData = { cases: [current], mode: "demo", integrations: [options.integration || { id: "xrpl", name: "XRPL Testnet", status: "configured", detail: "XRPL Testnet wallets configured." }] };
    await route.fulfill({ json: dashboard });
  });

  await page.route("**/api/cases/*/actions", async (route) => {
    const action = route.request().postDataJSON() as CaseAction;
    actions.push(action);
    let policy: PolicyResult | undefined;
    if (action.action === "enable_xrpl") current = { ...current, xrplSettlement: settlement(current, "ready", options.asset) };
    else if (action.action === "authorize_xrpl_agent") current = { ...current, xrplSettlement: { ...current.xrplSettlement!, agentAuthorizedAt: new Date().toISOString() } };
    else if (action.action === "policy_check") {
      policy = { approved: true, checks: [{ key: "network", label: "Demo network", passed: true, detail: "Simulated USD policy only." }] };
    } else if (action.action === "xrpl_security_demo" || action.action === "contract_security_demo") {
      const trusted = current.xrplSettlement!;
      const isIssuerAttack = action.scenario === "issuer_tamper";
      const isWrongAsset = action.scenario === "wrong_asset";
      const audit: AuditRecord = {
        id: `attack-${action.scenario}`,
        action: "Payment",
        createdAt: new Date().toISOString(),
        status: "rejected",
        network: "testnet",
        amountCents: 0,
        agentId: SETTLEMENT_AGENT_ID,
        policyVersion: SETTLEMENT_POLICY_VERSION,
        requestedAction: "REQUEST_SETTLEMENT",
        asset: isWrongAsset ? "XRP" : trusted.asset,
        amount: trusted.amount,
        amountDrops: isWrongAsset ? "10000000" : trusted.amountDrops,
        approvedAmount: trusted.amount,
        approvedAmountDrops: trusted.amountDrops,
        currency: isIssuerAttack ? "USD" : isWrongAsset ? "XRP" : trusted.currency,
        issuer: isIssuerAttack ? attacker : trusted.issuer,
        source: tenant,
        destination: action.scenario === "wallet_switch" ? attacker : landlord,
        code: action.scenario === "wallet_switch" ? "DESTINATION_WALLET_MISMATCH" : isIssuerAttack ? "ASSET_DEFINITION_MISMATCH" : isWrongAsset ? "ASSET_NOT_APPROVED" : action.scenario === "excess_fee" ? "FEE_EXCEEDS_CONTRACT_POLICY" : action.scenario === "mutate_terms" ? "CONTRACT_HASH_MISMATCH" : "ACTION_OUTSIDE_PERMISSION_SCOPE",
        detail: action.scenario === "wallet_switch" ? "Destination wallet does not match the authorized counterparty for this case." : isIssuerAttack ? "The attempted issuer and currency do not match the trusted Testnet RLUSD definition." : isWrongAsset ? "The attempted asset does not match the case-bound settlement asset." : "The request is outside this case's permission scope.",
        signed: false,
        submitted: false,
      };
      current = { ...current, escrow: { ...current.escrow, audit: [...current.escrow.audit, audit] } };
      policy = { approved: false, checks: [{ key: audit.code!, label: "Authorized recipient", passed: false, detail: audit.detail }] };
    } else if (action.action === "settle_xrpl" || action.action === "reconcile_xrpl" || action.action === "confirm_resolution") {
      if (action.action === "settle_xrpl" && options.submissionFailure) {
        current = { ...current, xrplSettlement: { ...settlement(current, "failed", options.asset), errorCode: "XRPL_SUBMISSION_UNCERTAIN", detail: "Reconcile the recorded transaction hash before another payment." } };
        return route.fulfill({ status: 409, json: { error: current.xrplSettlement!.detail, code: "XRPL_SUBMISSION_UNCERTAIN", case: current } });
      }
      const validated = { ...settlement(current, "validated", options.asset), agentAuthorizedAt: current.xrplSettlement?.agentAuthorizedAt,
        ...(action.action === "confirm_resolution" ? { agentRequestedAt: new Date().toISOString() } : {}),
        transactionHash: hash, validatedResult: "tesSUCCESS", ledgerIndex: 9_876_543, result: "tesSUCCESS", validatedAt: new Date().toISOString(),
        policyDecision: { approved: true, checks: [{ key: "XRPL_SPENDABLE_BALANCE", label: "Sufficient balance", passed: true, detail: "Validated balances cover the payment and fee." }, { key: "ASSET_MATCH", label: "Asset approved", passed: true, detail: "The asset matches trusted case state." }] } };
      const receipt: AuditRecord = { id: "payment-validated", action: "Payment", createdAt: new Date().toISOString(), timestamp: new Date().toISOString(), status: "validated", network: "testnet", amountCents: 0, amount: validated.amount, amountDrops: validated.amountDrops, approvedAmount: validated.amount, approvedAmountDrops: validated.amountDrops, asset: validated.asset, currency: validated.currency, issuer: validated.issuer, agentId: SETTLEMENT_AGENT_ID, policyVersion: SETTLEMENT_POLICY_VERSION, requestedAction: "REQUEST_SETTLEMENT", source: tenant, destination: landlord, hash, transactionHash: hash, ledgerIndex: validated.ledgerIndex, result: "tesSUCCESS", validatedResult: "tesSUCCESS", validated: true, policyDecision: validated.policyDecision, detail: "Payment validated on XRPL Testnet." };
      current = { ...current, tenantConfirmed: true, status: "resolved", xrplSettlement: validated, escrow: { ...current.escrow, status: "released", releasedAt: new Date().toISOString(), audit: [...current.escrow.audit, receipt] } };
      policy = { approved: true, checks: [{ key: "DESTINATION_MATCH", label: "Recipient", passed: true, detail: "The recipient matches trusted case state." }] };
    } else return route.fulfill({ status: 400, json: { error: `Unexpected action: ${action.action}` } });
    await route.fulfill({ status: 200, json: { case: current, policy } });
  });
  return { actions };
}

test("agent authorization reviews exact permission, then tenant confirmation triggers settlement without a payment request", async ({ page }) => {
  const { actions } = await mockXrpl(page, "ready", { awaitingConfirmation: true });
  await page.goto("/tenant?case=RE-1042");
  await page.getByRole("tab", { name: "Escrow", exact: true }).click();
  await page.getByRole("button", { name: "Review agent authorization", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Authorize XRPL settlement agent" });
  await expect(review.getByText("10 Test XRP", { exact: true })).toBeVisible();
  await expect(review.getByText(landlord, { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Authorize agent settlement", exact: true }).click();
  await expect(page.getByText("Agent settlement authorized", { exact: true })).toBeVisible();
  await expect(page.getByText("Settlement complete", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Confirm repair is complete", exact: true }).click();
  await expect(page.getByText("Settlement complete", { exact: true })).toBeVisible();
  await expect(page.getByText("Agent requested settlement", { exact: true })).toBeVisible();
  expect(actions).toEqual([{ action: "authorize_xrpl_agent" }, { action: "confirm_resolution" }]);
});

test("RLUSD settlement shows trusted identity, blocks definition replacement, and records autonomous delivery", async ({ page }) => {
  const { actions } = await mockXrpl(page, "ready", { awaitingConfirmation: true, asset: "RLUSD" });
  await page.goto("/tenant?case=RE-1042");
  await page.getByRole("tab", { name: "Escrow", exact: true }).click();

  await expect(page.getByText("$400", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("10 Testnet RLUSD", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(SETTLEMENT_AGENT_ID, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(SETTLEMENT_POLICY_VERSION, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("RLUSD", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("XRPL Testnet / Payment", { exact: true })).toBeVisible();
  const policyChecks = page.getByRole("region", { name: "Settlement policy checks" });
  await expect(policyChecks.getByText("✓ Recipient approved", { exact: true })).toBeVisible();
  await expect(policyChecks.getByText("✓ Amount within limit", { exact: true })).toBeVisible();
  await expect(policyChecks.getByText("✓ Asset approved", { exact: true })).toBeVisible();
  await expect(policyChecks.getByText("Pending · Sufficient balance — Checked at execution immediately before signing", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Replace issuer / currency", exact: true }).click();
  const blocked = page.locator(".security-result");
  await expect(blocked.getByText("BLOCKED BEFORE SIGNING", { exact: true })).toBeVisible();
  await expect(blocked.getByText("Nothing signed. Nothing submitted.", { exact: true })).toBeVisible();
  await expect(blocked.getByText("Approved definition", { exact: true })).toBeVisible();
  await expect(blocked.getByText("Attempted definition", { exact: true })).toBeVisible();
  await expect(blocked).toContainText(RLUSD_TESTNET_ISSUER);
  await expect(blocked).toContainText(attacker);

  await page.getByRole("button", { name: "Review agent authorization", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Authorize XRPL settlement agent" });
  await expect(review.getByText("10 Testnet RLUSD", { exact: true })).toBeVisible();
  await expect(review.getByText(RLUSD_TESTNET_ISSUER, { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Authorize agent settlement", exact: true }).click();
  await page.getByRole("button", { name: "Confirm repair is complete", exact: true }).click();

  await expect(page.getByText("Settlement complete", { exact: true })).toBeVisible();
  await expect(page.getByText(/tesSUCCESS · Ledger 9876543 · 10 Testnet RLUSD delivered/)).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(hash) }).first()).toHaveAttribute("href", `https://testnet.xrpl.org/transactions/${hash}`);
  expect(actions).toEqual([{ action: "xrpl_security_demo", scenario: "issuer_tamper" }, { action: "authorize_xrpl_agent" }, { action: "confirm_resolution" }]);
});

test("signed agreement governs RLUSD settlement without a per-payment approval", async ({ page }) => {
  const { actions } = await mockXrpl(page, "ready", { awaitingConfirmation: true, asset: "RLUSD", contractBound: true });
  await page.goto("/tenant?case=RE-1042");
  await page.getByRole("tab", { name: "Escrow", exact: true }).click();

  const authority = page.getByRole("region", { name: "Signed agreement authority" });
  await expect(authority.getByText(/Authorized under RentEscrow Agreement/)).toBeVisible();
  await expect(authority.getByText("AUTHORITY ACTIVE", { exact: true })).toBeVisible();
  await expect(authority.getByText(policyHash, { exact: true })).toBeVisible();
  await expect(authority.getByText("BLOCKED · ACTIVE_DISPUTE", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review agent authorization" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Review .* payment/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm repair is complete" })).toBeVisible();
  for (const label of ["Change recipient", "Exceed amount cap", "Change RLUSD issuer", "Wrong network", "Prompt injection",
    "Insufficient funds", "Wrong case", "Wrong asset", "Replay settlement", "Fee above maximum", "Unsupported action", "Mutate active terms"]) {
    await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
  }

  await page.getByRole("button", { name: "Fee above maximum" }).click();
  const blocked = page.locator(".security-result");
  await expect(blocked.getByText("BLOCKED BEFORE SIGNING", { exact: true })).toBeVisible();
  await expect(blocked.getByText("FEE_EXCEEDS_CONTRACT_POLICY", { exact: true })).toBeVisible();
  await expect(blocked.getByText("Nothing signed. Nothing submitted.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Confirm repair is complete" }).click();
  await expect(page.getByText("Settlement complete", { exact: true })).toBeVisible();
  expect(actions).toEqual([
    { action: "contract_security_demo", scenario: "excess_fee" },
    { action: "confirm_resolution" },
  ]);
});

test("case-bound Testnet settlement requires review and exposes the validated receipt", async ({ page }) => {
  await mockXrpl(page, "unbound");
  await page.goto("/tenant?case=RE-1042");
  await page.getByRole("tab", { name: "Escrow", exact: true }).click();

  await page.getByRole("button", { name: "Enable Testnet settlement", exact: true }).click();
  await expect(page.getByText("10 Test XRP", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(tenant, { exact: true })).toBeVisible();
  await expect(page.getByText(landlord, { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Wallet switch", exact: true }).click();
  await expect(page.getByText("DESTINATION_WALLET_MISMATCH", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Nothing signed. Nothing submitted.", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(attacker, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Review 10 Test XRP payment", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review XRPL Testnet settlement" });
  await expect(review.getByText("10 Test XRP", { exact: true })).toBeVisible();
  await expect(review.getByText(landlord, { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Approve Testnet payment", exact: true }).click();

  await expect(page.getByText("Settlement complete", { exact: true })).toBeVisible();
  await expect(page.getByText(/tesSUCCESS · Ledger 9876543/)).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(hash) }).first()).toHaveAttribute("href", `https://testnet.xrpl.org/transactions/${hash}`);
});

test("a pending signed payment stays unsettled until reconciliation validates it", async ({ page }) => {
  await mockXrpl(page, "pending");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tenant?case=RE-1042");
  await page.getByRole("tab", { name: "Escrow", exact: true }).click();
  await expect(page.getByText("Validation outcome pending", { exact: true })).toBeVisible();
  await expect(page.getByText("Nothing signed. Nothing submitted.", { exact: true })).toHaveCount(0);
  await expect(page.locator(".security-result")).toHaveCount(0);
  await expect(page.getByText("Repair resolved. Case complete.", { exact: true })).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "Reconcile ledger result", exact: true }).click();
  await expect(page.getByText("Settlement complete", { exact: true })).toBeVisible();
  await expect(page.getByText("Repair resolved. Case complete.", { exact: true })).toBeVisible();
});

test("unavailable settlement exposes the server reason and keeps simulated release available", async ({ page }) => {
  const detail = "MongoDB is selected but its server connection is missing. Configure storage before enabling settlement.";
  const mock = await mockXrpl(page, "unbound", { integration: { id: "xrpl", name: "XRPL Testnet", status: "unavailable", detail } });
  await page.goto("/tenant?case=RE-1042");
  await page.getByRole("tab", { name: "Escrow", exact: true }).click();
  await expect(page.getByText("Testnet settlement is unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText(detail, { exact: true })).toBeVisible();
  await expect(page.getByText("Testnet wallets are not configured", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enable Testnet settlement", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review & release $400", exact: true })).toBeEnabled();
  expect(mock.actions).toEqual([]);
});

test("legacy policy checks are explicitly scoped to simulated USD", async ({ page }) => {
  const mock = await mockXrpl(page, "unbound");
  await page.goto("/tenant?case=RE-1042");
  await page.getByRole("tab", { name: "Escrow", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Simulation guardrails", exact: true })).toBeVisible();
  await expect(page.getByText("Simulated USD only. These checks do not authorize an XRPL payment.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Check release policy", exact: true }).click();
  await expect(page.getByRole("region", { name: "Latest action policy result" }).getByText("All policy checks passed", { exact: true })).toBeVisible();
  expect(mock.actions).toEqual([expect.objectContaining({ action: "policy_check", intent: expect.objectContaining({ transactionType: "EscrowFinish", network: "demo" }) })]);
});

test("a failed settlement with a recorded hash permits reconciliation but not fresh approval", async ({ page }) => {
  const mock = await mockXrpl(page, "failed");
  await page.goto("/tenant?case=RE-1042");
  await page.getByRole("tab", { name: "Escrow", exact: true }).click();
  await expect(page.getByText("Settlement not completed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review Testnet settlement", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reconcile ledger result", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Approve Testnet payment", exact: true })).toHaveCount(0);
  expect(mock.actions).toEqual([]);
});

test("an uncertain submission disables repeat approval in the open review dialog", async ({ page }) => {
  const mock = await mockXrpl(page, "ready", { submissionFailure: true });
  await page.goto("/tenant?case=RE-1042");
  await page.getByRole("tab", { name: "Escrow", exact: true }).click();
  await page.getByRole("button", { name: "Review 10 Test XRP payment", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review XRPL Testnet settlement" });
  await review.getByRole("button", { name: "Approve Testnet payment", exact: true }).click();
  await expect(review.getByRole("alert")).toContainText("XRPL_SUBMISSION_UNCERTAIN");
  await expect(review.getByRole("button", { name: "Approve Testnet payment", exact: true })).toBeDisabled();
  expect(mock.actions.filter((action) => action.action === "settle_xrpl")).toHaveLength(1);
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review Testnet settlement", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reconcile ledger result", exact: true })).toBeEnabled();
});
