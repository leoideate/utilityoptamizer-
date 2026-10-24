import { PDFDocument, PDFTextField } from "pdf-lib";

export interface PdfFacts {
  /** Every MPRN-shaped (11 digits from 10) and GPRN-shaped (7 digits) number found. */
  mprns: string[];
  gprns: string[];
  /** Filled form values, page text and the file name, lower-cased, for matching business names. */
  text: string;
  /** Where the numbers came from, for the review report. */
  sources: string[];
}

// Spaced-out numbers ("10 012 345 678", or one digit per comb box) count too.
const MPRN = /(?<!\d)1\s?0(?:\s?\d){9}(?!\d)/g;
const GPRN = /(?<!\d)\d(?:\s?\d){6}(?!\d)/g;
const digits = (s: string) => s.replace(/\s/g, "");

function numbersIn(s: string) {
  const mprns = [...s.matchAll(MPRN)].map((m) => digits(m[0]));
  const gprns = [...s.matchAll(GPRN)].map((m) => digits(m[0])).filter((g) => !mprns.some((m) => m.includes(g)));
  return { mprns, gprns };
}

/** pdf.js is an ES module; a plain import() would be compiled to require() here. */
const importEsm = new Function("s", "return import(s)") as (s: string) => Promise<typeof import("pdfjs-dist")>;

async function pageText(buffer: Buffer): Promise<string> {
  const pdfjs = await importEsm("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  const out: string[] = [];
  for (let p = 1; p <= Math.min(doc.numPages, 10); p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    out.push(content.items.map((i) => ("str" in i ? i.str : "")).join(" "));
  }
  await doc.destroy();
  return out.join("\n");
}

/**
 * What a signed supplier PDF says about whose it is: its form field values (Bord Gáis forms keep
 * theirs), its page text (flattened or printed forms) and its file name. Best effort: an unreadable
 * part is skipped and the PDF goes to the review list if nothing matches.
 */
export async function pdfFacts(buffer: Buffer, filename: string): Promise<PdfFacts> {
  const parts: [string, string][] = [["file name", filename.replace(/\.pdf$/i, "").replace(/[_]+/g, " ")]];
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
    const values = doc
      .getForm()
      .getFields()
      .flatMap((f) => (f instanceof PDFTextField ? [f.getText() ?? ""] : []))
      .filter(Boolean);
    if (values.length) parts.push(["form fields", values.join(" | ")]);
  } catch {
    // Not a form we can read; the page text may still help.
  }
  try {
    const t = await pageText(buffer);
    if (t.trim()) parts.push(["page text", t]);
  } catch {
    // pdf.js unavailable or the PDF is image-only.
  }
  const mprns = new Set<string>();
  const gprns = new Set<string>();
  const sources: string[] = [];
  for (const [source, s] of parts) {
    const n = numbersIn(s);
    if (n.mprns.length || n.gprns.length) sources.push(source);
    n.mprns.forEach((m) => mprns.add(m));
    n.gprns.forEach((g) => gprns.add(g));
  }
  return { mprns: [...mprns], gprns: [...gprns], text: parts.map(([, s]) => s).join("\n").toLowerCase(), sources };
}
