/**
 * Imports existing customers and their contracts from the master sheet (one tab per supplier):
 *
 *   npm run migrate:customers -w @uo/api -- <sheet.xlsx> [--commit] [--create-suppliers] [--allow-format-exceptions]
 *
 * Without --commit nothing is written: migration-out/customers-report.csv lists what each row would
 * become. Re-running after a commit skips rows already imported. See docs/migration.md. Uses apps/api/.env.
 */
import "reflect-metadata";
import "../src/load-env";
import { readFileSync } from "node:fs";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { MigrationService } from "../src/migration/migration.service";
import { writeReport } from "../src/migration/report";
import { readMasterSheet } from "../src/migration/sheet";

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) throw new Error("Usage: npm run migrate:customers -w @uo/api -- <sheet.xlsx> [--commit] [--create-suppliers] [--allow-format-exceptions]");
  const opts = { commit: args.includes("--commit"), createSuppliers: args.includes("--create-suppliers"), allowFormatExceptions: args.includes("--allow-format-exceptions") };
  const tabs = await readMasterSheet(readFileSync(file));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
  try {
    const r = await app.get(MigrationService).importCustomers(tabs, opts);
    const report = writeReport(
      "customers-report.csv",
      ["Tab", "Row", opts.commit ? "Result" : "Would be", "Business", "Customer", "Detail", "Warnings"],
      r.lines.map((l) => [l.tab, l.line, l.action, l.business, l.customer, l.detail, l.warnings]),
    );
    const count = (a: string) => r.lines.filter((l) => l.action === a).length;
    console.log(opts.commit ? "Imported." : "Dry run: nothing was written. Add --commit to import.");
    for (const t of tabs) console.log(`  tab ${t.name}: ${t.rows.length} rows${t.rows.length ? "" : " (no header row found)"}`);
    console.log(`  ${opts.commit ? "created" : "to create"}: ${count("created")}, already imported: ${count("exists")}, skipped: ${count("skipped")}`);
    console.log(`  statuses: ${Object.entries(r.statuses).map(([s, n]) => `${s} (${n})`).join(", ")}`);
    if (r.suppliersToCreate.length) console.log(`  suppliers not in the CRM: ${r.suppliersToCreate.join(", ")}${opts.createSuppliers ? (opts.commit ? " (added)" : " (will be added)") : " (rows skipped; use --create-suppliers)"}`);
    if (r.unmatchedAgents.length) console.log(`  sales agents with no matching user (left unassigned): ${r.unmatchedAgents.join(", ")}`);
    if (r.ignoredColumns.length) console.log(`  columns not imported: ${r.ignoredColumns.join(", ")}`);
    console.log(`  live contracts ending within 120 days (renewals open at the next 07:00 run): ${r.renewalsSoon}`);
    console.log(`  report: ${report}`);
  } finally {
    await app.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
