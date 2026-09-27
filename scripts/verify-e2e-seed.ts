import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { closeMongoConnection } from "../src/lib/server/mongodb";
import { seedUsers } from "./seed-users";

async function main() {
  const mongo = await MongoMemoryServer.create({ instance: { dbName: "rentescrow_seed_e2e" } });
  const client = new MongoClient(mongo.getUri());
  try {
    process.env.MONGODB_URI = mongo.getUri();
    process.env.MONGODB_DATABASE = "rentescrow_seed_e2e";
    process.env.RENTESCROW_STORAGE = "mongodb";
    const first = await seedUsers();
    const second = await seedUsers();
    await client.connect();
    const database = client.db("rentescrow_seed_e2e");
    const users = await database.collection("users").find({}, { projection: { email: 1, role: 1, displayName: 1, passwordHash: 1, phoneContact: 1, phoneContactConfiguredAt: 1 } }).sort({ email: 1 }).toArray();
    const workspaces = await database.collection("sessions").find({}, { projection: { demoAccount: 1, cases: 1, xrplAuthorized: 1 } }).toArray();
    const propertyCount = await database.collection<{ _id: string }>("properties").countDocuments({ _id: "demo-123-example" });
    process.stdout.write(`${JSON.stringify({
      first: first.map((user) => ({ id: user.id, workspaceOwnerId: user.workspaceOwnerId })),
      second: second.map((user) => ({ id: user.id, workspaceOwnerId: user.workspaceOwnerId })),
      users: users.map((user) => ({
        email: user.email,
        role: user.role,
        displayName: user.displayName,
        hasBcryptHash: /^\$2[aby]\$/.test(user.passwordHash),
        containsPlaintextPassword: user.passwordHash.includes("Demo123!"),
        contactConfigured: Boolean(user.phoneContactConfiguredAt && /^\+[1-9]\d{7,14}$/.test(user.phoneContact)),
      })),
      workspaces: workspaces.map((workspace) => ({ demoAccount: workspace.demoAccount, caseIds: (workspace.cases as { id: string }[]).map((item) => item.id), xrplAuthorized: workspace.xrplAuthorized === true })),
      propertyCount,
      bindingMatchesUsers: workspaces.filter((workspace) => workspace.demoAccount === "tenant1").every((workspace) => {
        const binding = workspace.cases[0]?.messagingBinding;
        const tenant = users.find((user) => user.email === "tenant1@rentescrow.demo");
        const landlord = users.find((user) => user.email === "landlord@rentescrow.demo");
        return binding?.tenant.userId === tenant?._id.toHexString() && binding?.tenant.phone === tenant?.phoneContact
          && binding?.landlord.userId === landlord?._id.toHexString() && binding?.landlord.phone === landlord?.phoneContact;
      }),
    })}\n`);
  } finally {
    await client.close().catch(() => undefined);
    await closeMongoConnection().catch(() => undefined);
    await mongo.stop();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Seed verification failed.");
  process.exitCode = 1;
});
