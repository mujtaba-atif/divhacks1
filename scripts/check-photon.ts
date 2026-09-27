import { existsSync } from "node:fs";
import { cloud } from "spectrum-ts";
import { getPhotonConfig } from "../src/lib/integrations/photon";
import { withSpectrumTimeout } from "../src/lib/integrations/spectrum";

async function main() {
  try {
    if (existsSync(".env.local")) process.loadEnvFile(".env.local");
    const config = getPhotonConfig();
    if (!config) throw new Error("Live configuration is disabled");
    const project = await withSpectrumTimeout(cloud.getProject(config.projectId, config.projectSecret), 15_000);
    // The live API returns name/slug/profile; SDK types also declare an optional-in-practice id.
    if (!project || typeof project.slug !== "string" || !project.slug
      || (project.id !== undefined && project.id !== config.projectId)) throw new Error("Invalid project response");
    console.log("Spectrum project authentication passed. No messages were sent and no listener was started.");
    console.log("A tenant-approved send in the app is still needed to verify the connected iMessage device and delivery.");
    return 0;
  } catch {
    console.error("Spectrum authentication check failed. Check private configuration, network access, and project Settings in Photon.");
    return 1;
  }
}

void main().then((code) => process.exit(code));
