import type { NextRequest } from "next/server";
import { getSession, handleError, respond, type SessionContext } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let session: SessionContext | undefined;
  try {
    session = await getSession(request);
    return respond({ users: session.document.users ?? [] }, session);
  } catch (error) {
    return handleError(error, session);
  }
}
