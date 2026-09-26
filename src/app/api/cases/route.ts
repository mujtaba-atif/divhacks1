import type { NextRequest } from "next/server";
import { createCase } from "@/lib/server/cases";
import { assertSameOrigin, getSession, handleError, readJson, respond, type SessionContext } from "@/lib/server/http";
import { newCaseSchema } from "@/lib/server/validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let session: SessionContext | undefined;
  try {
    assertSameOrigin(request);
    const input = await readJson(request, newCaseSchema);
    session = await getSession(request);
    return respond({ case: await createCase(session.document.ownerId, input) }, session, 201);
  } catch (error) {
    return handleError(error, session);
  }
}
