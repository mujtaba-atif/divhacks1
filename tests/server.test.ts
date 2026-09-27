import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { addUploadedEvidence, performCaseAction } from "../src/lib/server/cases";
import { assertSameOrigin } from "../src/lib/server/http";
import { createSession, readSession } from "../src/lib/server/store";
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
