import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

/**
 * The Flogas Electricity Form. Runs against the local stack with the dev seed, like crm.spec.ts.
 * Generating a PDF also needs the Flogas PDF uploaded under Supplier forms (it isn't in the
 * repository); that test is skipped when it hasn't been.
 */

const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "ChangeMe-Demo-2026!";
const OPS = "ops@demo.utilityoptimizer.ie";
const IBAN = "IE29AIBK93115212345678";

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

/** An electricity deal with its customer, supply site, meter, reading and contract, and the given supplier selected. */
async function electricityDeal(page: Page, supplierName: string) {
  const suppliers = await call<{ id: string; name: string }[]>(page, "GET", "/suppliers?kind=energy");
  const supplier = suppliers.find((s) => s.name === supplierName)!;
  const name = `E2E Flogas ${Date.now()}`;
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
  await call(page, "PATCH", `/customers/${customerId}`, { legalEntity: "limited_company", businessType: "Hotel", companyRegNumber: "654321" });
  const site = await call<{ id: string }>(page, "POST", `/opportunities/${opp.id}/sites`, {
    serviceType: "electricity",
    occupancyType: "owner_occupied",
    occupiedSince: "2019-03-01",
    address: { line1: "Unit 14, Ballymount Industrial Estate", city: "Dublin 12", county: "Co. Dublin", postcode: "D12 X7Y9" },
  });
  const meter = await call<{ id: string }>(page, "POST", `/sites/${site.id}/meters`, { fuel: "electricity", mprn: "10012345670", mccCode: "MCC10" });
  await call(page, "POST", `/meters/${meter.id}/readings`, { readingType: "actual", register: "day", value: 123456, readingDate: "2026-10-01" });
  await call(page, "POST", `/opportunities/${opp.id}/contracts`, { fuel: "electricity", siteId: site.id, existingSupplierName: "Electric Ireland", termMonths: 24, priceType: "fixed", dayRate: 0.2145, nightRate: 0.1237 });
  await call(page, "PATCH", `/opportunities/${opp.id}`, { selectedSupplierId: supplier.id });
  return { id: opp.id, name, suppliers };
}

const flogasTab = (page: Page) => page.getByRole("tab", { name: "Flogas form" });
const SUB_TABS = ["Customer & Business", "Supply & Meter", "Pricing & Contract", "Direct Debit", "Signatures & Documents"];

/** Fails on serious or critical WCAG 2.1 AA violations. */
async function expectAccessible(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${label}: ${v.id} (${v.nodes.length}) ${v.help}`)).toEqual([]);
}

test("the Flogas tabs appear only for Electricity with Flogas selected", async ({ page }) => {
  await signIn(page);
  const deal = await electricityDeal(page, "Energia");
  await page.goto(`/opportunities/${deal.id}`);
  await expect(page.getByRole("heading", { level: 1, name: deal.name })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  await expect(flogasTab(page)).toHaveCount(0);

  // Choosing Flogas shows the form, prefilled from the deal.
  const flogas = deal.suppliers.find((s) => s.name === "Flogas")!;
  await call(page, "PATCH", `/opportunities/${deal.id}`, { selectedSupplierId: flogas.id });
  await page.goto(`/opportunities/${deal.id}?tab=flogas`);
  await expect(page.getByRole("heading", { name: "Flogas Electricity Form" })).toBeVisible();
  for (const t of SUB_TABS) await expect(page.getByRole("tab", { name: t })).toBeVisible();
  await expect(page.getByLabel("Legal entity name")).toHaveValue("E2E Harbourview Hotel Limited");
  await expect(page.getByLabel("Business type")).toHaveValue("Hotel");
  await page.getByRole("tab", { name: "Supply & Meter" }).click();
  await expect(page.getByLabel("MPRN")).toHaveValue("10012345670");
  await expectAccessible(page, "Flogas form");

  // Dropping Electricity from the product interest hides it again.
  await call(page, "PATCH", `/opportunities/${deal.id}`, { productInterest: ["gas"] });
  await page.goto(`/opportunities/${deal.id}?tab=flogas`);
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  await expect(flogasTab(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Flogas Electricity Form" })).toHaveCount(0);
});

test("the Flogas form validates by field, saves a draft and reopens it", async ({ page }) => {
  await signIn(page);
  const deal = await electricityDeal(page, "Flogas");
  await page.goto(`/opportunities/${deal.id}?tab=flogas`);
  await expect(page.getByRole("heading", { name: "Flogas Electricity Form" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save draft" })).toBeDisabled();

  // Validating lists what's missing, marks the tab and opens it.
  await page.getByRole("button", { name: "Validate application" }).click();
  await expect(page.getByText(/2 things to complete before it can be sent for signature/)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Direct Debit (2)" })).toBeVisible();
  await expect(page.getByText("2 things to complete on this tab:")).toBeVisible();

  // Typed bank details clear the errors as they are entered.
  await page.getByRole("button", { name: "Enter bank details" }).click();
  await page.getByLabel("Debtor (account holder) name").fill("E2E Harbourview Hotel Limited");
  await page.getByLabel("IBAN", { exact: true }).fill(IBAN);
  await page.getByLabel("BIC").fill("AIBKIE2D");
  await expect(page.getByRole("tab", { name: "Direct Debit" })).toBeVisible();
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // A Flogas-only answer and a CRM value, saved together.
  await page.getByRole("tab", { name: "Customer & Business" }).click();
  await page.getByLabel("Trading name").fill("The Harbourview");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save draft" })).toBeDisabled();

  // Reopening shows the saved draft; the bank details stay restricted for Operations.
  await page.reload();
  await expect(page.getByLabel("Trading name")).toHaveValue("The Harbourview");
  await page.getByRole("tab", { name: "Direct Debit" }).click();
  await expect(page.getByText("Bank account ending 5678 is on file. Its details are restricted.")).toBeVisible();
  await expect(page.getByText(IBAN)).toHaveCount(0);
  await page.getByRole("button", { name: "Validate application" }).click();
  await expect(page.getByText("Everything the form needs is filled in.")).toBeVisible();
});

test("the Flogas form generates a version and warns before the supplier changes", async ({ page }) => {
  await signIn(page);
  const deal = await electricityDeal(page, "Flogas");
  const view = await call<{ template: unknown }>(page, "GET", `/opportunities/${deal.id}/flogas-electricity`);
  test.skip(!view.template, "The Flogas PDF hasn't been uploaded under Supplier forms in this environment.");
  await call(page, "PUT", `/opportunities/${deal.id}/flogas-electricity`, { bank: { accountName: "E2E Harbourview Hotel Limited", iban: IBAN, bic: "AIBKIE2D" } });

  await page.goto(`/opportunities/${deal.id}?tab=flogas`);
  await page.getByRole("tab", { name: "Signatures & Documents" }).click();
  await page.getByRole("button", { name: "Generate PDF" }).click();
  await expect(page.getByText("Version 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Status: Ready for signature")).toBeVisible();
  // The stored PDF holds bank details, which Operations can't open; the draft preview masks them.
  await expect(page.getByText(/This PDF contains bank details/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Preview draft" })).toHaveAttribute("href", `/api/opportunities/${deal.id}/flogas-electricity/preview`);
  await expectAccessible(page, "Flogas documents");

  // Changing the supplier would hide a form with a document: the details card asks first.
  await page.getByRole("tab", { name: "Overview" }).click();
  await page.getByRole("textbox", { name: "Selected supplier", exact: true }).click();
  await page.getByRole("option", { name: "Energia", exact: true }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  // The dialog's content is slotted into the Material dialog, so it's checked at page level.
  const warning = page.getByRole("alertdialog", { name: "Hide the Flogas application?" });
  await expect(warning).toBeVisible();
  await expect(page.getByText(/Everything saved, generated and signed so far is kept\./)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(warning).toHaveCount(0);
  await expect(flogasTab(page)).toBeVisible();
});
