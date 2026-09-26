import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Client, Wallet, convertStringToHex, decode, isValidClassicAddress, validate, xrpToDrops, type EscrowCreate, type EscrowFinish, type Payment } from "xrpl";
import { z } from "zod";
import { evaluatePolicy } from "../policy";
import type { CaseRecord, TransactionIntent } from "../types";
import { assertServer, IntegrationError } from "./shared";

export const XRPL_TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const MAX_FEE_DROPS = 1000n;
const uint32 = z.number().int().positive().max(0xffffffff);
const classicAddress = z.string().refine(isValidClassicAddress, "A classic XRP Ledger address is required.");
const approvalSchema = z.object({
  caseId: z.string().min(1).max(80), escrowId: z.string().min(1).max(100),
  ownerAddress: classicAddress, destination: classicAddress,
  amountUsdCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  amountDrops: z.string().regex(/^[1-9]\d*$/).refine((value) => BigInt(value) <= 100_000_000n, "Testnet tooling is capped at 100 XRP."),
  offerSequence: uint32, finishAfter: uint32, cancelAfter: uint32,
}).strict().refine((value) => value.cancelAfter > value.finishAfter, "CancelAfter must follow FinishAfter.");

export type TestnetEscrowApproval = z.infer<typeof approvalSchema>;
export interface TestnetReceipt {
  caseId: string;
  escrowId: string;
  transactionType: "EscrowCreate" | "EscrowFinish";
  network: "testnet";
  ownerAddress: string;
  destination: string;
  amountDrops: string;
  offerSequence: number;
  hash: string;
  ledgerIndex: number;
  validated: true;
  result: "tesSUCCESS";
}
export interface TestnetExecutionContext {
  /** Load the authoritative, tenant-authorized case while holding its write lock. */
  loadCase: (caseId: string) => Promise<CaseRecord>;
  /** Persist before execution returns. Never put wallet seeds or fulfillment into this record. */
  recordResult: (receipt: TestnetReceipt) => Promise<void>;
  /** Required for both policy rejections and failed/uncertain submissions. */
  recordFailure: (event: { caseId: string; escrowId: string; detail: string; submittedHash?: string }) => Promise<void>;
}

function reject(message: string): never {
  throw new IntegrationError(message, "XRPL testnet", "rejected");
}

function checkedApproval(approval: TestnetEscrowApproval): TestnetEscrowApproval {
  const result = approvalSchema.safeParse(approval);
  if (!result.success) reject("Invalid testnet approval. Explicit case, owner, destination, native amount, and ledger sequence are required.");
  return result.data;
}

export function conditionForPreimage(preimageHex: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(preimageHex)) reject("A unique 32-byte testnet preimage is required.");
  // The fixed DER form is PREIMAGE-SHA-256 with a 32-byte fingerprint and cost 32.
  const fingerprint = createHash("sha256").update(Buffer.from(preimageHex, "hex")).digest("hex").toUpperCase();
  return `A0258020${fingerprint}810120`;
}

function bindingMemo(approval: TestnetEscrowApproval) {
  const binding = createHash("sha256").update(JSON.stringify({
    caseId: approval.caseId, escrowId: approval.escrowId, network: "testnet",
    owner: approval.ownerAddress, destination: approval.destination,
    amountDrops: approval.amountDrops, amountUsdCents: approval.amountUsdCents,
    offerSequence: approval.offerSequence,
  })).digest("hex").toUpperCase();
  return [{ Memo: { MemoType: convertStringToHex("rentescrow-case-v1"), MemoData: binding } }];
}

export function buildTestnetEscrowCreate(approvalInput: TestnetEscrowApproval, condition: string): EscrowCreate {
  const approval = checkedApproval(approvalInput);
  if (!/^A0258020[0-9A-F]{64}810120$/.test(condition)) reject("A 32-byte preimage condition is required; timed-only escrows are unsupported.");
  const transaction: EscrowCreate = {
    TransactionType: "EscrowCreate", Account: approval.ownerAddress, Destination: approval.destination,
    Amount: approval.amountDrops, Sequence: approval.offerSequence, Flags: 0,
    FinishAfter: approval.finishAfter, CancelAfter: approval.cancelAfter, Condition: condition,
    Memos: bindingMemo(approval),
  };
  validate(transaction);
  return transaction;
}

export function buildTestnetEscrowFinish(approvalInput: TestnetEscrowApproval, preimageHex: string): EscrowFinish {
  const approval = checkedApproval(approvalInput);
  const transaction: EscrowFinish = {
    TransactionType: "EscrowFinish", Account: approval.ownerAddress, Owner: approval.ownerAddress,
    OfferSequence: approval.offerSequence, Flags: 0,
    Condition: conditionForPreimage(preimageHex), Fulfillment: `A0228020${preimageHex.toUpperCase()}`,
    Memos: bindingMemo(approval),
  };
  validate(transaction);
  return transaction;
}

export function assertFinalTestnetTransaction(
  transaction: EscrowCreate | EscrowFinish | Payment,
  expected: EscrowCreate | EscrowFinish | Payment,
  ledgerIndex: number,
): void {
  const actual = transaction as unknown as Record<string, unknown>;
  const base = expected as unknown as Record<string, unknown>;
  const allowed = new Set([...Object.keys(base), "Fee", "Sequence", "LastLedgerSequence", "NetworkID", "SigningPubKey", "TxnSignature"]);
  if (Object.keys(actual).some((key) => !allowed.has(key))) reject("The prepared transaction contains an unapproved field.");
  for (const [key, value] of Object.entries(base)) {
    if (!isDeepStrictEqual(actual[key], value)) reject(`The prepared transaction changed the approved ${key} field.`);
  }
  if (actual.NetworkID !== undefined && actual.NetworkID !== 1) reject("Only the public XRP Ledger testnet is approved.");
  if (typeof actual.Fee !== "string" || !/^\d+$/.test(actual.Fee) || BigInt(actual.Fee) <= 0n || BigInt(actual.Fee) > MAX_FEE_DROPS) reject("The transaction fee is outside the approved testnet limit.");
  if (!Number.isSafeInteger(actual.Sequence) || Number(actual.Sequence) <= 0) reject("The transaction sequence is invalid.");
  if (!Number.isSafeInteger(actual.LastLedgerSequence) || Number(actual.LastLedgerSequence) <= ledgerIndex || Number(actual.LastLedgerSequence) > ledgerIndex + 25) reject("The transaction must expire within 25 ledger closes.");
  validate(transaction);
}

function assertCaseApproval(record: CaseRecord, intent: TransactionIntent, approval: TestnetEscrowApproval): void {
  const policy = evaluatePolicy(record, intent);
  if (!policy.approved) reject(`Escrow policy rejected the request: ${policy.checks.filter((check) => !check.passed).map((check) => check.label).join(", ")}.`);
  if (record.id !== approval.caseId || record.escrow.id !== approval.escrowId
    || record.escrow.network !== "testnet" || intent.network !== "testnet"
    || record.escrow.ownerAddress !== approval.ownerAddress || record.escrow.destination !== approval.destination
    || record.escrow.amountCents !== approval.amountUsdCents || intent.amountCents !== approval.amountUsdCents) {
    reject("The case does not match the server's explicit testnet approval.");
  }
  if (intent.transactionType === "EscrowFinish" && (record.escrow.sequence !== approval.offerSequence || !record.escrow.createHash)) {
    reject("The validated creation receipt is missing or belongs to a different escrow.");
  }
}

export function assertNativeXrpBalance(input: {
  balanceDrops: string; ownerCount: number; reserveBaseXrp: number; reserveIncrementXrp: number;
  feeDrops: string; amountDrops: string; creating: boolean;
}): void {
  if (!/^\d+$/.test(input.balanceDrops) || !/^\d+$/.test(input.feeDrops) || !/^[1-9]\d*$/.test(input.amountDrops)
    || !Number.isSafeInteger(input.ownerCount) || input.ownerCount < 0
    || !Number.isFinite(input.reserveBaseXrp) || input.reserveBaseXrp < 0
    || !Number.isFinite(input.reserveIncrementXrp) || input.reserveIncrementXrp < 0) reject("The ledger did not return valid native XRP balance and reserve data.");
  const ownerCount = BigInt(input.ownerCount + (input.creating ? 1 : 0));
  const reserve = BigInt(xrpToDrops(input.reserveBaseXrp)) + ownerCount * BigInt(xrpToDrops(input.reserveIncrementXrp));
  const required = reserve + BigInt(input.feeDrops) + (input.creating ? BigInt(input.amountDrops) : 0n);
  if (BigInt(input.balanceDrops) < required) reject("Insufficient spendable testnet XRP after the transaction fee and account reserve. USD demo balances do not fund XRP escrows.");
}

const pending = new Set<string>();

/** Isolated operator tooling. The HTTP application intentionally never calls this function. */
export async function submitGuardedTestnetEscrow(intent: TransactionIntent, context: TestnetExecutionContext): Promise<TestnetReceipt> {
  assertServer();
  const lockKey = `${intent.caseId}:${intent.escrowId}`;
  if (pending.has(lockKey)) {
    const detail = "A transaction is already pending for this escrow.";
    await context.recordFailure({ caseId: intent.caseId, escrowId: intent.escrowId, detail });
    reject(detail);
  }
  pending.add(lockKey);
  let client: Client | undefined;
  let submittedHash: string | undefined;
  try {
    if (process.env.XRPL_TESTNET_ENABLED !== "true") reject("Testnet submission is disabled. The application uses simulated funds.");
    let approval: TestnetEscrowApproval;
    try {
      approval = checkedApproval(JSON.parse(process.env.XRPL_TESTNET_APPROVAL_JSON ?? ""));
    } catch {
      reject("Configure a valid, explicit testnet approval before signing.");
    }
    const seed = process.env.XRPL_TESTNET_SEED;
    const preimageHex = process.env.XRPL_TESTNET_PREIMAGE_HEX;
    if (!seed || !preimageHex) reject("Testnet signing credentials and a unique escrow preimage are required.");
    const record = await context.loadCase(intent.caseId);
    assertCaseApproval(record, intent, approval);
    const wallet = Wallet.fromSeed(seed);
    if (wallet.classicAddress !== approval.ownerAddress) reject("The configured wallet is not the approved escrow owner.");
    const condition = conditionForPreimage(preimageHex);
    const expected = intent.transactionType === "EscrowCreate"
      ? buildTestnetEscrowCreate(approval, condition)
      : buildTestnetEscrowFinish(approval, preimageHex);
    client = new Client(XRPL_TESTNET_URL, { connectionTimeout: 10_000, timeout: 20_000 });
    await client.connect();
    const server = await client.request({ command: "server_info" });
    if (server.result.info.network_id !== 1) reject("The ledger server did not attest the expected testnet network ID.");
    const ledger = await client.request({ command: "ledger", ledger_index: "validated" });
    const closeTime = ledger.result.ledger.close_time;
    if (approval.cancelAfter <= closeTime || (intent.transactionType === "EscrowFinish" && approval.finishAfter > closeTime)) {
      reject("The escrow is not within its approved release window.");
    }
    if (intent.transactionType === "EscrowCreate" && approval.finishAfter <= closeTime) reject("Escrow creation requires a future FinishAfter time.");
    if (intent.transactionType === "EscrowFinish") {
      const original = await client.request({ command: "tx", transaction: record.escrow.createHash! });
      const meta = original.result.meta;
      const create = original.result.tx_json;
      if (original.result.validated !== true || typeof meta !== "object" || meta.TransactionResult !== "tesSUCCESS"
        || create.TransactionType !== "EscrowCreate" || create.Account !== approval.ownerAddress
        || create.Sequence !== approval.offerSequence || create.Destination !== approval.destination
        || create.Amount !== approval.amountDrops || create.Condition !== condition
        || create.FinishAfter !== approval.finishAfter || create.CancelAfter !== approval.cancelAfter
        || !isDeepStrictEqual(create.Memos, bindingMemo(approval))) reject("The validated escrow creation does not match this case approval.");
      const entry = await client.request({ command: "ledger_entry", ledger_index: "validated", escrow: { owner: approval.ownerAddress, seq: approval.offerSequence } });
      const escrow = entry.result.node;
      if (entry.result.validated !== true || escrow?.LedgerEntryType !== "Escrow"
        || escrow.Account !== approval.ownerAddress || escrow.Destination !== approval.destination
        || escrow.Amount !== approval.amountDrops || escrow.Condition !== condition
        || escrow.FinishAfter !== approval.finishAfter || escrow.CancelAfter !== approval.cancelAfter) reject("The current ledger escrow does not match the approved amount and destination.");
    }
    const prepared = await client.autofill(structuredClone(expected));
    const ledgerIndex = await client.getLedgerIndex();
    assertFinalTestnetTransaction(prepared, expected, ledgerIndex);
    const account = await client.request({ command: "account_info", ledger_index: "validated", account: approval.ownerAddress, strict: true });
    const reserve = server.result.info.validated_ledger;
    if (account.result.validated !== true || account.result.account_data.Account !== approval.ownerAddress || !reserve) reject("Validated native XRP account data is required before signing.");
    if (account.result.account_data.Sequence !== prepared.Sequence) reject("The account sequence has changed or the approved creation was already submitted.");
    assertNativeXrpBalance({
      balanceDrops: account.result.account_data.Balance, ownerCount: account.result.account_data.OwnerCount,
      reserveBaseXrp: reserve.reserve_base_xrp, reserveIncrementXrp: reserve.reserve_inc_xrp,
      feeDrops: prepared.Fee!, amountDrops: approval.amountDrops, creating: expected.TransactionType === "EscrowCreate",
    });
    const freshRecord = await context.loadCase(intent.caseId);
    assertCaseApproval(freshRecord, intent, approval);
    if (JSON.stringify(freshRecord) !== JSON.stringify(record)) reject("The case changed while the transaction was being prepared. Review it and retry.");
    // Nothing may edit the transaction between final policy validation and signing.
    const signed = wallet.sign(prepared);
    const decoded = decode(signed.tx_blob) as unknown as EscrowCreate | EscrowFinish;
    assertFinalTestnetTransaction(decoded, expected, ledgerIndex);
    if (decoded.SigningPubKey !== wallet.publicKey) reject("The signed transaction has an unexpected signing key.");
    submittedHash = signed.hash;
    const response = await client.submitAndWait(signed.tx_blob);
    const result = response.result;
    if (result.validated !== true || result.hash !== signed.hash || typeof result.meta !== "object"
      || result.meta.TransactionResult !== "tesSUCCESS" || !Number.isSafeInteger(result.ledger_index)) {
      reject("No validated tesSUCCESS receipt was returned. Do not change the escrow state; reconcile the transaction hash first.");
    }
    const receipt: TestnetReceipt = {
      caseId: approval.caseId, escrowId: approval.escrowId,
      transactionType: expected.TransactionType, network: "testnet", ownerAddress: approval.ownerAddress,
      destination: approval.destination, amountDrops: approval.amountDrops, offerSequence: approval.offerSequence,
      hash: result.hash, ledgerIndex: result.ledger_index!, validated: true, result: "tesSUCCESS",
    };
    await context.recordResult(receipt);
    return receipt;
  } catch (error) {
    const detail = error instanceof IntegrationError ? error.message : "Testnet execution did not complete. Reconcile any submitted hash before retrying; no success was recorded.";
    await context.recordFailure({ caseId: intent.caseId, escrowId: intent.escrowId, detail, ...(submittedHash ? { submittedHash } : {}) });
    throw new IntegrationError(detail, "XRPL testnet", "rejected");
  } finally {
    pending.delete(lockKey);
    if (client?.isConnected()) await client.disconnect().catch(() => undefined);
  }
}
