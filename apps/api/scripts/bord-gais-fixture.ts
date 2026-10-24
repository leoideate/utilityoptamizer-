/**
 * Visual check of the Bord Gáis electricity mapping: fills the real supplier PDF with demanding
 * dummy data (see test/support/bord-gais.ts) and writes the generated (fillable) PDF, the signed
 * (flattened) PDF and a PNG of each.
 *
 *   npm run bord-gais:fixture -w @uo/api -- <Bord Gáis electricity form.pdf> <out-folder>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bordGaisSigners } from "@uo/shared";
import { fillAcroForm } from "../src/forms/acroform";
import { renderBordGaisElectricity } from "../src/supplier-applications/bord-gais-electricity/render";
import { bordGaisDemo } from "../test/support/bord-gais";
import { png } from "../test/support/forms";
import { renderPages } from "./render-pages";

async function main() {
  const [pdfPath, out] = process.argv.slice(2);
  if (!pdfPath || !out) throw new Error("Usage: npm run bord-gais:fixture -w @uo/api -- <bord-gais.pdf> <out-folder>");
  mkdirSync(out, { recursive: true });
  const data = bordGaisDemo();
  const signers = bordGaisSigners(data);
  const r = await renderBordGaisElectricity(data, signers);
  const template = readFileSync(pdfPath);
  const generated = await fillAcroForm({ template, fields: r.fields, values: r.values, untouched: r.untouched, title: "Bord Gáis electricity – visual fixture" });
  const sig = png(160, 40);
  const signed = await fillAcroForm({
    template,
    fields: r.fields,
    values: r.values,
    untouched: r.untouched,
    signatures: Object.fromEntries(signers.map((s) => [s, sig])),
    signedDates: Object.fromEntries(signers.map((s) => [s, "23/10/2026"])),
    requireSignatures: true,
    flatten: true,
    title: "Bord Gáis electricity – visual fixture (signed)",
  });
  for (const [name, result] of [["generated", generated], ["signed", signed]] as const) {
    const file = path.join(out, `bord-gais-${name}.pdf`);
    writeFileSync(file, result.bytes);
    console.log(`wrote ${file}`);
    await renderPages(file, path.join(out, `bord-gais-${name}`));
  }
  const issues = [...r.issues, ...generated.issues.map((i) => `generated: ${i}`), ...signed.issues.map((i) => `signed: ${i}`)];
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
