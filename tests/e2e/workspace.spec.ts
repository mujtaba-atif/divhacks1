import { test, expect } from "@playwright/test";

test("desktop workspace renders assets and completes the tenant repair workflow", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No heat in apartment", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open evidence image" }).locator("img")).toBeVisible();
  await expect.poll(() => page.locator("img").first().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: "test-results/workspace-desktop.png", fullPage: true });

  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  await page.getByRole("checkbox", { name: "I reviewed this message and approve sending it." }).check();
  await page.getByRole("button", { name: "Approve & send", exact: true }).click();
  await expect(page.getByText("Simulated delivery", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Escrow", exact: true }).click();
  await page.getByRole("button", { name: "Set aside $400", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review & release $400", exact: true })).toBeDisabled();

  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  await page.getByRole("button", { name: "Schedule repair", exact: true }).click();
  await expect(page.getByText(/Demo landlord reply: A technician/)).toBeVisible();
  await page.getByRole("button", { name: "Report repair complete", exact: true }).click();
  await expect(page.getByRole("button", { name: "Report repair complete", exact: true })).toBeDisabled();

  await page.getByRole("tab", { name: /^Evidence/ }).click();
  await page.getByRole("button", { name: "Add after photo", exact: true }).click();
  await expect(page.getByRole("heading", { name: "After repair - 72F.png", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Analyze evidence", exact: true }).click();
  await page.getByRole("button", { name: "Verify repair", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Repair verification passed", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/evidence-verified.png", fullPage: true });

  await page.getByRole("tab", { name: "Escrow", exact: true }).click();
  await page.getByRole("button", { name: "Confirm repair is complete", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review & release $400", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Test wallet mismatch", exact: true }).click();
  await expect(page.getByText("Transaction blocked", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review & release $400", exact: true }).click();
  await page.getByRole("button", { name: "Approve release", exact: true }).click();
  await expect(page.getByText("Repair resolved. Case complete.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Repair resolved. Case complete.", { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("mobile navigation, dialogs, and new case creation remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No heat in apartment", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: "test-results/workspace-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Open workspace navigation" }).click();
  await page.getByRole("button", { name: "New case", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Open a repair case" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Street address").fill("123 Example Street");
  await dialog.getByLabel("Borough").selectOption("Brooklyn");
  await dialog.getByLabel("Apartment", { exact: true }).fill("5A");
  await dialog.getByLabel("What happened?").fill("The radiator is cold and the apartment has had no heat since Monday.");
  await expect(dialog.getByLabel("Landlord / property manager")).toHaveValue("Rayyan Khan");
  await expect(dialog.getByLabel("Landlord contact")).toHaveValue("+19736060558");
  await dialog.getByLabel("Monthly rent (USD)").fill("1850");
  await dialog.getByLabel("Disputed amount (USD)").fill("400");
  await dialog.getByRole("button", { name: "Create case", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText("123 Example Street, Apt 5A", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add evidence", exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: "Add case evidence" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
