import { type Page, expect, test } from "@playwright/test";

/** Assigning ticked leads and deleting untouched ones. Runs against the local stack with the dev seed, like crm.spec.ts. */

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

test("a manager ticks leads on the list and assigns them to a salesperson", async ({ page }) => {
  await signIn(page, "manager@demo.utilityoptimizer.ie");
  const tag = `E2E Assign ${Date.now()}`;
  await importCsv(page, ["Company,Service,Campaign", `${tag} One,Gas,${tag}`, `${tag} Two,Electricity,${tag}`].join("\n"));

  await page.goto(`/opportunities?view=all&q=${encodeURIComponent(tag)}`);
  await expect(page.getByRole("table").getByRole("link", { name: `${tag} One – Gas` })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select all on this page" }).check();
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("textbox", { name: "Assign to", exact: true }).click();
  await page.getByRole("option", { name: "Sarah Sales", exact: true }).click();
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.getByText("Assigned 2 to Sarah Sales.")).toBeVisible();
  await expect(page.getByRole("table").getByRole("cell", { name: "Sarah Sales" })).toHaveCount(2);
});

test("an administrator permanently deletes an import batch of untouched leads", async ({ page }) => {
  await signIn(page, "admin@demo.utilityoptimizer.ie");
  const campaign = `E2E delete ${Date.now()}`;
  await importCsv(page, ["Company,Service,Campaign", `E2E Gone One,Gas,${campaign}`, `E2E Gone Two,Electricity,${campaign}`].join("\n"));

  await page.goto("/admin");
  await page.getByRole("tab", { name: "Data retention" }).click();
  await page.getByRole("textbox", { name: "Import batch (campaign)", exact: true }).click();
  await page.getByRole("option", { name: campaign, exact: true }).click();
  await expect(page.getByText("2 leads can be deleted.")).toBeVisible();
  const remove = page.getByRole("button", { name: "Delete 2 leads" });
  await expect(remove).toBeDisabled();
  await page.getByLabel("Type DELETE to confirm").fill("DELETE");
  await remove.click();
  await expect(page.getByText("Deleted 2 leads.")).toBeVisible();

  await page.goto(`/opportunities?view=all&q=${encodeURIComponent("E2E Gone")}`);
  await expect(page.getByText("Nothing here")).toBeVisible();
});

test("deleting leads isn't offered to a manager", async ({ page }) => {
  await signIn(page, "manager@demo.utilityoptimizer.ie");
  await page.goto("/admin");
  await expect(page.getByRole("tab", { name: "Data retention" })).toHaveCount(0);
  await expect(page.getByText("Delete leads")).toHaveCount(0);
});
