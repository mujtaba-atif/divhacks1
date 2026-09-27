import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { handleError, respond } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    return respond({ user: await requireUser(request) });
  } catch (error) {
    return handleError(error);
  }
}
