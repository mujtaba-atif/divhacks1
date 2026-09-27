import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execute = promisify(execFile);

test("user seeding is idempotent and initializes only the two tenant workspaces", async () => {
  const { stdout } = await execute(process.execPath,
    ["--conditions=react-server", "--import", "tsx", "scripts/verify-e2e-seed.ts"], { cwd: process.cwd() });
  const result = JSON.parse(stdout) as {
    first: { id: string; workspaceOwnerId: string }[];
    second: { id: string; workspaceOwnerId: string }[];
    users: { email: string; role: string; displayName: string; hasBcryptHash: boolean; containsPlaintextPassword: boolean }[];
    workspaces: { demoAccount: string; caseIds: string[]; xrplAuthorized: boolean }[];
    propertyCount: number;
  };
  expect(result.second).toEqual(result.first);
  expect(result.users).toHaveLength(3);
  expect(result.users.map((user) => [user.email, user.role, user.displayName])).toEqual([
      ["landlord@rentescrow.demo", "landlord", "Alex Morgan"],
      ["tenant1@rentescrow.demo", "tenant", "Taylor Reed"],
      ["tenant2@rentescrow.demo", "tenant", "Jordan Lee"],
  ]);
  for (const user of result.users) {
    expect(user.hasBcryptHash).toBe(true);
    expect(user.containsPlaintextPassword).toBe(false);
  }
  expect(result.workspaces).toHaveLength(2);
  expect(result.workspaces.find((workspace) => workspace.demoAccount === "tenant1")?.caseIds).toEqual(["RE-1042"]);
  expect(result.workspaces.find((workspace) => workspace.demoAccount === "tenant2")?.caseIds).toEqual([]);
  expect(result.workspaces.find((workspace) => workspace.demoAccount === "tenant1")?.xrplAuthorized).toBe(true);
  expect(result.workspaces.find((workspace) => workspace.demoAccount === "tenant2")?.xrplAuthorized).toBe(false);
  expect(result.propertyCount).toBe(1);
});
