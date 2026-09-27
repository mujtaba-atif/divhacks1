import { expect, test } from "./auth-fixtures";
import type { Page } from "@playwright/test";
import type { DigitalContract } from "../../src/lib/contract-types";
import { CONTRACT_AGENT_ID, CONTRACT_POLICY_VERSION } from "../../src/lib/contract-types";
import { RLUSD_CURRENCY, RLUSD_TESTNET_ISSUER } from "../../src/lib/xrpl-assets";

const contractId = "tenant-contract-fixture";
const termsHash = "c".repeat(64);
const policyHash = "d".repeat(64);

function tenantAgreement(tenantId: string): DigitalContract {
  const createdAt = "2026-09-27T12:00:00.000Z";
  return {
    id: contractId,
    contractId,
    case_type: "bilateral",
    status: "draft",
    terms: "RentEscrow prototype bilateral rent and repair settlement agreement.",
    termsHash,
    tenantUserId: tenantId,
    landlordUserId: "landlord-fixture-user",
    tenantDisplayName: "Rayaan",
    landlordDisplayName: "Alex Morgan",
    propertyId: "property-fixture",
    effectiveDate: "2026-09-01",
    policyVersion: CONTRACT_POLICY_VERSION,
    policyHash,
    createdAt,
    acceptances: [],
    policy: {
      contractId,
      policyVersion: CONTRACT_POLICY_VERSION,
      tenantUserId: tenantId,
      tenantDisplayName: "Rayaan",
      landlordUserId: "landlord-fixture-user",
      landlordDisplayName: "Alex Morgan",
      property: { id: "property-fixture", address: "123 Example Street", borough: "Brooklyn" },
      monthlyRentCents: 185_000,
      dueDay: 1,
      obligationPeriod: "2026-09",
      effectiveDate: "2026-09-01",
      gracePeriodDays: 3,
      disputedFunds: { mode: "HOLD_ALL", allowUndisputedRelease: false },
      repairRules: { repairReportedRequired: true, evidenceVerifiedRequired: true, tenantConfirmationRequired: true },
      lateFeeRule: { feeCents: 2_500, maxLateFeeCents: 2_500 },
      monetaryDefault: { afterDays: 10, remedy: "RECORD_ONLY" },
      nonMonetaryDefault: { obligation: "REPAIR_BY_DEADLINE", deadlineDays: 30, remedy: "RECORD_ONLY" },
      settlement: {
        asset: "RLUSD",
        network: "testnet",
        source: "rSource111",
        destination: "rLandlord222",
        issuer: RLUSD_TESTNET_ISSUER,
        currency: RLUSD_CURRENCY,
        amountRlusd: "400",
        maxAutonomousAmountRlusd: "400",
      },
      agentId: CONTRACT_AGENT_ID,
    },
  };
}

async function mockTenantContracts(page: Page, initial: DigitalContract) {
  let current = initial;
  const acceptedBodies: unknown[] = [];
  await page.route("**/api/contracts", async (route) => {
    await route.fulfill({ json: { contracts: [current] } });
  });
  await page.route(`**/api/contracts/${contractId}/accept`, async (route) => {
    acceptedBodies.push(route.request().postDataJSON());
    current = {
      ...current,
      status: "draft",
      acceptances: [{
        role: "tenant",
        userId: current.tenantUserId,
        acceptedAt: "2026-09-27T13:00:00.000Z",
        termsHash,
        policyHash,
        method: "stored_acceptance",
      }],
    };
    await route.fulfill({ json: { contract: current } });
  });
  return { acceptedBodies };
}

test("tenant opens Contracts from the workspace and browser history restores the view", async ({ page }) => {
  const session = await page.request.get("/api/auth/me");
  const tenantId = (await session.json()).user.id as string;
  await mockTenantContracts(page, tenantAgreement(tenantId));

  await page.goto("/tenant");
  const workspaceNavigation = page.locator('aside[aria-label="Workspace navigation"]');
  await workspaceNavigation.getByRole("button", { name: "Contracts", exact: true }).click();
  await expect(page).toHaveURL(/\/tenant\?view=contracts$/);
  await expect(page.getByRole("heading", { name: "Contracts", exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Contracts", exact: true })).toBeVisible();
  await workspaceNavigation.getByRole("button", { name: "My cases", exact: true }).click();
  await expect(page).toHaveURL(/\/tenant$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/tenant\?view=contracts$/);
  await expect(page.getByRole("heading", { name: "Contracts", exact: true })).toBeVisible();
});

test("tenant confirmation gates signing and submits the exact reviewed hashes", async ({ page }) => {
  const session = await page.request.get("/api/auth/me");
  const tenantId = (await session.json()).user.id as string;
  const mock = await mockTenantContracts(page, tenantAgreement(tenantId));
  await page.goto("/tenant?view=contracts");

  await page.getByRole("button", { name: "Sign contract", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review and sign contract" });
  await expect(dialog.getByText(termsHash, { exact: true })).toBeVisible();
  await expect(dialog.getByText(policyHash, { exact: true })).toBeVisible();
  const confirm = dialog.getByRole("checkbox");
  const sign = dialog.getByRole("button", { name: "Accept and sign as tenant", exact: true });
  await expect(sign).toBeDisabled();
  await confirm.check();
  await expect(sign).toBeEnabled();
  await sign.click();

  await expect(dialog).not.toBeVisible();
  const signerSummary = page.getByRole("complementary", { name: "Contract summary and signers" });
  await expect(signerSummary.getByRole("article").filter({ hasText: "Rayaan" }).getByText("Signed", { exact: true })).toBeVisible();
  await expect(signerSummary.getByRole("article").filter({ hasText: "Alex Morgan" }).getByText("Awaiting signature", { exact: true })).toBeVisible();
  expect(mock.acceptedBodies).toEqual([{ role: "tenant", termsHash, policyHash }]);
});

test("tenant can retry a failed contracts load", async ({ page }) => {
  const session = await page.request.get("/api/auth/me");
  const tenantId = (await session.json()).user.id as string;
  let recover = false;
  await page.route("**/api/contracts", async (route) => {
    if (!recover) {
      await route.fulfill({ status: 503, json: { error: "Contract records are temporarily unavailable." } });
      return;
    }
    await route.fulfill({ json: { contracts: [tenantAgreement(tenantId)] } });
  });

  await page.goto("/tenant?view=contracts");
  await expect(page.getByRole("alert")).toContainText("Contract records are temporarily unavailable.");
  recover = true;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("article").filter({ hasText: "123 Example Street" })).toBeVisible();
});

test("tenant contracts remain within the mobile viewport", async ({ page }) => {
  const session = await page.request.get("/api/auth/me");
  const tenantId = (await session.json()).user.id as string;
  await mockTenantContracts(page, tenantAgreement(tenantId));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tenant?view=contracts");

  await expect(page.getByRole("heading", { name: "Contracts", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
