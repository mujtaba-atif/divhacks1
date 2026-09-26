import type { IntegrationStatus } from "../types";
import { assertServer } from "./shared";

export { lookupBuilding } from "./nyc-open-data";
export { analyzeEvidence, verifyEvidence } from "./gemini";
export { getFinancialContext } from "./nessie";
export { sendLandlordMessage } from "./photon";
export { DeliveryUncertainError, IntegrationError } from "./shared";

export function getIntegrationStatus(): IntegrationStatus[] {
  assertServer();
  const gemini = Boolean(process.env.GEMINI_API_KEY);
  const nessieEnabled = process.env.NESSIE_ENABLED === "true";
  const nessie = Boolean(process.env.NESSIE_API_KEY && process.env.NESSIE_ACCOUNT_ID);
  const photonEnabled = process.env.PHOTON_LIVE_SEND === "true";
  const photon = Boolean(process.env.PHOTON_PROXY_TOKEN && process.env.PHOTON_ALLOWED_RECIPIENT);
  const mongoEnabled = process.env.RENTESCROW_STORAGE === "mongodb";
  return [
    { id: "gemini", name: "Gemini", status: gemini ? "configured" : "demo", detail: gemini ? "Server credentials present; uploaded evidence uses Gemini. Connectivity has not been verified." : "Sample analysis only. Real uploads remain unverified until Gemini is configured." },
    { id: "mongodb", name: "MongoDB Atlas", status: mongoEnabled ? (process.env.MONGODB_URI ? "configured" : "unavailable") : "demo", detail: mongoEnabled ? "MongoDB persistence selected; connectivity is checked when data is loaded." : "Session-scoped local storage." },
    { id: "nyc", name: "NYC Open Data", status: "public", detail: "Public HPD complaints and violations lookup. The named demo building uses labeled fictional records." },
    { id: "nessie", name: "Capital One Nessie", status: nessieEnabled ? (nessie ? "configured" : "unavailable") : "demo", detail: nessieEnabled ? "Read-only mock banking API selected. Nessie data is simulated, not a real bank balance." : "Sample expenses and rent history. No bank account is connected." },
    { id: "photon", name: "Photon iMessage", status: photonEnabled ? (photon ? "configured" : "unavailable") : "demo", detail: photonEnabled ? "Explicit send actions may reach the configured approved recipient through the Photon HTTP proxy." : "Messages remain in the demo. No external delivery." },
    { id: "xrpl", name: "XRP Ledger", status: "demo", detail: "UI funds are simulated USD. Isolated, guarded XRP testnet tooling is available separately; no wallet is connected to this app." },
  ];
}
