import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { findLandlordLink } from "@/lib/server/agent-links";
import { recordInboundLandlordReply } from "@/lib/server/cases";
import { ApiError } from "@/lib/server/errors";
import { handleError, readJson, respond } from "@/lib/server/http";

export const runtime = "nodejs";

const replySchema = z.object({ from: z.string().trim().min(3).max(240), text: z.string().trim().min(1).max(2_000) }).strict();

// Only the local Spectrum agent holding AGENT_API_SECRET may post landlord replies.
function assertAgent(request: NextRequest) {
  const secret = process.env.AGENT_API_SECRET;
  if (!secret || secret.length < 16) throw new ApiError(503, "AGENT_API_SECRET is not configured.");
  const provided = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const hash = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(hash(provided), hash(secret))) throw new ApiError(401, "Invalid agent credentials.");
}

export async function POST(request: NextRequest) {
  try {
    assertAgent(request);
    const { from, text } = await readJson(request, replySchema);
    const link = await findLandlordLink(from);
    if (!link) return respond({ matched: false });
    const result = await recordInboundLandlordReply(link.ownerId, link.caseId, text);
    return respond({
      matched: true,
      caseId: link.caseId,
      intent: result.classification.intent,
      title: result.case.timeline.at(-1)?.title,
    });
  } catch (error) {
    return handleError(error);
  }
}
