import { existsSync } from "node:fs";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

type ReplyResult = { matched: false } | { matched: true; caseId: string; intent: string; title?: string };

async function forwardLandlordReply(appUrl: string, secret: string, from: string, text: string): Promise<ReplyResult> {
  const response = await fetch(`${appUrl}/api/agent/landlord-reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ from, text }),
  });
  const result = await response.json() as ReplyResult & { error?: string };
  if (!response.ok) throw new Error(result.error || `App responded with ${response.status}`);
  return result;
}

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const projectId = process.env.SPECTRUM_PROJECT_ID;
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
  const agentSecret = process.env.AGENT_API_SECRET;
  const appUrl = process.env.RENTESCROW_APP_URL || "http://127.0.0.1:3000";
  if (!projectId || !projectSecret || !agentSecret) {
    console.error("Set SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, and AGENT_API_SECRET in .env.local.");
    process.exitCode = 1;
    return;
  }

  const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
  console.log(`RentEscrow agent is listening for iMessages (app: ${appUrl})...`);

  for await (const [space, message] of app.messages) {
    if (message.platform !== "imessage" || message.content.type !== "text") continue;
    const from = imessage(message).sender?.address;
    const text = message.content.text;
    if (!from) continue;
    console.log(`${from}: ${text}`);
    try {
      const result = await forwardLandlordReply(appUrl, agentSecret, from, text);
      if (result.matched) {
        console.log(`  -> case ${result.caseId}: ${result.title} (${result.intent})`);
        await space.send("Thanks, I've added your reply to the repair case.");
      } else {
        await space.send("Hi, I'm the RentEscrow Agent. I couldn't find a repair case linked to this number.");
      }
    } catch (error) {
      console.error("  -> could not update the case:", error instanceof Error ? error.message : error);
    }
  }
}

void main();
