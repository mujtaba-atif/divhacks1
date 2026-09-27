import { expect, signIn, test } from "./auth-fixtures";
import type { Page } from "@playwright/test";
import type { DigitalContract } from "../../src/lib/contract-types";
import { CONTRACT_AGENT_ID, CONTRACT_POLICY_VERSION } from "../../src/lib/contract-types";
import { RLUSD_CURRENCY, RLUSD_TESTNET_ISSUER } from "../../src/lib/xrpl-assets";
import { origin } from "./environment";

const contractId = "2bd595d3-c05a-47fb-b3ed-13a9c8586516";
const termsHash = "a".repeat(64);
const policyHash = "b".repeat(64);
const landlordId = "landlord-fixture-user";

function agreement(tenantId: string, status: "draft" | "active" = "draft", assignedLandlordId = landlordId): DigitalContract {
  const now = "2026-09-27T12:00:00.000Z";
  return {
    id: contractId, contractId, case_type: "bilateral", status,
    terms: "RentEscrow prototype bilateral rent and repair settlement agreement.", termsHash,
    tenantUserId: tenantId, landlordUserId: assignedLandlordId, tenantDisplayName: "Rayaan", landlordDisplayName: "Alex Morgan",
    propertyId: "property-fixture", effectiveDate: "2026-09-01", policyVersion: CONTRACT_POLICY_VERSION, policyHash, createdAt: now,
    acceptances: status === "active" ? [
      { role: "tenant", userId: tenantId, acceptedAt: now, termsHash, policyHash, method: "stored_acceptance" },
      { role: "landlord", userId: assignedLandlordId, acceptedAt: now, termsHash, policyHash, method: "stored_acceptance" },
    ] : [],
    policy: {
      contractId, policyVersion: CONTRACT_POLICY_VERSION,
      tenantUserId: tenantId, tenantDisplayName: "Rayaan", landlordUserId: assignedLandlordId, landlordDisplayName: "Alex Morgan",
      property: { id: "property-fixture", address: "123 Example Street", borough: "Brooklyn" },
      monthlyRentCents: 40_000, dueDay: 1, obligationPeriod: "2026-09", effectiveDate: "2026-09-01", gracePeriodDays: 3,
      disputedFunds: { mode: "HOLD_ALL", allowUndisputedRelease: false },
      repairRules: { repairReportedRequired: true, evidenceVerifiedRequired: true, tenantConfirmationRequired: true },
      lateFeeRule: { feeCents: 2_500, maxLateFeeCents: 2_500 },
      monetaryDefault: { afterDays: 10, remedy: "RECORD_ONLY" },
      nonMonetaryDefault: { obligation: "REPAIR_BY_DEADLINE", deadlineDays: 30, remedy: "RECORD_ONLY" },
      settlement: { asset: "RLUSD", network: "testnet", source: "rSource111", destination: "rLandlord222",
        issuer: RLUSD_TESTNET_ISSUER, currency: RLUSD_CURRENCY, amountRlusd: "10", maxAutonomousAmountRlusd: "10" },
      agentId: CONTRACT_AGENT_ID,
    },
  };
}

async function mockAgreements(page: Page, initial: DigitalContract) {
  let current = initial;
  const acceptedBodies: unknown[] = [];
  const caseBodies: unknown[] = [];
  const repairBodies: unknown[] = [];
  await page.route("**/api/contracts", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { contracts: [current] } });
    return route.fulfill({ status: 400, json: { error: "Unexpected create request." } });
  });
  await page.route(`**/api/contracts/${contractId}/accept`, async (route) => {
    const body = route.request().postDataJSON();
    acceptedBodies.push(body);
    current = { ...current, acceptances: [{ role: "tenant", userId: current.tenantUserId, acceptedAt: new Date().toISOString(), termsHash, policyHash, method: "stored_acceptance" }], status: "draft" };
    await route.fulfill({ json: { contract: current } });
  });
  await page.route("**/api/contracts/cases", async (route) => {
    caseBodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { case: { id: "RE-CONTRACT-DEMO" } } });
  });
  await page.route(`**/api/contracts/${contractId}/preview`, async (route) => {
    const decision = (allowed: boolean, action: "RELEASE_RENT" | "RECORD_LATE_PAYMENT" | "RECORD_MONETARY_DEFAULT" | "NONE", reason: string) => ({
      allowed, action, contractId, policyVersion: CONTRACT_POLICY_VERSION, policyHash, reason, amount: "10", asset: "RLUSD" as const,
      evaluatedRules: [{ code: reason, passed: allowed, detail: "Deterministic simulated contract-policy result." }], effects: {},
    });
    await route.fulfill({ json: { simulated: true, warning: "Read-only policy previews. Nothing signed. Nothing submitted.", previews: [
      { scenario: "normal_due_date", label: "Normal due date", decision: decision(true, "RELEASE_RENT", "CONTRACT_AUTHORIZED") },
      { scenario: "active_dispute", label: "Active dispute", decision: decision(false, "NONE", "ACTIVE_DISPUTE") },
      { scenario: "grace_period_expired", label: "Grace period expired", decision: decision(true, "RECORD_LATE_PAYMENT", "LATE_PAYMENT") },
      { scenario: "monetary_default", label: "Monetary default threshold", decision: decision(true, "RECORD_MONETARY_DEFAULT", "MONETARY_DEFAULT") },
    ] } });
  });
  await page.route("**/api/landlord/cases/*/actions", async (route) => {
    repairBodies.push(route.request().postDataJSON());
    await route.fulfill({ json: { case: { id: current.caseId } } });
  });
  return { acceptedBodies, caseBodies, repairBodies };
}

test("authenticated tenant signs the exact reviewed policy version and authority stays inactive until landlord signs", async ({ page }) => {
  const session = await page.request.get("/api/auth/me");
  const tenantId = (await session.json()).user.id as string;
  const mock = await mockAgreements(page, agreement(tenantId, "draft"));
  await page.goto("/agreements");

  const panel = page.getByRole("article");
  await expect(panel.getByRole("heading", { name: "RentEscrow Agreement" })).toBeVisible();
  await expect(panel.getByText("Rayaan", { exact: true })).toBeVisible();
  await expect(panel.getByText("Alex Morgan", { exact: true })).toBeVisible();
  await expect(panel.getByText("10 Testnet RLUSD", { exact: true })).toBeVisible();
  await expect(panel.getByText(policyHash, { exact: true })).toBeVisible();
  await expect(panel.getByText("Agent Authority").locator("..")).toContainText("INACTIVE");

  await page.getByRole("button", { name: "Accept and sign as tenant" }).click();
  await expect(page.getByText("Your signature is recorded", { exact: true })).toBeVisible();
  await expect(page.getByText("Awaiting acceptance", { exact: true })).toBeVisible();
  expect(mock.acceptedBodies).toEqual([{ role: "tenant", termsHash, policyHash }]);
});

test("active bilateral agreement exposes scoped authority and creates a server-derived dispute event", async ({ page }) => {
  const session = await page.request.get("/api/auth/me");
  const tenantId = (await session.json()).user.id as string;
  const mock = await mockAgreements(page, agreement(tenantId, "active"));
  await page.goto("/agreements");

  await expect(page.getByText("ACTIVE", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Scoped delegated authority is active", { exact: true })).toBeVisible();
  await expect(page.getByText("Accepted by authenticated account", { exact: true })).toHaveCount(2);
  await expect(page.getByText("contract-configured demo policy", { exact: false })).toBeVisible();
  await expect(page.getByText("SIMULATED POLICY PREVIEW", { exact: true })).toBeVisible();
  await expect(page.getByText("Normal due date", { exact: true })).toBeVisible();
  await expect(page.getByText("Active dispute", { exact: true })).toBeVisible();
  await expect(page.getByText("Grace period expired", { exact: true })).toBeVisible();
  await expect(page.getByText("Due date", { exact: true }).locator("..")).toContainText("Sep 1, 2026");
  await expect(page.getByRole("button", { name: "Create new agreement", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Authorize agent settlement|Approve Testnet payment/ })).toHaveCount(0);

  const created = page.waitForRequest((request) => request.url().endsWith("/api/contracts/cases") && request.method() === "POST");
  await page.getByRole("button", { name: "Create disputed case" }).click();
  await created;
  expect(mock.caseBodies).toEqual([{ contractId, mode: "dispute" }]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("assigned landlord reports repair completion as a factual event without payment fields", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context.request, "landlord");
  const session = await context.request.get("/api/auth/me");
  const landlordUserId = (await session.json()).user.id as string;
  const page = await context.newPage();
  const active = { ...agreement("tenant-fixture", "active", landlordUserId), caseId: "RE-CONTRACT-DEMO" };
  const mock = await mockAgreements(page, active);

  await page.goto("/agreements");
  await expect(page.getByText("Agent Authority").locator("..")).toContainText("ACTIVE");
  await expect(page.getByRole("button", { name: "Create new agreement", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Report agreed repair complete" }).click();
  await expect(page.getByText("Repair completion recorded as a factual contract event. No payment was approved by this action.", { exact: true })).toBeVisible();
  expect(mock.repairBodies).toEqual([{
    action: "report_complete",
    notes: "The property manager reports that the contract-governed demo repair is complete.",
  }]);
  await context.close();
});

test("registration remains unavailable and authenticated roles cannot be claimed by the frontend", async ({ request }) => {
  const registration = await request.post("/api/auth/register", {
    headers: { Origin: origin }, data: { role: "tenant", displayName: "Taylor Tenant", walletAddress: "rTENANT789" },
  });
  expect(registration.status()).toBe(404);

  const roleEscalation = await request.post(`/api/contracts/${contractId}/accept`, {
    headers: { Origin: origin }, data: { role: "landlord", termsHash, policyHash },
  });
  expect(roleEscalation.status()).toBe(403);
});
