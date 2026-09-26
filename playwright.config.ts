import { defineConfig, devices } from "@playwright/test";
import { baseURL } from "./tests/e2e/environment";

const target = new URL(baseURL);
if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname)
  || target.pathname !== "/" || target.search || target.hash || target.username || target.password) {
  throw new Error("E2E_BASE_URL must identify a dedicated local HTTP test server.");
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
  webServer: {
    command: `node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port ${target.port || "80"}`,
    url: `${baseURL}/api/dashboard`,
    reuseExistingServer: false,
    env: {
      RENTESCROW_STORAGE: "local", NESSIE_ENABLED: "false", GEMINI_API_KEY: "",
      PHOTON_LIVE_SEND: "false", XRPL_TESTNET_ENABLED: "false",
    },
    timeout: 120_000,
  },
});
