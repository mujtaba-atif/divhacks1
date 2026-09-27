import type { NextRequest } from "next/server";
import { requireTenant } from "@/lib/server/auth";
import { getCaseBuildingContext } from "@/lib/server/buildings";
import { handleError, respond } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTenant(request);
    const { id } = await context.params;
    return respond(await getCaseBuildingContext(user, id));
  } catch (error) { return handleError(error); }
}
