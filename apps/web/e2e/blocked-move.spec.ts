import { type Page, expect, test } from "@playwright/test";

/** "Can't move … yet": each item links to where it's fixed. Runs against the local stack with the dev seed, like crm.spec.ts. */

const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "ChangeMe-Demo-2026!";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
}

/** A new electricity lead with no supply site, created with the session cookie and CSRF token as the app does. */
async function newLead(page: Page): Promise<string> {
  const res = await page.evaluate(async (name) => {
    const csrf = decodeURIComponent(document.cookie.split("; ").find((c) => c.startsWith("uo_csrf="))?.split("=")[1] ?? "");
    const r = await fetch("/api/opportunities", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ name, serviceType: "electricity", companyName: name }) });
    return { status: r.status, body: await r.json() };
  }, `E2E Blocked move ${Date.now()}`);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

test("a blocked stage move takes you to where the first missing item is fixed", async ({ page }) => {
  await signIn(page, "admin@demo.utilityoptimizer.ie");
  const id = await newLead(page);
  await page.goto(`/opportunities/${id}`);

  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Submitted", exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: /Can't move to Submitted yet/ })).toBeVisible();
  // The first thing a lead without a site needs is a supply site, added on the Energy tab.
  await expect(page.getByRole("button", { name: "Add at least one supply site before sending a proposal." })).toBeVisible();

  await page.getByRole("button", { name: "Take me there" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page).toHaveURL(/tab=energy/);
});

test("a link to the case's submissions lands on Record submission", async ({ page }) => {
  await signIn(page, "admin@demo.utilityoptimizer.ie");
  const id = await newLead(page);
  // The Pipeline board opens the deal like this for "Record the external party's acceptance…".
  await page.goto(`/opportunities/${id}?tab=forms#case-submissions`);
  await expect(page.locator("#case-submissions").getByRole("heading", { name: "Sent to the external party" })).toBeInViewport();
});
