import assert from "node:assert/strict";
import { test } from "node:test";
import { ObjectId } from "mongodb";
import {
  getCurrentUser,
  loginWithPassword,
  requireLandlord,
  requireTenant,
  revokeSessionToken,
} from "../src/lib/server/auth";
import type { AuthSessionRecord, AuthStorage, AuthUserRecord } from "../src/lib/server/auth-store";
import { hashPassword } from "../src/lib/server/password";
import { NextRequest } from "next/server";

class MemoryAuthStorage implements AuthStorage {
  users: AuthUserRecord[] = [];
  sessions: AuthSessionRecord[] = [];

  async findUserByEmail(email: string) {
    return this.users.find((user) => user.email === email) ?? null;
  }

  async findUserBySessionTokenHash(sessionTokenHash: string, now: Date) {
    const session = this.sessions.find((item) => item.sessionTokenHash === sessionTokenHash && item.expiresAt > now);
    return session ? this.users.find((user) => user._id.equals(session.userId)) ?? null : null;
  }

  async createSession(session: AuthSessionRecord) {
    this.sessions.push({ ...session, userId: new ObjectId(session.userId), expiresAt: new Date(session.expiresAt) });
  }

  async revokeSession(sessionTokenHash: string) {
    this.sessions = this.sessions.filter((item) => item.sessionTokenHash !== sessionTokenHash);
  }
}

async function storageWithUser(role: "tenant" | "landlord" = "tenant") {
  const storage = new MemoryAuthStorage();
  storage.users.push({
    _id: new ObjectId("66f75d2f3a904f36a7587d11"),
    email: role === "tenant" ? "tenant1@rentescrow.demo" : "landlord@rentescrow.demo",
    passwordHash: await hashPassword(role === "tenant" ? "TenantDemo123!" : "LandlordDemo123!"),
    role,
    displayName: role === "tenant" ? "Taylor Reed" : "Alex Morgan",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  return storage;
}

function authenticatedRequest(token: string) {
  return new NextRequest("http://localhost:3000/api/dashboard", {
    headers: { cookie: `rentescrow_session=${token}` },
  });
}

test("login stores only a token hash and returns a stable public user projection", async () => {
  const storage = await storageWithUser();
  const result = await loginWithPassword({
    email: "TENANT1@RENTESCROW.DEMO",
    password: "TenantDemo123!",
  }, storage);

  assert.match(result.token, /^[a-f0-9]{64}$/);
  assert.equal(storage.sessions.length, 1);
  assert.notEqual(storage.sessions[0].sessionTokenHash, result.token);
  assert.equal(storage.sessions[0].sessionTokenHash.length, 64);
  assert.equal(storage.sessions[0].userId.toHexString(), result.user.id);
  assert.equal(result.user.role, "tenant");
  assert.match(result.user.workspaceOwnerId, /^[a-f0-9]{64}$/);
  assert.equal("passwordHash" in result.user, false);
  assert.deepEqual(await getCurrentUser(result.token, storage), result.user);
});

test("unknown emails and wrong passwords return the same generic failure without sessions", async () => {
  const storage = await storageWithUser();
  for (const credentials of [
    { email: "missing@rentescrow.demo", password: "TenantDemo123!" },
    { email: "tenant1@rentescrow.demo", password: "wrong-password" },
  ]) {
    await assert.rejects(loginWithPassword(credentials, storage), (error: Error & { status?: number }) => {
      assert.equal(error.status, 401);
      assert.equal(error.message, "Invalid email or password.");
      return true;
    });
  }
  assert.equal(storage.sessions.length, 0);
});

test("expired and revoked sessions fail closed", async () => {
  const storage = await storageWithUser();
  const { token } = await loginWithPassword({
    email: "tenant1@rentescrow.demo",
    password: "TenantDemo123!",
  }, storage);
  storage.sessions[0].expiresAt = new Date(0);
  assert.equal(await getCurrentUser(token, storage), null);

  storage.sessions[0].expiresAt = new Date(Date.now() + 60_000);
  await revokeSessionToken(token, storage);
  assert.equal(await getCurrentUser(token, storage), null);
});

test("role helpers enforce the authoritative MongoDB role", async () => {
  const tenantStorage = await storageWithUser("tenant");
  const tenantLogin = await loginWithPassword({
    email: "tenant1@rentescrow.demo",
    password: "TenantDemo123!",
  }, tenantStorage);
  assert.equal((await requireTenant(authenticatedRequest(tenantLogin.token), tenantStorage)).role, "tenant");
  await assert.rejects(
    requireLandlord(authenticatedRequest(tenantLogin.token), tenantStorage),
    (error: Error & { status?: number; code?: string }) => error.status === 403 && error.code === "ROLE_NOT_ALLOWED",
  );
});
