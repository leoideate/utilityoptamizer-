import { expect, test } from "@playwright/test";

/** The New lead form. Runs against the local stack with the dev seed, like crm.spec.ts. */

const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "ChangeMe-Demo-2026!";

test("a new lead's source starts as Manual entry", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sarah@demo.utilityoptimizer.ie");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();

  await page.goto("/opportunities/new");
  // The select is a web component; its label is a property, not an attribute.
  const leadSource = () => page.evaluate(() => ([...document.querySelectorAll("md-select")] as unknown as { label: string; value: string }[]).find((s) => s.label === "Lead source")?.value);
  await expect.poll(leadSource).toBe("manual");
});
