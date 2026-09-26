import type { NextRequest } from "next/server";
import { findCase } from "@/lib/server/store";
import { getSession, handleError, respond, type SessionContext } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let session: SessionContext | undefined;
  try {
    const { id } = await context.params;
    session = await getSession(request);
    const caseRecord = findCase(session.document, id);
    const { ownerId: _ownerId, ...dossier } = caseRecord;
    const response = respond({
      exportedAt: new Date().toISOString(),
      mode: "demo",
      notice: "RentEscrow demonstration dossier. Simulated funds and sample records are explicitly marked. This export is not legal advice or proof of an actual escrow transfer.",
      case: dossier,
    }, session);
    const safeId = caseRecord.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    response.headers.set("Content-Disposition", `attachment; filename="${safeId}-dossier.json"`);
    return response;
  } catch (error) {
    return handleError(error, session);
  }
}
