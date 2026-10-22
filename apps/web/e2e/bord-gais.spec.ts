import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

/**
 * The Bord Gáis Electricity Form. Runs against the local stack with the dev seed, like crm.spec.ts.
 * Generating a PDF also needs the Bord Gáis PDF uploaded under Supplier forms (it isn't in the
 * repository); that test is skipped when it hasn't been.
 */

const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "ChangeMe-Demo-2026!";
const OPS = "ops@demo.utilityoptimizer.ie";
const IBAN = "IE29AIBK93115212345678";
const SUPPLIER = "Bord Gáis Energy";

/** One login for the whole file: logging in per test would trip the login rate limit. */
let session: Awaited<ReturnType<import("@playwright/test").BrowserContext["cookies"]>> | null = null;

async function signIn(page: Page) {
  if (session) {
    await page.context().clearCookies();
    await page.context().addCookies(session);
    await page.goto("/");
  } else {
    await page.goto("/login");
    await page.getByLabel("Email").fill(OPS);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
  session ??= await page.context().cookies();
}

/** Calls the API from the page, with the session cookie and CSRF token, as the app does. */
async function call<T = unknown>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  const res = await page.evaluate(
    async ({ method, path, body }) => {
      const csrf = decodeURIComponent(document.cookie.split("; ").find((c) => c.startsWith("uo_csrf="))?.split("=")[1] ?? "");
      const r = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    },
    { method, path, body },
  );
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as T;
}

/** An electricity deal with its customer, site, meter, reading and contract, and the given supplier selected. */
async function electricityDeal(page: Page, supplierName: string) {
  const suppliers = await call<{ id: string; name: string }[]>(page, "GET", "/suppliers?kind=energy");
  const supplier = suppliers.find((s) => s.name === supplierName)!;
  const name = `E2E Bord Gáis ${Date.now()}`;
  const opp = await call<{ id: string }>(page, "POST", "/opportunities", {
    name,
    serviceType: "electricity",
    companyName: "E2E Harbourview Hotel Limited",
    contactName: "Siobhán Ní Fhloinn",
    email: "siobhan@harbourview.example",
    phone: "01 456 7890",
    productInterest: ["electricity"],
    supplyChanges: ["change_of_supplier"],
    contactRole: "Director",
  });
  const { customerId } = await call<{ customerId: string }>(page, "POST", `/opportunities/${opp.id}/customer/create`);
  await call(page, "PATCH", `/customers/${customerId}`, {
    legalEntity: "limited_company",
    businessType: "Hotel",
    companyRegNumber: "654321",
    marketingEmail: false,
    marketingPost: true,
    marketingPhone: true,
    marketingSms: true,
    addresses: [{ kind: "registered", line1: "Harbour Road", city: "Howth", county: "Co. Dublin", postcode: "D13 X2Y3" }],
  });
  const site = await call<{ id: string }>(page, "POST", `/opportunities/${opp.id}/sites`, {
    label: "Harbourview Hotel",
    serviceType: "electricity",
    annualConsumptionKwh: 845000,
    address: { line1: "Harbour Road", city: "Howth", county: "Co. Dublin", postcode: "D13 X2Y3" },
  });
  const meter = await call<{ id: string }>(page, "POST", `/sites/${site.id}/meters`, { fuel: "electricity", mprn: "10012345670", mccCode: "MCC10", meterNumber: "000123456" });
  await call(page, "POST", `/meters/${meter.id}/readings`, { readingType: "actual", register: "day", value: 1234, readingDate: "2026-10-01" });
  await call(page, "POST", `/opportunities/${opp.id}/contracts`, { fuel: "electricity", siteId: site.id, existingSupplierName: "Electric Ireland", pricingPlan: "Business Fixed 24", termMonths: 24, priceType: "fixed", dayRate: 0.2145, standingCharge: 0.55 });
  await call(page, "PATCH", `/opportunities/${opp.id}`, { selectedSupplierId: supplier.id });
  return { id: opp.id, name, suppliers };
}

const bordGaisTab = (page: Page) => page.getByRole("tab", { name: "Bord Gáis form" });
const SUB_TABS = ["Account Holder", "Premises and Billing", "Supply and Meters", "Agreement and Rates", "Declaration and Marketing", "SEPA Direct Debit", "Signatures and Documents"];

/** Fails on serious or critical WCAG 2.1 AA violations. */
async function expectAccessible(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${label}: ${v.id} (${v.nodes.length}) ${v.help}`)).toEqual([]);
}

test("the Bord Gáis tabs appear only for Electricity with Bord Gáis Energy selected", async ({ page }) => {
  await signIn(page);
  const deal = await electricityDeal(page, "Energia");
  await page.goto(`/opportunities/${deal.id}`);
  await expect(page.getByRole("heading", { level: 1, name: deal.name })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  await expect(bordGaisTab(page)).toHaveCount(0);

  // Choosing Bord Gáis Energy shows the form, prefilled from the deal; Flogas's form doesn't show.
  const bge = deal.suppliers.find((s) => s.name === SUPPLIER)!;
  await call(page, "PATCH", `/opportunities/${deal.id}`, { selectedSupplierId: bge.id });
  await page.goto(`/opportunities/${deal.id}?tab=bord-gais`);
  await expect(page.getByRole("heading", { name: "Bord Gáis Electricity Form" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Flogas form" })).toHaveCount(0);
  for (const t of SUB_TABS) await expect(page.getByRole("tab", { name: t })).toBeVisible();
  await expect(page.getByLabel("Legal name")).toHaveValue("E2E Harbourview Hotel Limited");
  await page.getByRole("tab", { name: "Supply and Meters" }).click();
  await expect(page.getByLabel("Customer MPRN")).toHaveValue("10012345670");
  await expect(page.getByLabel("Meter serial number 1")).toHaveValue("000123456");
  await expectAccessible(page, "Bord Gáis form");

  // Dropping Electricity hides it again.
  await call(page, "PATCH", `/opportunities/${deal.id}`, { productInterest: ["gas"] });
  await page.goto(`/opportunities/${deal.id}?tab=bord-gais`);
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  await expect(bordGaisTab(page)).toHaveCount(0);
});

test("the Bord Gáis form validates by field, keeps the marketing boxes' meaning and saves a draft", async ({ page }) => {
  await signIn(page);
  const deal = await electricityDeal(page, SUPPLIER);
  await page.goto(`/opportunities/${deal.id}?tab=bord-gais`);
  await expect(page.getByRole("heading", { name: "Bord Gáis Electricity Form" })).toBeVisible();

  await page.getByRole("button", { name: "Validate application" }).click();
  await expect(page.getByText("3 things to complete before it can be sent for signature: see the tabs marked with a count.")).toBeVisible();
  await expect(page.getByRole("tab", { name: /^SEPA Direct Debit \(3\)$/ })).toBeVisible();

  // Marketing: the form ticks a box when the customer does NOT want offers that way.
  await page.getByRole("tab", { name: /^Declaration and Marketing/ }).click();
  await expect(page.getByText("On the form, a box is ticked when the customer does NOT want offers that way.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Offers by email", exact: true })).toHaveValue("Does not want (ticked on the form)");
  await page.getByRole("textbox", { name: "Broader marketing (products of the wider group and other companies)", exact: true }).click();
  await page.getByRole("option", { name: "Does not want", exact: true }).click();

  await page.getByRole("tab", { name: /^SEPA Direct Debit/ }).click();
  await page.getByRole("button", { name: "Enter bank details" }).click();
  await page.getByLabel("Account holder name").fill("E2E Harbourview Hotel Limited");
  await page.getByLabel("IBAN", { exact: true }).fill(IBAN);
  await page.getByLabel("BIC", { exact: true }).fill("AIBKIE2D");
  await page.getByRole("tab", { name: "Supply and Meters" }).click();
  await page.getByLabel("Meter serial number 2").fill("ab9876543");
  await page.getByLabel("Night reading").last().fill("00321.9");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);

  // Reopening shows the saved draft, readings exactly as typed; bank details stay restricted.
  await page.reload();
  await page.getByRole("tab", { name: "Supply and Meters" }).click();
  await expect(page.getByLabel("Meter serial number 2")).toHaveValue("AB9876543");
  await expect(page.getByLabel("Night reading").last()).toHaveValue("00321.9");
  await page.getByRole("tab", { name: "SEPA Direct Debit" }).click();
  await expect(page.getByText("Bank account ending 5678 is on file. Its details are restricted.")).toBeVisible();
  await expect(page.getByText(IBAN)).toHaveCount(0);
  await page.getByRole("button", { name: "Validate application" }).click();
  await expect(page.getByText("Everything the form needs is filled in.")).toBeVisible();
});

test("the Bord Gáis form generates a version and warns before the supplier changes", async ({ page }) => {
  await signIn(page);
  const deal = await electricityDeal(page, SUPPLIER);
  const view = await call<{ template: unknown }>(page, "GET", `/opportunities/${deal.id}/bord-gais-electricity`);
  test.skip(!view.template, "The Bord Gáis PDF hasn't been uploaded under Supplier forms in this environment.");
  await call(page, "PUT", `/opportunities/${deal.id}/bord-gais-electricity`, { bank: { accountName: "E2E Harbourview Hotel Limited", iban: IBAN, bic: "AIBKIE2D" }, answers: { broaderMarketing: false } });

  await page.goto(`/opportunities/${deal.id}?tab=bord-gais`);
  await page.getByRole("tab", { name: "Signatures and Documents" }).click();
  await page.getByRole("button", { name: "Generate PDF" }).click();
  await expect(page.getByText("Version 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Status: Ready for signature")).toBeVisible();
  await expect(page.getByText(/This PDF contains bank details/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Preview draft" })).toHaveAttribute("href", `/api/opportunities/${deal.id}/bord-gais-electricity/preview`);
  await expectAccessible(page, "Bord Gáis documents");

  await page.getByRole("tab", { name: "Overview" }).click();
  await page.getByRole("textbox", { name: "Selected supplier", exact: true }).click();
  await page.getByRole("option", { name: "Energia", exact: true }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  // The dialog's content is slotted into the Material dialog, so it's checked at page level.
  await expect(page.getByRole("alertdialog", { name: "Hide the Bord Gáis application?" })).toBeVisible();
  await expect(page.getByText(/Everything saved, generated and signed so far is kept\./)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(bordGaisTab(page)).toBeVisible();
});
