import { expect, test } from "@playwright/test";
import { demoUsers } from "./auth-fixtures";
import { origin } from "./environment";

// Route/auth verification without launching a browser.
test("tenant contracts entry preserves authentication, tenant ownership, and the selected navigation", async ({ playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL });
  try {
    const response = await anonymous.get("/tenant?view=contracts", { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(response.headers().location).toBe("/login");
  } finally { await anonymous.dispose(); }

  for (const role of ["tenant", "landlord"] as const) {
    const context = await playwright.request.newContext({ baseURL });
    const credentials = role === "tenant" ? demoUsers.tenant1 : demoUsers.landlord;
    try {
      const login = await context.post("/api/auth/login", {
        headers: { Origin: origin },
        data: { email: credentials.email, password: credentials.password, expectedRole: role },
      });
      expect(login.ok()).toBeTruthy();
      const response = await context.get("/tenant?view=contracts", { maxRedirects: 0 });
      if (role === "landlord") {
        expect(response.status()).toBe(307);
        expect(response.headers().location).toBe("/landlord");
      } else {
        expect(response.status()).toBe(200);
        const html = await response.text();
        expect(html).toMatch(/class="tenant-contracts-nav active" aria-current="page"/);
        expect(html).toContain('aria-label="Breadcrumb"><span>Tenant</span>');
        expect(html).toContain('aria-current="page">Contracts</strong>');
        const agreements = await context.get("/api/contracts");
        expect(agreements.ok()).toBeTruthy();
        expect(await agreements.json()).toHaveProperty("contracts");
      }
    } finally { await context.dispose(); }
  }
});
