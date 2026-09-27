import type { NextRequest } from "next/server";
import { acceptContractForUser, contractAcceptanceSchema, contractIdSchema } from "@/lib/server/contracts";
import { assertSameOrigin, handleError, readJson, respond } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const input = await readJson(request, contractAcceptanceSchema);
    const { id: rawId } = await context.params;
    const id = contractIdSchema.parse(rawId);
    return respond({ contract: await acceptContractForUser(user, id, input) });
  } catch (error) {
    return handleError(error);
  }
}
