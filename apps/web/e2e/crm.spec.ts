import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "ChangeMe-Demo-2026!";
const users = {
  sales: "sarah@demo.utilityoptimizer.ie",
  otherSales: "sean@demo.utilityoptimizer.ie",
  manager: "manager@demo.utilityoptimizer.ie",
  admin: "admin@demo.utilityoptimizer.ie",
};

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
}

/** Fails on serious or critical WCAG 2.1 AA violations. */
async function expectAccessible(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${label}: ${v.id} (${v.nodes.length}) ${v.help}`)).toEqual([]);
}

test("login page is accessible and rejects a wrong password", async ({ page }) => {
  await page.goto("/login");
  await expectAccessible(page, "login");
  await page.getByLabel("Email").fill(users.sales);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Email or password is incorrect.")).toBeVisible();
});

test("single sign-on errors are explained on the login page", async ({ page }) => {
  await page.goto("/login?error=sso_no_account");
  await expect(page.getByText("There's no active CRM account for that email address.")).toBeVisible();
  // No provider is configured in the dev stack, so no SSO buttons are offered.
  await expect(page.getByRole("link", { name: /Sign in with/ })).toHaveCount(0);
  await expectAccessible(page, "login with SSO error");
});

test("salesperson captures an electricity lead and sees electricity-only fields", async ({ page }) => {
  await signIn(page, users.sales);
  await expectAccessible(page, "dashboard");
  await page.getByRole("link", { name: "Opportunities" }).first().click();
  await page.getByRole("link", { name: "New opportunity" }).click();
  const name = `E2E Bakery ${Date.now()}`;
  await page.getByLabel("Opportunity name").fill(name);
  await page.getByLabel("Service").selectOption("electricity");
  await page.getByLabel("Business name").fill("E2E Bakery Ltd");
  await expectAccessible(page, "new opportunity");
  await page.getByRole("button", { name: "Create opportunity" }).click();

  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Energy/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Worldpay/ })).toHaveCount(0);
  await expectAccessible(page, "workspace");

  await page.getByRole("tab", { name: /Energy/ }).click();
  await expect(page.getByText("Electricity: each site needs an MPRN.")).toBeVisible();
  await page.getByRole("button", { name: "Add site" }).click();
  await page.getByLabel("Address line 1").fill("1 Quay Street");
  await page.getByLabel("Occupancy").selectOption("rented");
  await expect(page.getByLabel("Landlord name")).toBeVisible();
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Add meter" }).click();
  await expect(page.getByLabel("MPRN", { exact: true })).toBeVisible();
  await expect(page.getByLabel("GPRN", { exact: true })).toHaveCount(0);
  await page.getByLabel("MPRN", { exact: true }).fill("12345");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/should be 11 digits/)).toBeVisible();
  await page.getByLabel("MPRN", { exact: true }).fill("10098765432");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("10098765432")).toBeVisible();

  // Stage gate: a proposal needs nothing more for energy once there's a site, but Supplier Selected needs a supplier.
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Supplier or Product Selected" }).click();
  await expect(page.getByRole("dialog")).toContainText("Select the supplier.");
});

test("Worldpay opportunity shows the merchant workspace and hides energy sections", async ({ page }) => {
  await signIn(page, users.sales);
  await page.goto("/opportunities/new");
  await page.getByLabel("Opportunity name").fill(`E2E Card payments ${Date.now()}`);
  await page.getByLabel("Service").selectOption("merchant_services");
  await page.getByRole("button", { name: "Create opportunity" }).click();
  await expect(page.getByRole("tab", { name: /Worldpay/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Energy/ })).toHaveCount(0);
  await page.getByRole("tab", { name: /Worldpay/ }).click();
  await page.getByRole("button", { name: "Start application" }).click();
  await expect(page.getByText("Products & pricing")).toBeVisible();
  await page.getByLabel("Takes deposits").check();
  await expect(page.getByLabel("% of transactions that are deposits")).toBeVisible();
  await expectAccessible(page, "worldpay workspace");
});

test("duplicate customers are flagged before creation", async ({ page }) => {
  await signIn(page, users.sales);
  await page.goto("/customers/new");
  await page.getByLabel("Legal name").fill("Some Other Name Ltd");
  await page.getByLabel("Email").fill("hello@harbourcafe.example");
  await page.getByRole("button", { name: "Check and create" }).click();
  await expect(page.getByText("This customer may already exist")).toBeVisible();
  await expect(page.getByText("Harbour Café Limited")).toBeVisible();
  await expect(page.getByText("Same email")).toBeVisible();
});

test("salespeople only see their own pipeline; managers see everyone's", async ({ page }) => {
  await signIn(page, users.otherSales);
  await page.goto("/opportunities?view=all");
  await expect(page.getByText("Quayside Bakery – electricity")).toBeVisible();
  await expect(page.getByText("Harbour Café – dual fuel")).toHaveCount(0);

  await page.context().clearCookies();
  await signIn(page, users.manager);
  await page.goto("/opportunities?view=all");
  await expect(page.getByText("Harbour Café – dual fuel")).toBeVisible();
  await expect(page.getByText("Quayside Bakery – electricity")).toBeVisible();
});

test("won opportunities stay visible under All won and in the pipeline", async ({ page }) => {
  await signIn(page, users.manager);
  await page.goto("/opportunities?view=all_won");
  await expect(page.getByText("Quayside Bakery – electricity")).toBeVisible();
  await page.goto("/pipeline");
  await page.getByLabel("Whose opportunities").selectOption("all");
  await expect(page.getByRole("listitem", { name: /Live \/ Won/ })).toContainText("Quayside Bakery – electricity");
  await expectAccessible(page, "pipeline");
});

test("main pages pass automated accessibility checks", async ({ page }) => {
  await signIn(page, users.admin);
  for (const path of ["/opportunities", "/customers", "/activities", "/scan", "/admin", "/account"]) {
    await page.goto(path);
    await expect(page.locator("main h1")).toBeVisible();
    await expectAccessible(page, path);
  }
});

test("mobile layout keeps the menu and key figures usable @mobile", async ({ page }) => {
  await signIn(page, users.sales);
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
  await expect(page.getByText("Open pipeline")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
  await page.screenshot({ path: "e2e-report/mobile-dashboard.png", fullPage: true });
});
