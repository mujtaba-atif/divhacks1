import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./errors";
import { mutateSession, type SessionDocument } from "./store";

export type UserRole = "tenant" | "landlord";

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
