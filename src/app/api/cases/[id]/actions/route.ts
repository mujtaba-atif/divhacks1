import type { NextRequest } from "next/server";
import { performCaseAction } from "@/lib/server/cases";
import { assertSameOrigin, getSession, handleError, readJson, respond, type SessionContext } from "@/lib/server/http";
import { actionSchema } from "@/lib/server/validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let session: SessionContext | undefined;
  try {
    assertSameOrigin(request);
    const action = await readJson(request, actionSchema);
    const { id } = await context.params;
    session = await getSession(request);
    return respond(await performCaseAction(session.document.ownerId, id, action), session);
  } catch (error) {
    return handleError(error, session);
  }
}
