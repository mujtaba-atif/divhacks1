import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client, Wallet, isValidClassicAddress } from "xrpl";
import { XRPL_TESTNET_URL } from "../src/lib/integrations/xrpl-testnet";

const destination = path.resolve(".env.local");

async function setup() {
  // Fail before generating any credential if the destination could be committed.
  execFileSync("git", ["check-ignore", "--quiet", ".env.local"], { stdio: "ignore" });
  if (execFileSync("git", ["ls-files", "--", ".env.local"], { encoding: "utf8" }).trim()) {
    throw new Error("Tracked environment file");
  }
  await mkdir(".data", { recursive: true, mode: 0o700 });
  const lockPath = path.resolve(".data/xrpl-setup.lock");
  const lock = await open(lockPath, "wx", 0o600);
  let client: Client | undefined;
  try {
    let contents = "";
    try {
      if (!(await lstat(destination)).isFile()) throw new Error("Environment must be a regular file");
      contents = await readFile(destination, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const setting = (key: string) => {
      const match = contents.match(new RegExp(`^(?:export\\s+)?${key}\\s*=\\s*(.*)$`, "m"));
      let value = match?.[1]?.trim();
      if (value?.startsWith('"') || value?.startsWith("'")) value = value.slice(1, value.indexOf(value[0], 1));
      else value = value?.split("#")[0].trim();
      return process.env[key] ?? value;
    };
    if ((setting("XRPL_NETWORK") ?? "testnet") !== "testnet"
      || (setting("XRPL_RPC_URL") ?? XRPL_TESTNET_URL) !== XRPL_TESTNET_URL) throw new Error("Testnet only");
    const amount = setting("XRPL_SETTLEMENT_AMOUNT_XRP") ?? "10";
    if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > 100) {
      throw new Error("Amount must be positive and no more than 100 Test XRP");
    }
    async function persist(values: Record<string, string>) {
      for (const [key, value] of Object.entries(values)) {
        const matcher = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, "gm");
        contents = matcher.test(contents) ? contents.replace(matcher, `${key}=${value}`)
          : `${contents}${contents.endsWith("\n") || !contents ? "" : "\n"}${key}=${value}\n`;
      }
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
        await rename(temporary, destination);
      } finally { await unlink(temporary).catch(() => undefined); }
    }
    client = new Client(XRPL_TESTNET_URL, { connectionTimeout: 15_000, timeout: 20_000 });
    await client.connect();
    const info = await client.request({ command: "server_info" });
    if (info.result.info.network_id !== 1) throw new Error("Unexpected ledger network");

    const seed = setting("XRPL_TENANT_SEED");
    const existingSource = setting("XRPL_TENANT_ADDRESS");
    if (existingSource && !seed) throw new Error("Existing tenant address has no signing credential; refusing to replace it");
    const tenant = seed ? Wallet.fromSeed(seed) : Wallet.generate();
    if (existingSource && existingSource !== tenant.classicAddress) throw new Error("Tenant wallet mismatch");
    const existingRecipient = setting("XRPL_LANDLORD_ADDRESS");
    if (existingRecipient && !isValidClassicAddress(existingRecipient)) throw new Error("Invalid recipient");
    // fundWallet only needs classicAddress for an existing recipient. No recipient signs in this flow.
    const landlord = existingRecipient ? { classicAddress: existingRecipient } as Wallet : Wallet.generate();
    if (tenant.classicAddress === landlord.classicAddress) throw new Error("Wallets must be distinct");
    // Save before faucet calls so a partial setup can resume without losing/replacing wallets.
    await persist({ XRPL_NETWORK: "testnet", XRPL_RPC_URL: XRPL_TESTNET_URL,
      XRPL_TENANT_ADDRESS: tenant.classicAddress, XRPL_TENANT_SEED: tenant.seed!,
      XRPL_LANDLORD_ADDRESS: landlord.classicAddress, XRPL_SETTLEMENT_AMOUNT_XRP: amount,
      XRPL_SETTLEMENT_ENABLED: setting("XRPL_SETTLEMENT_ENABLED") ?? "false" });

    for (const [label, wallet] of [["Tenant", tenant], ["Landlord", landlord]] as const) {
      let funded = false;
      try {
        const account = await client.request({ command: "account_info", account: wallet.classicAddress, ledger_index: "validated" });
        funded = account.result.validated === true && BigInt(account.result.account_data.Balance) > 0n;
      } catch (error) {
        if ((error as { data?: { error?: string } }).data?.error !== "actNotFound") throw error;
      }
      if (!funded) await client.fundWallet(wallet, { usageContext: "RentEscrow NYC Testnet hackathon setup" });
      const verified = await client.request({ command: "account_info", account: wallet.classicAddress, ledger_index: "validated" });
      if (verified.result.validated !== true || BigInt(verified.result.account_data.Balance) <= 0n) throw new Error("Funding not validated");
      console.log(`${label} Testnet wallet funded: ${wallet.classicAddress}`);
    }
    await persist({ XRPL_SETTLEMENT_ENABLED: "true" });
    console.log(`Saved Testnet configuration to ignored .env.local (owner-only permissions). Settlement amount: ${amount} Test XRP. Restart the server, then enable Testnet in a case's Escrow tab.`);
  } finally {
    if (client?.isConnected()) await client.disconnect().catch(() => undefined);
    await lock.close();
    await unlink(lockPath);
  }
}

setup().catch(() => {
  // SDK errors and environment parser errors can contain credentials; never print them.
  console.error("Testnet setup did not complete. Check network access, the Testnet-only configuration, wallet/address pairing, positive amount (max 100 Test XRP), ignored .env.local, and .data/xrpl-setup.lock. Existing wallet credentials were preserved; retry to resume faucet funding.");
  process.exitCode = 1;
});
