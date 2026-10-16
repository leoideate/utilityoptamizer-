import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFCheckBox,
  PDFDocument,
  type PDFFont,
  type PDFPage,
  PDFRawStream,
  PDFRef,
  PDFSignature,
  PDFStream,
  PDFTextField,
  StandardFonts,
  decodePDFRawStream,
  fill,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setFillingGrayscaleColor,
  setGraphicsState,
} from "pdf-lib";
import type { FormField } from "@uo/shared";

export interface PageSize {
  width: number;
  height: number;
}

/** Reads a template: page sizes plus any fillable fields, converted to positioned fields. */
export async function inspectTemplate(bytes: Uint8Array): Promise<{ pages: PageSize[]; fields: FormField[] }> {
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();
  const pageOf = new Map<string, number>();
  pages.forEach((p, i) => {
    const annots = p.node.Annots();
    if (!annots) return;
    for (let k = 0; k < annots.size(); k++) {
      const ref = annots.get(k);
      if (ref instanceof PDFRef) pageOf.set(ref.toString(), i);
    }
  });

  const fields: FormField[] = [];
  let n = 0;
  for (const f of doc.getForm().getFields()) {
    const kind = f instanceof PDFCheckBox ? "check" : f instanceof PDFSignature ? "signature" : f instanceof PDFTextField ? "text" : null;
    if (!kind) continue;
    for (const w of f.acroField.getWidgets()) {
      const ref = doc.context.getObjectRef(w.dict);
      const page = ref ? pageOf.get(ref.toString()) : undefined;
      if (page === undefined) continue;
      const r = w.getRectangle();
      if (r.width < 4 || r.height < 4) continue;
      const name = f.getName();
      const isDate = kind === "text" && /date/i.test(name) && /sign/i.test(name);
      const isSignature = kind === "text" && !isDate && /signature/i.test(name);
      const comb = f instanceof PDFTextField && f.isCombed() ? f.getMaxLength() : undefined;
      fields.push({
        id: `f${++n}`,
        label: name.slice(0, 120) || `Field ${n}`,
        kind: isDate ? "signed_date" : isSignature ? "signature" : kind,
        page,
        x: round(r.x),
        y: round(r.y),
        w: round(r.width),
        h: round(r.height),
        source: null,
        signer: kind === "signature" || isSignature || isDate ? "customer" : null,
        ...(comb && comb > 1 && !isSignature && !isDate ? { comb } : {}),
      });
    }
  }
  return { pages: pages.map((p) => p.getSize()), fields };
}

const round = (v: number) => Math.round(v * 100) / 100;

export type FillValue = string | boolean | null | undefined;

export interface FillInput {
  template: Uint8Array;
  fields: FormField[];
  /** Value per field id; booleans for tick boxes. */
  values: Record<string, FillValue>;
  /** PNG signature images by signer role. */
  signatures?: Partial<Record<"customer" | "broker", Uint8Array>>;
  /** Date shown in signed-date fields, by signer role. */
  signedDates?: Partial<Record<"customer" | "broker", string>>;
  /** Signature fields must all be filled (signed copy). */
  requireSignatures?: boolean;
  title: string;
}

interface Expectation {
  page: number;
  /** Hex strings drawn with Tj, lower-cased. */
  text: string[];
  images: number;
}

/**
 * Writes the values onto the template and removes its fillable fields, so nothing can be
 * lost or changed when the file is opened and saved in another program.
 */
export async function fillPdf(input: FillInput): Promise<{ bytes: Uint8Array; issues: string[] }> {
  const doc = await PDFDocument.load(input.template);
  removeFields(doc);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const issues: string[] = [];
  const expect = new Map<number, Expectation>();
  const exp = (page: number) => expect.get(page) ?? (expect.set(page, { page, text: [], images: 0 }), expect.get(page)!);

  for (const f of input.fields) {
    const page = pages[f.page];
    if (!page) {
      issues.push(`"${f.label}" is on page ${f.page + 1}, which this PDF doesn't have.`);
      continue;
    }
    if (f.kind === "signature") {
      const png = f.signer ? input.signatures?.[f.signer] : undefined;
      if (!png) {
        if (input.requireSignatures) issues.push(`"${f.label}" has no signature.`);
        continue;
      }
      const img = await doc.embedPng(png);
      const scale = Math.min(f.w / img.width, f.h / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: f.x + 1, y: f.y + (f.h - h) / 2, width: w, height: h });
      exp(f.page).images++;
      continue;
    }
    if (f.kind === "check") {
      if (input.values[f.id] === true) {
        const size = Math.max(6, Math.min(f.w, f.h) * 0.8);
        const hex = draw(page, font, "X", f, size, issues);
        if (hex) exp(f.page).text.push(hex);
      }
      continue;
    }
    const raw = f.kind === "signed_date" ? (f.signer ? input.signedDates?.[f.signer] : undefined) : input.values[f.id];
    const value = typeof raw === "string" ? raw.replace(/\s*[\r\n]+\s*/g, ", ").trim() : "";
    if (!value) {
      if (f.required && f.kind === "text") issues.push(`"${f.label}" is required but empty.`);
      continue;
    }
    if (f.comb) exp(f.page).text.push(...drawComb(page, font, value, f, issues));
    else {
      const hex = draw(page, font, value, f, undefined, issues);
      if (hex) exp(f.page).text.push(hex);
    }
  }

  doc.setTitle(input.title);
  doc.setProducer("Utility Optimizer CRM");
  doc.setCreator("Utility Optimizer CRM");
  const bytes = await doc.save({ useObjectStreams: false });
  issues.push(...(await verifyPdf(bytes, pages.length, [...expect.values()])));
  return { bytes, issues };
}

/** Drops the form and its widget annotations at the object level (works on malformed forms too). */
function removeFields(doc: PDFDocument) {
  doc.catalog.delete(PDFName.of("AcroForm"));
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const keep = PDFArray.withContext(doc.context);
    for (let i = 0; i < annots.size(); i++) {
      const a = doc.context.lookup(annots.get(i));
      if (a instanceof PDFDict && a.get(PDFName.of("Subtype")) === PDFName.of("Widget")) continue;
      keep.push(annots.get(i));
    }
    if (keep.size()) page.node.set(PDFName.of("Annots"), keep);
    else page.node.delete(PDFName.of("Annots"));
  }
}

/** Draws one line, shrinking the font to fit the box. Returns the hex string written, or null on failure. */
function draw(page: PDFPage, font: PDFFont, text: string, f: FormField, fixedSize: number | undefined, issues: string[]): string | null {
  let encoded: string;
  try {
    encoded = font.encodeText(text).toString().toLowerCase();
  } catch {
    const bad = [...new Set([...text].filter((c) => !safeChar(font, c)))].join(" ");
    issues.push(`"${f.label}" contains characters the PDF font can't show (${bad}). Change the value.`);
    return null;
  }
  let size = fixedSize ?? f.fontSize ?? Math.min(10, f.h * 0.75);
  while (!fixedSize && size > 6 && font.widthOfTextAtSize(text, size) > f.w - 2) size -= 0.5;
  const width = font.widthOfTextAtSize(text, size);
  if (width > f.w - 1) {
    issues.push(`The value for "${f.label}" is too long for its box. Shorten it or widen the box in the template.`);
    return null;
  }
  const textHeight = font.heightAtSize(size, { descender: false });
  const x = fixedSize ? f.x + (f.w - width) / 2 : f.x + 1;
  page.drawText(text, { x, y: f.y + Math.max(1, (f.h - textHeight) / 2), size, font, color: rgb(0, 0, 0) });
  return encoded;
}

/** Writes one character per box, centred, for comb fields such as MPRN/GPRN rows. */
function drawComb(page: PDFPage, font: PDFFont, text: string, f: FormField, issues: string[]): string[] {
  const cells = f.comb!;
  const chars = [...text.replace(/\s+/g, "")];
  if (chars.length > cells) {
    issues.push(`"${f.label}" has room for ${cells} characters but the value has ${chars.length}.`);
    return [];
  }
  const bad = [...new Set(chars.filter((c) => !safeChar(font, c)))];
  if (bad.length) {
    issues.push(`"${f.label}" contains characters the PDF font can't show (${bad.join(" ")}). Change the value.`);
    return [];
  }
  const cell = f.w / cells;
  const size = f.fontSize ?? Math.max(6, Math.min(12, f.h * 0.75, cell * 1.1));
  const textHeight = font.heightAtSize(size, { descender: false });
  return chars.map((c, i) => {
    const w = font.widthOfTextAtSize(c, size);
    page.drawText(c, { x: f.x + i * cell + (cell - w) / 2, y: f.y + Math.max(1, (f.h - textHeight) / 2), size, font, color: rgb(0, 0, 0) });
    return font.encodeText(c).toString().toLowerCase();
  });
}

function safeChar(font: PDFFont, c: string) {
  try {
    font.encodeText(c);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-opens the saved file and confirms every value and signature is in the page content and
 * no fillable fields remain. This is the release check: any issue blocks the form.
 */
export async function verifyPdf(bytes: Uint8Array, pageCount: number, expect: Expectation[]): Promise<string[]> {
  const issues: string[] = [];
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes);
  } catch {
    return ["The generated PDF could not be reopened."];
  }
  const pages = doc.getPages();
  if (pages.length !== pageCount) issues.push(`The generated PDF has ${pages.length} pages instead of ${pageCount}.`);
  const widgets = pages.some((p) => {
    const annots = p.node.Annots();
    for (let i = 0; annots && i < annots.size(); i++) {
      const an = doc.context.lookup(annots.get(i));
      if (an instanceof PDFDict && an.get(PDFName.of("Subtype")) === PDFName.of("Widget")) return true;
    }
    return false;
  });
  if (widgets || doc.catalog.has(PDFName.of("AcroForm"))) issues.push("The generated PDF still has fillable fields, so its values could change when edited.");
  for (const e of expect) {
    const content = pages[e.page] ? pageContent(doc, pages[e.page]) : "";
    const missing = e.text.filter((hex) => !content.includes(hex)).length;
    if (missing) issues.push(`${missing} value${missing === 1 ? " is" : "s are"} missing from page ${e.page + 1} after saving.`);
    const images = content.split(/\sdo\b/).length - 1; // content is lower-cased
    if (images < e.images) issues.push(`A signature is missing from page ${e.page + 1} after saving.`);
  }
  return issues;
}

/**
 * A black and white (greyscale) copy for external parties that need one, made directly from the
 * PDF instead of printing and rescanning. A grey rectangle in "Saturation" blend mode is laid over
 * each page, so every colour renders as its own luminance while text and signatures stay vector.
 * The copy is reopened and each page's original content must still be there.
 */
export async function greyscaleCopy(source: Uint8Array, title: string): Promise<{ bytes: Uint8Array; issues: string[] }> {
  const doc = await PDFDocument.load(source);
  const pages = doc.getPages();
  const original = pages.map((p) => pageContent(doc, p));
  const gs = doc.context.register(doc.context.obj({ Type: "ExtGState", BM: "Saturation" }));
  for (const page of pages) {
    const box = page.getMediaBox();
    const key = page.node.newExtGState("UOGrey", gs);
    page.pushOperators(pushGraphicsState(), setGraphicsState(key), setFillingGrayscaleColor(0.5), rectangle(box.x, box.y, box.width, box.height), fill(), popGraphicsState());
  }
  doc.setTitle(`${title} (black and white)`);
  doc.setProducer("Utility Optimizer CRM");
  const bytes = await doc.save({ useObjectStreams: false });

  const issues: string[] = [];
  let reopened: PDFDocument;
  try {
    reopened = await PDFDocument.load(bytes);
  } catch {
    return { bytes, issues: ["The black and white copy could not be reopened."] };
  }
  const copy = reopened.getPages();
  if (copy.length !== pages.length) issues.push(`The black and white copy has ${copy.length} pages instead of ${pages.length}.`);
  copy.forEach((p, i) => {
    const content = pageContent(reopened, p);
    if (original[i] !== undefined && !content.includes(original[i])) issues.push(`Page ${i + 1} of the black and white copy lost some of its content.`);
    if (!/\/uogrey[-\d]*\s+gs/.test(content)) issues.push(`Page ${i + 1} of the black and white copy wasn't converted.`);
  });
  return { bytes, issues };
}

function pageContent(doc: PDFDocument, page: PDFPage): string {
  const contents = page.node.Contents();
  const streams: PDFStream[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = doc.context.lookup(contents.get(i));
      if (s instanceof PDFStream) streams.push(s);
    }
  } else if (contents instanceof PDFStream) streams.push(contents);
  return streams
    .map((s) => {
      const data = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
      return Buffer.from(data).toString("latin1");
    })
    .join("\n")
    .toLowerCase();
}
