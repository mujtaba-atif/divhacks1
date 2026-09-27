import { expect, test } from "./auth-fixtures";
import { origin } from "./environment";

const caseInput = {
  issue: "heating", description: "The radiator has stopped producing heat in this apartment.",
  noticedAt: "2026-09-23", address: "123 Example Street", borough: "Brooklyn",
  apartment: "5A", landlordName: "", landlordContact: "",
  monthlyRentCents: 300_000, disputedAmountCents: 40_000,
};

test("registration is unavailable and a tenant cannot accept as a landlord", async ({ request }) => {
  const registration = await request.post("/api/auth/register", {
    headers: { Origin: origin }, data: { role: "tenant", displayName: "Taylor Tenant", walletAddress: "rTENANT789" },
  });
  expect(registration.status()).toBe(404);

  const bilateral = await request.post("/api/contracts", {
    headers: { Origin: origin }, data: { case_type: "bilateral", terms: "Bilateral repair terms." },
  });
  expect(bilateral.status()).toBe(409);
  expect((await bilateral.json()).code).toBe("BILATERAL_CONTRACT_UNAVAILABLE");

  const contractResponse = await request.post("/api/contracts", {
    headers: { Origin: origin }, data: { case_type: "self_documentation", terms: "Tenant-only documentation terms." },
  });
  expect(contractResponse.ok(), await contractResponse.text()).toBeTruthy();
  const contract = (await contractResponse.json()).contract;

  const roleEscalation = await request.post(`/api/contracts/${contract.id}/accept`, {
    headers: { Origin: origin }, data: { role: "landlord" },
  });
  expect(roleEscalation.status()).toBe(403);

  const created = await request.post("/api/contracts/cases", {
    headers: { Origin: origin }, data: { contractId: contract.id, case: caseInput },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const record = (await created.json()).case;
  expect(record.case_type).toBe("self_documentation");
  expect(record.escrow.destination).toBe("");

  const dryRun = await request.post(`/api/cases/${record.id}/actions`, {
    headers: { Origin: origin }, data: { action: "policy_check", intent: {
      caseId: record.id, escrowId: record.escrow.id, transactionType: "EscrowFinish", destination: "",
      amountCents: 40_000, network: "demo",
    } },
  });
  expect(dryRun.ok(), await dryRun.text()).toBeTruthy();
  const result = await dryRun.json();
  expect(result.policy.approved).toBe(false);
  expect(result.case.escrow.audit.at(-1).status).toBe("rejected");
});
