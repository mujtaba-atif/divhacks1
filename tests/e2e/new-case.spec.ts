import { expect, test, type APIRequestContext } from "@playwright/test";
import type { CaseRecord, DashboardData } from "../../src/lib/types";
import { origin } from "./environment";

const tenant = { name: "Mujtaba Atif", phone: "+12018567033" };
const landlord = { name: "Rayyan Khan", contact: "+19736060558" };
const approvalLabel = "I reviewed this message and approve sending it.";

async function dashboard(request: APIRequestContext): Promise<DashboardData> {
  const response = await request.get("/api/dashboard");
  expect(response.ok(), await response.text()).toBeTruthy();
  const data = await response.json() as DashboardData;
  expect(data.integrations.find((integration) => integration.id === "photon")?.status).toBe("demo");
  return data;
}

async function resetWorkspace(request: APIRequestContext) {
  await dashboard(request);
  const response = await request.post("/api/demo/reset", { headers: { Origin: origin } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as DashboardData;
}

function expectBoundParticipants(record: CaseRecord) {
  expect(record.tenant).toEqual(tenant);
  expect(record.tenantName).toBe(tenant.name);
  expect(record.tenantPhone).toBe(tenant.phone);
  expect(record.landlordName).toBe(landlord.name);
  expect(record.landlordContact).toBe(landlord.contact);
  expect(record.demoMessagingBinding).toEqual({ ownerId: record.ownerId, caseId: record.id, recipient: landlord.contact });
}

function newCaseInput() {
  return {
    issue: "heating", description: "The radiator in the new case is cold and needs a repair.",
    noticedAt: new Date().toISOString().slice(0, 10), address: "123 Example Street", borough: "Brooklyn",
    apartment: "9C", monthlyRentCents: 185000, disputedAmountCents: 40000,
  };
}

test("a brand-new form-created case retains the tenant and landlord through reload and approved demo messaging", async ({ page }) => {
  const initial = await resetWorkspace(page.request);
  await page.goto("/");
  await page.getByRole("button", { name: "New case", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Open a repair case", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Landlord / property manager", { exact: true })).toHaveValue(landlord.name);
  await expect(dialog.getByLabel("Landlord / property manager", { exact: true })).toHaveAttribute("readonly", "");
  await expect(dialog.getByLabel("Landlord contact", { exact: true })).toHaveValue(landlord.contact);
  await expect(dialog.getByLabel("Landlord contact", { exact: true })).toHaveAttribute("readonly", "");
  await dialog.getByLabel("Street address", { exact: true }).fill("123 Example Street");
  await dialog.getByLabel("Borough").selectOption("Brooklyn");
  await dialog.getByLabel("Apartment", { exact: true }).fill("9C");
  await dialog.getByLabel("What happened?", { exact: true }).fill(newCaseInput().description);
  await dialog.getByLabel("Monthly rent (USD)", { exact: true }).fill("1850");
  await dialog.getByLabel("Disputed amount (USD)", { exact: true }).fill("400");
  const createdResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/cases" && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Create case", exact: true }).click();
  const created = await createdResponse;
  expect(created.status(), await created.text()).toBe(201);
  const record = (await created.json()).case as CaseRecord;
  expect(initial.cases.map((item) => item.id)).not.toContain(record.id);
  expect(record.apartment).toBe("9C");
  expectBoundParticipants(record);
  await expect(dialog).not.toBeVisible();
  const stored = (await dashboard(page.request)).cases.find((item) => item.id === record.id);
  expect(stored).toBeDefined();
  expectBoundParticipants(stored!);

  await page.reload();
  await page.getByRole("combobox", { name: "Select case", exact: true }).selectOption(record.id);
  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  const messages = page.getByRole("tabpanel", { name: "Messages", exact: true });
  await expect(messages.locator(".conversation-heading").getByText(landlord.name, { exact: true })).toBeVisible();
  await expect(messages.getByText(landlord.contact, { exact: true })).toBeVisible();
  const draft = messages.getByRole("textbox", { name: "Message to property manager", exact: true });
  await expect(draft).toHaveValue(/Hello Rayyan Khan,/);
  await expect(draft).toHaveValue(/Mujtaba Atif/);
  const approval = messages.getByRole("checkbox", { name: approvalLabel, exact: true });
  const send = messages.getByRole("button", { name: "Approve & send", exact: true });
  await expect(approval).not.toBeChecked();
  await expect(send).toBeDisabled();
  await approval.check();
  await expect(send).toBeEnabled();
  const sendResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/cases/${record.id}/actions` && response.request().method() === "POST");
  await send.click();
  const response = await sendResponse;
  expect(response.ok(), await response.text()).toBeTruthy();
  const submitted = response.request().postDataJSON();
  expect(submitted.action).toBe("send_message");
  expect(submitted.approved).toBe(true);
  expect(submitted).not.toHaveProperty("recipient");
  const sentCase = (await response.json()).case as CaseRecord;
  const message = sentCase.messages.find((item) => item.requestId === submitted.requestId);
  expect(message).toMatchObject({ caseId: record.id, sender: "tenant", provider: "demo", delivery: "demo", recipient: landlord.contact });
  expect(message?.body).toContain(`RentEscrow case: ${record.id}`);
  expect(message?.providerMessageId).toBeUndefined();
  expectBoundParticipants(sentCase);
  await expect(messages.getByText("Simulated delivery", { exact: true })).toBeVisible();
  await expect(messages.getByText(`Recipient: ${landlord.contact}`, { exact: true })).toBeVisible();
  const persisted = (await dashboard(page.request)).cases.find((item) => item.id === record.id)!;
  expectBoundParticipants(persisted);
  expect(persisted.messages.find((item) => item.requestId === submitted.requestId)).toEqual(message);
  await page.screenshot({ path: "test-results/new-case-message-recipient.png", fullPage: true });
});

test("new-case API resolves missing or unusable landlord input from trusted participant defaults", async ({ request }) => {
  await resetWorkspace(request);
  for (const contact of [undefined, null, "", "muji"]) {
    const response = await request.post("/api/cases", {
      headers: { Origin: origin }, data: { ...newCaseInput(), ...(contact === undefined ? {} : { landlordName: "Wrong person", landlordContact: contact }) },
    });
    expect(response.status(), await response.text()).toBe(201);
    const record = (await response.json()).case as CaseRecord;
    expectBoundParticipants(record);
    const stored = (await dashboard(request)).cases.find((item) => item.id === record.id)!;
    expectBoundParticipants(stored);
  }
});

test("new-case API rejects forged tenant, owner and messaging bindings without storing a case", async ({ request }) => {
  const initial = await resetWorkspace(request);
  for (const forged of [
    { ownerId: "attacker-owner" },
    { tenant: { name: "Attacker", phone: "+15555550123" } },
    { tenantName: "Attacker", tenantPhone: "+15555550123" },
    { demoMessagingBinding: { ownerId: "attacker-owner", recipient: "+15555550123", caseId: "RE-1042" } },
  ]) {
    const response = await request.post("/api/cases", {
      headers: { Origin: origin },
      data: { ...newCaseInput(), landlordName: landlord.name, landlordContact: landlord.contact, ...forged },
    });
    expect(response.status(), await response.text()).toBe(400);
  }
  expect((await dashboard(request)).cases.map((record) => record.id)).toEqual(initial.cases.map((record) => record.id));
});
