import { expect, signIn, test } from "./auth-fixtures";
import type { Page } from "@playwright/test";
import { createDemoCase } from "../../src/lib/seed";
import type { CaseAction, CaseMessage, IntegrationStatus, LandlordCase } from "../../src/lib/types";

type Outcome = Exclude<CaseMessage["delivery"], "received"> | "network";
const approvalLabel = "I reviewed this message and approve sending it.";
const body = "Please confirm when the heating repair can be completed.";
const recipient = "+15555550123";
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function mockMessages(page: Page, outcomes: Outcome[], options: { integration?: IntegrationStatus; hold?: boolean } = {}) {
  const record = createDemoCase("message-browser-fixture");
  record.landlordContact = recipient;
  const actions: Extract<CaseAction, { action: "send_message" }>[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  if (!options.hold) release();
  const integration: IntegrationStatus = options.integration || { id: "photon", name: "Spectrum messaging", status: "configured", detail: "Approved messages use the case-bound Spectrum recipient." };

  // All provider and API calls are blocked or fulfilled before navigation.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return route.abort();
    return route.continue();
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/dashboard") return route.fulfill({ json: { cases: [record], integrations: [integration], mode: "demo" } });
    if (url.pathname !== `/api/cases/${record.id}/actions` || route.request().method() !== "POST") return route.abort();
    const action = route.request().postDataJSON() as CaseAction;
    if (action.action !== "send_message") return route.fulfill({ status: 400, json: { error: "Unexpected fixture action." } });
    actions.push(action);
    await gate;
    const outcome = outcomes[actions.length - 1] || outcomes.at(-1) || "demo";
    if (outcome === "network") return route.abort("failed");
    const preparedBody = `${action.body}\n\nRentEscrow case: ${record.id}`;
    if (record.messages.some((message) => message.body === preparedBody && (message.delivery === "sent" || message.delivery === "demo"))) {
      return route.fulfill({ json: { case: record } });
    }
    const createdAt = new Date().toISOString();
    const message: CaseMessage = {
      id: `message-${actions.length}`, sender: "tenant", body: preparedBody, createdAt, attemptedAt: createdAt,
      caseId: record.id, requestId: action.requestId, recipient, delivery: outcome, provider: outcome === "demo" ? "demo" : "spectrum",
      ...(outcome === "sent" ? { providerMessageId: "spectrum-receipt-123", providerConversationId: "conversation-123", sentAt: createdAt } : {}),
      ...(outcome === "failed" ? { failureReason: "Spectrum rejected this attempt before sending." } : {}),
      ...(outcome === "uncertain" ? { failureReason: "Spectrum may have accepted the message; its receipt could not be confirmed." } : {}),
    };
    record.messages.push(message);
    if (outcome === "failed" || outcome === "uncertain") return route.fulfill({ status: 503, json: { error: message.failureReason, case: record } });
    return route.fulfill({ json: { case: record } });
  });
  return { actions, release, record };
}

async function openMessages(page: Page) {
  await page.goto("/");
  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  await page.getByRole("textbox", { name: "Message to property manager" }).fill(body);
}

async function approveAndSend(page: Page) {
  await page.getByRole("checkbox", { name: approvalLabel }).check();
  await page.getByRole("button", { name: "Approve & send", exact: true }).click();
}

test("demo send requires reviewed text and sends approval without a browser-controlled recipient", async ({ page }) => {
  const mock = await mockMessages(page, ["demo"], { integration: { id: "photon", name: "Spectrum messaging", status: "demo", detail: "Live sending is disabled." } });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await openMessages(page);
  const checkbox = page.getByRole("checkbox", { name: approvalLabel });
  const send = page.getByRole("button", { name: "Approve & send", exact: true });
  await expect(send).toBeDisabled();
  await checkbox.check();
  await page.getByRole("textbox", { name: "Message to property manager" }).fill(`${body} Thank you.`);
  await expect(checkbox).not.toBeChecked();
  await expect(send).toBeDisabled();
  expect(mock.actions).toEqual([]);
  await approveAndSend(page);
  await expect(page.getByText("Simulated delivery", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message to property manager" })).toHaveValue("");
  expect(mock.actions).toEqual([{ action: "send_message", body: `${body} Thank you.`, approved: true, requestId: expect.stringMatching(requestIdPattern) }]);
  await expect(page.getByText("Message saved in the demo. No external delivery.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: "test-results/messages-desktop.png", fullPage: true });
});

test("conversation identifies both people and both agents without exposing the full contact", async ({ page }) => {
  const mock = await mockMessages(page, [], { integration: { id: "photon", name: "Spectrum messaging", status: "configured", detail: "Live provider adapter configured." } });
  const createdAt = new Date().toISOString();
  mock.record.tenant = { name: "Rayaan", phone: "+19736060558" };
  mock.record.landlordName = "Alex Morgan";
  mock.record.messages = [
    { id: "role-tenant", sender: "tenant", body: "It is still freezing.", createdAt, delivery: "received", provider: "spectrum" },
    { id: "role-tenant-agent", sender: "agent", originatingAgent: "tenant", body: "Relayed the repair follow-up.", createdAt, delivery: "sent", provider: "spectrum" },
    { id: "role-landlord", sender: "landlord", body: "Maintenance can come tomorrow at 10.", createdAt, delivery: "received", provider: "spectrum",
      interpretation: { intent: "scheduled", summary: "Maintenance scheduled.", scheduledFor: "Sep 27 at 10 AM", source: "rules" } },
    { id: "role-landlord-agent", sender: "agent", originatingAgent: "landlord", body: "Maintenance is scheduled for tomorrow at 10 AM.", createdAt, delivery: "pending", provider: "spectrum" },
  ];
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  const conversation = page.locator(".conversation");
  await expect(conversation.getByText("PHOTON LIVE", { exact: true })).toBeVisible();
  await expect(conversation.getByText("Tenant · Rayaan (you)", { exact: true })).toBeVisible();
  await expect(conversation.getByText("Tenant Agent", { exact: true })).toBeVisible();
  await expect(conversation.getByText("Landlord · Alex Morgan", { exact: true })).toBeVisible();
  await expect(conversation.getByText("Landlord Agent", { exact: true })).toBeVisible();
  await expect(conversation.getByText("Agent interpretation · Rules: Maintenance scheduled. · Sep 27 at 10 AM", { exact: true })).toBeVisible();
  await expect(conversation.getByText(/Invalid Date/)).toHaveCount(0);
  await expect(conversation.getByText(recipient, { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "test-results/photon-roles-desktop.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: "test-results/photon-roles-mobile.png", fullPage: true, animations: "disabled" });
});

test("in-flight live sends lock the composer and show provider acceptance rather than delivery proof", async ({ page }) => {
  const mock = await mockMessages(page, ["sent"], { hold: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await openMessages(page);
  try {
    await approveAndSend(page);
    await expect.poll(() => mock.actions.length).toBe(1);
    await expect(page.getByRole("textbox", { name: "Message to property manager" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Draft notice", exact: true })).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: approvalLabel })).toBeDisabled();
  } finally { mock.release(); }
  await expect(page.getByText("Accepted by Spectrum", { exact: true })).toBeVisible();
  await expect(page.getByText("Provider acceptance is recorded; this is not a delivery or read receipt.", { exact: true })).toBeVisible();
  await expect(page.getByText("spectrum-receipt-123", { exact: true })).toBeVisible();
  await expect(page.getByText("Recipient: +1 (***) ***-0123", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const notification = page.getByRole("button", { name: "Dismiss notification", exact: true });
  if (await notification.isVisible()) await notification.click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/messages-mobile.png", fullPage: true });
});

test("known failed sends preserve the draft and require new approval with a new request ID", async ({ page }) => {
  const mock = await mockMessages(page, ["failed", "sent"]);
  await openMessages(page);
  await approveAndSend(page);
  await expect(page.getByText("Not sent", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message to property manager" })).toHaveValue(body);
  await expect(page.getByRole("checkbox", { name: approvalLabel })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Approve & send", exact: true })).toBeDisabled();
  await expect(page.locator(".toast-success")).toHaveCount(0);
  expect(mock.actions).toHaveLength(1);
  await approveAndSend(page);
  await expect(page.getByText("Accepted by Spectrum", { exact: true })).toBeVisible();
  expect(mock.actions).toHaveLength(2);
  expect(mock.actions[1].requestId).not.toBe(mock.actions[0].requestId);
});

for (const outcome of ["pending", "uncertain"] as const) {
  test(`${outcome} delivery blocks a new same-body send and does not advance notification progress`, async ({ page }) => {
    const mock = await mockMessages(page, [outcome]);
    await openMessages(page);
    await approveAndSend(page);
    await expect(page.getByText(outcome === "pending" ? "Delivery pending" : "Delivery unconfirmed", { exact: true })).toBeVisible();
    const draft = page.getByRole("textbox", { name: "Message to property manager" });
    await expect(draft).toHaveValue(body);
    await expect(page.getByRole("checkbox", { name: approvalLabel })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Approve & send", exact: true })).toBeDisabled();
    await expect(page.locator(".toast-success")).toHaveCount(0);
    await expect(page.getByText("Accepted by Spectrum", { exact: true })).toHaveCount(0);
    await draft.fill(`${body} An edit.`);
    await draft.fill(body);
    await expect(page.getByRole("checkbox", { name: approvalLabel })).toBeDisabled();
    expect(mock.actions).toHaveLength(1);
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Send your repair request", exact: true })).toBeVisible();
  });
}

test("a transport failure retains the request ID for an explicit retry", async ({ page }) => {
  const mock = await mockMessages(page, ["network", "sent"]);
  await openMessages(page);
  await approveAndSend(page);
  await expect(page.getByText("Your draft is kept. Review the delivery status before approving another attempt.", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message to property manager" })).toHaveValue(body);
  expect(mock.actions).toHaveLength(1);
  await approveAndSend(page);
  await expect(page.getByText("Accepted by Spectrum", { exact: true })).toBeVisible();
  expect(mock.actions).toHaveLength(2);
  expect(mock.actions[1].requestId).toBe(mock.actions[0].requestId);
});

test("unavailable live configuration is never labeled demo or allowed to send", async ({ page }) => {
  const detail = "Spectrum credentials or an approved sending line are unavailable.";
  const mock = await mockMessages(page, [], { integration: { id: "photon", name: "Spectrum messaging", status: "unavailable", detail } });
  await openMessages(page);
  await expect(page.getByText("PHOTON UNAVAILABLE", { exact: true })).toBeVisible();
  await expect(page.getByText(detail, { exact: true })).toBeVisible();
  await expect(page.getByText("Demo delivery", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: approvalLabel })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Approve & send", exact: true })).toBeDisabled();
  expect(mock.actions).toEqual([]);
});

test("a deduplicated send recognizes its existing provider receipt without claiming uncertainty", async ({ page }) => {
  const mock = await mockMessages(page, ["sent", "sent"]);
  await openMessages(page);
  await approveAndSend(page);
  await expect(page.getByText("Accepted by Spectrum", { exact: true })).toBeVisible();
  const draft = page.getByRole("textbox", { name: "Message to property manager" });
  await draft.fill(body);
  await approveAndSend(page);
  await expect(draft).toHaveValue("");
  await expect(page.getByText("The provider accepted your message. Delivery and reading are not confirmed.", { exact: true })).toBeVisible();
  await expect(page.getByText("Delivery unconfirmed", { exact: true })).toHaveCount(0);
  expect(mock.actions).toHaveLength(2);
  expect(mock.actions[0].requestId).not.toBe(mock.actions[1].requestId);
  expect(mock.record.messages).toHaveLength(1);
});

test("the active conversation refreshes received replies without replacing an approved draft", async ({ page }) => {
  const mock = await mockMessages(page, []);
  await openMessages(page);
  await page.getByRole("checkbox", { name: approvalLabel }).check();
  mock.record.messages.push({ id: "listener-reply", sender: "landlord", body: "A technician will arrive tomorrow morning.",
    createdAt: new Date().toISOString(), delivery: "received", provider: "spectrum", providerMessageId: "incoming-receipt-1" });
  await expect(page.getByText("A technician will arrive tomorrow morning.", { exact: true })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText("Received", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message to property manager" })).toHaveValue(body);
  await expect(page.getByRole("checkbox", { name: approvalLabel })).toBeChecked();
  expect(mock.actions).toEqual([]);
});

test("the landlord thread polls for agent replies without replacing a message draft", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    await signIn(context.request, "landlord");
    const page = await context.newPage();
    const source = createDemoCase("landlord-message-browser-fixture");
    const record: LandlordCase = {
      id: source.id, title: source.title, issue: source.issue, description: source.description,
      noticedAt: source.noticedAt, createdAt: source.createdAt, updatedAt: source.updatedAt, status: source.status,
      property: { id: "demo-property", address: source.building.address, borough: source.building.borough, apartment: source.apartment },
      tenant: { displayName: "Rayaan" }, evidence: source.evidence,
      messages: [{ id: "local-case-note", sender: "landlord", body: "I added this note in RentEscrow.",
        createdAt: new Date().toISOString(), delivery: "received", provider: "demo" }], timeline: source.timeline,
      repairReported: false, repairs: [],
      financialSummary: { disputedAmountCents: source.disputedAmountCents, escrowStatus: source.escrow.status, settlementStatus: "pending" },
    };
    await page.route("**/api/landlord/cases", (route) => route.fulfill({ json: {
      user: { id: "landlord-demo", email: "landlord@rentescrow.demo", role: "landlord", displayName: "Alex Morgan", workspaceOwnerId: "landlord-demo", maskedPhone: "+1 (***) ***-7033" },
      cases: [record], integration: { id: "photon", name: "Spectrum messaging", status: "configured", detail: "Live provider adapter configured." },
    } }));
    await page.goto("/landlord");
    await page.getByRole("button", { name: "Messages", exact: true }).click();
    await expect(page.getByText("Saved to case", { exact: true })).toBeVisible();
    const draft = page.getByRole("textbox", { name: "Message" });
    await draft.fill("Please confirm whether the tenant can meet the technician at 11.");
    record.messages.push({ id: "tenant-agent-poll-reply", sender: "agent", originatingAgent: "tenant",
      body: "The tenant requested an 11 AM appointment.", createdAt: new Date().toISOString(), delivery: "received", provider: "spectrum" });
    await expect(page.getByText("The tenant requested an 11 AM appointment.", { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText("Tenant Agent", { exact: true })).toBeVisible();
    await expect(draft).toHaveValue("Please confirm whether the tenant can meet the technician at 11.");
    await expect(page.getByText("PHOTON LIVE", { exact: true })).toBeVisible();
  } finally { await context.close(); }
});
