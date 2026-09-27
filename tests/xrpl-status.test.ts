import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "xrpl";
import { getIntegrationStatus } from "../src/lib/integrations";

test("configured MongoDB exposes the existing durable XRPL settlement path", (t) => {
  const source = Wallet.generate();
  const env = { XRPL_SETTLEMENT_ENABLED: "true", XRPL_NETWORK: "testnet",
    XRPL_RPC_URL: "wss://s.altnet.rippletest.net:51233", XRPL_TENANT_ADDRESS: source.classicAddress,
    XRPL_TENANT_SEED: source.seed!, XRPL_LANDLORD_ADDRESS: Wallet.generate().classicAddress,
    XRPL_SETTLEMENT_AMOUNT_XRP: "10", RENTESCROW_STORAGE: "mongodb", MONGODB_URI: "mongodb://configured.invalid" };
  const prior = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(env)) {
    if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
  } });
  assert.equal(getIntegrationStatus().find((item) => item.id === "xrpl")?.status, "configured");
  delete process.env.MONGODB_URI;
  assert.equal(getIntegrationStatus().find((item) => item.id === "xrpl")?.status, "unavailable");
  process.env.XRPL_NETWORK = "mainnet";
  assert.equal(getIntegrationStatus().find((item) => item.id === "xrpl")?.status, "unavailable");
});
