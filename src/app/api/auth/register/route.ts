import type { NextRequest } from "next/server";
import { ApiError } from "@/lib/server/errors";
import { assertSameOrigin, handleError } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    throw new ApiError(404, "Registration is not available.", false, "REGISTRATION_DISABLED");
  } catch (error) {
    return handleError(error);
  }
}
