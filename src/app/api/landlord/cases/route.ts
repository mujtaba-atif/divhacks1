import type { NextRequest } from "next/server";
import { requireLandlord } from "@/lib/server/auth";
import { handleError, respond } from "@/lib/server/http";
import { landlordCases, publicLandlordError } from "@/lib/server/landlord";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await requireLandlord(request);
    return respond({ user, cases: await landlordCases(user) });
  } catch (error) { return handleError(publicLandlordError(error)); }
}

