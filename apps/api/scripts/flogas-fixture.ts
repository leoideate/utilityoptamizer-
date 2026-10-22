/**
 * Visual check of the Flogas electricity layout: fills the real supplier PDF with demanding dummy
 * data (see test/support/flogas.ts) and writes the signed PDF plus a PNG of each page.
 *
 *   npm run flogas:fixture -w @uo/api -- <flogas electricity form.pdf> <out-folder>

 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { flogasSigners } from "@uo/shared";
import { fillPdf } from "../src/forms/pdf";
import { renderFlogasElectricity } from "../src/supplier-applications/flogas-electricity/render";
import { flogasDemo } from "../test/support/flogas";
import { png } from "../test/support/forms";
import { renderPages } from "./render-pages";

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

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
