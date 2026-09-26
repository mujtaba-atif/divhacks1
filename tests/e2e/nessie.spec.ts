import { expect, test, type Page } from "@playwright/test";
import { createDemoCase } from "../../src/lib/seed";
import type { CaseAction, CaseRecord, FinancialProfile, PolicyResult } from "../../src/lib/types";

function fixtureProfile(record: CaseRecord): FinancialProfile {
  return {
    binding: { tenantId: record.ownerId, caseId: record.id, customerId: "customer_123", accountId: "account_456", source: "demo" },
    status: "verified", detail: "Explicit fixture customer and account verified for this case.",
    checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
    customerVerified: true, accountVerified: true, ownershipVerified: true, accountBalanceCents: 243000,
    transactions: [
      { id: "heater", label: "Space heater", amountCents: 4799, date: new Date().toISOString(), category: "supplies", source: "demo", relatedStatus: "suggested", suggestionReason: "Possibly related to loss of heat. Tenant confirmation is required." },
      { id: "hotel", label: "Temporary accommodation", amountCents: 11000, date: new Date().toISOString(), category: "accommodation", source: "demo", relatedStatus: "suggested" },
    ],
  };
}

async function mockWorkspace(page: Page, initialRecord: CaseRecord) {
  const record = structuredClone(initialRecord);
  const actions: CaseAction[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Never let these presentation tests reach Atlas, Nessie, or any other provider.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return route.abort();
    return route.continue();
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/dashboard" && route.request().method() === "GET") {
      return route.fulfill({ json: { cases: [record], integrations: [{ id: "nessie", name: "Capital One / Nessie", status: "demo", detail: "Intercepted browser fixture" }], mode: "demo" } });
    }
    if (url.pathname === `/api/cases/${record.id}/actions` && route.request().method() === "POST") {
      const action = route.request().postDataJSON() as CaseAction;
      actions.push(action);
      let policy: PolicyResult | undefined;
      if (action.action === "sync_finances") record.financialProfile = fixtureProfile(record);
      else if (action.action === "confirm_transaction" || action.action === "dismiss_transaction") {
        const transaction = record.financialProfile?.transactions.find((item) => item.id === action.transactionId);
        if (!transaction) return route.fulfill({ status: 404, json: { error: "Transaction not found" } });
        transaction.relatedStatus = action.action === "confirm_transaction" ? "confirmed" : "dismissed";
        if (transaction.relatedStatus === "confirmed" && !record.expenses.some((item) => item.transactionId === transaction.id)) {
          record.expenses.push({ id: `expense-${transaction.id}`, transactionId: transaction.id, label: transaction.label, amountCents: transaction.amountCents, category: transaction.category, source: transaction.source, date: transaction.date });
        }
      } else if (action.action === "check_financial_binding") {
        const approved = action.scenario === "valid";
        policy = { approved, reasonCodes: approved ? [] : ["NESSIE_ACCOUNT_MISMATCH"], checks: [{ key: "nessieAccount", label: "Case-bound customer/account", passed: approved, detail: approved ? "Authoritative customer_123 and account_456 match." : "Untrusted customer_attacker and account_bad were rejected." }] };
      } else return route.fulfill({ status: 400, json: { error: "This action is not available in the intercepted UI fixture." } });
      return route.fulfill({ json: { case: record, policy } });
    }
    return route.abort();
  });
  return { actions, pageErrors, record };
}

test("mocked Nessie profile requires confirmation and blocks substitution without settlement", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  const initial = createDemoCase("tenant_1042");
  delete initial.financialProfile;
  initial.expenses = [];
  initial.rentHistory = [initial.rentHistory[0], initial.rentHistory[2], initial.rentHistory[1]];
  const mock = await mockWorkspace(page, initial);
  await page.goto("/");
  await page.getByRole("tab", { name: "Finances", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Capital One / Nessie", exact: true })).toBeVisible();
  await expect(page.getByText("Verification required", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load financial profile", exact: true }).click();
  await expect(page.getByText("Binding verified", { exact: true })).toBeVisible();
  await expect(page.locator(".nessie-binding")).toContainText("customer_123");
  await expect(page.locator(".nessie-binding")).toContainText("account_456");
  await expect(page.getByTestId("nessie-bank-balance")).toHaveText("$2,430");
  await expect(page.getByTestId("simulation-balance")).toHaveText("$2,450");
  await expect(page.getByTestId("confirmed-issue-impact")).toHaveText("$0");
  await expect(page.locator(".nessie-finances table").first().locator("tbody tr td:first-child")).toHaveText(["August 2026", "September 2026", "October 2026"]);
  expect(mock.record.rentHistory.map((item) => item.month)).toEqual(["August 2026", "October 2026", "September 2026"]);
  await page.getByRole("button", { name: "Dismiss notification", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/nessie-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Confirm Space heater as issue-related", exact: true }).click();
  await expect(page.getByTestId("confirmed-issue-impact")).toHaveText("$47.99");
  await expect(page.getByText("Confirmed by tenant", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Dismiss Temporary accommodation", exact: true }).click();
  await expect(page.getByTestId("confirmed-issue-impact")).toHaveText("$47.99");
  await expect(page.getByText("Dismissed from issue impact", { exact: true })).toBeVisible();
  const escrowBefore = structuredClone(mock.record.escrow);
  await page.getByRole("button", { name: "Test account substitution", exact: true }).click();
  await expect(page.getByTestId("nessie-policy-result")).toContainText("Payment authorization blocked");
  await expect(page.getByTestId("nessie-policy-result")).toContainText("NESSIE_ACCOUNT_MISMATCH");
  await expect(page.getByTestId("nessie-policy-result")).toContainText("No settlement action initiated.");
  expect(mock.record.escrow).toEqual(escrowBefore);
  expect(mock.actions.at(-1)).toEqual({ action: "check_financial_binding", scenario: "substitution" });
  await page.getByRole("button", { name: "Dismiss notification", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/nessie-substitution-blocked.png", fullPage: true });
  await page.getByRole("button", { name: "Check financial binding", exact: true }).click();
  await expect(page.getByTestId("nessie-policy-result")).toContainText("Financial binding verified");
  await page.getByRole("tab", { name: "Escrow", exact: true }).click();
  await expect(page.getByTestId("nessie-policy-result")).toHaveCount(0);
  expect(mock.pageErrors).toEqual([]);
});

test("mocked Nessie verification expires visibly and cannot confirm stale transactions", async ({ page }) => {
  const record = createDemoCase("tenant_1042");
  record.financialProfile = fixtureProfile(record);
  record.financialProfile.expiresAt = new Date(Date.now() + 3_000).toISOString();
  const mock = await mockWorkspace(page, record);
  await page.goto("/");
  await page.getByRole("tab", { name: "Finances", exact: true }).click();
  await expect(page.getByText("Verification stale", { exact: true })).toBeVisible({ timeout: 7000 });
  await expect(page.getByText("Stale snapshot, not current authorization", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm Space heater as issue-related", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Dismiss Space heater", exact: true })).toBeDisabled();
  await expect(page.getByText("Historical snapshot", { exact: true })).toBeVisible();
  expect(mock.actions).toEqual([]);
  expect(mock.pageErrors).toEqual([]);
});

test("mocked unavailable banking clears current balance and labels historical records", async ({ page }) => {
  const record = createDemoCase("tenant_1042");
  record.financialProfile = { ...fixtureProfile(record), status: "unavailable", reasonCode: "NESSIE_API_UNAVAILABLE", detail: "The banking provider is unavailable. Existing records are retained for inspection.", customerVerified: false, accountVerified: false, ownershipVerified: false, accountBalanceCents: undefined };
  record.financialProfile.binding.source = "nessie";
  const mock = await mockWorkspace(page, record);
  await page.goto("/");
  await page.getByRole("tab", { name: "Finances", exact: true }).click();
  await expect(page.getByText("Verification unavailable", { exact: true })).toBeVisible();
  await expect(page.getByTestId("nessie-bank-balance")).toHaveText("Unavailable");
  await expect(page.getByText("NESSIE_API_UNAVAILABLE", { exact: true })).toBeVisible();
  await expect(page.getByText("Current banking context is unavailable. Previously recorded payments are shown below.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm Space heater as issue-related", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Dismiss Space heater", exact: true })).toBeDisabled();
  await expect(page.getByText("Binding verified", { exact: true })).toHaveCount(0);
  expect(mock.actions).toEqual([]);
  expect(mock.pageErrors).toEqual([]);
});

test("mocked Nessie workspace stays within mobile width with long binding identifiers", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const record = createDemoCase("tenant_" + "a".repeat(64));
  record.financialProfile = fixtureProfile(record);
  record.financialProfile.binding.accountId = "account_" + "b".repeat(64);
  record.financialProfile.transactions[1].providerStatus = "missing";
  record.financialProfile.transactions[1].reviewNote = "This transaction is no longer returned by the provider.";
  const mock = await mockWorkspace(page, record);
  await page.goto("/");
  await page.getByRole("tab", { name: "Finances", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Capital One / Nessie", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm Temporary accommodation as issue-related", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Dismiss Temporary accommodation", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Test account substitution", exact: true }).click();
  await expect(page.getByTestId("nessie-policy-result")).toContainText("Payment authorization blocked");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Dismiss notification", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/nessie-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(mock.pageErrors).toEqual([]);
});

test("mocked corrected and missing transactions retain explicit confirmed expense snapshots", async ({ page }) => {
  const record = createDemoCase("tenant_1042");
  record.financialProfile = fixtureProfile(record);
  const [heater, hotel] = record.financialProfile.transactions;
  record.expenses = [heater, hotel].map((item) => ({ id: `expense-${item.id}`, transactionId: item.id, label: item.label, amountCents: item.amountCents, category: item.category, source: item.source, date: item.date }));
  heater.relatedStatus = "confirmed";
  heater.providerStatus = "changed";
  heater.confirmedAmountCents = 4799;
  heater.amountCents = 4999;
  heater.reviewNote = "The provider corrected this purchase. The original confirmed expense remains unchanged.";
  hotel.relatedStatus = "confirmed";
  hotel.providerStatus = "missing";
  hotel.confirmedAmountCents = 11000;
  hotel.reviewNote = "This transaction was not returned by the provider. The confirmed expense is retained.";
  const mock = await mockWorkspace(page, record);
  await page.goto("/");
  await page.getByRole("tab", { name: "Finances", exact: true }).click();
  await expect(page.getByText("Provider transaction changed", { exact: true })).toBeVisible();
  await expect(page.getByText("Archived: no longer returned by provider", { exact: true })).toBeVisible();
  await expect(page.getByText("$47.99 remains in issue impact", { exact: true })).toBeVisible();
  await expect(page.getByText("$110 remains in issue impact", { exact: true })).toBeVisible();
  await expect(page.getByTestId("confirmed-issue-impact")).toHaveText("$157.99");
  await expect(page.getByRole("button", { name: "Confirm Space heater as issue-related", exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("region", { name: "Account transactions", exact: true }).screenshot({ path: "test-results/nessie-provider-snapshot.png" });
  expect(mock.actions).toEqual([]);
  expect(mock.pageErrors).toEqual([]);
});
