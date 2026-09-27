import { readFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./auth-fixtures";
import type { DashboardData } from "../../src/lib/types";

for (const width of [320, 768, 1920]) {
  test(`all case tabs fit the ${width}px viewport without body overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "No heat in apartment", exact: true })).toBeVisible();
    for (const name of ["Overview", "Evidence", "Messages", "Finances", "Escrow"]) {
      await test.step(name, async () => {
        const tab = page.getByRole("tab", { name: name === "Evidence" ? /^Evidence/ : name, exact: name !== "Evidence" });
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("tabpanel")).toBeVisible();
        const dimensions = await page.evaluate(() => ({
          viewport: window.innerWidth,
          document: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
        }));
        expect.soft(dimensions.document, `${name} document width at ${width}px`).toBeLessThanOrEqual(dimensions.viewport + 1);
        expect.soft(dimensions.body, `${name} body width at ${width}px`).toBeLessThanOrEqual(dimensions.viewport + 1);
      });
    }
  });
}

test("manual expense entry closes the modal and persists integer cents", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1000 });
  await page.goto("/");
  await page.getByRole("tab", { name: "Finances", exact: true }).click();
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Record an expense" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Description", { exact: true }).fill("Window insulation tape");
  await dialog.getByLabel("Amount (USD)").fill("35.49");
  await dialog.getByLabel("Category").selectOption("supplies");
  await dialog.getByRole("button", { name: "Add expense", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Window insulation tape" });
  await expect(row).toContainText("$35.49");
  await expect(row).toContainText("Added by you");
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");

  await page.reload();
  await page.getByRole("tab", { name: "Finances", exact: true }).click();
  await expect(row).toContainText("$35.49");
  const data = await (await page.request.get("/api/dashboard")).json() as DashboardData;
  const expense = data.cases[0].expenses.find((item) => item.label === "Window insulation tape");
  expect(expense?.amountCents).toBe(3549);
  expect(expense?.source).toBe("manual");
});

test("an uploaded PNG remains real and unverified without Gemini credentials", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No heat in apartment", exact: true })).toBeVisible();
  const initial = await (await page.request.get("/api/dashboard")).json() as DashboardData;
  expect(initial.integrations.find((item) => item.id === "gemini")?.status).toBe("demo");
  await page.getByRole("button", { name: "Add evidence", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add case evidence" });
  await dialog.getByLabel("Evidence file").setInputFiles({
    name: "tenant-upload.png", mimeType: "image/png",
    buffer: await readFile(path.join(process.cwd(), "public/evidence-before.png")),
  });
  await dialog.getByLabel("Evidence stage").selectOption("after");
  await dialog.getByLabel("Temperature (°F, optional)").fill("54");
  await dialog.getByLabel("Notes", { exact: true }).fill("Tenant upload for the no-key analyzer check.");
  await dialog.getByRole("button", { name: "Add to case", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "tenant-upload.png", exact: true }) });
  await expect(card).toBeVisible();
  await expect.poll(() => card.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(card.getByRole("alert").filter({ hasText: "Gemini is not configured" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Retry AI analysis", exact: true })).toBeEnabled();
  await expect(card.getByText("54°F tenant-reported", { exact: true })).toBeVisible();
  await expect(card.getByText("Verification evidence passed", { exact: true })).toHaveCount(0);
  const data = await (await page.request.get("/api/dashboard")).json() as DashboardData;
  const uploaded = data.cases[0].evidence.find((item) => item.name === "tenant-upload.png");
  expect(uploaded?.isDemo).toBe(false);
  expect(uploaded?.analysis).toBeUndefined();
  expect(uploaded?.analysisError?.code).toBe("unavailable");
  expect(data.cases[0].verification?.verified).not.toBe(true);
  expect(data.cases[0].tenantConfirmed).toBe(false);
});
