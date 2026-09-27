import type { NextRequest } from "next/server";
import { loginSchema, loginWithPassword } from "@/lib/server/auth";
import { assertSameOrigin, handleError, readJson, respond, setAuthSessionCookie } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = await readJson(request, loginSchema);
    const { user, token, expiresAt } = await loginWithPassword(input);
    const response = respond({
      user,
      redirectTo: user.role === "tenant" ? "/tenant" : "/landlord",
    });
    setAuthSessionCookie(response, token, expiresAt);
    return response;
  } catch (error) {
    return handleError(error);
  }
}
