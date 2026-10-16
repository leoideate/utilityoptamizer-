import { mkdirSync, writeFileSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";

/**
 * Responsive checks for every main screen at content-driven widths, from a small phone (320px)
 * to a wide desktop (1920px). Fails on:
 * - page-level horizontal scrolling;
 * - elements sticking out of the viewport (unless inside an intentional horizontal scroller);
 * - text smaller than 12px;
 * - on touch widths, interactive targets smaller than 24×24px (WCAG 2.2, 2.5.8).
 * Screenshots go to e2e-report/responsive/ for visual review.
 */

const WIDTHS = [320, 375, 768, 1024, 1280, 1920];
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "ChangeMe-Demo-2026!";

interface Problem {
  kind: string;
  detail: string;
}

async function audit(page: Page, touch: boolean): Promise<Problem[]> {
  return page.evaluate((touch) => {
    const problems: { kind: string; detail: string }[] = [];
    const vw = document.documentElement.clientWidth;
    const describe = (el: Element) => {
      const t = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
      const cls = typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className.split(" ").slice(0, 3).join(".") : "";
      return `<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}> "${t}"`;
    };
    const visible = (el: Element) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0 && !el.closest("[aria-hidden=true], .sr-only");
    };
    /** Inside something that scrolls or clips horizontally on purpose (tables, kanban, tabs). */
    const inScroller = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") return true;
      }
      return false;
    };

    if (document.documentElement.scrollWidth > vw + 1) problems.push({ kind: "page-scroll", detail: `page is ${document.documentElement.scrollWidth}px wide in a ${vw}px viewport` });

    const all = Array.from(document.querySelectorAll("body *"));
    const seen = new Set<string>();
    for (const el of all) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if ((r.right > vw + 1 || r.left < -1) && !inScroller(el) && getComputedStyle(el).position !== "fixed") {
        const d = describe(el);
        if (!seen.has(d)) problems.push({ kind: "overflow", detail: `${d} spans ${Math.round(r.left)}–${Math.round(r.right)}px` });
        seen.add(d);
      }
      const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim());
      if (hasText && parseFloat(getComputedStyle(el).fontSize) < 12) problems.push({ kind: "tiny-text", detail: `${describe(el)} at ${getComputedStyle(el).fontSize}` });
    }
    if (touch) {
      for (const el of document.querySelectorAll("a[href], button, input:not([type=hidden]):not(.sr-only), select, textarea, [role=tab], [role=option]")) {
        if (!visible(el) || el.closest("p, li > p, td p")) continue; // inline text links are exempt (2.5.8)
        const r = el.getBoundingClientRect();
        if (r.width < 24 || r.height < 24) problems.push({ kind: "small-target", detail: `${describe(el)} is ${Math.round(r.width)}×${Math.round(r.height)}px` });
      }
    }
    return problems.slice(0, 60);
  }, touch);
}

const shot = (page: Page, name: string, width: number) => page.screenshot({ path: `e2e-report/responsive/${name}-${width}.png`, fullPage: true });

test.describe.configure({ mode: "serial" });

test("main screens adapt from 320px to 1920px", async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill("manager@demo.utilityoptimizer.ie");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();

  // A deal with sites, meters and documents for the workspace screens.
  await page.goto("/opportunities?view=all");
  await page.getByLabel("Search opportunities").fill("Harbour");
  const dealHref = await page.getByRole("link", { name: "Harbour Café – dual fuel" }).first().getAttribute("href");
  await page.goto("/customers?q=Harbour");
  const customerHref = await page.getByRole("link", { name: "Harbour Café Limited" }).first().getAttribute("href");
  await page.goto("/forms");
  const templateHref = await page.locator('a[href^="/forms/"]').first().getAttribute("href").catch(() => null);

  const screens: [string, string][] = [
    ["dashboard", "/"],
    ["pipeline", "/pipeline"],
    ["opportunities", "/opportunities?view=all"],
    ["new-opportunity", "/opportunities/new"],
    ["workspace-overview", `${dealHref}?tab=overview`],
    ["workspace-energy", `${dealHref}?tab=energy`],
    ["workspace-documents", `${dealHref}?tab=documents`],
    ["workspace-forms", `${dealHref}?tab=forms`],
    ["workspace-timeline", `${dealHref}?tab=timeline`],
    ["customers", "/customers"],
    ["customer", customerHref!],
    ["tasks", "/activities"],
    ["cases", "/cases"],
    ["chat", "/chat"],
    ["scan", "/scan"],
    ["admin", "/admin"],
    ["supplier-forms", "/forms"],
    ...(templateHref ? ([["form-template", templateHref]] as [string, string][]) : []),
    ["account", "/account"],
  ];

  const report: string[] = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
    for (const [name, path] of screens) {
      await page.goto(path);
      await page.locator("main h1, main h2").first().waitFor({ timeout: 15_000 });
      await page.waitForLoadState("networkidle");
      const problems = await audit(page, width < 1024);
      if (width === 320 || width === 768 || width === 1920) await shot(page, name, width);
      for (const p of problems) report.push(`${width}px ${name}: [${p.kind}] ${p.detail}`);
    }
  }
  await ctx.close();

  // Also the signed-out login page.
  const anon = await browser.newPage({ viewport: { width: 320, height: 640 } });
  await anon.goto("/login");
  for (const p of await audit(anon, true)) report.push(`320px login: [${p.kind}] ${p.detail}`);
  await anon.close();

  mkdirSync("e2e-report/responsive", { recursive: true });
  writeFileSync("e2e-report/responsive/report.txt", report.join("\n"));
  expect(report).toEqual([]);
});
