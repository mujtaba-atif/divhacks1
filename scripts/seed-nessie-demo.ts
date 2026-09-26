import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const ORIGIN = "https://api.nessieisreal.com";
const id = z.union([z.string().regex(/^[a-f0-9]{24}$/i), z.string().uuid()]);
const receipt = z.object({ objectCreated: z.object({ _id: id }) });
const manifestSchema = z.object({
  version: z.literal(1), origin: z.literal(ORIGIN), keyFingerprint: z.string(),
  date: z.string(), completed: z.record(id), pending: z.string().optional(),
});
type Manifest = z.infer<typeof manifestSchema>;
class SetupError extends Error {}

function dateForMonth(date: string, offset: number) {
  const now = new Date(date);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
}

async function main() {
  let lock: FileHandle | undefined;
  const directory = path.resolve(".data");
  const manifestPath = path.join(directory, "nessie-demo.json");
  const lockPath = path.join(directory, "nessie-demo.lock");
  try {
    if (!process.argv.includes("--create-demo")) {
      throw new SetupError("This command creates synthetic records in the Nessie mock API. Run pnpm nessie:seed --create-demo to opt in. It never creates a real bank account or moves real money.");
    }
    if (existsSync(".env.local")) process.loadEnvFile(".env.local");
    const key = process.env.NESSIE_API_KEY?.trim();
    if (!key) throw new SetupError("NESSIE_API_KEY is missing. Add it to ignored .env.local; never put it in the command line or chat.");
    if (process.env.NESSIE_BASE_URL && process.env.NESSIE_BASE_URL !== ORIGIN) {
      throw new SetupError("The seed command only supports the current approved HTTPS Nessie origin.");
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { lock = await open(lockPath, "wx", 0o600); }
    catch { throw new SetupError("Another seed may be running or was interrupted. Review .data/nessie-demo.json and the provider records before removing the lock; do not blindly retry."); }
    const keyFingerprint = createHash("sha256").update(key).digest("hex");
    const manifest: Manifest = existsSync(manifestPath)
      ? manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")))
      : { version: 1, origin: ORIGIN, keyFingerprint, date: new Date().toISOString().slice(0, 10), completed: {} };
    if (manifest.keyFingerprint !== keyFingerprint) {
      throw new SetupError("The saved demo manifest belongs to another API key. Review it before provisioning a different workspace.");
    }
    if (manifest.pending) {
      throw new SetupError("A previous provider write has an uncertain outcome. Inspect its pending step in .data/nessie-demo.json and reconcile with Nessie before retrying.");
    }
    const save = async () => {
      const temporary = `${manifestPath}.tmp`;
      await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, manifestPath);
    };
    await save();
    const create = async (step: string, endpoint: string, payload: unknown): Promise<string> => {
      const existing = manifest.completed[step];
      if (existing) return existing;
      manifest.pending = step;
      await save();
      const url = new URL(endpoint, ORIGIN);
      url.searchParams.set("key", key);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
          redirect: "error", signal: AbortSignal.timeout(20_000),
        });
      } catch { throw new SetupError(`The ${step} write could not be confirmed. Its pending receipt was retained. Reconcile it before retrying.`); }
      if (response.status !== 201) {
        throw new SetupError(`Nessie did not confirm ${step} creation (HTTP ${response.status}). The pending receipt was retained for review; no automatic retry was performed.`);
      }
      let createdId: string;
      try { createdId = receipt.parse(await response.json()).objectCreated._id; }
      catch { throw new SetupError(`Nessie returned an invalid ${step} receipt. Reconcile the pending operation before retrying.`); }
      manifest.completed[step] = createdId;
      delete manifest.pending;
      await save();
      console.log(`Synthetic ${step} created and receipt saved.`);
      return createdId;
    };
    const address = { street_number: "123", street_name: "Example Street", city: "Brooklyn", state: "NY", zip: "11201" };
    const customerId = await create("customer", "/customers", { first_name: "RentEscrow", last_name: "Demo", address });
    const accountId = await create("account", `/customers/${customerId}/accounts`, {
      type: "Checking", nickname: "RentEscrow NYC synthetic demo", rewards: 0, balance: 6500,
    });
    const merchantId = await create("merchant", "/merchants", {
      name: "RentEscrow Demo Supplies", category: "Other", address, geocode: { lat: 40.694, lng: -73.986 },
    });
    for (const purchase of [
      { step: "heater", amount: 47.99, description: "Synthetic demo: space heater for no-heat case" },
      { step: "lodging", amount: 110, description: "Synthetic demo: temporary hotel accommodation" },
      { step: "groceries", amount: 65, description: "Synthetic demo: routine groceries" },
    ]) {
      await create(purchase.step, `/accounts/${accountId}/purchases`, {
        merchant_id: merchantId, medium: "balance", purchase_date: manifest.date,
        amount: purchase.amount, status: "completed", description: purchase.description,
      });
    }
    for (const bill of [{ step: "rentPrevious", offset: -1, status: "completed" },
      { step: "rentCurrent", offset: 0, status: "completed" }, { step: "rentNext", offset: 1, status: "pending" }]) {
      await create(bill.step, `/accounts/${accountId}/bills`, {
        status: bill.status, payee: "RentEscrow Demo Landlord", nickname: `Synthetic rent ${bill.step}`,
        payment_date: dateForMonth(manifest.date, bill.offset), payment_amount: 1850,
        recurring_date: 1,
      });
    }
    console.log("Synthetic Nessie demo provisioning complete. Provider balances and statuses must be verified by readback, not assumed.");
    console.log(`NESSIE_CUSTOMER_ID=${customerId}\nNESSIE_ACCOUNT_ID=${accountId}\nNESSIE_RENT_PAYEE=RentEscrow Demo Landlord`);
    console.log("Bind NESSIE_TENANT_ID to the current workspace's server-issued tenant ID, then enable Nessie and run pnpm nessie:check. No secrets are in this output.");
  } catch (error) {
    console.error(error instanceof SetupError ? error.message : "Nessie demo setup failed. Check the local manifest and private configuration; no automatic retries were made.");
    process.exitCode = 1;
  } finally {
    if (lock) {
      await lock.close();
      await unlink(lockPath);
    }
  }
}

void main();
