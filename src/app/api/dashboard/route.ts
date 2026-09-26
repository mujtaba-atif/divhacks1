import type { NextRequest } from "next/server";
import { getIntegrationStatus } from "@/lib/integrations";
import { getSession, handleError, respond, type SessionContext } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let session: SessionContext | undefined;
  try {
    session = await getSession(request);
    return respond({ cases: session.document.cases, integrations: getIntegrationStatus(), mode: "demo" }, session);
  } catch (error) {
    return handleError(error, session);
  }
}
