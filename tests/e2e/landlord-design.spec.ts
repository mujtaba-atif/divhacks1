import { expect, test, resetTenantWorkspace, signIn } from "./auth-fixtures";
import type { DigitalContract } from "../../src/lib/contract-types";

test("landlord design navigation, filters, evidence, and case notes use assigned records", async ({ browser, baseURL, request }) => {
  await resetTenantWorkspace(request);
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1024 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await signIn(context.request, "landlord");
    await page.goto("/landlord");
    const nav = page.getByRole("navigation", { name: "Landlord workspace" });
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Repair work queue" })).toBeVisible();
    await expect(page.getByRole("button", { name: "RE-1042", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("landlord-design-overview.png"), fullPage: true });

    await nav.getByRole("button", { name: "Repair Cases", exact: true }).click();
    await page.getByPlaceholder("Search case, issue, tenant, or unit").fill("does not exist");
    await expect(page.getByText("No cases match these filters.")).toBeVisible();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(page.getByRole("button", { name: "RE-1042", exact: true })).toBeVisible();
    await page.getByLabel("Status", { exact: true }).selectOption("Resolved");
    await expect(page.getByText("No cases match these filters.")).toBeVisible();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await page.getByRole("button", { name: "Save view" }).click();
    await expect(page.getByRole("button", { name: "View saved" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("landlord-design-cases.png"), fullPage: true });
    await page.getByRole("button", { name: "Open case RE-1042" }).click();
    await page.getByRole("tab", { name: "Evidence", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Tenant-submitted evidence" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("landlord-design-evidence.png"), fullPage: true });
    await page.getByRole("button", { name: "Choose files" }).click();
    await expect(page.getByRole("dialog", { name: "Upload repair evidence" })).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();

    await page.getByRole("button", { name: "Acknowledge request" }).click();
    await expect(page.getByRole("tab", { name: "Conversation" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Case message", { exact: true })).toHaveValue(/received your repair request/);
    await page.getByLabel("Case message", { exact: true }).fill("Landlord UI verification: reviewing the reported repair.");
    await nav.getByRole("button", { name: "Account", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Account & Access" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit profile" })).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath("landlord-design-account.png"), fullPage: true });
    await nav.getByRole("button", { name: "Messages", exact: true }).click();
    await expect(page.getByLabel("Case message", { exact: true })).toHaveValue("Landlord UI verification: reviewing the reported repair.");
    await page.getByRole("button", { name: "Add case message", exact: true }).click();
    await expect(page.getByLabel("Case message", { exact: true })).toHaveValue("");
    await expect(page.getByText("Landlord UI verification: reviewing the reported repair.", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("landlord-design-conversation.png"), fullPage: true });

    await page.getByRole("tab", { name: "Activity & completion" }).click();
    await expect(page.getByRole("heading", { name: "Schedule maintenance" })).toBeVisible();
    await page.getByRole("tab", { name: "Escrow & timeline" }).click();
    await expect(page.getByRole("heading", { name: "Escrow summary" })).toBeVisible();
    await nav.getByRole("button", { name: "Properties", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Properties", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Invite tenant" })).toBeDisabled();
    await page.getByPlaceholder("Search property, unit, tenant, or case").fill("not assigned");
    await expect(page.getByRole("button", { name: "Open case", exact: true })).toHaveCount(0);
    await page.getByPlaceholder("Search property, unit, tenant, or case").fill("");
    await page.screenshot({ path: test.info().outputPath("landlord-design-properties.png"), fullPage: true });
    await expect(page.getByRole("button", { name: "Open case", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test("landlord layouts work on mobile and role guards preserve the tenant workspace", async ({ browser, baseURL, request }) => {
  await resetTenantWorkspace(request);
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto("/landlord");
    await expect(page).toHaveURL(/\/login$/);
    await signIn(context.request, "tenant1");
    await page.goto("/landlord");
    await expect(page).toHaveURL(/\/tenant$/);
    await expect(page.getByRole("navigation", { name: "Landlord workspace" })).toHaveCount(0);
    await signIn(context.request, "landlord");
    await page.goto("/tenant");
    await expect(page).toHaveURL(/\/landlord$/);
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Property manager navigation" })).toBeHidden();
    const nav = page.getByRole("navigation", { name: "Landlord workspace" });
    for (const name of ["Properties", "Repair Cases", "Messages", "Account", "Contracts", "Overview"]) {
      await page.getByRole("button", { name: "Open workspace navigation" }).click();
      await expect(nav).toBeVisible();
      await nav.getByRole("button", { name, exact: true }).click();
      await expect(nav).toBeHidden();
      const overflow = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, elements: [...document.querySelectorAll("body *")].filter((node) => { const rect = node.getBoundingClientRect(); return rect.width && rect.right > window.innerWidth + 1 && getComputedStyle(node).visibility !== "hidden" && !node.closest(".ld-table-scroll"); }).map((node) => ({ className: node.className, right: node.getBoundingClientRect().right })) }));
      expect(overflow.scrollWidth <= overflow.width, `${name}: ${JSON.stringify(overflow)}`).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`landlord-mobile-${name.toLowerCase().replaceAll(" ", "-")}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "Open workspace navigation" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open workspace navigation" })).toBeFocused();
    await page.getByRole("button", { name: "Open workspace navigation" }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
  } finally { await context.close(); }
});

test("resolved landlord conversations stay read only", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  try {
    await signIn(context.request, "landlord");
    const response = await context.request.get("/api/landlord/cases");
    const payload = await response.json();
    expect(payload.cases.length).toBeGreaterThan(0);
    await page.route("**/api/landlord/cases", (route) => route.fulfill({ json: { ...payload, cases: payload.cases.map((record: object) => ({ ...record, status: "resolved" })) } }));
    await page.goto("/landlord");
    await page.getByRole("navigation", { name: "Landlord workspace" }).getByRole("button", { name: "Messages", exact: true }).click();
    await expect(page.getByText("This resolved case is read only.")).toBeVisible();
    await expect(page.getByLabel("Case message", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add case message", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Schedule access", exact: true })).toBeDisabled();
  } finally { await context.close(); }
});

test("landlord contract design reviews the exact version before submitting acceptance", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1024 } });
  const page = await context.newPage();
  try {
    const session = await signIn(context.request, "landlord");
    const landlord = (await session.json()).user;
    let contract: DigitalContract = { id: "landlord-ui-agreement", case_type: "bilateral", status: "draft", terms: "UI test agreement. Review the repair terms before signing.", termsHash: "a".repeat(64), policyHash: "b".repeat(64), tenantUserId: "tenant-ui-fixture", tenantDisplayName: "Mujtaba Atif", landlordUserId: landlord.id, landlordDisplayName: landlord.displayName, createdAt: "2026-09-27T12:00:00.000Z", acceptances: [] };
    const accepted: unknown[] = [];
    await page.route("**/api/contracts", (route) => route.fulfill({ json: { contracts: [contract] } }));
    await page.route("**/api/contracts/landlord-ui-agreement/accept", async (route) => {
      accepted.push(route.request().postDataJSON());
      contract = { ...contract, acceptances: [{ role: "landlord", userId: landlord.id, acceptedAt: new Date().toISOString(), termsHash: contract.termsHash, policyHash: contract.policyHash, method: "stored_acceptance" }] };
      await route.fulfill({ json: { contract } });
    });
    await page.goto("/landlord");
    await page.getByRole("navigation", { name: "Landlord workspace" }).getByRole("button", { name: "Contracts", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Contracts", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Replace PDF unavailable/ })).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath("landlord-design-contracts.png"), fullPage: true });
    await page.getByRole("button", { name: "Sign contract", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Review and sign contract" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("UI test agreement. Review the repair terms before signing.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Accept and sign as landlord" })).toBeDisabled();
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Accept and sign as landlord" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: /Landlord signed:/ })).toBeDisabled();
    expect(accepted).toEqual([{ role: "landlord", termsHash: contract.termsHash, policyHash: contract.policyHash }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("landlord-mobile-contracts-populated.png"), fullPage: true });
  } finally { await context.close(); }
});
