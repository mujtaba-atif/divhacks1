import "server-only";

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Maps a landlord's iMessage address to the case it belongs to, so the Spectrum agent can route replies.
type AgentLink = { ownerId: string; caseId: string; linkedAt: string };

const linksFile = path.join(process.cwd(), ".data", "agent-links.json");

// Returns a stable key for a phone number (E.164) or email, or null if the contact is neither.
export function normalizeContact(contact: string): string | null {
  const trimmed = contact.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return trimmed.toLowerCase();
  const digits = trimmed.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}

async function readLinks(): Promise<Record<string, AgentLink>> {
  try {
    return JSON.parse(await readFile(linksFile, "utf8")) as Record<string, AgentLink>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

// The most recently created case for a landlord wins.
export async function linkLandlordContact(contact: string, ownerId: string, caseId: string) {
  const key = normalizeContact(contact);
  if (!key) return;
  const links = await readLinks();
  links[key] = { ownerId, caseId, linkedAt: new Date().toISOString() };
  await mkdir(path.dirname(linksFile), { recursive: true, mode: 0o700 });
  const temporary = `${linksFile}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(links), { mode: 0o600 });
  await rename(temporary, linksFile);
}

export async function findLandlordLink(contact: string): Promise<AgentLink | null> {
  const key = normalizeContact(contact);
  return key ? (await readLinks())[key] ?? null : null;
}
