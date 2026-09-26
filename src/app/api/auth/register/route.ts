import type { NextRequest } from "next/server";
import { registerUser } from "@/lib/server/auth";
import { assertSameOrigin, getSession, handleError, readJson, respond, type SessionContext } from "@/lib/server/http";
import { registerSchema } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let session: SessionContext | undefined;
  try {
    assertSameOrigin(request);
    const input = await readJson(request, registerSchema);
    session = await getSession(request);
    return respond({ user: await registerUser(session.document.ownerId, input) }, session, 201);
  } catch (error) {
    return handleError(error, session);
  }
}
