import { addMonths, today } from "@uo/shared";
import ExcelJS from "exceljs";
import { type Client, type TestApp, createTestApp, createUser, expectStatus, userAndClient } from "../support/app";
import { supplier } from "../support/fixtures";

let t: TestApp;
let admin: Client;
let sales: Client;
let pat: { id: string };

const COLS = ["Business name", "Trading name", "Country", "Contact person", "Contact number", "Contact number (+353)", "Email", "MPRN/GPRN", "Supplier", "Utility type", "Product type", "Contract start", "Expiry date", "Contract term (years)", "Contract status", "Sales agent"];
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const expiry = addMonths(today(), 20).split("-").reverse().join("/");

async function sheet() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Flogas Customers");
  ws.addRow(COLS);
  ws.addRow(["Run Café Ltd", null, "Ireland", "Pat Kelly", "0861112223", "+353861112223", null, "10012300001", "Flogas", "Electricity", "GP (Rate Card 3)", null, expiry, 2, "Accepted", "Pat Kelly Sales"]);
  ws.addRow(["Run Bakery", null, "Ireland", null, "0861114445", null, null, "10012300002", "Flogas", "Electricity", "GP (Rate Card 3)", null, expiry, 2, "Rejected", "Pat Kelly Sales"]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Polls a run until the background work finishes. */
async function finished(c: Client, id: string) {
  for (let i = 0; i < 100; i++) {
    const run = expectStatus(await c.get(`/admin/imports/${id}`), 200).body;
    if (run.status !== "running") return run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("The import run didn't finish");
}

beforeAll(async () => {
  t = await createTestApp();
  await supplier(t, "Flogas");
  admin = (await userAndClient(t, ["administrator"])).client;
  sales = (await userAndClient(t, ["salesperson"])).client;
  pat = await createUser(t, ["salesperson"], "Pat");
});
afterAll(() => t.close());

describe("Administration → Import customers", () => {
  it("is for administrators only, and refuses files that aren't a sheet", async () => {
    expectStatus(await sales.upload("/admin/imports", await sheet(), "sheet.xlsx", XLSX), 403);
    const bad = expectStatus(await admin.upload("/admin/imports", Buffer.from("not a sheet"), "notes.xlsx", XLSX), 422);
    expect(bad.body.issues[0]).toMatch(/No customer rows were found/);
  });

  it("dry runs in the background, then imports with the salespeople chosen, once", async () => {
    const started = expectStatus(await admin.upload("/admin/imports", await sheet(), "Flogas customers.xlsx", XLSX), 201).body;
    expect(started).toMatchObject({ mode: "dry_run", status: "running" });
    const dry = await finished(admin, started.id);
    expect(dry.summary).toMatchObject({ rows: 2, created: 1, skipped: 1, unmatchedAgents: ["Pat Kelly Sales"] });
    expect(dry.lines.map((l: { action: string }) => l.action)).toEqual(["created", "skipped"]);
    expect(await t.prisma.opportunity.count({ where: { leadSource: "migration" } })).toBe(0);

    const imported = await finished(admin, expectStatus(await admin.post(`/admin/imports/${dry.id}/import`, { agents: { "Pat Kelly Sales": pat.id } }), 201).body.id);
    expect(imported).toMatchObject({ mode: "import", status: "done", summary: { created: 1, unmatchedAgents: [] } });
    const deal = await t.prisma.opportunity.findFirstOrThrow({ where: { leadSource: "migration" } });
    expect(deal).toMatchObject({ companyName: "Run Café Ltd", ownerId: pat.id, outcome: "won", applicationStatus: "Accepted" });
    expect(await t.prisma.auditLog.count({ where: { action: "import.customers", entityId: imported.id } })).toBe(1);

    // The same sheet again: nothing new.
    const again = await finished(admin, expectStatus(await admin.post(`/admin/imports/${dry.id}/import`, { agents: {} }), 201).body.id);
    expect(again.summary).toMatchObject({ created: 0, exists: 1 });
    expect(await t.prisma.opportunity.count({ where: { leadSource: "migration" } })).toBe(1);

    const runs = expectStatus(await admin.get("/admin/imports"), 200).body;
    expect(runs[0]).not.toHaveProperty("storageKey");
    expect(runs[0]).not.toHaveProperty("lines");
  });

  it("only imports from a finished dry run", async () => {
    expectStatus(await admin.post("/admin/imports/7c9e6679-7425-40de-944b-e07fc1f90ae7/import", {}), 404);
  });
});
