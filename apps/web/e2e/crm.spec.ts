import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "ChangeMe-Demo-2026!";
const users = {
  sales: "sarah@demo.utilityoptimizer.ie",
  otherSales: "sean@demo.utilityoptimizer.ie",
  manager: "manager@demo.utilityoptimizer.ie",
  admin: "admin@demo.utilityoptimizer.ie",
  ops: "ops@demo.utilityoptimizer.ie",
};

/** Sessions are reused per user: logging in for every test would trip the login rate limit (10/min per IP). */
const sessions = new Map<string, Awaited<ReturnType<import("@playwright/test").BrowserContext["cookies"]>>>();

async function signIn(page: Page, email: string) {
  const saved = sessions.get(email);
  if (saved) {
    await page.context().clearCookies();
    await page.context().addCookies(saved);
    await page.goto("/");
    await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
    return;
  }
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
  sessions.set(email, await page.context().cookies());
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
  await page.getByRole("link", { name: "Leads and deals" }).first().click();
  await page.getByRole("link", { name: "New opportunity" }).click();
  const name = `E2E Bakery ${Date.now()}`;
  await page.getByLabel("Opportunity name").fill(name);
  await page.getByLabel("Service", { exact: true }).selectOption("electricity");
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

test("a change of entity case shows its status and guided checklist, and records where the supply details came from", async ({ page }) => {
  await signIn(page, users.sales);
  await page.goto("/opportunities/new");
  const name = `E2E Change of entity ${Date.now()}`;
  await page.getByLabel("Opportunity name").fill(name);
  await page.getByLabel("Service", { exact: true }).selectOption("electricity");
  await page.getByLabel("Business name").fill("E2E Incoming Ltd");
  await page.getByRole("button", { name: "Create opportunity" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  const id = page.url().split("/opportunities/")[1].split("?")[0];
  // Mark it as a change of legal entity through the API (the same call the details form makes).
  const status = await page.evaluate(async (oppId) => {
    const csrf = decodeURIComponent(document.cookie.split("; ").find((c) => c.startsWith("uo_csrf="))?.split("=")[1] ?? "");
    const res = await fetch(`/api/opportunities/${oppId}`, { method: "PATCH", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ supplyChanges: ["change_of_legal_entity"] }) });
    return res.status;
  }, id);
  expect(status).toBe(204);

  await page.goto(`/opportunities/${id}?tab=forms`);
  await expect(page.getByRole("heading", { name: "Change of legal entity New request" })).toBeVisible();
  await expect(page.getByText("Incoming customer's IBAN on file")).toBeVisible();
  await page.getByRole("button", { name: "Case details" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Request came by").selectOption("whatsapp");
  await dialog.getByLabel("Supply point", { exact: true }).selectOption("new_supply_point");
  await dialog.getByLabel("Where the MPRN/GPRN and address came from").fill("ESB Networks connection letter");
  await expectAccessible(page, "case details");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^Change of legal entity (Awaiting incoming details|Request received)$/ })).toBeVisible();
  await expect(page.getByText(/ESB Networks connection letter \(verified by/)).toBeVisible();
  await expectAccessible(page, "forms tab with case");
});

test("sales and the back office each get their own interface", async ({ page }) => {
  await signIn(page, users.sales);
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Scan business card" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Work queue" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Supplier forms" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "New lead" })).toBeVisible();

  await signIn(page, users.ops);
  await expect(nav.getByRole("link", { name: "Work queue" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Scan business card" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Work queue" })).toBeVisible();
  await expectAccessible(page, "back office work queue");

  // Managers can switch between the two.
  await signIn(page, users.manager);
  await nav.getByRole("button", { name: "Back office" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Work queue" })).toBeVisible();
  await nav.getByRole("button", { name: "Sales" }).click();
  await expect(nav.getByRole("link", { name: "Scan business card" })).toBeVisible();
});

test("Worldpay opportunity shows the merchant workspace and hides energy sections", async ({ page }) => {
  await signIn(page, users.sales);
  await page.goto("/opportunities/new");
  await page.getByLabel("Opportunity name").fill(`E2E Card payments ${Date.now()}`);
  await page.getByLabel("Service", { exact: true }).selectOption("merchant_services");
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
  // Search, so records added by earlier e2e runs can't push the seeded deals off the first page.
  const find = async (term: string) => {
    await page.getByLabel("Search opportunities").fill(term);
    await expect(page.getByText("Loading")).toHaveCount(0);
  };
  await signIn(page, users.otherSales);
  await page.goto("/opportunities?view=all");
  await find("Quayside");
  await expect(page.getByRole("link", { name: "Quayside Bakery – electricity", exact: true })).toBeVisible();
  await find("Harbour");
  await expect(page.getByRole("link", { name: "Quayside Bakery – electricity", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Harbour Café – dual fuel", exact: true })).toHaveCount(0);

  await page.context().clearCookies();
  await signIn(page, users.manager);
  await page.goto("/opportunities?view=all");
  await find("Harbour");
  await expect(page.getByRole("link", { name: "Harbour Café – dual fuel", exact: true })).toBeVisible();
  await find("Quayside");
  await expect(page.getByRole("link", { name: "Quayside Bakery – electricity", exact: true })).toBeVisible();
});

test("won opportunities stay visible under All won and in the pipeline", async ({ page }) => {
  await signIn(page, users.manager);
  await page.goto("/opportunities?view=all_won");
  await expect(page.getByRole("link", { name: "Quayside Bakery – electricity", exact: true })).toBeVisible();
  await page.goto("/pipeline");
  await page.getByLabel("Whose opportunities").selectOption("all");
  await expect(page.getByRole("listitem", { name: /Live \/ Won/ })).toContainText("Quayside Bakery – electricity");
  await expectAccessible(page, "pipeline");
});

test("main pages pass automated accessibility checks, with no Content-Security-Policy violations", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to (load|execute|connect|frame)/i.test(m.text())) violations.push(m.text());
  });
  await signIn(page, users.admin);
  for (const path of ["/", "/opportunities", "/pipeline", "/customers", "/activities", "/cases", "/chat", "/scan", "/admin", "/account", "/forms"]) {
    await page.goto(path);
    await expect(page.locator("main h1").first()).toBeVisible();
    if (path !== "/" && path !== "/pipeline" && path !== "/chat") await expectAccessible(page, path);
  }
  // The template editor renders PDFs with pdf.js in a worker, which the CSP must allow.
  const template = await page.locator('a[href^="/forms/"]').first().getAttribute("href").catch(() => null);
  if (template) {
    await page.goto(template);
    await expect(page.getByRole("img", { name: /page 1/ })).toBeVisible();
    await expect(page.getByText("The PDF couldn't be shown.")).toHaveCount(0);
    await expectAccessible(page, "form template editor");
  }
  expect(violations).toEqual([]);
});

test("mobile layout keeps the menu and key figures usable @mobile", async ({ page }) => {
  await signIn(page, users.sales);
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
  await expect(page.getByText("Open pipeline")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
  await page.screenshot({ path: "e2e-report/mobile-dashboard.png", fullPage: true });
});

test("colleagues chat in real time, with mentions in deal discussions", async ({ browser }) => {
  const sarahCtx = await browser.newContext();
  const seanCtx = await browser.newContext();
  const sarah = await sarahCtx.newPage();
  const sean = await seanCtx.newPage();
  await signIn(sarah, users.sales);
  await signIn(sean, users.otherSales);

  // Sarah opens a direct message with Sean.
  await sarah.goto("/chat");
  await sarah.getByRole("button", { name: "New direct message" }).click();
  await sarah.getByLabel("Colleague").selectOption({ label: "Sean Sales" });
  await sarah.getByRole("button", { name: "Start conversation" }).click();
  await expectAccessible(sarah, "chat");

  // Sean has the conversation open; Sarah's message appears without a reload.
  await sean.goto("/chat");
  await sean.getByRole("button", { name: /Sarah Sales/ }).click();
  const text = `Can you cover my 3pm? ${Date.now()}`;
  await sarah.getByLabel("Message", { exact: true }).fill(text);
  await sarah.keyboard.press("Enter");
  await expect(sean.getByText(text)).toBeVisible({ timeout: 10_000 });

  // Deal discussion: the Team chat tab on an opportunity.
  await sarah.goto("/opportunities?view=my_open");
  await sarah.getByLabel("Search opportunities").fill("Harbour");
  await sarah.getByRole("link", { name: "Harbour Café – dual fuel" }).click();
  await sarah.getByRole("tab", { name: "Team chat" }).click();
  await sarah.getByLabel("Message", { exact: true }).fill("@Mich");
  await sarah.getByRole("option", { name: "Michael Manager" }).click();
  const ask = `can you approve this today? ${Date.now()}`;
  await sarah.getByLabel("Message", { exact: true }).type(ask);
  await sarah.keyboard.press("Enter");
  await expect(sarah.getByText(ask)).toBeVisible();
  await expect(sarah.getByText("@Michael Manager").last()).toBeVisible();
  await sarahCtx.close();
  await seanCtx.close();
});

test("calling a customer without a phone system opens the dialler and logs the outcome", async ({ page }) => {
  await signIn(page, users.sales);
  await page.goto("/opportunities?view=my_open");
  await page.getByLabel("Search opportunities").fill("Doyle");
  await page.getByRole("link", { name: "Doyle Pharmacy – electricity" }).click();
  await page.getByRole("button", { name: "Call", exact: true }).click();
  await expect(page.getByLabel("Number")).toContainText("+353875550199");
  await expectAccessible(page, "call dialog");
  // Don't actually leave the page for tel: in the test browser.
  await page.evaluate(() => {
    Object.defineProperty(window, "location", { value: { ...window.location, set href(_v: string) {} }, configurable: true });
  }).catch(() => undefined);
  await page.getByRole("button", { name: "Dial on my phone" }).click();
  await page.getByLabel("Outcome").selectOption("answered");
  await page.getByLabel("Length (minutes)").fill("4");
  const note = `Sending latest bill ${Date.now()}`;
  await page.getByLabel("Notes").fill(note);
  await page.getByRole("button", { name: "Save to timeline" }).click();
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page.getByText(note)).toBeVisible();
  await expect(page.getByText(/Outbound call to \+353875550199 · Answered · 4 min 0 s\./).first()).toBeVisible();
});
