import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, Wallet, decode, hashes, type EscrowCreate } from "xrpl";
import { createDemoCase } from "../src/lib/seed";
import { makeIntent } from "../src/lib/policy";
import { analyzeEvidence, verifyEvidence, lookupBuilding, getFinancialContext, sendLandlordMessage, DeliveryUncertainError, IntegrationError } from "../src/lib/integrations";
import { assertFinalTestnetTransaction, assertNativeXrpBalance, buildTestnetEscrowCreate, buildTestnetEscrowFinish, conditionForPreimage, submitGuardedTestnetEscrow, type TestnetEscrowApproval } from "../src/lib/integrations/xrpl-testnet";

function environment(values: Record<string, string | undefined>): () => void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("sample verification requires analyzed before and after evidence and a reported repair", async () => {
  const record = createDemoCase("test");
  const after = { ...record.evidence[0], id: "after", stage: "after" as const, temperatureF: 72 };
  after.analysis = await analyzeEvidence(after, record);
  assert.equal(after.analysis.verified, false);
  assert.equal(after.analysis.temperatureF, 72);
  record.evidence.push(after);
  await assert.rejects(verifyEvidence(record), /reported repair/);
  record.repairReported = true;
  assert.equal((await verifyEvidence(record)).verified, true);
  record.issue = "mold";
  assert.equal((await verifyEvidence(record)).verified, false);
});

test("real uploads are never verified by sample fallback", async () => {
  const restore = environment({ GEMINI_API_KEY: undefined });
  try {
    const record = createDemoCase("test");
    const upload = { ...record.evidence[0], id: "real-upload", isDemo: false };
    await assert.rejects(analyzeEvidence(upload, record), /not configured/);
    record.evidence.push({ ...upload, stage: "after" });
    record.repairReported = true;
    await assert.rejects(verifyEvidence(record), /sample evidence cannot verify/);
  } finally { restore(); }
});

test("Gemini enforces structured output and single-image analysis cannot verify a repair", async (t) => {
  const restore = environment({ GEMINI_API_KEY: "test-key-not-real", GEMINI_MODEL: "gemini-2.5-flash" });
  t.after(restore);
  const record = createDemoCase("test");
  const upload = { ...record.evidence[0], isDemo: false, dataUrl: "data:image/png;base64,aGVsbG8=", stage: "after" as const };
  let malformed = false;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2.5-flash:generateContent$/);
    assert.equal((options.headers as Record<string, string>)["x-goog-api-key"], "test-key-not-real");
    assert.equal(url.includes("test-key-not-real"), false);
    const body = JSON.parse(String(options.body));
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: malformed ? "{\"issueType\":\"heating\"}" : JSON.stringify({
      issueType: "heating", observations: ["A room thermometer appears to display 72 F."], evidenceType: "thermometer_photo",
      summary: "A room thermometer appears to be visible.", severity: "low", temperatureF: 72,
      confidence: 0.95, requiresHumanConfirmation: true,
    }) }] } }] });
  });
  assert.equal((await analyzeEvidence(upload, record)).verified, false);
  malformed = true;
  await assert.rejects(analyzeEvidence(upload, record), /invalid analysis/);
});

test("NYC lookup maps actual records and preserves partial unavailability", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    calls++;
    const url = new URL(input);
    assert.match(url.searchParams.get("$where") ?? "", /O''CONNOR STREET/);
    if (url.pathname.includes("ygpa-z7cr")) return Response.json([{ unique_key: "p1", complaint_id: "c1", received_date: "2026-09-01", major_category: "HEAT/HOT WATER", problem_code: "NO HEAT", complaint_status: "OPEN", post_code: "11201" }]);
    return new Response("Unavailable", { status: 503 });
  });
  assert.equal((await lookupBuilding("123 Example Street", "Brooklyn")).source, "demo");
  assert.equal(calls, 0);
  const record = await lookupBuilding("321 O'Connor Street", "Brooklyn");
  assert.equal(record.source, "nyc-open-data");
  assert.equal(record.complaints.length, 1);
  assert.equal(record.complaints[0].id, "p1");
  assert.equal(record.violations.length, 0);
  assert.match(record.warning ?? "", /Violation records are currently unavailable/);
  assert.equal(record.zip, "11201");
});

test("Nessie uses explicit mock account and rent payee with integer cents", async (t) => {
  const restore = environment({ NESSIE_ENABLED: "true", NESSIE_API_KEY: "test-key-not-real", NESSIE_TENANT_ID: "test", NESSIE_CUSTOMER_ID: "customer_123", NESSIE_ACCOUNT_ID: "account_456", NESSIE_RENT_PAYEE: "Landlord", NESSIE_BASE_URL: undefined });
  t.after(restore);
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    const url = new URL(input);
    if (url.pathname.includes("/customers/")) return Response.json({ _id: "customer_123" });
    if (url.pathname.endsWith("/purchases")) return Response.json([{ _id: "p1", payer_id: "account_456", amount: 47.99, purchase_date: "2026-09-01", description: "Heater", status: "completed" }, { _id: "p2", payer_id: "account_456", amount: 20, purchase_date: "2026-09-02", status: "cancelled" }]);
    if (url.pathname.endsWith("/bills")) return Response.json([{ _id: "b1", account_id: "account_456", payment_amount: 1850, payment_date: "2026-09-01", payee: "Landlord", status: "completed" }, { _id: "b2", account_id: "account_456", payment_amount: 99, payee: "Phone company", status: "completed" }]);
    return Response.json({ _id: "account_456", customer_id: "customer_123", balance: 2450.19 });
  });
  const context = await getFinancialContext(createDemoCase("test"));
  assert.equal(context.profile.accountBalanceCents, 245019);
  assert.equal(context.profile.transactions[0].amountCents, 4799);
  assert.equal(context.profile.transactions[0].relatedStatus, "suggested");
  assert.equal(context.profile.transactions.length, 1);
  assert.equal(context.rentHistory.length, 1);
  assert.equal(context.rentHistory[0].amountCents, 185000);
  assert.equal(context.rentHistory[0].source, "nessie");
});

test("Photon cannot send without opt-in and an exact approved recipient", async (t) => {
  const restore = environment({ PHOTON_LIVE_SEND: undefined, PHOTON_PROXY_TOKEN: "not-a-real-token", PHOTON_ALLOWED_RECIPIENT: "+12125550100" });
  t.after(restore);
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not contact provider"); });
  const record = createDemoCase("test");
  assert.equal((await sendLandlordMessage(record, "Please repair the heat.")).delivery, "demo");
  process.env.PHOTON_LIVE_SEND = "true";
  record.landlordContact = "+12125550101";
  await assert.rejects(sendLandlordMessage(record, "Please repair the heat."), (error: unknown) => {
    assert.ok(error instanceof IntegrationError);
    assert.equal(error.code, "rejected");
    assert.equal(error instanceof DeliveryUncertainError, false);
    return true;
  });
  assert.equal(fetch.mock.callCount(), 0);
});

test("Photon reports uncertain delivery when a dispatched request loses its receipt", async (t) => {
  const restore = environment({ PHOTON_LIVE_SEND: "true", PHOTON_PROXY_TOKEN: "not-a-real-token", PHOTON_ALLOWED_RECIPIENT: "+12125550100" });
  t.after(restore);
  const record = createDemoCase("test");
  record.landlordContact = "+12125550100";
  let response: "timeout" | "invalid-json" | "mismatch" | "success" = "timeout";
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    if (response === "timeout") throw new DOMException("Receipt timed out after acceptance", "TimeoutError");
    if (response === "invalid-json") return new Response("not-json", { status: 200 });
    return Response.json({ ok: true, data: { id: "provider-message-1", to: response === "mismatch" ? "+12125550101" : record.landlordContact, text: "Please repair the heat.", sentAt: 1 } });
  });
  const uncertain = (error: unknown) => {
    assert.ok(error instanceof DeliveryUncertainError);
    assert.equal(error.code, "uncertain_delivery");
    assert.match(error.message, /may have sent/);
    assert.match(error.message, /Check delivery before retrying/);
    return true;
  };
  await assert.rejects(sendLandlordMessage(record, "Please repair the heat."), uncertain);
  response = "invalid-json";
  await assert.rejects(sendLandlordMessage(record, "Please repair the heat."), uncertain);
  response = "mismatch";
  await assert.rejects(sendLandlordMessage(record, "Please repair the heat."), uncertain);
  response = "success";
  assert.equal((await sendLandlordMessage(record, "Please repair the heat.")).delivery, "sent");
  assert.equal(fetch.mock.callCount(), 4);
});

test("XRPL final validation rejects post-autofill changes and permits a valid offline signature", () => {
  const wallet = Wallet.generate();
  const destination = Wallet.generate().classicAddress;
  const approval: TestnetEscrowApproval = { caseId: "RE-TEST", escrowId: "ESC-TEST", ownerAddress: wallet.classicAddress, destination, amountUsdCents: 40000, amountDrops: "1000000", offerSequence: 123, finishAfter: 900000000, cancelAfter: 900086400 };
  const condition = conditionForPreimage("11".repeat(32));
  const expected = buildTestnetEscrowCreate(approval, condition);
  assert.equal(expected.Amount, "1000000");
  assert.notEqual(expected.Amount, String(approval.amountUsdCents));
  assert.throws(() => buildTestnetEscrowCreate(approval, ""), /timed-only/);
  const prepared = { ...expected, Fee: "12", LastLedgerSequence: 1020 };
  assert.doesNotThrow(() => assertFinalTestnetTransaction(prepared, expected, 1000));
  for (const changes of [
    { Destination: wallet.classicAddress }, { Amount: "40000" }, { Sequence: 124 },
    { Fee: "1001" }, { NetworkID: 0 }, { LastLedgerSequence: 2000 },
    { Condition: undefined }, { DestinationTag: 9 }, { Memos: [] },
  ]) assert.throws(() => assertFinalTestnetTransaction({ ...prepared, ...changes } as EscrowCreate, expected, 1000));
  const signed = wallet.sign(prepared);
  const decoded = decode(signed.tx_blob) as unknown as EscrowCreate;
  assert.doesNotThrow(() => assertFinalTestnetTransaction(decoded, expected, 1000));
  const finish = buildTestnetEscrowFinish(approval, "11".repeat(32));
  assert.equal(finish.OfferSequence, 123);
  assert.equal(finish.Condition, condition);
  assert.equal(finish.Fulfillment, `A0228020${"11".repeat(32)}`);
});

test("native XRP reserve checks never treat USD demo funds as XRP", () => {
  const input = { balanceDrops: "2200012", ownerCount: 0, reserveBaseXrp: 1, reserveIncrementXrp: 0.2, feeDrops: "12", amountDrops: "1000000", creating: true };
  assert.doesNotThrow(() => assertNativeXrpBalance(input));
  assert.throws(() => assertNativeXrpBalance({ ...input, balanceDrops: "2200011" }), /Insufficient spendable testnet XRP/);
  assert.throws(() => assertNativeXrpBalance({ ...input, balanceDrops: "245000" }), /USD demo balances/);
});

test("disabled testnet submissions are audited and never load or sign a case", async () => {
  const restore = environment({ XRPL_TESTNET_ENABLED: undefined });
  const failures: string[] = [];
  try {
    await assert.rejects(submitGuardedTestnetEscrow(makeIntent(createDemoCase("test"), "EscrowCreate"), {
      loadCase: async () => { throw new Error("Should not load"); },
      recordResult: async () => { throw new Error("Should not succeed"); },
      recordFailure: async (event) => { failures.push(event.detail); },
    }), /submission is disabled/);
    assert.equal(failures.length, 1);
  } finally { restore(); }
});

test("guarded testnet executor persists only validated success and rejects autofill tampering before signing", async (t) => {
  const wallet = Wallet.generate();
  const approval: TestnetEscrowApproval = { caseId: "RE-1042", escrowId: "ESC-RE-1042", ownerAddress: wallet.classicAddress, destination: Wallet.generate().classicAddress, amountUsdCents: 40000, amountDrops: "1000000", offerSequence: 123, finishAfter: 900000000, cancelAfter: 900086400 };
  const restore = environment({ XRPL_TESTNET_ENABLED: "true", XRPL_TESTNET_SEED: wallet.seed, XRPL_TESTNET_PREIMAGE_HEX: "11".repeat(32), XRPL_TESTNET_APPROVAL_JSON: JSON.stringify(approval),
    NESSIE_ENABLED: "true", NESSIE_API_KEY: "test-only-key", NESSIE_TENANT_ID: "test", NESSIE_CUSTOMER_ID: "customer_123", NESSIE_ACCOUNT_ID: "account_456", NESSIE_BASE_URL: undefined });
  t.after(restore);
  const record = createDemoCase("test");
  record.financialProfile!.binding.source = "nessie";
  let bankingAvailable = true;
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    if (!bankingAvailable) return new Response("Unavailable", { status: 503 });
    const path = new URL(input).pathname;
    if (path.includes("/customers/")) return Response.json({ _id: "customer_123" });
    if (path.endsWith("/purchases") || path.endsWith("/bills")) return Response.json([]);
    return Response.json({ _id: "account_456", customer_id: "customer_123", balance: 2430 });
  });
  Object.assign(record.escrow, { network: "testnet", destination: approval.destination, ownerAddress: approval.ownerAddress });
  let tamper = false;
  let validated = true;
  let balance = "50000000";
  const receipts: string[] = [];
  const failures: string[] = [];
  t.mock.method(Client.prototype, "connect", async () => undefined);
  t.mock.method(Client.prototype, "disconnect", async () => undefined);
  t.mock.method(Client.prototype, "isConnected", () => true);
  t.mock.method(Client.prototype, "getLedgerIndex", async () => 1000);
  t.mock.method(Client.prototype, "request", async (request: Parameters<Client["request"]>[0]) => {
    if (request.command === "server_info") return { result: { info: { network_id: 1, validated_ledger: { reserve_base_xrp: 1, reserve_inc_xrp: 0.2 } } } } as never;
    if (request.command === "ledger") return { result: { ledger: { close_time: 899999999 } } } as never;
    if (request.command === "account_info") return { result: { validated: true, account_data: { Account: wallet.classicAddress, Balance: balance, OwnerCount: 0, Sequence: 123 } } } as never;
    throw new Error("Unexpected ledger request");
  });
  t.mock.method(Client.prototype, "autofill", async (transaction: Parameters<Client["autofill"]>[0]) => ({ ...transaction, Fee: "12", LastLedgerSequence: 1020, ...(tamper ? { Amount: "999999" } : {}) }) as never);
  const originalSign = Wallet.prototype.sign;
  let signs = 0;
  t.mock.method(Wallet.prototype, "sign", function (this: Wallet, transaction: Parameters<Wallet["sign"]>[0], multisign?: Parameters<Wallet["sign"]>[1]) {
    signs++;
    return originalSign.call(this, transaction, multisign);
  });
  const submit = t.mock.method(Client.prototype, "submitAndWait", async (blob: Parameters<Client["submitAndWait"]>[0]) => ({ result: { validated, hash: hashes.hashSignedTx(String(blob)), ledger_index: 1001, meta: { TransactionResult: "tesSUCCESS" } } }) as never);
  const context = {
    loadCase: async () => structuredClone(record),
    recordResult: async (receipt: { hash: string }) => { receipts.push(receipt.hash); },
    recordFailure: async (event: { detail: string }) => { failures.push(event.detail); },
  };
  const intent = makeIntent(record, "EscrowCreate");
  const receipt = await submitGuardedTestnetEscrow(intent, context);
  assert.equal(receipt.result, "tesSUCCESS");
  assert.equal(receipts.length, 1);
  assert.equal(signs, 1);
  tamper = true;
  await assert.rejects(submitGuardedTestnetEscrow(intent, context), /approved Amount/);
  assert.equal(signs, 1);
  assert.equal(submit.mock.callCount(), 1);
  tamper = false;
  balance = "1";
  await assert.rejects(submitGuardedTestnetEscrow(intent, context), /Insufficient spendable/);
  assert.equal(signs, 1);
  balance = "50000000";
  validated = false;
  await assert.rejects(submitGuardedTestnetEscrow(intent, context), /No validated tesSUCCESS/);
  assert.equal(receipts.length, 1);
  assert.equal(failures.length, 3);
  bankingAvailable = false;
  const priorSigns = signs;
  const priorSubmissions = submit.mock.callCount();
  await assert.rejects(submitGuardedTestnetEscrow(intent, context), /Nessie API is unavailable/);
  assert.equal(signs, priorSigns);
  assert.equal(submit.mock.callCount(), priorSubmissions);
  assert.equal(failures.length, 4);
});

test("a Nessie outage at the second pre-sign refresh produces no signature or submission", async (t) => {
  const wallet = Wallet.generate();
  const approval: TestnetEscrowApproval = {
    caseId: "RE-1042", escrowId: "ESC-RE-1042", ownerAddress: wallet.classicAddress,
    destination: Wallet.generate().classicAddress, amountUsdCents: 40000, amountDrops: "1000000",
    offerSequence: 123, finishAfter: 900000000, cancelAfter: 900086400,
  };
  t.after(environment({
    XRPL_TESTNET_ENABLED: "true", XRPL_TESTNET_SEED: wallet.seed,
    XRPL_TESTNET_PREIMAGE_HEX: "11".repeat(32), XRPL_TESTNET_APPROVAL_JSON: JSON.stringify(approval),
    NESSIE_ENABLED: "true", NESSIE_API_KEY: "offline-test-key", NESSIE_TENANT_ID: "test",
    NESSIE_CUSTOMER_ID: "customer_123", NESSIE_ACCOUNT_ID: "account_456", NESSIE_BASE_URL: undefined,
  }));
  const record = createDemoCase("test");
  record.financialProfile!.binding.source = "nessie";
  Object.assign(record.escrow, { network: "testnet", destination: approval.destination, ownerAddress: approval.ownerAddress });

  const requestedPaths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    const path = new URL(input).pathname;
    requestedPaths.push(path);
    if (requestedPaths.length === 5) return new Response("Unavailable", { status: 503 });
    if (path === "/customers/customer_123") return Response.json({ _id: "customer_123" });
    if (path === "/accounts/account_456") return Response.json({ _id: "account_456", customer_id: "customer_123", balance: 2430 });
    if (path === "/accounts/account_456/purchases" || path === "/accounts/account_456/bills") return Response.json([]);
    throw new Error("Unexpected banking request");
  });
  t.mock.method(Client.prototype, "connect", async () => undefined);
  t.mock.method(Client.prototype, "disconnect", async () => undefined);
  t.mock.method(Client.prototype, "isConnected", () => true);
  t.mock.method(Client.prototype, "getLedgerIndex", async () => 1000);
  t.mock.method(Client.prototype, "request", async (request: Parameters<Client["request"]>[0]) => {
    if (request.command === "server_info") return { result: { info: { network_id: 1, validated_ledger: { reserve_base_xrp: 1, reserve_inc_xrp: 0.2 } } } } as never;
    if (request.command === "ledger") return { result: { ledger: { close_time: 899999999 } } } as never;
    if (request.command === "account_info") return { result: { validated: true, account_data: { Account: wallet.classicAddress, Balance: "50000000", OwnerCount: 0, Sequence: 123 } } } as never;
    throw new Error("Unexpected ledger request");
  });
  const autofill = t.mock.method(Client.prototype, "autofill", async (transaction: Parameters<Client["autofill"]>[0]) => ({ ...transaction, Fee: "12", LastLedgerSequence: 1020 }) as never);
  const sign = t.mock.method(Wallet.prototype, "sign", () => { throw new Error("Must not sign after banking verification fails"); });
  const submit = t.mock.method(Client.prototype, "submitAndWait", async () => { throw new Error("Must not submit after banking verification fails"); });
  let loads = 0;
  let receipts = 0;
  const failures: { detail: string; submittedHash?: string }[] = [];
  await assert.rejects(submitGuardedTestnetEscrow(makeIntent(record, "EscrowCreate"), {
    loadCase: async () => { loads++; return structuredClone(record); },
    recordResult: async () => { receipts++; },
    recordFailure: async (failure) => { failures.push(failure); },
  }), /Nessie API is unavailable/);

  assert.deepEqual(requestedPaths, [
    "/customers/customer_123", "/accounts/account_456", "/accounts/account_456/purchases",
    "/accounts/account_456/bills", "/customers/customer_123",
  ]);
  assert.equal(loads, 2, "The second authoritative case reload must be reached");
  assert.equal(autofill.mock.callCount(), 1, "The first banking preflight must allow transaction preparation");
  assert.equal(sign.mock.callCount(), 0);
  assert.equal(submit.mock.callCount(), 0);
  assert.equal(receipts, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].submittedHash, undefined);
});
