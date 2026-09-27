import type { NextRequest } from "next/server";
import { contractSchema, createContract, getContractsForUser } from "@/lib/server/contracts";
import { assertSameOrigin, getSession, handleError, readJson, respond, type SessionContext } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    return respond({ contracts: await getContractsForUser(user) });
  } catch (error) {
    return handleError(error);
  }
}
export async function POST(request: NextRequest) {
  let session: SessionContext | undefined;
  try {
    assertSameOrigin(request);
    session = await getSession(request);
    const input = await readJson(request, contractSchema);
    return respond({ contract: await createContract(session.document.ownerId, input, session.user) }, session, 201);
  } catch (error) {
    return handleError(error, session);
  }
}
