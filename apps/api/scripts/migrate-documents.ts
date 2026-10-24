/**
 * Attaches a folder of signed supplier PDFs to the deals imported from the master sheet:
 *
 *   npm run migrate:documents -w @uo/api -- <folder> [--matches <pdf-review.csv>] [--commit]
 *
 * Each PDF is matched by the MPRN/GPRN in its form fields, page text or file name, then by business
 * name. Without --commit nothing is written. PDFs without exactly one match are listed in
 * migration-out/pdf-review.csv: fill in its "Match" column with a deal number (UO-000123) or an
 * MPRN/GPRN and pass the file back with --matches. Uploads are virus-scanned by the worker (Redis).
 */
import "reflect-metadata";
import "../src/load-env";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { MigrationService } from "../src/migration/migration.service";
import { BOM, writeReport } from "../src/migration/report";
import { parseCsv } from "../src/opportunities/lead-intake";

/** File name → match, from the review CSV's "File" and "Match" columns. */
function readMatches(file: string): Map<string, string> {
  const [header, ...rows] = parseCsv(readFileSync(file, "utf8").replace(BOM, ""));
  const fileCol = header.findIndex((h) => h.trim().toLowerCase() === "file");
  const matchCol = header.findIndex((h) => h.trim().toLowerCase() === "match");
  if (fileCol < 0 || matchCol < 0) throw new Error(`${file} needs "File" and "Match" columns (as in pdf-review.csv).`);
  return new Map(rows.filter((r) => r[matchCol]?.trim()).map((r) => [r[fileCol].trim(), r[matchCol].trim()]));
}

async function main() {
  const args = process.argv.slice(2);
  const folder = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--matches");
  if (!folder) throw new Error("Usage: npm run migrate:documents -w @uo/api -- <folder> [--matches <pdf-review.csv>] [--commit]");
  const matchesFile = args[args.indexOf("--matches") + 1];
  const commit = args.includes("--commit");
  const manual = args.includes("--matches") && matchesFile ? readMatches(matchesFile) : undefined;
  const files = readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".pdf"))
    .map((d) => ({ name: d.name, buffer: readFileSync(path.join(d.parentPath, d.name)) }));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
  try {
    const lines = await app.get(MigrationService).importDocuments(files, { commit, manual });
    const review = lines.filter((l) => l.action === "review");
    const report = writeReport(
      "pdf-report.csv",
      ["File", commit ? "Result" : "Would be", "Deal", "Numbers found", "Detail"],
      lines.map((l) => [l.file, l.action, l.deal, l.found, l.detail]),
    );
    const reviewFile = writeReport(
      "pdf-review.csv",
      ["File", "Match", "Suggested deals", "Numbers found", "Why"],
      review.map((l) => [l.file, "", l.deal, l.found, l.detail]),
    );
    const count = (a: string) => lines.filter((l) => l.action === a).length;
    console.log(commit ? "Attached." : "Dry run: nothing was written. Add --commit to attach.");
    console.log(`  ${files.length} PDFs: ${commit ? "attached" : "to attach"} ${count("attached")}, already uploaded ${count("exists")}, need a match ${review.length}`);
    console.log(`  report: ${report}`);
    if (review.length) console.log(`  fill in the Match column of ${reviewFile} and run again with --matches ${reviewFile}`);
  } finally {
    await app.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
