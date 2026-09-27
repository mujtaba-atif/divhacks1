import type { NextRequest } from "next/server";
import { performCaseAction } from "@/lib/server/cases";
import { assertSameOrigin, getSession, handleError, readJson, respond, type SessionContext } from "@/lib/server/http";
import { actionSchema } from "@/lib/server/validation";
import { findCase } from "@/lib/server/store";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let session: SessionContext | undefined;
  try {
    assertSameOrigin(request);
    session = await getSession(request);
    const { id } = await context.params;
    findCase(session.document, id);
    const action = await readJson(request, actionSchema);
    return respond(await performCaseAction(session.document.ownerId, id, action), session);
  } catch (error) {
    return handleError(error, session);
  }
}
