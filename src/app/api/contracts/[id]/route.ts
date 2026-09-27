import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { contractIdSchema, rejectContractMutation } from "@/lib/server/contracts";
import { assertSameOrigin, handleError, respond } from "@/lib/server/http";

export const runtime = "nodejs";

async function immutable(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id: rawId } = await context.params;
    await rejectContractMutation(user, contractIdSchema.parse(rawId));
    return respond({ error: "unreachable" }, undefined, 500);
  } catch (error) {
    return handleError(error);
  }
}

export const PATCH = immutable;
export const PUT = immutable;
