import type { NextRequest } from "next/server";
import { requireLandlord } from "@/lib/server/auth";
import { handleError, respond } from "@/lib/server/http";
import { landlordCases, publicLandlordError } from "@/lib/server/landlord";
import { getIntegrationStatus } from "@/lib/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await requireLandlord(request);
    return respond({ user, cases: await landlordCases(user), integration: getIntegrationStatus().find((item) => item.id === "photon") });
  } catch (error) { return handleError(publicLandlordError(error)); }
}
