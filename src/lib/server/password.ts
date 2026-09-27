import "server-only";

import bcrypt from "bcryptjs";

const PASSWORD_COST = 12;
// A public sentinel keeps unknown-email comparisons on the same bcrypt path.
const INVALID_PASSWORD_HASH = "$2b$12$g.gLQV1a7zSeWkOBQuZEyO.4ZFlo9JyNW/MuuWCcZPS37lX2R92OS";

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, PASSWORD_COST);
}

export function verifyPassword(password: string, passwordHash?: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash ?? INVALID_PASSWORD_HASH);
}
