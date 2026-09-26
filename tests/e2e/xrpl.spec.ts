import { expect, test, type Page } from "@playwright/test";
import type { AuditRecord, CaseAction, CaseRecord, DashboardData, PolicyResult, XrplSettlement } from "../../src/lib/types";

const tenant = "rTenantTestnet111111111111111111111";
const landlord = "rLandlordTestnet222222222222222222";
const attacker = "rAttackerTestnet999999999999999999";
const hash = "A7BFC5B975F8366F4B3A71D65A0A1E4F2A1D82AF4FAD0AF3863D46A4A209F996";

function settlement(record: CaseRecord, status: XrplSettlement["status"]): XrplSettlement {
  return {
    id: `xrpl-${record.id}`,
    caseId: record.id,
    ownerId: record.ownerId,
    escrowId: record.escrow.id,
    network: "testnet",
    transactionType: "Payment",
    source: tenant,
    destination: landlord,
    amountDrops: "10000000",
    amountUsdCents: record.disputedAmountCents,
    status,
    createdAt: new Date().toISOString(),
    ...(status !== "ready" ? { hash } : {}),
  };
}

async function mockXrpl(page: Page, initial: "unbound" | "pending") {
  let current: CaseRecord | undefined;

  await page.route("**/api/dashboard", async (route) => {
    const response = await route.fetch();
    const dashboard = await response.json() as DashboardData;
    const base = structuredClone(dashboard.cases[0]);
    const now = new Date().toISOString();
    const after = { ...base.evidence[0], id: "evidence-after-xrpl", name: "After repair - 72F.png", stage: "after" as const, createdAt: now, analysis: { summary: "The repaired apartment is warm.", severity: "low" as const, temperatureF: 72, verified: true, reasons: ["Temperature recovered"], source: "demo" as const } };
    current = {
      ...base,
      status: "verified",
      repairReported: true,
      tenantConfirmed: true,
      verification: after.analysis,
      evidence: [...base.evidence, after],
      escrow: { ...base.escrow, status: "locked", lockedAt: now, audit: [] },
    };
    if (initial === "pending") {
      current.xrplSettlement = settlement(current, "pending");
      current.escrow.audit.push({ id: "uncertain-submission", action: "Payment", createdAt: now,
        status: "failed", network: "testnet", amountCents: 40000, amountDrops: "10000000",
        destination: landlord, hash, code: "XRPL_SUBMISSION_UNCERTAIN", signed: true, submitted: true,
        detail: "Submission may have reached Testnet. Reconcile the recorded hash." });
    }
    dashboard.cases = [current];
    const xrpl = dashboard.integrations.find((item) => item.id === "xrpl");
    if (xrpl) Object.assign(xrpl, { status: "configured", detail: "XRPL Testnet wallets configured." });
    else dashboard.integrations.push({ id: "xrpl", name: "XRPL Testnet", status: "configured", detail: "XRPL Testnet wallets configured." });
    await route.fulfill({ response, json: dashboard });
  });

  await page.route("**/api/cases/*/actions", async (route) => {
    if (!current) return route.fulfill({ status: 500, json: { error: "Fixture did not initialize." } });
    const action = route.request().postDataJSON() as CaseAction;
    let policy: PolicyResult | undefined;
    if (action.action === "enable_xrpl") current = { ...current, xrplSettlement: settlement(current, "ready") };
    else if (action.action === "xrpl_security_demo") {
      const audit: AuditRecord = {
        id: `attack-${action.scenario}`,
        action: "Payment",
        createdAt: new Date().toISOString(),
        status: "rejected",
        network: "testnet",
        amountCents: 0,
        amountDrops: "10000000",
        approvedAmountDrops: "10000000",
        source: tenant,
        destination: action.scenario === "wallet_switch" ? attacker : landlord,
        code: action.scenario === "wallet_switch" ? "DESTINATION_WALLET_MISMATCH" : "ACTION_OUTSIDE_PERMISSION_SCOPE",
        detail: action.scenario === "wallet_switch" ? "Destination wallet does not match the authorized counterparty for this case." : "The request is outside this case's permission scope.",
        signed: false,
        submitted: false,
      };
      current = { ...current, escrow: { ...current.escrow, audit: [...current.escrow.audit, audit] } };
      policy = { approved: false, checks: [{ key: audit.code!, label: "Authorized recipient", passed: false, detail: audit.detail }] };
    } else if (action.action === "settle_xrpl" || action.action === "reconcile_xrpl") {
      const validated = { ...settlement(current, "validated"), ledgerIndex: 9_876_543, result: "tesSUCCESS", validatedAt: new Date().toISOString() };
      const receipt: AuditRecord = { id: "payment-validated", action: "Payment", createdAt: new Date().toISOString(), status: "validated", network: "testnet", amountCents: 0, amountDrops: validated.amountDrops, approvedAmountDrops: validated.amountDrops, source: tenant, destination: landlord, hash, ledgerIndex: validated.ledgerIndex, result: "tesSUCCESS", validated: true, detail: "Payment validated on XRPL Testnet." };
      current = { ...current, status: "resolved", xrplSettlement: validated, escrow: { ...current.escrow, status: "released", releasedAt: new Date().toISOString(), audit: [...current.escrow.audit, receipt] } };
      policy = { approved: true, checks: [{ key: "DESTINATION_MATCH", label: "Recipient", passed: true, detail: "The recipient matches trusted case state." }] };
    } else return route.fulfill({ status: 400, json: { error: `Unexpected action: ${action.action}` } });
    await route.fulfill({ status: 200, json: { case: current, policy } });
  });
}

test("case-bound Testnet settlement requires review and exposes the validated receipt", async ({ page }) => {
  await mockXrpl(page, "unbound");
  await page.goto("/");
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
  await page.goto("/");
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
