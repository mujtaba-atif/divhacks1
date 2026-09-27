import { test as base, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { origin } from "./environment";

export const demoUsers = {
  tenant1: { email: "tenant1@rentescrow.demo", password: "TenantDemo123!", role: "tenant" },
  tenant2: { email: "tenant2@rentescrow.demo", password: "TenantDemo123!", role: "tenant" },
  landlord: { email: "landlord@rentescrow.demo", password: "LandlordDemo123!", role: "landlord" },
} as const;

export type DemoUser = keyof typeof demoUsers;

export async function signIn(request: APIRequestContext, user: DemoUser) {
  const credentials = demoUsers[user];
  const response = await request.post("/api/auth/login", {
    headers: { Origin: origin },
    data: { email: credentials.email, password: credentials.password },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response;
}

export async function resetTenantWorkspace(request: APIRequestContext) {
  const response = await request.post("/api/demo/reset", { headers: { Origin: origin } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function tenantContext(browserContext: BrowserContext) {
  await signIn(browserContext.request, "tenant1");
  await resetTenantWorkspace(browserContext.request);
}

/**
 * Tenant 1 is authenticated and reset before each test. The reset route only
 * reaches the disposable MongoDB started by `scripts/e2e-server.ts`.
 */
export const test = base.extend({
  context: async ({ browser, baseURL }, use) => {
    const context = await browser.newContext({ baseURL });
    await tenantContext(context);
    await use(context);
    await context.close();
  },
  request: async ({ playwright, baseURL }, use) => {
    const request = await playwright.request.newContext({ baseURL });
    await signIn(request, "tenant1");
    await resetTenantWorkspace(request);
    await use(request);
    await request.dispose();
  },
});

export { expect };
