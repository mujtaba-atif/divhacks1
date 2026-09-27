import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { contractIdSchema } from "@/lib/server/contracts";
import { getContractPolicyPreviewForUser } from "@/lib/server/contract-preview";
import { handleError, respond } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id: rawId } = await context.params;
    const preview = await getContractPolicyPreviewForUser(user, contractIdSchema.parse(rawId));
    return respond(preview);
  } catch (error) {
    return handleError(error);
  }
}
