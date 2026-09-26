import type { NextRequest } from "next/server";
import { acceptContract, contractAcceptanceSchema, contractIdSchema } from "@/lib/server/contracts";
import { assertSameOrigin, getSession, handleError, readJson, respond, type SessionContext } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let session: SessionContext | undefined;
  try {
    assertSameOrigin(request);
    const input = await readJson(request, contractAcceptanceSchema);
    const { id: rawId } = await context.params;
    const id = contractIdSchema.parse(rawId);
    session = await getSession(request);
    return respond({ contract: await acceptContract(session.document.ownerId, id, input.role) }, session);
  } catch (error) {
    return handleError(error, session);
  }
}
