import type { NextRequest } from "next/server";
import { lookupBuilding } from "@/lib/integrations";
import { handleError, respond } from "@/lib/server/http";
import { buildingQuerySchema } from "@/lib/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const query = buildingQuerySchema.parse({
      address: request.nextUrl.searchParams.get("address"),
      borough: request.nextUrl.searchParams.get("borough"),
    });
    return respond(await lookupBuilding(query.address, query.borough));
  } catch (error) {
    return handleError(error);
  }
}
