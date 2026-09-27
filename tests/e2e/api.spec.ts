import { test, expect, type APIRequestContext } from "@playwright/test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { CaseRecord } from "../../src/lib/types";

import { origin } from "./environment";
async function dashboard(request: APIRequestContext) {
  const response = await request.get("/api/dashboard");
  expect(response.ok()).toBeTruthy();
  return response.json();
}
function action(request: APIRequestContext, id: string, data: Record<string, unknown>) {
  return request.post(`/api/cases/${id}/actions`, { headers: { Origin: origin }, data });
}
async function successfulAction(request: APIRequestContext, id: string, data: Record<string, unknown>): Promise<CaseRecord> {
  const response = await action(request, id, data);
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).case;
}
async function verifiedCase(request: APIRequestContext) {
  const initial = (await dashboard(request)).cases[0] as CaseRecord;
  await successfulAction(request, initial.id, { action: "create_escrow" });
  await successfulAction(request, initial.id, { action: "send_message", body: "Please arrange a heating repair for apartment 4B.", approved: true, requestId: crypto.randomUUID() });
  await successfulAction(request, initial.id, { action: "simulate_landlord_reply", variant: "completed" });
  const evidence = await successfulAction(request, initial.id, { action: "add_demo_evidence", stage: "after" });
  await successfulAction(request, initial.id, { action: "analyze_evidence", evidenceId: evidence.evidence.at(-1)!.id });
  return successfulAction(request, initial.id, { action: "verify_repair" });
}

test("complete case lifecycle, persisted audit, and idempotent settlement", async ({ request }) => {
  const record = await verifiedCase(request);
  expect(record.status).toBe("verified");
  expect(record.verification?.temperatureF).toBe(72);
  const premature = await action(request, record.id, { action: "release_escrow" });
  expect(premature.status()).toBe(409);
  await successfulAction(request, record.id, { action: "confirm_resolution" });
  const released = await successfulAction(request, record.id, { action: "release_escrow" });
  expect(released.status).toBe("resolved");
  expect(released.escrow.status).toBe("released");
  expect(released.escrow.finishHash).toMatch(/^DEMO/);
  const repeat = await successfulAction(request, record.id, { action: "release_escrow" });
  expect(repeat.accountBalanceCents).toBe(released.accountBalanceCents);
  expect(repeat.escrow.finishHash).toBe(released.escrow.finishHash);
  expect(repeat.escrow.audit.filter((entry) => entry.action === "EscrowFinish" && entry.status === "validated")).toHaveLength(1);
  const exported = await request.get(`/api/cases/${record.id}/export`);
  expect(exported.ok()).toBeTruthy();
  expect(exported.headers()["content-disposition"]).toContain("attachment");
  expect((await dashboard(request)).cases[0].status).toBe("resolved");
});

test("concurrent funding and finance sync cannot debit twice or replenish locked money", async ({ request }) => {
  const initial = (await dashboard(request)).cases[0] as CaseRecord;
  const results = await Promise.all([action(request, initial.id, { action: "create_escrow" }), action(request, initial.id, { action: "create_escrow" })]);
  for (const response of results) expect(response.ok()).toBeTruthy();
  const synced = await successfulAction(request, initial.id, { action: "sync_finances" });
  expect(synced.accountBalanceCents).toBe(initial.accountBalanceCents - initial.disputedAmountCents);
  expect(synced.escrow.audit.filter((entry) => entry.action === "EscrowCreate" && entry.status === "validated")).toHaveLength(1);
});

test("wallet substitution is rejected and recorded without submission", async ({ request }) => {
  const record = await verifiedCase(request);
  await successfulAction(request, record.id, { action: "confirm_resolution" });
  const response = await action(request, record.id, { action: "policy_check", intent: {
    caseId: record.id, escrowId: record.escrow.id, transactionType: "EscrowFinish", destination: "rATTACKER999",
    amountCents: record.disputedAmountCents, network: "demo",
  } });
  expect(response.ok()).toBeTruthy();
  const result = await response.json();
  expect(result.policy.approved).toBe(false);
  expect(result.case.escrow.status).toBe("locked");
  expect(result.case.escrow.finishHash).toBeUndefined();
  expect(result.case.escrow.audit.at(-1).status).toBe("rejected");
});

test("new uploaded evidence invalidates previous verification and tenant consent", async ({ request }) => {
  const record = await verifiedCase(request);
  await successfulAction(request, record.id, { action: "confirm_resolution" });
  const upload = await request.post(`/api/cases/${record.id}/evidence`, {
    headers: { Origin: origin }, multipart: { stage: "after", note: "Additional evidence",
      file: { name: "after.png", mimeType: "image/png", buffer: await readFile(path.join(process.cwd(), "public/evidence-after.png")) } },
  });
  expect(upload.ok(), await upload.text()).toBeTruthy();
  const updated = (await upload.json()).case;
  expect(updated.tenantConfirmed).toBe(false);
  expect(updated.verification?.verified).not.toBe(true);
  expect(updated.evidence.at(-1).isDemo).toBe(false);
  expect((await action(request, record.id, { action: "release_escrow" })).status()).toBe(409);
});

test("rejects cross-origin actions, forged fields, and disguised uploads", async ({ request }) => {
  const record = (await dashboard(request)).cases[0];
  const crossOrigin = await request.post(`/api/cases/${record.id}/actions`, { headers: { Origin: "https://attacker.example" }, data: { action: "create_escrow" } });
  expect(crossOrigin.status()).toBe(403);
  const forged = await action(request, record.id, { action: "create_escrow", destination: "rATTACKER" });
  expect(forged.status()).toBe(400);
  const upload = await request.post(`/api/cases/${record.id}/evidence`, { headers: { Origin: origin }, multipart: { stage: "after", note: "Bad file",
    file: { name: "fake.png", mimeType: "image/png", buffer: Buffer.from("<script>alert(1)</script>") } } });
  expect(upload.status()).toBe(415);
});

test("new cases are session-scoped and insufficient funds never create an escrow", async ({ request, playwright }) => {
  await dashboard(request);
  const created = await request.post("/api/cases", { headers: { Origin: origin }, data: {
    issue: "heating", description: "The radiator has stopped producing heat.", noticedAt: "2026-09-23",
    address: "123 Example Street", borough: "Brooklyn", apartment: "5A", landlordName: "Example Manager",
    landlordContact: "manager@example.com", monthlyRentCents: 300000, disputedAmountCents: 260000,
  } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const record = (await created.json()).case;
  const fund = await action(request, record.id, { action: "create_escrow" });
  expect(fund.status()).toBe(409);
  const stored = (await dashboard(request)).cases.find((item: CaseRecord) => item.id === record.id);
  expect(stored.escrow.status).toBe("unfunded");
  expect(stored.escrow.createHash).toBeUndefined();
  const other = await playwright.request.newContext({ baseURL: origin });
  try {
    await dashboard(other);
    expect((await other.get(`/api/cases/${record.id}/export`)).status()).toBe(404);
    expect((await action(other, record.id, { action: "create_escrow" })).status()).toBe(404);
  } finally { await other.dispose(); }
});
