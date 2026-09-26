import type { IntegrationStatus } from "../types";
import { assertServer } from "./shared";
import { getXrplConfig } from "./xrpl-settlement";

export { lookupBuilding } from "./nyc-open-data";
export { analyzeEvidence, classifyLandlordReply, classifyReplyByRules, verifyEvidence } from "./gemini";
export { getFinancialContext } from "./nessie";
export { sendLandlordMessage } from "./photon";
export { DeliveryUncertainError, IntegrationError } from "./shared";

export function getIntegrationStatus(): IntegrationStatus[] {
  assertServer();
  const gemini = Boolean(process.env.GEMINI_API_KEY);
  const nessieEnabled = process.env.NESSIE_ENABLED === "true";
  const nessie = Boolean(process.env.NESSIE_API_KEY && process.env.NESSIE_TENANT_ID && process.env.NESSIE_CUSTOMER_ID && process.env.NESSIE_ACCOUNT_ID);
  const photonEnabled = process.env.PHOTON_LIVE_SEND === "true";
  const photon = Boolean(process.env.PHOTON_PROXY_TOKEN && process.env.PHOTON_ALLOWED_RECIPIENT);
  const mongoEnabled = process.env.RENTESCROW_STORAGE === "mongodb";
  let xrpl: IntegrationStatus = { id: "xrpl", name: "XRP Ledger", status: "demo", detail: "USD escrow is simulated. Run pnpm xrpl:setup-testnet to enable a separate real Testnet Payment after verified repair." };
  try {
    if (getXrplConfig()) xrpl = { ...xrpl, status: mongoEnabled ? "unavailable" : "configured", detail: mongoEnabled
      ? "Testnet payments require local storage on a single host. MongoDB case storage remains available for the simulated workflow."
      : "Dedicated Testnet wallets configured. Enable settlement per case; validated Test XRP Payments are separate from simulated USD." };
  } catch { xrpl = { ...xrpl, status: "unavailable", detail: "Testnet configuration is invalid. Check the pinned network, wallet addresses, signing credential, and amount on the server." }; }
  return [
    { id: "gemini", name: "Gemini", status: gemini ? "configured" : "demo", detail: gemini ? "Server credentials present; uploaded evidence uses Gemini. Connectivity has not been verified." : "Sample analysis only. Real uploads remain unverified until Gemini is configured." },
    { id: "mongodb", name: "MongoDB Atlas", status: mongoEnabled ? (process.env.MONGODB_URI ? "configured" : "unavailable") : "demo", detail: mongoEnabled ? "MongoDB persistence selected; connectivity is checked when data is loaded." : "Session-scoped local storage." },
    { id: "nyc", name: "NYC Open Data", status: "public", detail: "Public HPD complaints and violations lookup. The named demo building uses labeled fictional records." },
    { id: "nessie", name: "Capital One Nessie", status: nessieEnabled ? (nessie ? "configured" : "unavailable") : "demo", detail: nessieEnabled ? "Read-only sandbox banking API selected. Customer/account ownership is checked for the operator-bound tenant. Connectivity is verified per case, not by this status." : "Explicit local customer/account fixtures, not a Nessie API connection or real identity verification." },
    { id: "photon", name: "Photon iMessage", status: photonEnabled ? (photon ? "configured" : "unavailable") : "demo", detail: photonEnabled ? "Explicit send actions may reach the configured approved recipient through the Photon HTTP proxy." : "Messages remain in the demo. No external delivery." },
    xrpl,
  ];
}
