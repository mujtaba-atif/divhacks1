import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

const loader = require.resolve("tsx");
const seedScript = require.resolve("../scripts/seed-nessie-demo.ts");
const checkScript = require.resolve("../scripts/check-nessie.ts");
const fakeKey = "offline-only-private-key";

function run(t: TestContext, script: string, args: string[] = [], values: Record<string, string> = {}, manifest?: object) {
  const directory = mkdtempSync(join(tmpdir(), "rentescrow-nessie-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  if (manifest) {
    mkdirSync(join(directory, ".data"));
    writeFileSync(join(directory, ".data", "nessie-demo.json"), JSON.stringify(manifest));
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("NESSIE_")) delete env[key];
  Object.assign(env, values);
  return spawnSync(process.execPath, ["--conditions=react-server", "--import", loader, script, ...args], {
    cwd: directory, env, encoding: "utf8", timeout: 10_000,
  });
}

test("Nessie seed requires explicit operator opt-in before any provider call", (t) => {
  const result = run(t, seedScript);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--create-demo/);
});

test("Nessie seed refuses missing keys and nonapproved origins without exposing values", (t) => {
  assert.match(run(t, seedScript, ["--create-demo"]).stderr, /NESSIE_API_KEY is missing/);
  const result = run(t, seedScript, ["--create-demo"], { NESSIE_API_KEY: fakeKey, NESSIE_BASE_URL: "http://private.invalid" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /approved HTTPS/);
  assert.doesNotMatch(result.stdout + result.stderr, /offline-only-private-key|private.invalid/);
});

test("Nessie seed never retries an uncertain provider write", (t) => {
  const result = run(t, seedScript, ["--create-demo"], { NESSIE_API_KEY: fakeKey }, {
    version: 1, origin: "https://api.nessieisreal.com", date: "2026-09-26",
    keyFingerprint: createHash("sha256").update(fakeKey).digest("hex"), completed: {}, pending: "customer",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /uncertain outcome/);
  assert.doesNotMatch(result.stdout + result.stderr, /offline-only-private-key/);
});

test("Nessie seed reuses every recorded UUID receipt without duplicate writes", (t) => {
  const completed = Object.fromEntries(["customer", "account", "merchant", "heater", "lodging", "groceries", "rentPrevious", "rentCurrent", "rentNext"].map(
    (step) => [step, "b63d7247-e564-4c8a-a2f4-c40d604ec6b9"],
  ));
  const result = run(t, seedScript, ["--create-demo"], { NESSIE_API_KEY: fakeKey }, {
    version: 1, origin: "https://api.nessieisreal.com", date: "2026-09-26",
    keyFingerprint: createHash("sha256").update(fakeKey).digest("hex"), completed,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /provisioning complete/);
  assert.doesNotMatch(result.stdout, /created and receipt saved/);
});

test("Nessie check refuses fixture mode and missing live binding", (t) => {
  const fixture = run(t, checkScript);
  assert.equal(fixture.status, 1);
  assert.match(fixture.stderr, /Fixtures do not count as a live connection/);
  const missing = run(t, checkScript, [], { NESSIE_ENABLED: "true", NESSIE_API_KEY: fakeKey });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /NESSIE_NOT_CONFIGURED/);
  assert.doesNotMatch(missing.stdout + missing.stderr, /offline-only-private-key|check passed/);
});
