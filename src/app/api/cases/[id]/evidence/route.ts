import type { NextRequest } from "next/server";
import { addUploadedEvidence } from "@/lib/server/cases";
import { assertSameOrigin, getSession, handleError, respond, type SessionContext } from "@/lib/server/http";
import { parseEvidenceUpload } from "@/lib/server/uploads";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let session: SessionContext | undefined;
  try {
    assertSameOrigin(request);
    const evidence = await parseEvidenceUpload(request);
    const { id } = await context.params;
    session = await getSession(request);
    return respond({ case: await addUploadedEvidence(session.document.ownerId, id, evidence) }, session, 201);
  } catch (error) {
    return handleError(error, session);
  }
}
