import { z } from "zod";
import type { CaseRecord } from "../types";
import { assertServer, DeliveryUncertainError, fetchJson, IntegrationError } from "./shared";

const sendResponse = z.object({
  ok: z.literal(true),
  data: z.object({ id: z.string().min(1), to: z.string(), text: z.string(), sentAt: z.number().finite() }),
});

export async function sendLandlordMessage(caseRecord: CaseRecord, body: string): Promise<{ delivery: "demo" | "sent" }> {
  assertServer();
  const text = body.trim();
  if (!text || text.length > 10_000 || caseRecord.status === "resolved") {
    throw new IntegrationError("A nonempty message of at most 10,000 characters and an active case are required.", "Photon", "invalid_input");
  }
  if (process.env.PHOTON_LIVE_SEND !== "true") return { delivery: "demo" };
  const token = process.env.PHOTON_PROXY_TOKEN;
  const recipient = caseRecord.landlordContact.trim();
  if (!token || !process.env.PHOTON_ALLOWED_RECIPIENT) {
    throw new IntegrationError("Photon live sending requires a proxy token and an explicitly approved recipient.", "Photon");
  }
  if (recipient !== process.env.PHOTON_ALLOWED_RECIPIENT.trim() || !/^(?:\+[1-9]\d{7,14}|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(recipient)) {
    throw new IntegrationError("This landlord contact is not the configured approved Photon recipient.", "Photon", "rejected");
  }
  // This pinned origin implements Photon's documented legacy HTTP proxy contract.
  let payload: unknown;
  try {
    payload = await fetchJson("https://imessage-swagger.photon.codes/send", "Photon", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: recipient, text }),
    });
  } catch {
    // A provider can accept the message before its receipt is lost or fails to parse.
    throw new DeliveryUncertainError();
  }
  const response = sendResponse.safeParse(payload);
  if (!response.success || response.data.data.to !== recipient || response.data.data.text !== text) {
    throw new DeliveryUncertainError("Photon may have sent this message, but it did not return a matching send receipt. Check delivery before retrying.");
  }
  return { delivery: "sent" };
}
