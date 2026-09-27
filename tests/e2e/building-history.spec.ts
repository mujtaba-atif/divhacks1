import type { Page } from "@playwright/test";
import { expect, signIn, test } from "./auth-fixtures";

const tenantBuildingPath = "/api/cases/RE-1042/building";
const landlordBuildingPath = "/api/landlord/cases/RE-1042/building";

const publicBuildingKeys = [
  "address", "borough", "buildingId", "cache", "complaints", "datasets", "fetchedAt",
  "identifiers", "lookupStatus", "normalizedAddress", "source", "summary", "violations", "warning", "zip",
].sort();

const emptyBuilding = {
  address: "123 Example Street",
  borough: "Brooklyn",
  zip: "11201",
  source: "nyc-open-data",
  fetchedAt: "2026-09-26T12:00:00.000Z",
  lookupStatus: "not_found",
  datasets: { complaints: "ok", violations: "ok" },
  cache: { state: "fresh", expiresAt: "2026-09-26T12:15:00.000Z" },
  complaints: [],
  violations: [],
  summary: { recentComplaints: 0, openViolations: 0, heatingComplaints: 0, recentSince: "2026-03-26T12:00:00.000Z" },
};

const partialBuilding = {
  ...emptyBuilding,
  lookupStatus: "partial",
  datasets: { complaints: "ok", violations: "unavailable" },
  complaints: [{
    id: "HPD-100", category: "HEAT/HOT WATER", description: "Heat was not provided.",
    status: "OPEN", date: "2026-09-20T00:00:00.000Z",
  }],
  warning: "Violation records are temporarily unavailable.",
  summary: { recentComplaints: 1, openViolations: 0, heatingComplaints: 1, recentSince: "2026-03-26T12:00:00.000Z" },
};

function expectOnlyPublicBuildingFields(body: unknown) {
  expect(body).toBeTruthy();
  expect(Object.keys(body as Record<string, unknown>).every((key) => publicBuildingKeys.includes(key))).toBe(true);
  const privateKeys = new Set([
    "accountBalanceCents", "apartment", "dataUrl", "disputedAmountCents", "escrow", "expenses",
    "financialProfile", "monthlyRentCents", "ownerId", "rentHistory", "tenantDisplayName", "tenantUserId",
    "transaction", "wallet", "xrplSettlement",
  ]);
  const keys = new Set<string>();
  const collectKeys = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collectKeys); return; }
    for (const [key, child] of Object.entries(value)) { keys.add(key); collectKeys(child); }
  };
  collectKeys(body);
  expect([...keys].some((key) => privateKeys.has(key))).toBe(false);
}

async function openTenantHistory(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No heat in apartment", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View building history", exact: true }).first().click();
  return page.getByRole("dialog", { name: "Building history", exact: true });
}

async function openLandlordHistory(page: Page) {
  await page.goto("/landlord");
  await expect(page.getByRole("heading", { name: "Assigned repair cases", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View building history", exact: true }).first().click();
  return page.getByRole("dialog", { name: "Building history", exact: true });
}

test("tenant case building context is a deterministic public DEMO DATA record", async ({ request }) => {
  const response = await request.get(tenantBuildingPath);
  expect(response.ok(), await response.text()).toBeTruthy();
  const building = await response.json();

  expectOnlyPublicBuildingFields(building);
  expect(building).toMatchObject({
    address: "123 Example Street", borough: "Brooklyn", source: "demo", lookupStatus: "demo",
  });
  expect(["fresh", "cached"]).toContain(building.cache?.state);
  expect(building.complaints.filter((record: { category: string }) => record.category === "HEAT/HOT WATER")).toHaveLength(6);
  expect(building.violations).toHaveLength(2);
});

test("building context routes enforce authentication, case assignment, and role boundaries", async ({ playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL });
  const tenantTwo = await playwright.request.newContext({ baseURL });
  const landlord = await playwright.request.newContext({ baseURL });
  try {
    expect((await anonymous.get(tenantBuildingPath)).status()).toBe(401);
    expect((await anonymous.get(landlordBuildingPath)).status()).toBe(401);

    await signIn(tenantTwo, "tenant2");
    expect((await tenantTwo.get(tenantBuildingPath)).status()).toBe(403);
    expect((await tenantTwo.get(landlordBuildingPath)).status()).toBe(403);

    await signIn(landlord, "landlord");
    expect((await landlord.get(tenantBuildingPath)).status()).toBe(403);
    const assigned = await landlord.get(landlordBuildingPath);
    expect(assigned.ok(), await assigned.text()).toBeTruthy();
    expectOnlyPublicBuildingFields(await assigned.json());
  } finally {
    await Promise.all([anonymous.dispose(), tenantTwo.dispose(), landlord.dispose()]);
  }
});

test("tenant building history labels demo source, freshness, and heating matches", async ({ page }) => {
  let requested = false;
  await page.route(`**${tenantBuildingPath}`, (route) => {
    requested = true;
    return route.continue();
  });
  const dialog = await openTenantHistory(page);
  await expect(dialog.getByText("DEMO DATA", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Source: Demo fallback \(not live NYC data\)/)).toBeVisible();
  await expect(dialog.getByText(/Last refreshed/)).toBeVisible();
  await expect(dialog.getByText("HEAT/HOT WATER", { exact: true })).toHaveCount(6);
  expect(requested).toBe(true);
});

test("landlord history uses the assigned-case public endpoint", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  let requested = false;
  try {
    await signIn(context.request, "landlord");
    await page.route(`**${landlordBuildingPath}`, (route) => {
      requested = true;
      return route.continue();
    });
    const dialog = await openLandlordHistory(page);
    await expect(dialog.getByText(/Source:/)).toBeVisible();
    expect(requested).toBe(true);
  } finally {
    await context.close();
  }
});

test("building history distinguishes an empty public result", async ({ page }) => {
  await page.route(`**${tenantBuildingPath}`, (route) => route.fulfill({ json: emptyBuilding }));
  const dialog = await openTenantHistory(page);
  await expect(dialog.getByText("No recent public activity was returned for this building.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Dataset unavailable", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("No matching building", { exact: true })).toHaveCount(4);
});

test("building history discloses partial provider data instead of treating an empty collection as clear", async ({ page }) => {
  await page.route(`**${tenantBuildingPath}`, (route) => route.fulfill({ json: partialBuilding }));
  const dialog = await openTenantHistory(page);
  await expect(dialog.getByText("Partial data", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Some NYC housing datasets were unavailable, so these totals may be incomplete.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Dataset unavailable", { exact: true })).toBeVisible();
  await expect(dialog.getByText("HEAT/HOT WATER", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Counts cover returned records only/)).toBeVisible();
});

test("building history surfaces a route failure and allows a deterministic retry", async ({ page }) => {
  let attempts = 0;
  await page.route(`**${tenantBuildingPath}`, (route) => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({ status: 503, json: { error: "NYC building history could not be refreshed." } })
      : route.fulfill({ json: emptyBuilding });
  });
  const dialog = await openTenantHistory(page);
  await expect(dialog.getByText("NYC building history could not be refreshed.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(dialog.getByText("No recent public activity was returned for this building.", { exact: true })).toBeVisible();
  expect(attempts).toBe(2);
});
