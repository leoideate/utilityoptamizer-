/**
 * Visual check of the Flogas electricity layout: fills the real supplier PDF with demanding dummy
 * data (see test/support/flogas.ts) and writes the signed PDF plus a PNG of each page.
 *
 *   npm run flogas:fixture -w @uo/api -- <flogas electricity form.pdf> <out-folder>
 *
 * PNGs are rendered with pdf.js in Playwright's Chromium (installed for the web e2e tests).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { flogasSigners } from "@uo/shared";
import { fillPdf } from "../src/forms/pdf";
import { renderFlogasElectricity } from "../src/supplier-applications/flogas-electricity/render";
import { flogasDemo } from "../test/support/flogas";
import { png } from "../test/support/forms";

async function main() {
  const [pdfPath, out] = process.argv.slice(2);
  if (!pdfPath || !out) throw new Error("Usage: npm run flogas:fixture -w @uo/api -- <flogas.pdf> <out-folder>");
  mkdirSync(out, { recursive: true });
  const data = flogasDemo();
  const signers = flogasSigners(data);
  const rendered = await renderFlogasElectricity(data, signers);
  const sig = png(160, 40);
  const filled = await fillPdf({
    template: readFileSync(pdfPath),
    fields: rendered.fields,
    values: rendered.values,
    signatures: Object.fromEntries(signers.map((r) => [r, sig])),
    signedDates: Object.fromEntries(signers.map((r) => [r, "22/10/2026"])),
    requireSignatures: true,
    title: "Flogas electricity – visual fixture",
  });
  const issues = [...rendered.issues, ...filled.issues];
  const pdfOut = path.join(out, "flogas-electricity-fixture.pdf");
  writeFileSync(pdfOut, filled.bytes);
  console.log(`wrote ${pdfOut}`);
  await renderPages(pdfOut, path.join(out, "flogas-electricity-fixture"));
  if (issues.length) {
    console.error(`Quality check issues:\n- ${issues.join("\n- ")}`);
    process.exit(1);
  }
  console.log("quality check passed");
}

async function renderPages(pdfFile: string, prefix: string) {
  // Resolved from the workspace root, where the web app's Playwright is installed.
  const { chromium } = (await import("playwright")) as typeof import("playwright");
  const lib = (name: string) => readFileSync(require.resolve(`pdfjs-dist/legacy/build/${name}`), "utf8");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent("<body style='margin:0'></body>");
    // Plain JavaScript, so TypeScript's CommonJS output doesn't rewrite the browser's import().
    const pages = (await page.evaluate(`(async ({ pdfjs, worker, data }) => {
      const mod = await import(URL.createObjectURL(new Blob([pdfjs], { type: "text/javascript" })));
      mod.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([worker], { type: "text/javascript" }));
      const doc = await mod.getDocument({ data: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) }).promise;
      for (let i = 1; i <= doc.numPages; i++) {
        const p = await doc.getPage(i);
        const viewport = p.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.id = "p" + i;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        document.body.appendChild(canvas);
        await p.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      }
      return doc.numPages;
    })(${JSON.stringify({ pdfjs: lib("pdf.min.mjs"), worker: lib("pdf.worker.min.mjs"), data: readFileSync(pdfFile).toString("base64") })})`)) as number;
    for (let i = 1; i <= pages; i++) {
      await page.locator(`#p${i}`).screenshot({ path: `${prefix}-page-${i}.png` });
      console.log(`wrote ${prefix}-page-${i}.png`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
