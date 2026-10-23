import { type Page, expect, test } from "@playwright/test";

/** Closing an import batch of leads. Runs against the local stack with the dev seed, like crm.spec.ts. */

const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "ChangeMe-Demo-2026!";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
}

/** Imports a CSV from the page, with the session cookie and CSRF token, as the app does. */
async function importCsv(page: Page, csv: string) {
  const status = await page.evaluate(async (csv) => {
    const csrf = decodeURIComponent(document.cookie.split("; ").find((c) => c.startsWith("uo_csrf="))?.split("=")[1] ?? "");
    const fd = new FormData();
    fd.append("file", new File([csv], "leads.csv", { type: "text/csv" }));
    return (await fetch("/api/opportunities/import", { method: "POST", headers: { "X-CSRF-Token": csrf }, body: fd })).status;
  }, csv);
  expect(status).toBe(201);
}

test("a manager marks one service of an import batch lost, and the rest of the batch stays open", async ({ page }) => {
  await signIn(page, "manager@demo.utilityoptimizer.ie");
  const campaign = `E2E batch ${Date.now()}`;
  await importCsv(page, ["Company,Service,Campaign", `E2E Café,Worldpay,${campaign}`, `E2E Café,Electricity,${campaign}`, `E2E Bar,Worldpay,${campaign}`, `E2E Bar,Electricity,${campaign}`].join("\n"));

  await page.goto("/opportunities");
  await page.getByRole("button", { name: "Close a lead batch" }).click();
  await expect(page.getByRole("alertdialog", { name: "Close a lead batch" })).toBeVisible();
  // The dialog's content is slotted into the Material dialog, so it's found at page level.
  await page.getByRole("textbox", { name: "Import batch (campaign)", exact: true }).click();
  await page.getByRole("option", { name: `${campaign} (4 leads)`, exact: true }).click();
  await page.getByRole("textbox", { name: "Which leads", exact: true }).click();
  await page.getByRole("option", { name: "Only Merchant Services / Worldpay (2 leads)", exact: true }).click();
  await page.getByLabel("Reason").fill("Duplicate: one lead per business is kept");
  await page.getByRole("button", { name: "Mark 2 leads lost" }).click();
  await expect(page.getByText("Marked 2 leads lost.")).toBeVisible();

  // What's left of the batch is its Electricity leads.
  await page.getByRole("textbox", { name: "Import batch (campaign)", exact: true }).click();
  await expect(page.getByRole("option", { name: `${campaign} (2 leads)`, exact: true })).toBeVisible();
});

test("the batch close isn't offered to a salesperson", async ({ page }) => {
  await signIn(page, "sarah@demo.utilityoptimizer.ie");
  await page.goto("/opportunities");
  await expect(page.getByRole("button", { name: "Import CSV" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close a lead batch" })).toHaveCount(0);
});
