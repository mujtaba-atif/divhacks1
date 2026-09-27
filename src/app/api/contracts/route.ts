import type { NextRequest } from "next/server";
import { contractSchema, createContract, getContracts } from "@/lib/server/contracts";
import { assertSameOrigin, getSession, handleError, readJson, respond, type SessionContext } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let session: SessionContext | undefined;
  try {
    session = await getSession(request);
    return respond({ contracts: await getContracts(session.document.ownerId) }, session);
  } catch (error) {
    return handleError(error, session);
  }
}
export async function POST(request: NextRequest) {
  let session: SessionContext | undefined;
  try {
    assertSameOrigin(request);
    session = await getSession(request);
    const input = await readJson(request, contractSchema);
    return respond({ contract: await createContract(session.document.ownerId, input) }, session, 201);
  } catch (error) {
    return handleError(error, session);
  }
}
