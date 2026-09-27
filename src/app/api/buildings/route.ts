import type { NextRequest } from "next/server";
import { getBuildingContext } from "@/lib/server/buildings";
import { handleError, respond } from "@/lib/server/http";
import { buildingQuerySchema } from "@/lib/server/validation";
import { requireUser } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireUser(request);
    const query = buildingQuerySchema.parse({
      address: request.nextUrl.searchParams.get("address"),
      borough: request.nextUrl.searchParams.get("borough"),
    });
    return respond(await getBuildingContext(query.address, query.borough));
  } catch (error) {
    return handleError(error);
  }
}
