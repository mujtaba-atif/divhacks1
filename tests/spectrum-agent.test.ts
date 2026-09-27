import assert from "node:assert/strict";
import test from "node:test";
import { runSpectrumAgent, type EchoApp } from "../scripts/spectrum-agent";

const environment = { SPECTRUM_PROJECT_ID: "test-project", SPECTRUM_PROJECT_SECRET: "test-secret" };
const now = () => Date.parse("2026-09-26T12:00:00Z");
type Entry = Awaited<ReturnType<ReturnType<EchoApp["messages"][typeof Symbol.asyncIterator]>["next"]>> extends IteratorResult<infer T> ? T : never;
type Message = Entry[1];

function message(id: string, overrides: Partial<Message> = {}): Message {
  return { platform: "imessage", direction: "inbound", id, timestamp: new Date(now()), content: { type: "text", text: "private body" }, ...overrides };
}

function harness(messages: Message[], send?: (body: string) => Promise<unknown>) {
  const logs: string[] = [];
  const sent: string[] = [];
  let stops = 0;
  let starts = 0;
  const app: EchoApp = {
    messages: (async function* () {
      for (const item of messages) yield [{ send: async (body: string) => { sent.push(body); return send?.(body); } }, item] as const;
    })(),
    stop: async () => { stops += 1; },
  };
  const options = {
    environment,
    now,
    logger: { log: (text: string) => logs.push(text), error: (text: string) => logs.push(text) },
    createApp: async () => { starts += 1; return app; },
  };
  return { app, options, logs, sent, stops: () => stops, starts: () => starts };
}

test("missing or blank configuration fails before starting Spectrum", async () => {
  const h = harness([]);
  for (const config of [{}, { SPECTRUM_PROJECT_ID: " ", SPECTRUM_PROJECT_SECRET: "test-secret" }, { SPECTRUM_PROJECT_ID: "test-project" }]) {
    assert.equal(await runSpectrumAgent({ ...h.options, environment: config }), 1);
  }
  assert.equal(h.starts(), 0);
  assert.equal(h.stops(), 0);
});

test("echoes fresh inbound text once and suppresses outgoing, replayed, invalid and echo messages", async () => {
  const h = harness([
    message("fresh"), message("fresh"),
    message("outgoing", { direction: "outbound" }),
    message("other-platform", { platform: "slack" }),
    message("old", { timestamp: new Date(now() - 1) }),
    message("invalid-date", { timestamp: new Date(NaN) }),
    message("attachment", { content: { type: "image" } }),
    message("blank", { content: { type: "text", text: "  " } }),
    message("loop", { content: { type: "text", text: "RentEscrow Agent got: echo" } }),
    message(""),
  ]);
  assert.equal(await runSpectrumAgent(h.options), 0);
  assert.deepEqual(h.sent, ['RentEscrow Agent got: "private body"']);
  assert.equal(h.stops(), 1);
  assert.doesNotMatch(h.logs.join("\n"), /private body|test-secret/);
});

test("uncertain delivery is not retried and private provider errors are not logged", async () => {
  let sends = 0;
  const h = harness([message("first"), message("first"), message("second")], async () => {
    if (++sends === 1) throw new Error("private body +15555550123 test-secret");
  });
  assert.equal(await runSpectrumAgent(h.options), 1);
  assert.equal(h.sent.length, 2);
  assert.equal(h.stops(), 1);
  assert.doesNotMatch(h.logs.join("\n"), /private body|15555550123|test-secret/);
});

test("startup errors are sanitized and never produce an unhandled provider error", async () => {
  const h = harness([]);
  assert.equal(await runSpectrumAgent({ ...h.options, createApp: async () => { throw new Error("test-secret private body"); } }), 1);
  assert.match(h.logs.join("\n"), /startup failed/);
  assert.doesNotMatch(h.logs.join("\n"), /test-secret|private body/);
});

test("stream failure closes the app and reports a sanitized failure", async () => {
  const h = harness([]);
  h.app.messages = (async function* () { throw new Error("test-secret private body"); })();
  assert.equal(await runSpectrumAgent(h.options), 1);
  assert.equal(h.stops(), 1);
  assert.match(h.logs.join("\n"), /stream stopped unexpectedly/);
  assert.doesNotMatch(h.logs.join("\n"), /test-secret|private body/);
});

test("abort wakes an idle stream and closes the provider exactly once", async () => {
  const controller = new AbortController();
  const h = harness([]);
  h.app.messages = {
    [Symbol.asyncIterator]: () => ({ next: () => {
      controller.abort();
      return new Promise<IteratorResult<Entry>>(() => {});
    } }),
  };
  assert.equal(await runSpectrumAgent({ ...h.options, signal: controller.signal }), 0);
  assert.equal(h.stops(), 1);
});

test("abort interrupts a pending send without retrying or logging its body", async () => {
  const controller = new AbortController();
  const h = harness([message("pending"), message("pending")], () => {
    controller.abort();
    return new Promise(() => {});
  });
  assert.equal(await runSpectrumAgent({ ...h.options, signal: controller.signal }), 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.stops(), 1);
  assert.match(h.logs.join("\n"), /delivery interrupted/);
  assert.doesNotMatch(h.logs.join("\n"), /private body/);
});

test("startup completion after abort still cleans up and does not hide cleanup failure", async () => {
  const controller = new AbortController();
  const h = harness([message("fresh")]);
  h.app.stop = async () => { throw new Error("test-secret"); };
  assert.equal(await runSpectrumAgent({
    ...h.options,
    signal: controller.signal,
    createApp: async () => { controller.abort(); return h.app; },
  }), 1);
  assert.equal(h.sent.length, 0);
  assert.match(h.logs.join("\n"), /could not shut down cleanly/);
  assert.doesNotMatch(h.logs.join("\n"), /test-secret/);
});

test("provider shutdown is bounded", async () => {
  const h = harness([]);
  h.app.stop = () => new Promise(() => {});
  assert.equal(await runSpectrumAgent({ ...h.options, shutdownTimeoutMs: 5 }), 1);
  assert.match(h.logs.join("\n"), /could not shut down cleanly/);
});

test("an already aborted worker does not start a provider", async () => {
  const h = harness([]);
  assert.equal(await runSpectrumAgent({ ...h.options, signal: AbortSignal.abort() }), 0);
  assert.equal(h.starts(), 0);
});
