import { readFile } from "node:fs/promises";
import { expect, test, demoUsers, resetTenantWorkspace, signIn } from "./auth-fixtures";
import { origin } from "./environment";

test("email/password sessions are server-authorized and logout revokes the session", async ({ playwright, baseURL }) => {
  const request = await playwright.request.newContext({ baseURL });
  try {
    expect((await request.get("/api/dashboard")).status()).toBe(401);

    const rejected = await request.post("/api/auth/login", {
      headers: { Origin: origin },
      data: { email: demoUsers.tenant1.email, password: "incorrect-password" },
    });
    expect(rejected.status()).toBe(401);

    const login = await signIn(request, "tenant1");
    const body = await login.json();
    expect(body).toMatchObject({
      user: { email: demoUsers.tenant1.email, role: "tenant", displayName: "Rayaan" },
      redirectTo: "/tenant",
    });
    expect(body.user.id).toMatch(/^[a-f0-9]{24}$/);
    expect(JSON.stringify(body)).not.toContain("passwordHash");
    expect(JSON.stringify(body)).not.toContain(demoUsers.tenant1.password);

    expect((await request.get("/api/dashboard")).ok()).toBeTruthy();
    const logout = await request.post("/api/auth/logout", { headers: { Origin: origin } });
    expect(logout.ok(), await logout.text()).toBeTruthy();
    expect((await request.get("/api/dashboard")).status()).toBe(401);
  } finally {
    await request.dispose();
  }
});

test("login routes the property manager to a responsive landlord workspace", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/login");
    await page.getByRole("radio", { name: "Landlord", exact: true }).check();
    await page.locator("#login-email").fill(demoUsers.landlord.email);
    await page.locator("#login-password").fill(demoUsers.landlord.password);
    await page.locator("button[type=submit]").click();
    await expect(page).toHaveURL(/\/landlord$/);
    await expect(page.getByRole("navigation", { name: "Landlord workspace" })).toContainText("Repair Cases");
    await expect(page.getByText("RE-1042", { exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/landlord-desktop.png", fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("complementary", { name: "Property manager navigation" })).toBeHidden();
    await expect(page.getByText("RE-1042", { exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/landlord-mobile.png", fullPage: true, animations: "disabled" });
  } finally {
    await context.close();
  }
});

test("signing out clears the tenant workspace in every open tab", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    await signIn(context.request, "tenant1");
    const first = await context.newPage();
    const second = await context.newPage();
    await first.goto("/tenant");
    await second.goto("/tenant");
    await expect(first.getByRole("heading", { name: "No heat in apartment", exact: true })).toBeVisible();
    await expect(second.getByRole("heading", { name: "No heat in apartment", exact: true })).toBeVisible();
    await second.getByRole("button", { name: "Sign out", exact: true }).first().click();
    await expect(second).toHaveURL(/\/login$/);
    await expect(first).toHaveURL(/\/login$/);
    await expect(first.getByRole("heading", { name: "No heat in apartment", exact: true })).toHaveCount(0);
    expect((await context.request.get("/api/dashboard")).status()).toBe(401);
  } finally { await context.close(); }
});

test("tenant two cannot read or mutate tenant one's RE-1042 case", async ({ playwright, baseURL }) => {
  const tenantOne = await playwright.request.newContext({ baseURL });
  const tenantTwo = await playwright.request.newContext({ baseURL });
  try {
    await signIn(tenantOne, "tenant1");
    await resetTenantWorkspace(tenantOne);
    await signIn(tenantTwo, "tenant2");
    const dashboard = await tenantTwo.get("/api/dashboard");
    expect(dashboard.ok(), await dashboard.text()).toBeTruthy();
    expect((await dashboard.json()).cases.map((item: { id: string }) => item.id)).not.toContain("RE-1042");

    const action = await tenantTwo.post("/api/cases/RE-1042/actions", {
      headers: { Origin: origin }, data: { action: "confirm_resolution" },
    });
    expect(action.status()).toBe(403);
    const evidence = await tenantTwo.post("/api/cases/RE-1042/evidence", {
      headers: { Origin: origin }, multipart: { stage: "after", file: { name: "after.png", mimeType: "image/png", buffer: await readFile("public/evidence-after.png") } },
    });
    expect(evidence.status()).toBe(403);
    const tenantTwoCase = await tenantTwo.post("/api/cases", {
      headers: { Origin: origin }, data: {
        issue: "heating", description: "The radiator is not producing heat.", noticedAt: "2026-09-20",
        address: "456 Separate Street", borough: "Brooklyn", apartment: "2A", landlordName: "Another Manager", landlordContact: "manager@example.com",
        monthlyRentCents: 200_000, disputedAmountCents: 40_000,
      },
    });
    expect(tenantTwoCase.ok(), await tenantTwoCase.text()).toBeTruthy();
    const tenantTwoXrpl = await tenantTwo.post(`/api/cases/${(await tenantTwoCase.json()).case.id}/actions`, {
      headers: { Origin: origin }, data: { action: "enable_xrpl" },
    });
    expect(tenantTwoXrpl.status()).toBe(403);
    expect((await tenantTwoXrpl.json()).code).toBe("XRPL_ACCOUNT_NOT_AUTHORIZED");
  } finally {
    await tenantOne.dispose();
    await tenantTwo.dispose();
  }
});

test("a tenant cannot spoof property-manager schedule or completion actions", async ({ request }) => {
  const schedule = await request.post("/api/cases/RE-1042/actions", {
    headers: { Origin: origin }, data: { action: "simulate_landlord_reply", variant: "scheduled" },
  });
  expect(schedule.status()).toBe(403);
  expect((await schedule.json()).code).toBe("ROLE_NOT_ALLOWED");
  const completion = await request.post("/api/cases/RE-1042/actions", {
    headers: { Origin: origin }, data: { action: "record_landlord_reply", body: "The repair is complete." },
  });
  expect(completion.status()).toBe(403);
  expect((await completion.json()).code).toBe("ROLE_NOT_ALLOWED");
});

test("landlord views assigned redacted cases and cannot perform tenant actions", async ({ playwright, baseURL }) => {
  const landlord = await playwright.request.newContext({ baseURL });
  try {
    await signIn(landlord, "landlord");
    expect((await landlord.get("/api/dashboard")).status()).toBe(403);
    const cases = await landlord.get("/api/landlord/cases");
    expect(cases.ok(), await cases.text()).toBeTruthy();
    const body = await cases.json();
    expect(body.user).toMatchObject({ email: demoUsers.landlord.email, role: "landlord", displayName: "Alex Morgan" });
    expect(body.cases).toHaveLength(1);
    expect(body.cases[0].id).toBe("RE-1042");
    expect(JSON.stringify(body.cases[0])).not.toContain("accountBalanceCents");
    expect(JSON.stringify(body.cases[0])).not.toContain("dataUrl");

    const tenantAction = await landlord.post("/api/cases/RE-1042/actions", {
      headers: { Origin: origin }, data: { action: "confirm_resolution" },
    });
    expect(tenantAction.status()).toBe(403);
  } finally {
    await landlord.dispose();
  }
});

test("assigned landlord schedule and completion lead to a tenant-only verified confirmation", async ({ playwright, baseURL }) => {
  const tenant = await playwright.request.newContext({ baseURL });
  const landlord = await playwright.request.newContext({ baseURL });
  try {
    await signIn(tenant, "tenant1");
    await resetTenantWorkspace(tenant);
    await signIn(landlord, "landlord");

    const scheduledFor = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const schedule = await landlord.post("/api/landlord/cases/RE-1042/actions", {
      headers: { Origin: origin }, data: { action: "schedule", scheduledFor, notes: "Licensed technician booked for the boiler repair." },
    });
    expect(schedule.ok(), await schedule.text()).toBeTruthy();
    expect((await schedule.json()).case.repairs.at(-1)).toMatchObject({ kind: "scheduled", scheduledFor });

    const report = await landlord.post("/api/landlord/cases/RE-1042/actions", {
      headers: { Origin: origin }, data: { action: "report_complete", notes: "The boiler repair is complete; please verify the apartment temperature." },
    });
    expect(report.ok(), await report.text()).toBeTruthy();
    expect((await report.json()).case.repairReported).toBe(true);

    const tenantEvidence = await tenant.post("/api/cases/RE-1042/evidence", {
      headers: { Origin: origin },
      multipart: {
        stage: "after", note: "Tenant photo after the completed repair.", temperatureF: "72",
        file: { name: "tenant-after.png", mimeType: "image/png", buffer: await readFile("public/evidence-after.png") },
      },
    });
    expect(tenantEvidence.status(), await tenantEvidence.text()).toBe(201);
    const uploaded = (await tenantEvidence.json()).case.evidence.at(-1);
    expect(uploaded).toMatchObject({ name: "tenant-after.png", stage: "after", uploadedByRole: "tenant" });

    // The isolated runner deliberately has no Gemini key. Add explicit demo
    // evidence to validate the deterministic verification/confirmation branch.
    const sample = await tenant.post("/api/cases/RE-1042/actions", {
      headers: { Origin: origin }, data: { action: "add_demo_evidence", stage: "after" },
    });
    expect(sample.ok(), await sample.text()).toBeTruthy();
    const afterId = (await sample.json()).case.evidence.at(-1).id;
    const analyzed = await tenant.post("/api/cases/RE-1042/actions", {
      headers: { Origin: origin }, data: { action: "analyze_evidence", evidenceId: afterId },
    });
    expect(analyzed.ok(), await analyzed.text()).toBeTruthy();
    const verified = await tenant.post("/api/cases/RE-1042/actions", {
      headers: { Origin: origin }, data: { action: "verify_repair" },
    });
    expect(verified.ok(), await verified.text()).toBeTruthy();
    expect((await verified.json()).case.verification.verified).toBe(true);
    const confirmed = await tenant.post("/api/cases/RE-1042/actions", {
      headers: { Origin: origin }, data: { action: "confirm_resolution" },
    });
    expect(confirmed.ok(), await confirmed.text()).toBeTruthy();
    expect((await confirmed.json()).case.tenantConfirmed).toBe(true);
  } finally {
    await tenant.dispose();
    await landlord.dispose();
  }
});
