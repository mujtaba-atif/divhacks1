import { existsSync } from "node:fs";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const projectId = process.env.SPECTRUM_PROJECT_ID;
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
  if (!projectId || !projectSecret) {
    console.error("Set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET in .env.local.");
    process.exitCode = 1;
    return;
  }

  const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
  console.log("RentEscrow agent is listening for iMessages...");

  for await (const [space, message] of app.messages) {
    if (message.platform !== "imessage" || message.content.type !== "text") continue;
    const from = imessage(message).sender?.address ?? "unknown";
    console.log(`${from}: ${message.content.text}`);
    await space.send(`RentEscrow Agent got: "${message.content.text}"`);
  }
}

void main();
