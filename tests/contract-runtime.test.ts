import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Client, Wallet, decode, hashes, type Payment } from "xrpl";
import type { AuthUser } from "../src/lib/types";
import { prepareParticipantMessage } from "../src/lib/integrations/photon";
import { RLUSD_CURRENCY, RLUSD_TESTNET_ISSUER } from "../src/lib/xrpl-assets";
import { acceptContract, createCaseForContract, createContract } from "../src/lib/server/contracts";
import { evaluateActiveContracts, performCaseAction, receiveParticipantMessage,
  type ParticipantMessagingDependencies } from "../src/lib/server/cases";
import { createSession, mutateSession, readSession } from "../src/lib/server/store";
import { readXrplJournal } from "../src/lib/server/xrpl-journal";

function environment(t: TestContext, values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
}

function ledger(t: TestContext, source: Wallet, destination: string, amount = "10") {
  const state = { signs: 0, submits: 0 };
  t.mock.method(Client.prototype, "connect", async () => undefined);
  t.mock.method(Client.prototype, "disconnect", async () => undefined);
  t.mock.method(Client.prototype, "isConnected", () => true);
  t.mock.method(Client.prototype, "getLedgerIndex", async () => 1000);
  t.mock.method(Client.prototype, "request", async (request: Parameters<Client["request"]>[0]) => {
    if (request.command === "server_info") return { result: { info: { network_id: 1,
      validated_ledger: { reserve_base_xrp: 1, reserve_inc_xrp: 0.2 } } } } as never;
    if (request.command === "account_lines") return { result: { validated: true, account: request.account,
      ledger_index: 1000, lines: [{ account: RLUSD_TESTNET_ISSUER, currency: RLUSD_CURRENCY,
        balance: request.account === source.classicAddress ? "100" : "0", limit: "1000", quality_in: 0, quality_out: 0 }] } } as never;
    if (request.command === "account_info") return { result: { validated: true, ledger_index: 1000,
      account_data: { Account: request.account, Balance: "50000000", OwnerCount: 2,
        Sequence: request.account === source.classicAddress ? 123 : 1, Flags: 0 } } } as never;
    throw new Error(`Unexpected ledger request: ${request.command}`);
  });
  t.mock.method(Client.prototype, "autofill", async (transaction: Parameters<Client["autofill"]>[0]) => ({
    ...transaction, Fee: "12", Sequence: 123, LastLedgerSequence: 1020,
  }) as never);
  const sign = Wallet.prototype.sign;
  t.mock.method(Wallet.prototype, "sign", function (this: Wallet, ...args: Parameters<Wallet["sign"]>) {
    state.signs++;
    return sign.apply(this, args);
  });
  t.mock.method(Client.prototype, "submitAndWait", async (blob: Parameters<Client["submitAndWait"]>[0]) => {
    state.submits++;
    const transaction = decode(String(blob)) as unknown as Payment;
    return { result: { validated: true, hash: hashes.hashSignedTx(String(blob)), ledger_index: 1001,
      tx_json: { ...transaction, Amount: undefined, DeliverMax: transaction.Amount },
      meta: { TransactionResult: "tesSUCCESS", delivered_amount: {
        currency: RLUSD_CURRENCY, issuer: RLUSD_TESTNET_ISSUER, value: amount,
      }, TransactionIndex: 0, AffectedNodes: [] } } } as never;
  });
  return state;
}

async function agreement(t: TestContext, mode: "rent" | "dispute", signLandlord = true) {
  const source = Wallet.generate();
  const destination = Wallet.generate().classicAddress;
  environment(t, {
    RENTESCROW_STORAGE: "local", NESSIE_ENABLED: "false",
    XRPL_SETTLEMENT_ENABLED: "true", XRPL_SETTLEMENT_ASSET: "RLUSD", XRPL_NETWORK: "testnet",
    XRPL_RPC_URL: "wss://s.altnet.rippletest.net:51233", XRPL_TENANT_SEED: source.seed,
    XRPL_TENANT_ADDRESS: source.classicAddress, XRPL_LANDLORD_ADDRESS: destination,
    XRPL_RLUSD_LANDLORD_ADDRESS: destination, XRPL_RLUSD_ISSUER: RLUSD_TESTNET_ISSUER,
    XRPL_RLUSD_CURRENCY: "RLUSD", XRPL_SETTLEMENT_AMOUNT_RLUSD: "10",
  });
  const { document } = await createSession();
  const tenant: AuthUser = { id: `tenant-${document.ownerId.slice(0, 8)}`, role: "tenant", displayName: "Rayaan",
    email: "tenant@example.test", workspaceOwnerId: document.ownerId };
  const landlord: AuthUser = { id: `landlord-${document.ownerId.slice(0, 8)}`, role: "landlord", displayName: "Alex Morgan",
    email: "landlord@example.test", workspaceOwnerId: `landlord-${document.ownerId}` };
  await mutateSession(document.ownerId, (stored) => {
    stored.cases = [];
    stored.contracts = [];
    stored.tenantUserId = tenant.id;
    stored.tenantDisplayName = tenant.displayName;
    stored.xrplAuthorized = true;
    stored.accountBalanceCents = 1_000_000;
    stored.simulatedDebitsCents = 0;
    stored.managedProperty = { id: "property-contract-runtime", address: "123 Example Street", borough: "Brooklyn",
      landlordUserId: landlord.id, landlordDisplayName: landlord.displayName };
  });
  const contract = await createContract(document.ownerId, {
    case_type: "bilateral", terms: "Prototype agreement containing a contract-configured demo policy.",
    policy: { effectiveDate: `${new Date().toISOString().slice(0, 7)}-01`, dueDay: 1, monthlyRentCents: 40_000,
      gracePeriodDays: 3, lateFeeCents: 2_500, maxLateFeeCents: 2_500,
      monetaryDefaultAfterDays: 10, repairDeadlineDays: 30 },
  }, tenant);
  await acceptContract(document.ownerId, contract.id, "tenant", tenant,
    { termsHash: contract.termsHash, policyHash: contract.policyHash });
  if (!signLandlord) return { ownerId: document.ownerId, tenant, landlord, source, destination, contract };
  await acceptContract(document.ownerId, contract.id, "landlord", landlord,
    { termsHash: contract.termsHash, policyHash: contract.policyHash });
  const record = await createCaseForContract(document.ownerId, { contractId: contract.id, mode });
  return { ownerId: document.ownerId, tenant, landlord, source, destination, contract, record };
}

test("both authenticated signatures are required, then escrow funding autonomously settles normal rent", async (t) => {
  const unsigned = await agreement(t, "rent", false);
  const connect = t.mock.method(Client.prototype, "connect", async () => undefined);
  await assert.rejects(createCaseForContract(unsigned.ownerId, { contractId: unsigned.contract.id, mode: "rent" }),
    /fully accepted contract/i);
  assert.equal(connect.mock.callCount(), 0);

  await acceptContract(unsigned.ownerId, unsigned.contract.id, "landlord", unsigned.landlord,
    { termsHash: unsigned.contract.termsHash, policyHash: unsigned.contract.policyHash });
  const record = await createCaseForContract(unsigned.ownerId, { contractId: unsigned.contract.id, mode: "rent" });
  t.mock.restoreAll();
  const chain = ledger(t, unsigned.source, unsigned.destination);
  const result = await performCaseAction(unsigned.ownerId, record.id, { action: "create_escrow" });
  assert.equal(chain.signs, 1);
  assert.equal(chain.submits, 1);
  assert.equal(result.case.xrplSettlement?.status, "validated");
  assert.equal(result.case.xrplSettlement?.requestedAction, "RELEASE_RENT");
  assert.equal(result.case.escrow.status, "released");
  assert.equal(result.case.xrplSettlement?.agentAuthorizedAt !== undefined, true);
  assert.equal(result.case.xrplSettlement?.agentRequestedAt !== undefined, true);

  const paymentAudit = result.case.escrow.audit.findLast((entry) => entry.action === "Payment" && entry.status === "validated");
  assert.equal(paymentAudit?.actor, "settlement_agent");
  assert.equal(paymentAudit?.contractId, unsigned.contract.id);
  assert.equal(paymentAudit?.policyHash, unsigned.contract.policyHash);
  assert.equal(paymentAudit?.triggeringEvent, "escrow_funded");
  assert.ok(paymentAudit?.evaluatedRules?.some((rule) => rule.key === "CONTRACT_ACTION_ALLOWED" && rule.passed));
  const journal = await readXrplJournal(result.case.xrplSettlement!);
  assert.equal(journal?.receipt?.contractId, unsigned.contract.id);
  assert.equal(journal?.receipt?.policyHash, unsigned.contract.policyHash);
  assert.equal(journal?.receipt?.triggeringEvent, "escrow_funded");

  await evaluateActiveContracts(unsigned.ownerId);
  assert.equal(chain.submits, 1, "scheduled replay must not sign or submit again");
  await assert.rejects(createCaseForContract(unsigned.ownerId, { contractId: unsigned.contract.id, mode: "rent" }),
    /unused contract/i);
  const attacks = {
    wallet_switch: "DESTINATION_WALLET_MISMATCH", amount_tamper: "AMOUNT_OUTSIDE_AUTHORIZATION",
    issuer_tamper: "ASSET_DEFINITION_MISMATCH", wrong_network: "WRONG_NETWORK",
    prompt_injection: "DESTINATION_WALLET_MISMATCH", insufficient_funds: "INSUFFICIENT_RLUSD_FUNDS",
    wrong_case: "WRONG_CASE", wrong_asset: "ASSET_NOT_APPROVED", duplicate: "SETTLEMENT_ALREADY_COMPLETED",
    excess_fee: "FEE_EXCEEDS_CONTRACT_POLICY", unsupported_action: "ACTION_NOT_PERMITTED_BY_CONTRACT",
    mutate_terms: "CONTRACT_HASH_MISMATCH",
  } as const;
  for (const [scenario, expectedCode] of Object.entries(attacks) as [keyof typeof attacks, string][]) {
    const signCountBefore: number = chain.signs;
    const submitCountBefore: number = chain.submits;
    const demo = await performCaseAction(unsigned.ownerId, record.id, { action: "contract_security_demo", scenario });
    assert.equal(demo.policy?.approved, false);
    assert.equal(chain.signs, signCountBefore);
    assert.equal(chain.submits, submitCountBefore);
    assert.equal(demo.case.escrow.audit.at(-1)?.code, expectedCode, scenario);
    assert.match(demo.case.escrow.audit.at(-1)?.detail ?? "", /Nothing signed\. Nothing submitted\./);
  }
});

test("an active dispute holds a ready permission and signs only after tenant factual confirmation", async (t) => {
  const setup = await agreement(t, "dispute");
  const chain = ledger(t, setup.source, setup.destination);
  const funded = await performCaseAction(setup.ownerId, setup.record!.id, { action: "create_escrow" });
  assert.equal(funded.case.escrow.status, "locked");
  assert.equal(funded.case.xrplSettlement?.status, "ready");
  assert.equal(funded.case.contractEvaluation?.reason, "ACTIVE_DISPUTE");
  assert.equal(chain.signs, 0);
  assert.equal(chain.submits, 0);

  const before = await performCaseAction(setup.ownerId, setup.record!.id, { action: "add_demo_evidence", stage: "before" });
  await performCaseAction(setup.ownerId, setup.record!.id, { action: "analyze_evidence", evidenceId: before.case.evidence.at(-1)!.id });
  const tenantPhone = "+19736060558", landlordPhone = "+12018567033", conversationId = `any;-;${landlordPhone}`;
  environment(t, { PHOTON_LIVE_SEND: "true", SPECTRUM_PROJECT_ID: "offline-project",
    SPECTRUM_PROJECT_SECRET: "offline-secret", PHOTON_TENANT_PHONE: tenantPhone,
    PHOTON_ALLOWED_RECIPIENT: landlordPhone, SPECTRUM_SENDING_LINE: "shared",
    PHOTON_TENANT_ID: setup.ownerId, PHOTON_CASE_ID: setup.record!.id });
  await mutateSession(setup.ownerId, (document) => {
    document.messagingContacts = { tenantPhone, landlordPhone };
    const record = document.cases.find((item) => item.id === setup.record!.id)!;
    record.landlordContact = landlordPhone;
    record.tenantPhone = tenantPhone;
    record.messagingBinding = { ownerId: setup.ownerId, caseId: record.id,
      tenant: { userId: setup.tenant.id, phone: tenantPhone },
      landlord: { userId: setup.landlord.id, phone: landlordPhone, conversationId, sendingLine: "shared" } };
  });
  let classifications = 0;
  const dependencies: ParticipantMessagingDependencies = {
    prepare: prepareParticipantMessage,
    classify: async () => { classifications++; return { intent: "repair_complete", summary: "The repair was reported complete.", source: "rules" }; },
    relay: () => undefined,
    send: async () => { assert.fail("The contract hook test must not send a physical message"); },
  };
  const incoming = { id: "contract-repair-complete", conversationId, sender: landlordPhone, sendingLine: "shared",
    body: "The heating repair has been completed and is ready for tenant evidence review.", createdAt: new Date().toISOString() };
  const received = await receiveParticipantMessage(setup.ownerId, incoming, dependencies);
  assert.equal(received.processing.intent, "repair_complete");
  assert.equal(received.case.repairReported, true);
  assert.equal(received.case.verification, undefined);
  assert.equal(received.case.tenantConfirmed, false);
  assert.equal(received.case.contractTrigger, "repair_reported");
  await receiveParticipantMessage(setup.ownerId, incoming, dependencies);
  const afterDuplicate = (await readSession(setup.ownerId))!.cases.find((item) => item.id === setup.record!.id)!;
  assert.equal(classifications, 1, "a duplicate provider event is not interpreted or evaluated again");
  assert.equal(afterDuplicate.repairs?.filter((item) => item.kind === "reported_complete").length, 1);
  assert.equal(afterDuplicate.escrow.audit.filter((item) => item.action === "PolicyCheck"
    && item.triggeringEvent === "repair_reported").length, 1);
  const after = await performCaseAction(setup.ownerId, setup.record!.id, { action: "add_demo_evidence", stage: "after" });
  await performCaseAction(setup.ownerId, setup.record!.id, { action: "analyze_evidence", evidenceId: after.case.evidence.at(-1)!.id });
  await performCaseAction(setup.ownerId, setup.record!.id, { action: "verify_repair" });
  assert.equal(chain.signs, 0, "repair facts alone do not bypass required tenant confirmation");

  const settled = await performCaseAction(setup.ownerId, setup.record!.id, { action: "confirm_resolution" });
  assert.equal(settled.case.tenantConfirmed, true);
  assert.equal(settled.case.xrplSettlement?.status, "validated");
  assert.equal(chain.signs, 1);
  assert.equal(chain.submits, 1);
  assert.equal(settled.case.escrow.audit.filter((entry) => entry.action === "Payment" && entry.status === "validated").length, 1);
  const payment = settled.case.escrow.audit.find((entry) => entry.action === "Payment" && entry.status === "validated");
  assert.equal(payment?.triggeringEvent, "tenant_confirmed_repair");
  const closure = settled.case.escrow.audit.findLast((entry) => entry.action === "PolicyCheck"
    && entry.triggeringEvent === "dispute_closed");
  assert.equal(closure?.code, "ALREADY_SETTLED");
  assert.equal(closure?.signed, false);
  assert.equal(closure?.submitted, false);
});

test("scheduled evaluator uses the same signed policy and guarded settlement path", async (t) => {
  const setup = await agreement(t, "rent");
  await mutateSession(setup.ownerId, (document) => {
    const record = document.cases.find((item) => item.id === setup.record!.id)!;
    record.escrow.status = "locked";
    record.escrow.lockedAt = new Date().toISOString();
    document.simulatedDebitsCents += record.escrow.amountCents;
    document.accountBalanceCents -= record.escrow.amountCents;
  });
  const chain = ledger(t, setup.source, setup.destination);
  const dryRun = await evaluateActiveContracts(setup.ownerId, { dryRun: true });
  assert.equal(dryRun[0]?.reason, "NORMAL_RENT_RELEASE");
  assert.equal(chain.signs, 0);
  const result = await evaluateActiveContracts(setup.ownerId);
  assert.equal(result[0]?.status, "validated");
  assert.equal(chain.signs, 1);
  assert.equal(chain.submits, 1);
  const stored = await readSession(setup.ownerId);
  assert.equal(stored?.cases.find((item) => item.id === setup.record!.id)?.xrplSettlement?.triggeringEvent, "scheduled_evaluation");
});
