import type { NextRequest } from "next/server";
import { requireLandlord } from "@/lib/server/auth";
import { addLandlordEvidence } from "@/lib/server/cases";
import { assertSameOrigin, handleError, respond } from "@/lib/server/http";
import { landlordCaseOwner, publicLandlordError, toLandlordCase } from "@/lib/server/landlord";
import { parseEvidenceUpload } from "@/lib/server/uploads";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireLandlord(request);
    const { id } = await context.params;
    const ownerId = await landlordCaseOwner(user, id);
    const evidence = await parseEvidenceUpload(request);
    const record = await addLandlordEvidence(ownerId, id, user, evidence);
    return respond({ case: toLandlordCase(user, record) }, undefined, 201);
  } catch (error) { return handleError(publicLandlordError(error)); }
}

