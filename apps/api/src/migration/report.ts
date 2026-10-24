import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Reports hold customers' details, so they go to a gitignored folder next to the API. */
export const REPORT_DIR = path.resolve(__dirname, "../../migration-out");

/** Byte order mark, so Excel reads the file as UTF-8 (accents in names). */
export const BOM = String.fromCharCode(0xfeff);

const esc = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // Neutralise spreadsheet formulas and quote everything (as reports.service does).
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

/** Writes a CSV report (with a BOM so Excel reads accents) and returns its path. */
export function writeReport(name: string, header: string[], rows: unknown[][]): string {
  mkdirSync(REPORT_DIR, { recursive: true });
  const file = path.join(REPORT_DIR, name);
  writeFileSync(file, `${BOM}${[header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n")}\r\n`);
  return file;
}
