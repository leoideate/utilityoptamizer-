import type { PDFDocumentProxy } from "pdfjs-dist";
import type { FormField } from "@uo/shared";

/** Names a PDF tool gives fields when nobody named them: "Text37", "undefined_5", "Check Box 78", "Signature45_es_:signer:signature"… */
export function isGenericLabel(label: string) {
  const l = label.trim();
  return (
    l.length <= 2 ||
    /_es_:/i.test(l) ||
    /^\d+$/.test(l) ||
    /^(text|text ?field|check ?box|checkbox|undefined|field|signature|date|cb|button|untitled|fill|box)[\s_.-]*\d*$/i.test(l) ||
    /^(text|check ?box|field|undefined)[\s_.-]*\d+[\s_.-]*\d*$/i.test(l)
  );
}

interface Line {
  text: string;
  /** PDF points, origin bottom-left. */
  x0: number;
  x1: number;
  y: number;
  h: number;
}

/** Joins pdf.js text runs into words/phrases, splitting where there's a visible gap. */
async function pageLines(doc: PDFDocumentProxy, page: number): Promise<Line[]> {
  const p = await doc.getPage(page + 1);
  const content = await p.getTextContent();
  const runs = content.items
    .flatMap((it) => ("str" in it && it.str.trim() ? [{ text: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || it.height || 8 }] : []))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const r of runs) {
    const prev = lines.at(-1);
    const gap = prev ? r.x - prev.x1 : Infinity;
    if (prev && Math.abs(prev.y - r.y) < 2 && gap > -1 && gap < Math.max(4, r.h * 0.6)) {
      prev.text += (gap > r.h * 0.15 && !prev.text.endsWith(" ") && !r.text.startsWith(" ") ? " " : "") + r.text;
      prev.x1 = r.x + r.w;
    } else lines.push({ text: r.text, x0: r.x, x1: r.x + r.w, y: r.y, h: r.h });
  }
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => /[A-Za-zÁÉÍÓÚáéíóú]/.test(l.text));
}

const clean = (s: string) => {
  const t = s
    .replace(/\s*[:*]+\s*$/, "")
    .replace(/^[*\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 60 ? `${t.slice(0, 57).replace(/\s+\S*$/, "")}…` : t;
};

/** Spaces out names a PDF tool glued together: "Block 1Energy Rate" → "Block 1 Energy Rate". */
export const tidyLabel = (s: string) => clean(s.replace(/([a-z0-9)])([A-Z][a-z])/g, "$1 $2"));

/** Section headings: capitals (ignoring a bracketed note) or noticeably larger text. */
const isHeading = (l: Line, bodySize: number) => {
  const main = l.text.replace(/\(.*$/, "").trim();
  const letters = main.replace(/[^A-Za-zÁÉÍÓÚáéíóú]/g, "");
  if (letters.length < 6 || !main.includes(" ")) return false;
  return letters.replace(/[^A-ZÁÉÍÓÚ]/g, "").length / letters.length > 0.8 || l.h >= bodySize * 1.3;
};
const headingText = (t: string) => {
  const s = t.replace(/^STEP\s*\d+\s*/i, "").replace(/\(.*$/, "").trim();
  // Capitals become sentence case; mixed-case headings keep their capitals.
  const sentence = s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s;
  return clean(sentence);
};

/** The section heading (an all-capitals line) above a box, in the same column. */
function sectionOf(f: FormField, lines: Line[], bodySize: number): string | null {
  const h = lines
    .filter((l) => isHeading(l, bodySize) && l.y > f.y + f.h && l.x0 <= f.x + f.w)
    .sort((a, b) => a.y - b.y)[0];
  return h ? headingText(h.text) : null;
}

/** The printed wording nearest a box: to its left on the same line, else just above it (tick boxes: to the right first). */
/** Whether tick boxes on this box's row are labelled on their left ("Limited Co. ☐  Plc ☐") or right ("☐ Yes  ☐ No"). */
function checkRowSide(f: FormField, lines: Line[], pageFields: FormField[]): "left" | "right" {
  const row = pageFields.filter((o) => o.kind === "check" && Math.abs(o.y + o.h / 2 - (f.y + f.h / 2)) < Math.max(4, f.h / 2)).sort((a, b) => a.x - b.x);
  const wordsOnRow = (o: FormField) => lines.filter((l) => l.y + l.h * 0.35 >= o.y - 3 && l.y + l.h * 0.35 <= o.y + o.h + 3);
  const first = row[0];
  // A word right before the first box means each label comes before its box; otherwise labels follow their boxes.
  return wordsOnRow(first).some((l) => l.x1 <= first.x + 6 && first.x - l.x1 < 30) ? "left" : "right";
}

function nearestWording(f: FormField, lines: Line[], pageFields: FormField[], bodySize: number): string | null {
  // Same line: the text's middle sits within the box's height (a little slack for short boxes).
  const mid = f.y + f.h / 2;
  // Single letters (a printed "M" before an MPRN row) aren't labels.
  const words = lines.filter((l) => clean(l.text).length >= 2);
  const sameLine = words.filter((l) => Math.abs(l.y + l.h * 0.35 - mid) <= Math.max(f.h / 2, l.h / 2) + 1);
  const left = sameLine.filter((l) => l.x1 <= f.x + 6 && f.x - l.x1 < 200).sort((a, b) => b.x1 - a.x1)[0];
  const right = sameLine.filter((l) => l.x0 >= f.x + f.w - 6 && l.x0 - (f.x + f.w) < 70).sort((a, b) => a.x0 - b.x0)[0];
  const above = words
    .filter((l) => l.y >= f.y + f.h - 2 && l.y - (f.y + f.h) < 16 && l.x0 < f.x + f.w && l.x1 > f.x - 10)
    .sort((a, b) => a.y - b.y || Math.abs(a.x0 - f.x) - Math.abs(b.x0 - f.x))[0];
  const pick = f.kind === "check" ? (checkRowSide(f, lines, pageFields) === "left" ? (left ?? right ?? above) : (right ?? left ?? above)) : (left ?? above ?? right);
  if (!pick) return null;
  let text = clean(pick.text);
  // In a grid (other boxes sit between the row label and this box), add the column heading.
  if (pick === left && pageFields.some((o) => o !== f && o.x >= left.x1 - 2 && o.x + o.w <= f.x + 2 && Math.abs(o.y + o.h / 2 - (f.y + f.h / 2)) < f.h)) {
    const col = lines
      .filter((l) => l.y > f.y + f.h && l.y - (f.y + f.h) < 120 && l.x0 < f.x + f.w + 4 && l.x1 > f.x - 4 && !isHeading(l, bodySize))
      .sort((a, b) => a.y - b.y)[0];
    if (col) text = `${text} (${clean(col.text)})`;
  }
  return text.length >= 2 ? text : null;
}

/**
 * Suggests labels from the PDF's own wording for fields with generic names, and spaces out
 * glued names on the others. Wording that repeats across sections gets the section heading
 * ("Contact Name (Address to send bill to)"); anything still repeated gets a number.
 */
export async function labelsFromPdf(doc: PDFDocumentProxy, fields: FormField[], { all = false } = {}): Promise<Map<string, string>> {
  const rename = (f: FormField) => all || isGenericLabel(f.label);
  const proposed = new Map<string, { base: string; section: string | null }>();
  for (const page of [...new Set(fields.map((f) => f.page))]) {
    const lines = await pageLines(doc, page);
    const sizes = lines.map((l) => l.h).sort((a, b) => a - b);
    const bodySize = sizes[Math.floor(sizes.length / 2)] ?? 8;
    const pageFields = fields.filter((f) => f.page === page);
    for (const f of pageFields) {
      if (!rename(f)) continue;
      const base = nearestWording(f, lines, pageFields, bodySize);
      if (base) proposed.set(f.id, { base, section: sectionOf(f, lines, bodySize) });
    }
  }
  const counts = new Map<string, number>();
  for (const p of proposed.values()) counts.set(p.base.toLowerCase(), (counts.get(p.base.toLowerCase()) ?? 0) + 1);

  // Reading order: page, then top to bottom, then left to right.
  const ordered = [...fields].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const f of ordered) {
    const p = proposed.get(f.id);
    let label = p ? p.base : isGenericLabel(f.label) ? f.label : tidyLabel(f.label);
    if (p && (counts.get(p.base.toLowerCase()) ?? 0) > 1 && p.section && !p.base.toLowerCase().includes(p.section.toLowerCase())) label = `${p.base} (${p.section})`;
    let unique = label;
    for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${label} ${n}`;
    taken.add(unique.toLowerCase());
    if (unique !== f.label) out.set(f.id, unique);
  }
  return out;
}
