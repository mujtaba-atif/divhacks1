import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { IntegrationError } from "@/lib/integrations";
import { createSession, ownerIdFromToken, readSession, type SessionDocument } from "./store";
import { ApiError } from "./errors";

const COOKIE_NAME = "rentescrow_session";

export interface SessionContext {
  document: SessionDocument;
  isNew: boolean;
  token?: string;
}

export async function getSession(request: NextRequest): Promise<SessionContext> {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    const document = await readSession(ownerIdFromToken(token));
    if (document) return { document, isNew: false };
  }
  const created = await createSession();
  return { ...created, isNew: true };
}

export function assertSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host") || requestUrl.host;
  let expectedOrigin: string;
  try {
    if (!/^[a-z0-9.\[\]:-]+$/i.test(host)) throw new Error("Invalid host");
    // Next can normalize loopback URLs to localhost; Host retains the browser's target authority.
    expectedOrigin = new URL(`${requestUrl.protocol}//${host}`).origin;
  } catch {
    throw new ApiError(403, "This action requires a request from the same application origin.");
  }
  if (!origin || origin !== expectedOrigin || fetchSite === "cross-site") {
    throw new ApiError(403, "This action requires a request from the same application origin.");
  }
}

export function respond(data: unknown, session?: SessionContext, status = 200) {
  const response = NextResponse.json(data, { status });
  response.headers.set("Cache-Control", "no-store, private");
  response.headers.set("X-Content-Type-Options", "nosniff");
  if (session?.isNew && session.token) {
    response.cookies.set(COOKIE_NAME, session.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  return response;
}

export function handleError(error: unknown, session?: SessionContext) {
  if (error instanceof ApiError) {
    return respond({ error: error.message, ...(error.code ? { code: error.code } : {}),
      ...(error.policy ? { policy: error.policy } : {}),
      ...(error.caseRecord ? { case: error.caseRecord } : {}) }, session, error.status);
  }
  if (error instanceof IntegrationError) {
    const status = error.code === "invalid_input" ? 400 : error.code === "rejected" ? 409
      : error.code === "invalid_response" ? 502 : 503;
    return respond({ error: error.message }, session, status);
  }
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const field = issue.path.length ? `${issue.path.join(".")}: ` : "";
    return respond({ error: `${field}${issue.message}` }, session, 400);
  }
  console.error("RentEscrow request failed:", error instanceof Error ? error.name : "Unknown error");
  return respond({ error: "The request could not be completed. Try again shortly." }, session, 500);
}

export async function readLimitedBody(request: NextRequest, limit: number): Promise<Uint8Array> {
  const claimedLength = request.headers.get("content-length");
  if (claimedLength && Number(claimedLength) > limit) {
    throw new ApiError(413, "The request is too large.");
  }
  if (!request.body) throw new ApiError(400, "A request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ApiError(413, "The request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

export async function readJson<T>(request: NextRequest, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "Send this request as application/json.");
  }
  const bytes = await readLimitedBody(request, 64 * 1024);
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "The request contains invalid JSON.");
  }
  return schema.parse(payload);
}
