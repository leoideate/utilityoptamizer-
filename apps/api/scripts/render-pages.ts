import { readFileSync } from "node:fs";

/**
 * Writes a PNG of each page of a PDF (`<prefix>-page-<n>.png`), rendered with pdf.js in
 * Playwright's Chromium (installed for the web e2e tests), for visual checks of filled forms.
 */
export async function renderPages(pdfFile: string, prefix: string) {
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
