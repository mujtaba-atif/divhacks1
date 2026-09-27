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
    command: `E2E_PORT=${target.port || "80"} node --import tsx scripts/e2e-server.ts`,
    url: `${baseURL}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
