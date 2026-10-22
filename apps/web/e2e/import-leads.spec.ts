import { type Page, expect, test } from "@playwright/test";

/** The CSV lead import with a list of businesses. Runs against the local stack with the dev seed, like crm.spec.ts. */

const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "ChangeMe-Demo-2026!";
const OPS = "ops@demo.utilityoptimizer.ie";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(OPS);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
}

/** Reads from the API with the page's session cookie. */
async function call<T = unknown>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (path) => (await fetch(`/api${path}`)).json(), path);
}

test("a list of businesses imports as one lead per chosen service, and the same file isn't imported twice", async ({ page }) => {
  await signIn(page);
  // Unique names and numbers so earlier runs don't count as duplicates.
  const run = Date.now();
  const phone = (n: number) => `01 ${String(run).slice(-3)} ${String(run + n).slice(-4)}`;
  const csv = [
    "Business Name,Category,Address,Area,Phone,Owner / Manager Name,Opening/Closing",
    `E2E Pantry ${run},Takeaway,"157 Drimnagh Road Dublin 12 D12 CX84, Co. Dublin",Dublin 12,${phone(1)},Paul McDonald (Owner),17:00-23:30`,
    `E2E Bakery ${run},Cafe,"Long Mile Road, Dublin 12, D12 T2H4",Dublin 12,${phone(2)},,`,
  ].join("\n");
  const file = { name: "businesses.csv", mimeType: "text/csv", buffer: Buffer.from(csv) };

  await page.goto("/opportunities");
  await page.getByRole("button", { name: "Import CSV" }).click();
  await expect(page.getByRole("alertdialog", { name: "Import leads from CSV" })).toBeVisible();
  // The dialog's content is slotted into the Material dialog, so it's found at page level.
  await page.getByRole("checkbox", { name: "Electricity", exact: true }).click();
  await page.getByRole("checkbox", { name: "Merchant Services / Worldpay", exact: true }).click();
  await page.getByLabel("CSV file").setInputFiles(file);
  await expect(page.getByText("Imported 4 leads and 2 customers.")).toBeVisible();

  const leads = await call<{ items: { name: string }[] }>(page, `/opportunities?q=${run}&pageSize=10`);
  expect(leads.items.map((o) => o.name).sort()).toEqual([`E2E Bakery ${run} – Electricity`, `E2E Bakery ${run} – Worldpay`, `E2E Pantry ${run} – Electricity`, `E2E Pantry ${run} – Worldpay`]);

  // The same file with the same services again is refused rather than duplicating every lead.
  await page.getByLabel("CSV file").setInputFiles(file);
  await expect(page.getByText(/This file was already imported on .+ with the same services/)).toBeVisible();
  expect((await call<{ total: number }>(page, `/opportunities?q=${run}&pageSize=10`)).total).toBe(4);
});
