import { test, expect, signIn } from "./auth-fixtures";
import { origin } from "./environment";
import type { APIRequest } from "@playwright/test";

const caseId = "RE-1042";
const forbiddenFinancialMarkers = /customerId|accountId|accountBalanceCents|financialProfile|rentHistory|transactions|NESSIE/i;

async function asUser(playwright: { request: APIRequest }, user: "landlord" | "tenant2") {
  const request = await playwright.request.newContext({ baseURL: origin });
  await signIn(request, user);
  return request;
}

test("private Nessie finance endpoint denies landlord, other tenant, and unauthenticated callers", async ({ playwright }) => {
  const landlord = await asUser(playwright, "landlord");
  const otherTenant = await asUser(playwright, "tenant2");
  const anonymous = await playwright.request.newContext({ baseURL: origin });
  try {
    for (const request of [landlord, otherTenant, anonymous]) {
      const response = await request.get(`/api/cases/${caseId}/finances`);
      expect(response.ok()).toBeFalsy();
      expect([401, 403, 404]).toContain(response.status());
      expect(await response.text()).not.toMatch(forbiddenFinancialMarkers);
    }

    const landlordCases = await landlord.get("/api/landlord/cases");
    expect(landlordCases.ok()).toBeTruthy();
    expect(await landlordCases.text()).not.toMatch(forbiddenFinancialMarkers);
  } finally {
    await Promise.all([landlord.dispose(), otherTenant.dispose(), anonymous.dispose()]);
  }
});

test("tenant action requests reject frontend attempts to substitute Nessie identities", async ({ request }) => {
  for (const data of [
    { action: "sync_finances", tenantId: "tenant-attacker" },
    { action: "sync_finances", customerId: "customer-attacker" },
    { action: "sync_finances", nessieCustomerId: "customer-attacker" },
    { action: "sync_finances", accountId: "account-attacker" },
    { action: "sync_finances", nessieAccountId: "account-attacker" },
    { action: "create_escrow", nessieAccountId: "account-attacker" },
  ]) {
    const response = await request.post(`/api/cases/${caseId}/actions`, { headers: { Origin: origin }, data });
    expect(response.status(), await response.text()).toBe(400);
  }
});

test("landlord and other tenant cannot use actions to sync or alter the tenant financial identity", async ({ playwright }) => {
  const landlord = await asUser(playwright, "landlord");
  const otherTenant = await asUser(playwright, "tenant2");
  try {
    for (const request of [landlord, otherTenant]) {
      const response = await request.post(`/api/cases/${caseId}/actions`, {
        headers: { Origin: origin }, data: { action: "sync_finances" },
      });
      expect(response.ok()).toBeFalsy();
      expect([401, 403, 404]).toContain(response.status());
      expect(await response.text()).not.toMatch(forbiddenFinancialMarkers);
    }
  } finally { await Promise.all([landlord.dispose(), otherTenant.dispose()]); }
});
