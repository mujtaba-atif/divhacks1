import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client, Wallet, decode, isValidClassicAddress, TrustSetFlags, type TrustSet, type TxResponse } from "xrpl";
import { assertFinalTestnetTransaction, XRPL_TESTNET_URL } from "../src/lib/integrations/xrpl-testnet";
import { assertRlusdReadiness, assertXrplSpendableBalance, assertXrplTestnetEnvironment,
  readRlusdTrustLine, XrplError } from "../src/lib/integrations/xrpl-settlement";
import { canonicalSettlementAmount, compareDecimal, MAX_RLUSD_AMOUNT, RLUSD_CURRENCY, RLUSD_TESTNET_ISSUER } from "../src/lib/xrpl-assets";
import { withXrplWalletLock } from "../src/lib/server/store";
import { assertXrplWalletAvailable } from "../src/lib/server/xrpl-journal";
import { closeMongoConnection } from "../src/lib/server/mongodb";

// This is operator setup only. The settlement agent cannot request TrustSet or faucet funding.
const envPath = path.resolve(".env.local");
const options = new Set(process.argv.slice(2));
const checkOnly = options.has("--check");
function fail(message: string): never { throw new XrplError("RLUSD_SETUP", message); }

async function setup() {
  if ([...options].some((value) => !["--check", "--create-recipient", "--fund"].includes(value))
    || (checkOnly && options.size !== 1)) fail("Use --check alone, or optional --create-recipient and --fund.");
  assertXrplTestnetEnvironment();
  execFileSync("git", ["check-ignore", "--quiet", ".env.local"], { stdio: "ignore" });
  if (execFileSync("git", ["ls-files", "--", ".env.local"], { encoding: "utf8" }).trim()) fail(".env.local must be ignored and untracked.");
  if (!(await lstat(envPath)).isFile()) fail(".env.local must be a regular file.");
  await chmod(envPath, 0o600);
  await mkdir(".data", { recursive: true, mode: 0o700 });
  const lockPath = path.resolve(".data/xrpl-setup.lock");
  const lock = await open(lockPath, "wx", 0o600);
  let client: Client | undefined;
  try {
    let contents = await readFile(envPath, "utf8");
    async function persist(values: Record<string, string>) {
      for (const [key, value] of Object.entries(values)) {
        const matcher = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, "gm");
        contents = matcher.test(contents) ? contents.replace(matcher, `${key}=${value}`)
          : `${contents}${contents.endsWith("\n") ? "" : "\n"}${key}=${value}\n`;
      }
      const temporary = `${envPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
        await rename(temporary, envPath);
      } finally { await unlink(temporary).catch(() => undefined); }
    }
    const amount = canonicalSettlementAmount(process.env.XRPL_SETTLEMENT_AMOUNT_RLUSD ?? "10", MAX_RLUSD_AMOUNT);
    if (process.env.XRPL_RLUSD_ISSUER && process.env.XRPL_RLUSD_ISSUER !== RLUSD_TESTNET_ISSUER) fail("Issuer differs from Ripple's documented Testnet RLUSD issuer.");
    if (process.env.XRPL_RLUSD_CURRENCY && !["RLUSD", RLUSD_CURRENCY].includes(process.env.XRPL_RLUSD_CURRENCY)) fail("Currency differs from Ripple's documented RLUSD definition.");
    if (!process.env.XRPL_TENANT_SEED) fail("Run pnpm xrpl:setup-testnet first to create the source Testnet wallet.");
    const source = Wallet.fromSeed(process.env.XRPL_TENANT_SEED);
    if (source.classicAddress !== process.env.XRPL_TENANT_ADDRESS) fail("Source seed/address mismatch.");
    let recipientAddress = process.env.XRPL_RLUSD_LANDLORD_ADDRESS ?? process.env.XRPL_LANDLORD_ADDRESS;
    let recipient = process.env.XRPL_RLUSD_LANDLORD_SEED ? Wallet.fromSeed(process.env.XRPL_RLUSD_LANDLORD_SEED) : undefined;
    if (recipient && recipient.classicAddress !== recipientAddress) fail("RLUSD recipient seed/address mismatch.");
    if (options.has("--create-recipient") && !process.env.XRPL_RLUSD_LANDLORD_ADDRESS) {
      // Dedicated RLUSD recipient preserves the existing XRP recipient and its historical permissions.
      recipient = Wallet.generate();
      recipientAddress = recipient.classicAddress;
      await persist({ XRPL_RLUSD_LANDLORD_ADDRESS: recipientAddress, XRPL_RLUSD_LANDLORD_SEED: recipient.seed! });
      console.log(`Created dedicated RLUSD Testnet recipient: ${recipientAddress}. Credential saved only to .env.local.`);
    }
    if (!recipientAddress || !isValidClassicAddress(recipientAddress) || recipientAddress === source.classicAddress
      || [recipientAddress, source.classicAddress].includes(RLUSD_TESTNET_ISSUER)) fail("Distinct holder wallets are required.");
    client = new Client(XRPL_TESTNET_URL, { connectionTimeout: 15_000, timeout: 25_000 });
    await client.connect();
    const connected = client;
    async function network() {
      const info = await connected.request({ command: "server_info" });
      if (info.result.info.network_id !== 1 || !info.result.info.validated_ledger) fail("Validated public Testnet required.");
      return info.result.info.validated_ledger;
    }
    await network();

    async function ensureLine(address: string, wallet?: Wallet) {
      await withXrplWalletLock(address, async () => {
        await assertXrplWalletAvailable(address);
        let account;
        try { account = await connected.request({ command: "account_info", account: address, ledger_index: "validated", strict: true }); }
        catch (error) {
          if ((error as { data?: { error?: string } }).data?.error !== "actNotFound" || checkOnly || !wallet) throw error;
          await connected.fundWallet(wallet, { usageContext: "RentEscrow RLUSD Testnet trust-line setup" });
          account = await connected.request({ command: "account_info", account: address, ledger_index: "validated", strict: true });
        }
        if (account.result.validated !== true || account.result.account_data.Account !== address) fail("Validated holder account required.");
        const expected: TrustSet = { TransactionType: "TrustSet", Account: address,
          LimitAmount: { issuer: RLUSD_TESTNET_ISSUER, currency: RLUSD_CURRENCY, value: MAX_RLUSD_AMOUNT },
          Flags: TrustSetFlags.tfSetNoRipple };
        const pendingPath = path.resolve(`.data/xrpl-rlusd-trustline-${address}.json`);
        let previous: { hash: string; ledgerIndex: number; sequence: number; lastLedgerSequence: number } | undefined;
        try { previous = JSON.parse(await readFile(pendingPath, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        function verify(result: TxResponse<TrustSet>["result"], pending: NonNullable<typeof previous>) {
          if (!/^[A-F0-9]{64}$/.test(pending.hash) || result.hash !== pending.hash || result.validated !== true
            || !result.ledger_index || result.ledger_index <= pending.ledgerIndex || result.ledger_index > pending.lastLedgerSequence
            || typeof result.meta !== "object" || result.meta.TransactionResult !== "tesSUCCESS") fail("TrustSet has no matching validated success; inspect its saved public hash before proceeding.");
          const tx = { ...result.tx_json } as unknown as Record<string, unknown>;
          for (const annotation of ["date", "hash", "ledger_index", "ctid", "inLedger"]) delete tx[annotation];
          assertFinalTestnetTransaction(tx as unknown as TrustSet, { ...expected, Sequence: pending.sequence,
            LastLedgerSequence: pending.lastLedgerSequence }, pending.ledgerIndex);
        }
        if (previous) {
          const tx = await connected.request({ command: "tx", transaction: previous.hash, binary: false });
          verify(tx.result as TxResponse<TrustSet>["result"], previous);
          console.log(`Validated existing trust-line receipt: ${previous.hash}`);
        }
        const ledgerIndex = await connected.getLedgerIndex();
        const line = await readRlusdTrustLine(connected, address, ledgerIndex);
        if (line && compareDecimal(line.limit, amount) >= 0) {
          console.log(`Approved RLUSD trust line: ${address}; balance ${line.balance} Testnet RLUSD.`);
          return;
        }
        if (checkOnly) fail(`RLUSD trust line missing or limit too low for ${address}. Run setup without --check.`);
        if (!wallet) fail("Recipient needs a trust line but no matching setup seed is available. Supply XRPL_RLUSD_LANDLORD_SEED or use --create-recipient for a dedicated recipient.");
        if (previous) fail("A prior TrustSet exists but no longer satisfies setup. Review the existing trust line before changing it.");
        const prepared = await connected.autofill(expected);
        const reserves = await network();
        const fresh = await connected.request({ command: "account_info", account: address, ledger_index: "validated", strict: true });
        if (fresh.result.validated !== true || fresh.result.account_data.Account !== address
          || fresh.result.account_data.Sequence !== prepared.Sequence) fail("Wallet changed during setup; retry.");
        assertXrplSpendableBalance({ balanceDrops: fresh.result.account_data.Balance,
          ownerCount: fresh.result.account_data.OwnerCount + (line ? 0 : 1), reserveBaseXrp: reserves.reserve_base_xrp,
          reserveIncrementXrp: reserves.reserve_inc_xrp, feeDrops: prepared.Fee!, amountDrops: "0" });
        assertXrplTestnetEnvironment();
        assertFinalTestnetTransaction(prepared, expected, ledgerIndex);
        if (prepared.SigningPubKey || prepared.TxnSignature) fail("Setup received signing fields from outside its signer.");
        const signed = wallet.sign(prepared);
        assertFinalTestnetTransaction(decode(signed.tx_blob) as unknown as TrustSet, expected, ledgerIndex);
        const pending = { hash: signed.hash, ledgerIndex, sequence: prepared.Sequence!, lastLedgerSequence: prepared.LastLedgerSequence! };
        // Persist only public metadata before dispatch. A lost response never triggers a replacement.
        const file = await open(pendingPath, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(pending)); await file.sync(); } finally { await file.close(); }
        const result = await connected.submitAndWait(signed.tx_blob);
        verify(result.result as TxResponse<TrustSet>["result"], pending);
        console.log(`TrustSet validated: ${address}; https://testnet.xrpl.org/transactions/${signed.hash}`);
      });
    }
    await ensureLine(source.classicAddress, source);
    await ensureLine(recipientAddress, recipient);
    // Pin RLUSD even if faucet funding is still required. Never silently fall
    // back to paying XRP when an RLUSD setup or balance check fails.
    if (!checkOnly) await persist({ XRPL_SETTLEMENT_ASSET: "RLUSD", XRPL_RLUSD_ISSUER: RLUSD_TESTNET_ISSUER,
      XRPL_RLUSD_CURRENCY: "RLUSD", XRPL_SETTLEMENT_AMOUNT_RLUSD: amount });
    if (options.has("--fund")) {
      const line = await readRlusdTrustLine(connected, source.classicAddress, await connected.getLedgerIndex());
      if (!line || compareDecimal(line.balance, amount) < 0) {
        // Official faucet referenced by Ripple; public address only, never credentials.
        const response = await fetch("https://tryrlusd.com/api/mint-xrpl", { method: "POST",
          headers: { "Content-Type": "application/json", Origin: "https://tryrlusd.com" },
          body: JSON.stringify({ address: source.classicAddress }), signal: AbortSignal.timeout(60_000) });
        if (response.status === 401) fail(`RLUSD funding requires GitHub sign-in at https://tryrlusd.com/. Select XRPL Testnet and fund ${source.classicAddress} using only this public address, then rerun pnpm xrpl:setup-rlusd. RLUSD remains selected; settlement blocks until funded.`);
        if (!response.ok) fail(`RLUSD faucet unavailable or rate limited. Visit https://tryrlusd.com/ and fund ${source.classicAddress}, then rerun pnpm xrpl:setup-rlusd.`);
        const body = await response.json() as { txHash?: unknown };
        if (typeof body.txHash === "string" && /^[A-F0-9]{64}$/i.test(body.txHash)) console.log(`Faucet transaction: https://testnet.xrpl.org/transactions/${body.txHash}`);
      }
    }
    const ledgerIndex = await connected.getLedgerIndex();
    // Reuse the settlement adapter's exact issued-asset and XRP reserve preflight.
    await assertRlusdReadiness(connected, { asset: "RLUSD", amount, amountDrops: "0", issuer: RLUSD_TESTNET_ISSUER,
      currency: RLUSD_CURRENCY, source: source.classicAddress, destination: recipientAddress } as Parameters<typeof assertRlusdReadiness>[1], ledgerIndex);
    const reserves = await network();
    const sourceAccount = await connected.request({ command: "account_info", account: source.classicAddress, ledger_index: "validated", strict: true });
    if (sourceAccount.result.validated !== true || sourceAccount.result.account_data.Account !== source.classicAddress) fail("Validated source account required.");
    assertXrplSpendableBalance({ balanceDrops: sourceAccount.result.account_data.Balance, ownerCount: sourceAccount.result.account_data.OwnerCount,
      reserveBaseXrp: reserves.reserve_base_xrp, reserveIncrementXrp: reserves.reserve_inc_xrp, feeDrops: "1000", amountDrops: "0" });
    if (!checkOnly) await persist({ XRPL_SETTLEMENT_ENABLED: "true" });
    console.log(`Ready: ${amount} Testnet RLUSD; source ${source.classicAddress}; recipient ${recipientAddress}. No monetary value. ${checkOnly ? "Read-only check passed." : "RLUSD selected in .env.local; restart the server and enable a fresh case."}`);
  } finally {
    if (client?.isConnected()) await client.disconnect().catch(() => undefined);
    await lock.close();
    await unlink(lockPath);
  }
}

setup().catch((error: unknown) => {
  // Never serialize SDK errors, environment values, wallet objects, or seeds.
  console.error(error instanceof XrplError ? error.message
    : "RLUSD Testnet setup could not complete. Check ignored .env.local, wallet pairing, network access and .data/xrpl-setup.lock. Existing credentials and public pending receipts were preserved.");
  process.exitCode = 1;
}).finally(closeMongoConnection);
