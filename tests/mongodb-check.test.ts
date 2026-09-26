import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

const script = require.resolve("../scripts/check-mongodb.ts");
const loader = require.resolve("tsx");

function runCheck(t: TestContext, settings: Record<string, string> = {}, envFile?: string) {
  const directory = mkdtempSync(join(tmpdir(), "rentescrow-db-check-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  if (envFile !== undefined) writeFileSync(join(directory, ".env.local"), envFile, { mode: 0o600 });
  const env = { ...process.env };
  delete env.MONGODB_URI;
  delete env.MONGODB_DATABASE;
  delete env.RENTESCROW_STORAGE;
  Object.assign(env, settings);
  return spawnSync(process.execPath, ["--conditions=react-server", "--import", loader, script], {
    cwd: directory, env, encoding: "utf8", timeout: 10_000,
  });
}

test("db:check fails without a URI and gives setup guidance without claiming a connection", (t) => {
  const result = runCheck(t);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Application storage mode: local/);
  assert.match(result.stderr, /MONGODB_URI is missing/);
  assert.match(result.stderr, /docs\/mongodb-atlas\.md/);
  assert.doesNotMatch(result.stdout + result.stderr, /check passed/);
});

test("db:check auto-loads .env.local without making a network request when its URI is absent", (t) => {
  const result = runCheck(t, {}, "RENTESCROW_STORAGE=mongodb\nMONGODB_DATABASE=rentescrow\n");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Application storage mode: mongodb/);
  assert.match(result.stderr, /MONGODB_URI is missing/);
});

test("db:check rejects malformed URI values without exposing them", (t) => {
  const result = runCheck(t, { MONGODB_URI: "private-user:private-password@example.invalid", RENTESCROW_STORAGE: "mongodb" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must begin with mongodb/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-user|private-password|example\.invalid|check passed/);
});

test("db:check rejects unknown storage modes without echoing their value", (t) => {
  const result = runCheck(t, { RENTESCROW_STORAGE: "private-invalid-mode" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RENTESCROW_STORAGE must be local or mongodb/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-invalid-mode|check passed/);
});
