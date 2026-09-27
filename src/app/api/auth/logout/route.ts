import type { NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, revokeSessionToken } from "@/lib/server/auth";
import { assertSameOrigin, clearAuthSessionCookie, handleError, respond } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    await revokeSessionToken(request.cookies.get(AUTH_COOKIE_NAME)?.value);
    const response = respond({ success: true });
    clearAuthSessionCookie(response);
    return response;
  } catch (error) {
    return handleError(error);
  }
}
