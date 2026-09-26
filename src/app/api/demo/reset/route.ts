import type { NextRequest } from "next/server";
import { getIntegrationStatus } from "@/lib/integrations";
import { assertSameOrigin, getSession, handleError, respond, type SessionContext } from "@/lib/server/http";
import { resetSession } from "@/lib/server/store";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let session: SessionContext | undefined;
  try {
    assertSameOrigin(request);
    session = await getSession(request);
    const cases = await resetSession(session.document.ownerId);
    return respond({ cases, integrations: getIntegrationStatus(), mode: "demo" }, session);
  } catch (error) {
    return handleError(error, session);
  }
}
