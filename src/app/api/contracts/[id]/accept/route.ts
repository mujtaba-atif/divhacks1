import type { NextRequest } from "next/server";
import { acceptContract, contractAcceptanceSchema, contractIdSchema } from "@/lib/server/contracts";
import { assertSameOrigin, getSession, handleError, readJson, respond, type SessionContext } from "@/lib/server/http";
import { ApiError } from "@/lib/server/errors";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let session: SessionContext | undefined;
  try {
    assertSameOrigin(request);
    session = await getSession(request);
    const input = await readJson(request, contractAcceptanceSchema);
    if (input.role !== session.user.role) throw new ApiError(403, "You cannot accept a contract as another role.", false, "ROLE_NOT_ALLOWED");
    const { id: rawId } = await context.params;
    const id = contractIdSchema.parse(rawId);
    return respond({ contract: await acceptContract(session.document.ownerId, id, input.role) }, session);
  } catch (error) {
    return handleError(error, session);
  }
}
