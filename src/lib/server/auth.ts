import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { z } from "zod";
import type { AuthUser } from "@/lib/types";
import { maskMessagingContact, normalizeMessagingContact } from "@/lib/messaging-contact";
import { getMongoAuthStorage, type AuthStorage, type AuthUserRecord } from "./auth-store";
import { ApiError } from "./errors";
import { verifyPassword } from "./password";
import { mutateSession, type SessionDocument } from "./store";

export type UserRole = "tenant" | "landlord";

export const AUTH_COOKIE_NAME = "rentescrow_session";
export const AUTH_SESSION_SECONDS = 60 * 60 * 24 * 30;
const AUTH_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const INVALID_CREDENTIALS = "Invalid email or password.";

export const loginSchema = z.object({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(256),
  expectedRole: z.enum(["tenant", "landlord"]).optional(),
}).strict();

function sessionTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function workspaceOwnerId(userId: string): string {
  return createHash("sha256").update(userId).digest("hex");
}

export function authUserFromRecord(record: AuthUserRecord): AuthUser {
  if ((record.role !== "tenant" && record.role !== "landlord")
    || typeof record.email !== "string" || typeof record.displayName !== "string") {
    throw new ApiError(503, "The authenticated user record is invalid.");
  }
  const id = record._id.toHexString();
  return {
    id,
    email: record.email,
    role: record.role,
    displayName: record.displayName,
    ...(record.phoneContactConfiguredAt && normalizeMessagingContact(record.phoneContact)
      ? { maskedPhone: maskMessagingContact(record.phoneContact) } : {}),
    workspaceOwnerId: workspaceOwnerId(id),
  };
}

async function resolveStorage(storage?: AuthStorage): Promise<AuthStorage> {
  return storage ?? getMongoAuthStorage();
}

export async function loginWithPassword(
  input: z.infer<typeof loginSchema>,
  storage?: AuthStorage,
): Promise<{ user: AuthUser; token: string; expiresAt: Date }> {
  const activeStorage = await resolveStorage(storage);
  const record = await activeStorage.findUserByEmail(input.email.toLowerCase());
  const validPassword = await verifyPassword(input.password, record?.passwordHash);
  if (!record || !validPassword) throw new ApiError(401, INVALID_CREDENTIALS);
  const user = authUserFromRecord(record);
  if (input.expectedRole && user.role !== input.expectedRole) {
    const accountRole = user.role;
    const accountRoleLabel = accountRole === "tenant" ? "Tenant" : "Landlord";
    throw new ApiError(
      403,
      `This account belongs to a ${accountRole}. Select ${accountRoleLabel} to sign in.`,
      false,
      "ROLE_MISMATCH",
    );
  }

  const token = randomBytes(32).toString("hex");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + AUTH_SESSION_SECONDS * 1000);
  await activeStorage.createSession({
    sessionTokenHash: sessionTokenHash(token),
    userId: record._id,
    createdAt,
    expiresAt,
  });
  return { user, token, expiresAt };
}

export async function getCurrentUser(token?: string, storage?: AuthStorage): Promise<AuthUser | null> {
  const resolvedToken = token ?? (await cookies()).get(AUTH_COOKIE_NAME)?.value;
  if (!resolvedToken || !AUTH_TOKEN_PATTERN.test(resolvedToken)) return null;
  const activeStorage = await resolveStorage(storage);
  const record = await activeStorage.findUserBySessionTokenHash(sessionTokenHash(resolvedToken), new Date());
  return record ? authUserFromRecord(record) : null;
}

export async function requireUser(request: NextRequest, storage?: AuthStorage): Promise<AuthUser> {
  const user = await getCurrentUser(request.cookies.get(AUTH_COOKIE_NAME)?.value ?? "", storage);
  if (!user) throw new ApiError(401, "Sign in to continue.", false, "AUTH_REQUIRED");
  return user;
}

export async function requireTenant(request: NextRequest, storage?: AuthStorage): Promise<AuthUser> {
  const user = await requireUser(request, storage);
  if (user.role !== "tenant") {
    throw new ApiError(403, "This action is available only to tenants.", false, "ROLE_NOT_ALLOWED");
  }
  return user;
}

export async function requireLandlord(request: NextRequest, storage?: AuthStorage): Promise<AuthUser> {
  const user = await requireUser(request, storage);
  if (user.role !== "landlord") {
    throw new ApiError(403, "This action is available only to landlords.", false, "ROLE_NOT_ALLOWED");
  }
  return user;
}

export async function revokeSessionToken(token?: string, storage?: AuthStorage): Promise<void> {
  if (!token || !AUTH_TOKEN_PATTERN.test(token)) return;
  const activeStorage = await resolveStorage(storage);
  await activeStorage.revokeSession(sessionTokenHash(token));
}

export interface RegisteredUser {
  id: string;
  role: UserRole;
  displayName: string;
  email?: string;
  walletAddress?: string;
  registeredAt: string;
}
const name = z.string().trim().min(1).max(160);
const optionalText = (maximum: number) => z.string().trim().min(1).max(maximum).optional();

export const registerSchema = z.object({
  role: z.enum(["tenant", "landlord"]),
  displayName: name,
  email: z.string().trim().email().max(320).optional(),
  // Wallet ownership cannot be proven by this local demo registration flow.
  walletAddress: optionalText(240),
}).strict();

export async function registerUser(ownerId: string, input: z.infer<typeof registerSchema>) {
  return mutateSession(ownerId, (document) => {
    const users = document.users ??= [];
    const previous = users.find((user) => user.role === input.role);
    const user: RegisteredUser = {
      id: previous?.id ?? randomUUID(), role: input.role, displayName: input.displayName,
      ...(input.email ? { email: input.email.toLowerCase() } : {}),
      ...(input.walletAddress ? { walletAddress: input.walletAddress } : {}),
      registeredAt: previous?.registeredAt ?? new Date().toISOString(),
    };
    if (previous) {
      Object.assign(previous, user);
      return previous;
    }
    users.push(user);
    return user;
  });
}

export function getRegisteredUser(session: Pick<SessionDocument, "users">, role: UserRole): RegisteredUser {
  const user = session.users?.find((item) => item.role === role);
  if (!user) throw new ApiError(401, `Register a ${role} profile in this demo session first.`);
  return user;
}
