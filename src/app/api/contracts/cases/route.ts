import type { NextRequest } from "next/server";
import { contractCaseSchema, createCaseForContract } from "@/lib/server/contracts";
import { assertSameOrigin, getSession, handleError, readJson, respond, type SessionContext } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let session: SessionContext | undefined;
  try {
    assertSameOrigin(request);
    session = await getSession(request);
    const input = await readJson(request, contractCaseSchema);
    return respond({ case: await createCaseForContract(session.document.ownerId, input) }, session, 201);
  } catch (error) {
    return handleError(error, session);
  }
}
