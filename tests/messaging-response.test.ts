import assert from "node:assert/strict";
import { test } from "node:test";
import { createDemoCase } from "../src/lib/seed";
import { respond, handleError } from "../src/lib/server/http";
import { ApiError } from "../src/lib/server/errors";

test("case responses, arrays, and errors omit private messaging routing bindings", async () => {
  const record = createDemoCase("tenant-workspace");
  record.messagingBinding = { ownerId: record.ownerId, caseId: record.id,
    tenant: { userId: "private-tenant", phone: "+12125550101", conversationId: "private-tenant-thread" },
    landlord: { userId: "private-landlord", phone: "+12125550102", conversationId: "private-landlord-thread", sendingLine: "private-line" } };
  for (const response of [respond({ case: record }), respond({ cases: [record] }),
    handleError(new ApiError(409, "Recorded attempt", true, "ATTEMPT", undefined, record))]) {
    const serialized = await response.text();
    assert.doesNotMatch(serialized, /messagingBinding|private-tenant|private-landlord|private-line|1212555010/);
    assert.match(serialized, /RE-1042/);
    assert.equal(response.headers.get("cache-control"), "no-store, private");
  }
  assert.ok(record.messagingBinding, "serializing must not mutate persisted routing state");
});
