import { ObjectId } from "mongodb";
import type { AuthUser } from "../src/lib/types";
import { DEMO_PARTICIPANTS } from "../src/lib/seed";
import {
  ensureAuthIndexes,
  USERS_COLLECTION,
  type AuthUserRecord,
} from "../src/lib/server/auth-store";
import { authUserFromRecord } from "../src/lib/server/auth";
import { ApiError } from "../src/lib/server/errors";
import { closeMongoConnection, getMongoDatabase } from "../src/lib/server/mongodb";
import { hashPassword } from "../src/lib/server/password";
import { initializeUserWorkspace } from "../src/lib/server/store";

const DEMO_USERS = [
  {
    email: "tenant1@rentescrow.demo",
    password: "TenantDemo123!",
    role: "tenant",
    displayName: DEMO_PARTICIPANTS.tenant.name,
    phoneContact: DEMO_PARTICIPANTS.tenant.phone,
  },
  {
    email: "tenant2@rentescrow.demo",
    password: "TenantDemo123!",
    role: "tenant",
    displayName: "Jordan Lee",
  },
  {
    email: "landlord@rentescrow.demo",
    password: "LandlordDemo123!",
    role: "landlord",
    displayName: "Alex Morgan",
    phoneContact: DEMO_PARTICIPANTS.landlord.phone,
  },
] as const;

interface PropertyRecord {
  _id: string;
  address: string;
  borough: string;
  landlordUserId: string;
  updatedAt: Date;
  createdAt: Date;
}

export async function seedUsers(): Promise<AuthUser[]> {
  if (process.env.RENTESCROW_STORAGE === "local") {
    throw new ApiError(503,
      "User seeding requires MongoDB workspace storage. Remove RENTESCROW_STORAGE=local or set it to mongodb.");
  }
  const database = await getMongoDatabase();
  await ensureAuthIndexes(database);
  const users = database.collection<AuthUserRecord>(USERS_COLLECTION);
  const now = new Date();
  const seeded: AuthUser[] = [];

  for (const demo of DEMO_USERS) {
    const passwordHash = await hashPassword(demo.password);
    const record = await users.findOneAndUpdate(
      { email: demo.email },
      {
        $set: {
          email: demo.email,
          passwordHash,
          role: demo.role,
          displayName: demo.displayName,
          ...("phoneContact" in demo ? { phoneContact: demo.phoneContact, phoneContactConfiguredAt: now } : {}),
          updatedAt: now,
        },
        $setOnInsert: { _id: new ObjectId(), createdAt: now },
      },
      { upsert: true, returnDocument: "after" },
    );
    if (!record) throw new Error("MongoDB did not return the seeded user record.");
    seeded.push(authUserFromRecord(record));
  }

  const landlord = seeded.find((user) => user.role === "landlord");
  if (!landlord) throw new Error("The seeded landlord record is missing.");
  await database.collection<PropertyRecord>("properties").updateOne(
    { _id: "demo-123-example" },
    {
      $set: {
        address: "123 Example Street",
        borough: "Brooklyn",
        landlordUserId: landlord.id,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );

  for (const user of seeded) await initializeUserWorkspace(user, landlord.id, {
    ...(user.email === "tenant1@rentescrow.demo" ? { tenantPhone: DEMO_PARTICIPANTS.tenant.phone } : {}),
    landlordPhone: DEMO_PARTICIPANTS.landlord.phone,
  });
  return seeded;
}

async function main() {
  try {
    const users = await seedUsers();
    for (const user of users) console.log(`${user.email} | ${user.role} | ${user.displayName}`);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "MongoDB could not complete user seeding.";
    console.error(`User seeding failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await closeMongoConnection().catch(() => {
      console.error("User seeding failed: MongoDB connection cleanup did not complete.");
      process.exitCode = 1;
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
