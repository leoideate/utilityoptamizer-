import { expect, test } from "@playwright/test";

// Deterministic layout fixtures, independent of demo names and database contents.
const WIDTHS = [320, 375, 768, 1024, 1280, 1920];
const longName = "Customer".repeat(24);
const rows = Array.from({ length: 25 }, (_, i) => ({
  id: "customer-" + i, legalName: i === 0 ? longName : "Layout test business " + i,
  tradingName: "Trading".repeat(25), contactName: "Contact person " + i,
  email: "contact@" + "example".repeat(20) + ".test", phone: "+353 1 555 0101", _count: { opps: 250 },
  contract: {
    supplier: "Supplier", fuel: "electricity", meter: "10012345678", product: "Business product",
    startDate: "2026-01-01", endDate: "2027-01-01", status: "live", applicationStatus: null,
    country: "IE", suppliers: ["Supplier".repeat(20), "Another supplier"], fuels: ["electricity", "gas"],
    meters: Array.from({ length: 30 }, (_, n) => String(10012345678 + n)), termMonths: 24, salesAgent: "Test salesperson",
  },
}));

for (const width of WIDTHS) {
  test("customer list with large data at " + width + "px", async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/realtime/stream") return route.fulfill({ contentType: "text/event-stream", body: "event: ready\ndata: {}\n\n" });
      let data: unknown;
      switch (url.pathname) {
        case "/api/auth/me": data = { user: { id: "layout-user", name: "Layout Tester", roles: ["manager"], capabilities: ["customer.read", "customer.write"], features: { chat: false, aiReading: false, assistant: false } } }; break;
        case "/api/customers": {
          const current = Number(url.searchParams.get("page") ?? 1);
          data = { items: current === 1 ? rows : rows.map((r) => ({ ...r, id: r.id + "-page2", legalName: "Second page " + r.legalName })), total: 1000, page: current, pageSize: 25 }; break;
        }
        case "/api/notifications": data = []; break;
        case "/api/notifications/unread-count":
        case "/api/mailbox/unread-count": data = { count: 0 }; break;
        default: throw new Error("Unexpected API request: " + url.pathname);
      }
      await route.fulfill({ json: data });
    });
    await page.clock.install();
    await page.goto("/customers");
    await expect(page.getByRole("heading", { name: "Customers", exact: true })).toBeVisible();
    await expect(page.getByText("Page 1 of 40", { exact: true })).toBeVisible();
    // Require loaded records, so a skeleton or empty page cannot pass.
    await expect(page.locator('a[href="/customers/customer-0"]').filter({ visible: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    // Flush the initial 300ms search debounce before testing pagination.
    await page.clock.runFor(350);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    if (width < 768) {
      const overflows = await page.locator("main li").evaluateAll((cards) => cards.flatMap((card) =>
        Array.from(card.querySelectorAll("span, p")).filter((el) => !el.classList.contains("truncate") && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent?.slice(0, 30)),
      ));
      expect(overflows).toEqual([]);
    } else {
      const scroller = page.locator("main table").locator("..");
      const size = await scroller.evaluate((el) => ({ content: el.scrollWidth, box: el.clientWidth }));
      expect(size.content).toBeGreaterThan(size.box);
      await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
      await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    }
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByText("Page 2 of 40", { exact: true })).toBeVisible();
    await expect(page.locator('a[href="/customers/customer-0-page2"]').filter({ visible: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("customers-" + width + ".png"), fullPage: true });
  });
}
