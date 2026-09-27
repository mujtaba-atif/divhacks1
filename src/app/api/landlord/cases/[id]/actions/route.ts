import type { NextRequest } from "next/server";
import { requireLandlord } from "@/lib/server/auth";
import { performLandlordAction } from "@/lib/server/cases";
import { assertSameOrigin, handleError, readJson, respond } from "@/lib/server/http";
import { landlordActionSchema, landlordCaseOwner, publicLandlordError, toLandlordCase } from "@/lib/server/landlord";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireLandlord(request);
    const { id } = await context.params;
    const ownerId = await landlordCaseOwner(user, id);
    const action = await readJson(request, landlordActionSchema);
    const record = await performLandlordAction(ownerId, id, user, action);
    return respond({ case: toLandlordCase(user, record) });
  } catch (error) { return handleError(publicLandlordError(error)); }
}

