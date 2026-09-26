import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { addUploadedEvidence, performCaseAction } from "../src/lib/server/cases";
import { assertSameOrigin } from "../src/lib/server/http";
import { createSession, mutateSession, readSession } from "../src/lib/server/store";
import type { EvidenceRecord } from "../src/lib/types";

function localStorage(t: TestContext) {
  const previous = process.env.RENTESCROW_STORAGE;
  process.env.RENTESCROW_STORAGE = "local";
  t.after(() => {
    if (previous === undefined) delete process.env.RENTESCROW_STORAGE;
    else process.env.RENTESCROW_STORAGE = previous;
  });
}

test("same-origin validation respects the request Host without trusting forwarded hosts", () => {
  const url = "http://localhost:3000/api/cases";
  assert.doesNotThrow(() => assertSameOrigin(new NextRequest(url, {
    headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
  })));
  const rejectedHeaders: Record<string, string>[] = [
    { host: "127.0.0.1:3000", origin: "https://attacker.example" },
    { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3001" },
    { host: "127.0.0.1:3000" },
    { host: "127.0.0.1:3000", origin: "https://attacker.example", "x-forwarded-host": "attacker.example" },
    { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "cross-site" },
    { host: "127.0.0.1:3000/path", origin: "http://127.0.0.1:3000" },
  ];
  for (const headers of rejectedHeaders) {
    assert.throws(() => assertSameOrigin(new NextRequest(url, { headers })), /same application origin/);
  }
});

test("a failed older after upload does not block an analyzed replacement", async (t) => {
  localStorage(t);
  const { document } = await createSession();
  const ownerId = document.ownerId;
  const caseId = document.cases[0].id;
  const failedUpload: EvidenceRecord = {
    id: "failed-old-after", name: "unanalysable.png", mimeType: "image/png", stage: "after",
    note: "An earlier upload that could not be analyzed.", createdAt: new Date().toISOString(), isDemo: false,
  };
  await addUploadedEvidence(ownerId, caseId, failedUpload);
  await performCaseAction(ownerId, caseId, { action: "simulate_landlord_reply", variant: "completed" });
  const replacement = await performCaseAction(ownerId, caseId, { action: "add_demo_evidence", stage: "after" });
  await performCaseAction(ownerId, caseId, { action: "analyze_evidence", evidenceId: replacement.case.evidence.at(-1)!.id });
  const verified = await performCaseAction(ownerId, caseId, { action: "verify_repair" });
  assert.equal(verified.case.verification?.verified, true);
  assert.equal(verified.case.evidence.find((item) => item.id === failedUpload.id)?.analysis, undefined);

  await addUploadedEvidence(ownerId, caseId, { ...failedUpload, id: "new-unanalysed-after" });
  await assert.rejects(performCaseAction(ownerId, caseId, { action: "verify_repair" }), /Upload and analyze/);
  const stored = await readSession(ownerId);
  assert.equal(stored?.cases[0].verification, undefined);
  assert.equal(stored?.cases[0].tenantConfirmed, false);
});

test("uncertain Photon delivery is persisted and identical immediate retries do not send", async (t) => {
  localStorage(t);
  const settings = {
    PHOTON_LIVE_SEND: "true", PHOTON_PROXY_TOKEN: "offline-test-token", PHOTON_ALLOWED_RECIPIENT: "+12125550100",
  };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new DOMException("Response timed out after request dispatch", "TimeoutError");
  });
  const { document } = await createSession();
  const ownerId = document.ownerId;
  const caseId = document.cases[0].id;
  await mutateSession(ownerId, (session) => { session.cases[0].landlordContact = settings.PHOTON_ALLOWED_RECIPIENT; });
  const message = { action: "send_message" as const, body: "Please confirm the repair appointment." };
  await assert.rejects(performCaseAction(ownerId, caseId, message), /may have sent/);
  const stored = await readSession(ownerId);
  assert.equal(stored?.cases[0].messages.length, 0);
  assert.equal(stored?.cases[0].timeline.at(-1)?.title, "Message delivery uncertain");
  assert.equal(stored?.uncertainDeliveries?.length, 1);
  await assert.rejects(performCaseAction(ownerId, caseId, message), /Identical retries are blocked/);
  assert.equal(fetch.mock.callCount(), 1);
});
