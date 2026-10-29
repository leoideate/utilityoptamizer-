/**
 * Visual check of a supplier form preset: fills every field of the preset matching the given PDF
 * with sample text (and ticks every box, so alternatives overlap), then writes the PDF and a PNG of
 * each page. Values that are too long for small boxes are reported; real values are shorter.
 *
 *   npx ts-node --transpile-only scripts/preset-fixture.ts <supplier form.pdf> <out-folder>
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FormField } from "@uo/shared";
import { fillPdf, type FillValue } from "../src/forms/pdf";
import { presetFor } from "../src/forms/presets";
import { png } from "../test/support/forms";
import { renderPages } from "./render-pages";

const SAMPLES: Record<string, string> = {
  "customer.legalName": "O'Sullivan Hospitality Group Ltd",
  "customer.tradingName": "The Harbourview Hotel",
  "site.gprn": "1234567",
  "site.mprn": "10012345678",
  "bank.iban": "IE29AIBK93115212345678",
  "bank.bic": "AIBKIE2D",
  "contact.email": "facilities@harbourview.example",
  "contact.mobile": "087 123 4567",
  "customer.phone": "01 832 1234",
  "reading.date": "20/10/2026",
  "contract.proposedStartDate": "01/11/2026",
  today: "29/10/2026",
};

/** Sample answers to the yes/no sources fields depend on (`onlyIf`), as for an electricity deal. */
const FLAGS: Record<string, string> = { "is.electricity": "true", "customer.paperlessBilling": "true" };

const sample = (f: FormField): FillValue => {
  if (f.onlyIf && (FLAGS[f.onlyIf.source] ?? "false") !== f.onlyIf.equals) return null;
  if (f.kind === "check") return true;
  if (f.source && SAMPLES[f.source]) return SAMPLES[f.source];
  return f.label.replace(/[^A-Za-z0-9 ]/g, "").slice(0, 28);
};

async function main() {
  const [pdfPath, out] = process.argv.slice(2);
  if (!pdfPath || !out) throw new Error("Usage: preset-fixture.ts <supplier form.pdf> <out-folder>");
  const template = readFileSync(pdfPath);
  const preset = presetFor(createHash("sha256").update(template).digest("hex"));
  if (!preset) throw new Error("No preset matches this PDF.");
  mkdirSync(out, { recursive: true });
  const values = Object.fromEntries(preset.fields.map((f) => [f.id, f.mask && !f.source ? null : sample(f)]));
  const sig = png(160, 40);
  const filled = await fillPdf({
    template,
    fields: preset.fields,
    values,
    signatures: { customer: sig, broker: sig },
    signedDates: { customer: "29/10/2026", broker: "29/10/2026" },
    title: `${preset.name} – visual fixture`,
  });
  const pdfOut = path.join(out, `${preset.key}.pdf`);
  writeFileSync(pdfOut, filled.bytes);
  await renderPages(pdfOut, path.join(out, preset.key));
  console.log(filled.issues.length ? `Quality check issues:\n- ${filled.issues.join("\n- ")}` : `${preset.name}: quality check passed`);
}

void main();
