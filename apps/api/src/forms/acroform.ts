import { PDFCheckBox, PDFDict, PDFDocument, type PDFFont, PDFName, PDFRawStream, PDFRef, PDFStream, PDFTextField, StandardFonts, decodePDFRawStream, rgb } from "pdf-lib";
import type { FormField } from "@uo/shared";
import { type FillInput, type FillValue, draw, drawSigningRecord, safeChar } from "./pdf";

export interface AcroFillInput extends FillInput {
  /** Flatten the fields into the page (the signed copy). The generated version stays fillable. */
  flatten?: boolean;
  /** PDF fields the CRM knowingly leaves alone (e.g. signature boxes of signers this version doesn't have). */
  untouched?: string[];
  /** Skip the check that every PDF field is mapped (the signed copy of a version already checked). */
  allowUnmapped?: boolean;
}

/** What the filled PDF must show once reopened. */
interface Expected {
  /** PDF field → text (empty when cleared); `comb` text is drawn one character per box. */
  texts: { field: string; value: string; comb: boolean }[];
  /** PDF field → ticked. */
  checks: { field: string; on: boolean }[];
  /** Values drawn on the page because the form has no field for them (hex strings, lower case). */
  drawn: string[];
  images: number;
}

const MIN_SIZE = 6;

/**
 * Fills a PDF's own form fields (AcroForm) from positioned fields that name them (`pdfField`).
 * Text is written into the field and its appearance regenerated, so it shows in every viewer;
 * tick boxes are set to the on-state their own appearance names. Fields without `pdfField` are
 * drawn on the page. Signatures are drawn into their boxes and, for the signed copy, the form is
 * flattened. The saved file is reopened and every value and appearance checked.
 */
export async function fillAcroForm(input: AcroFillInput): Promise<{ bytes: Uint8Array; issues: string[] }> {
  const doc = await PDFDocument.load(input.template);
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const issues: string[] = [];
  const expected: Expected = { texts: [], checks: [], drawn: [], images: 0 };

  // Every field on the form must be one the CRM fills or knowingly leaves: a different revision of
  // the PDF fails here instead of going out half filled.
  const mapped = new Set([...input.fields.flatMap((f) => (f.pdfField ? [f.pdfField] : [])), ...(input.untouched ?? [])]);
  if (!input.allowUnmapped) for (const f of form.getFields()) if (!mapped.has(f.getName())) issues.push(`The PDF has a field the CRM doesn't fill ("${f.getName()}"). Check the form's layout.`);

  // White boxes over what the template itself prints (e.g. a tick in its artwork), drawn first.
  for (const f of input.fields) if (f.mask && pages[f.page]) pages[f.page].drawRectangle({ x: f.x, y: f.y, width: f.w, height: f.h, color: rgb(1, 1, 1) });

  const signatureBoxes: FormField[] = [];
  for (const f of input.fields) {
    if (f.mask) continue;
    const page = pages[f.page];
    if (!page) {
      issues.push(`"${f.label}" is on page ${f.page + 1}, which this PDF doesn't have.`);
      continue;
    }
    if (f.kind === "signature") {
      signatureBoxes.push(f);
      continue;
    }
    const value = valueOf(f, input);
    if (!f.pdfField) {
      // No field on the form: draw it at the printed line.
      if (typeof value === "string" && value) {
        const hex = draw(page, font, value, f, undefined, issues);
        if (hex) expected.drawn.push(hex);
      }
      continue;
    }
    const field = form.getFieldMaybe(f.pdfField);
    if (!field) {
      issues.push(`"${f.label}" should fill the PDF field "${f.pdfField}", which this PDF doesn't have.`);
      continue;
    }
    if (f.kind === "check") {
      const on = value === true;
      if (field instanceof PDFCheckBox) {
        if (on) field.check();
        else field.uncheck();
        expected.checks.push({ field: f.pdfField, on });
      } else if (field instanceof PDFTextField) {
        // A tick box drawn as a text field on this form: a tick is an "X".
        setText(field, on ? "X" : "", f, font, issues);
        expected.texts.push({ field: f.pdfField, value: on ? "X" : "", comb: false });
      } else issues.push(`"${f.label}" isn't a tick box or text field in the PDF.`);
      continue;
    }
    if (!(field instanceof PDFTextField)) {
      issues.push(`"${f.label}" isn't a text field in the PDF.`);
      continue;
    }
    const text = typeof value === "string" ? value : "";
    if (setText(field, text, f, font, issues)) expected.texts.push({ field: f.pdfField, value: text, comb: !!f.comb });
  }

  // Regenerate every appearance, so stale ones in the template (a tick with no value) don't show.
  for (const f of form.getFields()) if (f instanceof PDFTextField && f.getText() === undefined) f.setText("");
  form.updateFieldAppearances(font);

  for (const f of signatureBoxes) {
    const png = f.signer ? input.signatures?.[f.signer] : undefined;
    if (!png) {
      if (input.requireSignatures) issues.push(`"${f.label}" has no signature.`);
      continue;
    }
    // The box is a text field: take it off the form so nothing can be typed over the signature.
    const box = f.pdfField ? form.getFieldMaybe(f.pdfField) : undefined;
    if (box) form.removeField(box);
    const img = await doc.embedPng(png);
    const scale = Math.min((f.w - 2) / img.width, (f.h - 2) / img.height);
    pages[f.page].drawImage(img, { x: f.x + 1, y: f.y + (f.h - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
    expected.images++;
    expected.texts = expected.texts.filter((t) => t.field !== f.pdfField);
  }

  if (input.flatten) form.flatten({ updateFieldAppearances: false });
  if (input.signingRecord?.length) drawSigningRecord(doc, font, input.signingRecord);

  doc.setTitle(input.title);
  doc.setProducer("Utility Optimizer CRM");
  doc.setCreator("Utility Optimizer CRM");
  const bytes = await doc.save({ useObjectStreams: false });
  issues.push(...(await verifyAcroForm(bytes, expected, { flattened: !!input.flatten, pages: doc.getPageCount() })));
  return { bytes, issues };
}

function valueOf(f: FormField, input: FillInput): FillValue {
  if (f.kind === "signed_date") {
    const d = f.signer ? input.signedDates?.[f.signer] : undefined;
    // Boxed dates are written as DDMMYY.
    return d && f.comb === 6 ? d.replace(/^(\d{2})\/(\d{2})\/\d{2}(\d{2})$/, "$1$2$3") : (d ?? null);
  }
  const v = input.values[f.id];
  if (typeof v === "string") {
    const flat = v.replace(/\s*[\r\n]+\s*/g, ", ").trim();
    return f.upper ? flat.toLocaleUpperCase("en-IE") : flat;
  }
  return v;
}

/** Writes text into a field at a size that fits its box. Returns false (with an issue) when it can't. */
function setText(field: PDFTextField, text: string, f: FormField, font: PDFFont, issues: string[]): boolean {
  const bad = [...new Set([...text].filter((c) => !safeChar(font, c)))];
  if (bad.length) {
    issues.push(`"${f.label}" contains characters the PDF font can't show (${bad.join(" ")}). Change the value.`);
    return false;
  }
  try {
    // Some supplier PDFs leave out a field's default appearance; give it the form's usual one.
    if (!field.acroField.getDefaultAppearance()) field.acroField.setDefaultAppearance("/Helv 0 Tf 0 g");
    if (f.comb) {
      if (text.length > f.comb) {
        issues.push(`"${f.label}" has room for ${f.comb} characters but the value has ${text.length}.`);
        return false;
      }
      field.setMaxLength(f.comb);
      field.enableCombing();
      field.setFontSize(f.fontSize ?? Math.max(MIN_SIZE, Math.min(11, f.h * 0.7, (f.w / f.comb) * 1.1)));
    } else {
      let size = f.fontSize ?? Math.min(10, f.h * 0.72);
      while (size > MIN_SIZE && font.widthOfTextAtSize(text, size) > f.w - 4) size -= 0.5;
      if (font.widthOfTextAtSize(text, size) > f.w - 2) {
        issues.push(`The value for "${f.label}" is too long for its box. Shorten it.`);
        return false;
      }
      field.setFontSize(size);
    }
    field.setText(text);
    return true;
  } catch {
    issues.push(`"${f.label}" couldn't be filled.`);
    return false;
  }
}

const hexOf = (font: PDFFont, s: string) => font.encodeText(s).toString().toLowerCase();

function streamText(doc: PDFDocument, obj: unknown): string {
  const s = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  // Images (often JPEG) are counted elsewhere; only content streams are read.
  if (!(s instanceof PDFStream) || s.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")) return "";
  const data = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
  return Buffer.from(data).toString("latin1").toLowerCase();
}

/**
 * Reopens a filled AcroForm PDF and checks it: each field holds its value and its appearance shows
 * it (or, once flattened, the page shows it and no fields remain), tick boxes are in the right
 * state, drawn values and signatures are on the page. Any issue blocks the document.
 */
export async function verifyAcroForm(bytes: Uint8Array, e: Expected, opts: { flattened: boolean; pages: number }): Promise<string[]> {
  const issues: string[] = [];
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes);
  } catch {
    return ["The generated PDF could not be reopened."];
  }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  if (doc.getPageCount() !== opts.pages) issues.push(`The generated PDF has ${doc.getPageCount()} pages instead of ${opts.pages}.`);
  const page = doc.getPages()[0];
  const resources = page.node.Resources();
  const xobjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  const xobjectStreams = (xobjects?.keys() ?? []).map((k) => xobjects!.get(k));
  const images = xobjectStreams.filter((x) => {
    const s = doc.context.lookup(x);
    return s instanceof PDFStream && s.dict.get(PDFName.of("Subtype")) === PDFName.of("Image");
  }).length;
  const content = [streamText(doc, page.node.Contents()), ...arrayContents(doc, page.node.Contents()), ...xobjectStreams.map((x) => streamText(doc, x))].join("\n");

  const shows = (value: string, comb: boolean, where: string) => (comb ? [...value].every((c) => where.includes(hexOf(font, c))) : where.includes(hexOf(font, value)));

  if (opts.flattened) {
    if (doc.getForm().getFields().length) issues.push("The signed PDF still has fillable fields, so its values could change when edited.");
    const missing = e.texts.filter((t) => t.value && !shows(t.value, t.comb, content)).length;
    if (missing) issues.push(`${missing} value${missing === 1 ? " is" : "s are"} missing from the signed PDF.`);
  } else {
    const form = doc.getForm();
    for (const t of e.texts) {
      const field = form.getFieldMaybe(t.field);
      if (!(field instanceof PDFTextField)) {
        issues.push(`The PDF field "${t.field}" is missing after saving.`);
        continue;
      }
      if ((field.getText() ?? "") !== t.value) issues.push(`The PDF field "${t.field}" doesn't hold its value after saving.`);
      const ap = field.acroField.getWidgets()[0]?.getNormalAppearance();
      const shown = streamText(doc, ap);
      if (!ap) issues.push(`The PDF field "${t.field}" has no appearance, so some viewers won't show it.`);
      else if (t.value && !shows(t.value, t.comb, shown)) issues.push(`The PDF field "${t.field}" doesn't show its value.`);
    }
    for (const c of e.checks) {
      const field = form.getFieldMaybe(c.field);
      if (!(field instanceof PDFCheckBox)) {
        issues.push(`The tick box "${c.field}" is missing after saving.`);
        continue;
      }
      const widget = field.acroField.getWidgets()[0];
      const state = widget.dict.get(PDFName.of("AS"));
      const onState = field.acroField.getOnValue();
      if (field.isChecked() !== c.on || (c.on ? state !== onState : state !== PDFName.of("Off"))) issues.push(`The tick box "${c.field}" isn't ${c.on ? "ticked" : "clear"} after saving.`);
    }
  }
  const drawnMissing = e.drawn.filter((h) => !content.includes(h)).length;
  if (drawnMissing) issues.push(`${drawnMissing} value${drawnMissing === 1 ? " is" : "s are"} missing from the page after saving.`);
  if (images < e.images) issues.push("A signature is missing from the page after saving.");
  return issues;
}

function arrayContents(doc: PDFDocument, contents: unknown): string[] {
  if (!contents || typeof contents !== "object" || !("size" in contents)) return [];
  const arr = contents as { size(): number; get(i: number): unknown };
  return Array.from({ length: arr.size() }, (_, i) => streamText(doc, arr.get(i)));
}
