import { addDays, addMonths, today } from "@uo/shared";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import { RenewalsService } from "../../src/automations/renewals.service";
import { MigrationService } from "../../src/migration/migration.service";
import { readMasterSheet } from "../../src/migration/sheet";
import { type Client, type TestApp, createTestApp, createUser, expectStatus, pdf, userAndClient } from "../support/app";
import { supplier } from "../support/fixtures";

let t: TestApp;
let migration: MigrationService;
let admin: Client;

const HEADERS = ["Contract Sign Date", "Month", "Year", "Contract Start Date", "Contract Status", "Business Name", "Trading Name", "Contact Person", "Address", "Contact Number", "Email", "MPRN/GPRN", "Utility Type", "Connection Type", "Product Type", "Term (yrs)", "Sales Agent Name", "Comment - Contract Issue", "Expire Date", "Email Date", "Comment - Isuues for Invoices", "Posted By", "Reviewer", "Review Date"];
const TODAY = today();
const irish = (iso: string) => iso.split("-").reverse().join("/");

function row(over: Partial<Record<(typeof HEADERS)[number], unknown>>) {
  const base: Record<string, unknown> = {
    "Contract Sign Date": irish(addMonths(TODAY, -4)),
    "Contract Start Date": irish(addMonths(TODAY, -3)),
    "Contract Status": "Ready for Invoice",
    "Term (yrs)": 2,
    "Utility Type": "Electricity",
    "Connection Type": "New",
    ...over,
  };
  return HEADERS.map((h) => base[h] ?? null);
}

async function workbook() {
  const wb = new ExcelJS.Workbook();
  const flogas = wb.addWorksheet("Flogas");
  flogas.addRow(HEADERS);
  flogas.addRow(row({ "Business Name": "Harbour Café Ltd", "Trading Name": "Harbour Café", "Contact Person": "Aoife Byrne", Address: "12 Quay St, Galway, Co. Galway, H91 X2Y3", "Contact Number": 871234567, Email: "aoife@harbour.ie", "MPRN/GPRN": 10012345678, "Product Type": "GP (Rate card 3)", "Sales Agent Name": "Sarah Sales", Reviewer: "Mary", "Comment - Contract Issue": "Awaiting COT form" }));
  flogas.addRow(row({ "Business Name": "Harbour Café Ltd", Email: "aoife@harbour.ie", "MPRN/GPRN": "1234567", "Utility Type": "Gas", "Product Type": "MBU (Rate Card 4)", "Sales Agent Name": "sarah sales" }));
  flogas.addRow(row({ "Business Name": "Gone Ltd", "MPRN/GPRN": 10011111111, "Contract Status": "Cancelled" }));
  const bg = wb.addWorksheet("Bord Gais");
  bg.addRow(HEADERS);
  bg.addRow(row({ "Business Name": "Quay Bakery", Address: "Main St, Naas", "Contact Number": "045 123456", "MPRN/GPRN": "10098765432", "Expire Date": irish(addDays(TODAY, 60)), "Sales Agent Name": "Former Agent" }));
  bg.addRow(row({ "Business Name": "Typo Ltd", "MPRN/GPRN": "2009876543" }));
  const energia = wb.addWorksheet("Energia");
  energia.addRow(HEADERS);
  energia.addRow(row({ "Business Name": "Hillside Hotel", "MPRN/GPRN": "10055555555" }));
  return readMasterSheet(Buffer.from(await wb.xlsx.writeBuffer()));
}

beforeAll(async () => {
  t = await createTestApp();
  migration = t.app.get(MigrationService);
  await supplier(t, "Flogas");
  await supplier(t, "Bord Gáis Energy");
  await createUser(t, ["salesperson"], "Sarah Sales");
  admin = (await userAndClient(t, ["administrator"])).client;
});
afterAll(() => t.close());

describe("master sheet migration", () => {
  it("reports without writing on a dry run", async () => {
    const r = await migration.importCustomers(await workbook(), { commit: false });
    expect(r.lines.map((l) => [l.tab, l.line, l.action])).toEqual([
      ["Flogas", 2, "created"],
      ["Flogas", 3, "created"],
      ["Flogas", 4, "created"],
      ["Bord Gais", 2, "created"],
      ["Bord Gais", 3, "skipped"],
      ["Energia", 2, "skipped"],
    ]);
    expect(r.lines[1].customer).toBe("same as Flogas row 2");
    expect(r.suppliersToCreate).toEqual(["Energia"]);
    expect(r.unmatchedAgents).toEqual(["Former Agent"]);
    expect(r.renewalsSoon).toBe(1);
    expect(r.statuses).toMatchObject({ "Ready for Invoice": 5, Cancelled: 1 });
    expect(r.lost).toBe(1);
    expect(r.ignoredColumns).toEqual(expect.arrayContaining(["Month", "Year"]));
    expect(await t.prisma.opportunity.count()).toBe(0);
    expect(await t.prisma.customer.count()).toBe(0);
  });

  it("imports won deals with live contracts, once", async () => {
    const r = await migration.importCustomers(await workbook(), { commit: true });
    expect(r.lines.filter((l) => l.action === "created")).toHaveLength(4);
    expect(await t.prisma.customer.count()).toBe(3); // both Harbour Café rows share one customer

    const sarah = await t.prisma.user.findFirstOrThrow({ where: { name: "Sarah Sales" } });
    const elec = await t.prisma.opportunity.findFirstOrThrow({ where: { importKey: { contains: "10012345678" } }, include: { stage: true, contracts: true, sites: { include: { meterPoints: true } }, customer: { include: { contacts: true, addresses: true } }, timeline: true } });
    expect(elec).toMatchObject({ outcome: "won", leadSource: "migration", ownerId: sarah.id, serviceType: "electricity", stage: { key: "live_won" } });
    expect(elec.contracts[0]).toMatchObject({ status: "live", fuel: "electricity", termMonths: 24, pricingPlan: "GP (Rate card 3)" });
    expect(elec.contracts[0].contractEndDate?.toISOString().slice(0, 10)).toBe(addDays(addMonths(addMonths(TODAY, -3), 24), -1));
    expect(elec.sites[0]).toMatchObject({ line1: "12 Quay St", city: "Galway", county: "Galway", postcode: "H91 X2Y3", meterPoints: [expect.objectContaining({ mprn: "10012345678" })] });
    expect(elec.customer).toMatchObject({ legalName: "Harbour Café Ltd", tradingName: "Harbour Café", phone: "0871234567", contacts: [expect.objectContaining({ firstName: "Aoife", lastName: "Byrne", isPrimary: true })] });
    const note = elec.timeline.map((e) => e.body).join("\n");
    expect(note).toContain("Reviewer: Mary");
    expect(note).toContain("Contract issue: Awaiting COT form");

    const bakery = await t.prisma.opportunity.findFirstOrThrow({ where: { importKey: { contains: "10098765432" } }, include: { selectedSupplier: true } });
    expect(bakery).toMatchObject({ ownerId: null, selectedSupplier: { name: "Bord Gáis Energy" } });
    expect(await t.prisma.auditLog.count({ where: { action: "migration.import" } })).toBe(4);

    // A cancelled row is kept as a lost deal at Submitted, with its meter but no live contract or renewal.
    const gone = await t.prisma.opportunity.findFirstOrThrow({ where: { importKey: { contains: "10011111111" } }, include: { stage: true, contracts: true, sites: { include: { meterPoints: true } } } });
    expect(gone).toMatchObject({ outcome: "lost", lostReason: "Master sheet status: Cancelled", wonAt: null, renewalDate: null, probability: 0, stage: { key: "submitted" }, applicationStatus: "Cancelled" });
    expect(gone.contracts[0]).toMatchObject({ status: "cancelled", activationDate: null });
    expect(gone.sites[0].meterPoints[0].mprn).toBe("10011111111");

    const again = await migration.importCustomers(await workbook(), { commit: true });
    expect(again.lines.filter((l) => l.action === "exists")).toHaveLength(4);
    expect(await t.prisma.opportunity.count()).toBe(4);
  });

  it("adds missing suppliers when asked", async () => {
    const r = await migration.importCustomers(await workbook(), { commit: true, createSuppliers: true });
    expect(r.lines.find((l) => l.tab === "Energia")?.action).toBe("created");
    expect(await t.prisma.supplier.count({ where: { name: "Energia" } })).toBe(1);
  });

  it("schedules renewals for imported contracts ending soon", async () => {
    await t.app.get(RenewalsService).run();
    const renewal = await t.prisma.opportunity.findFirst({ where: { saleType: "renewal", previousOpportunity: { importKey: { contains: "10098765432" } } } });
    expect(renewal).not.toBeNull();
  });

  it("shows the master sheet's columns on the customers list, and finds customers by MPRN", async () => {
    const list = expectStatus(await admin.get("/customers?q=10012345678"), 200).body;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      legalName: "Harbour Café Ltd",
      contactName: "Aoife Byrne",
      phone: "0871234567",
      email: "aoife@harbour.ie",
      contract: { supplier: "Flogas", status: "live", startDate: addMonths(TODAY, -3) },
    });
  });

  it("imports the aligned sheet layout, with a task and a notification for meter numbers to fix", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Flogas Customers");
    const cols = ["Business name", "Trading name", "Country", "Contact person", "Contact number", "Contact number (+353)", "Email", "MPRN/GPRN", "Supplier", "Utility type", "Product type", "Contract start", "Expiry date", "Contract term (years)", "Contract status", "Sales agent"];
    ws.addRow(cols);
    const expiry = irish(addMonths(TODAY, 20));
    ws.addRow(["Aligned Gas Ltd", null, "Ireland", "Pat Kelly", "0861112223", "+353861112223", null, null, "Flogas", "Gas", "MBU (Rate Card 4)", null, expiry, 2, "Clawback", "Sarah Sales"]);
    ws.addRow(["Short Meter Ltd", null, "Ireland", null, null, null, null, "475303", "Flogas", "Gas", "SBU (Rate Card 4)", null, expiry, 1, "Accepted", "Sarah Sales"]);
    ws.addRow(["Aligned Gas Limited", null, "Ireland", null, "0869998887", null, null, "10077777777", "Flogas", "Electricity", "GP (Rate Card 3)", null, expiry, 2, "Accepted", "Sarah Sales"]);
    const tabs = await readMasterSheet(Buffer.from(await wb.xlsx.writeBuffer()));
    const before = await t.prisma.notification.count();
    const r = await migration.importCustomers(tabs, { commit: true, allowFormatExceptions: true });
    expect(r.lines.map((l) => l.action)).toEqual(["created", "created", "created"]);
    expect(r.meterChecks).toBe(2);
    // Same business name, nothing else shared: a separate customer, flagged for a manager to merge.
    expect(r.lines[2].warnings).toMatch(/Same name as Flogas Customers row 2, but no shared email, phone or Eircode/);

    const deal = await t.prisma.opportunity.findFirstOrThrow({ where: { companyName: "Aligned Gas Ltd" }, include: { contracts: true, sites: { include: { meterPoints: true } } } });
    expect(deal).toMatchObject({ applicationStatus: "Clawback", phone: "+353861112223" });
    expect(deal.contracts[0]).toMatchObject({ status: "ended", termMonths: 24 });
    expect(deal.sites[0]).toMatchObject({ country: "IE" });
    expect(deal.sites[0].meterPoints[0]).toMatchObject({ fuel: "gas", gprn: null });

    const adminUser = await t.prisma.user.findFirstOrThrow({ where: { roles: { some: { role: "administrator" } } }, orderBy: { createdAt: "asc" } });
    const tasks = await t.prisma.activity.findMany({ where: { automationKey: "migration_meter_check" }, orderBy: { summary: "asc" } });
    expect(tasks.map((a) => [a.summary, a.ownerId, a.priority, a.status])).toEqual([
      ["Add the missing GPRN (imported without one)", adminUser.id, "high", "open"],
      ["Check the GPRN 475303: it isn't in the standard format", adminUser.id, "high", "open"],
    ]);
    const notes = await t.prisma.notification.findMany({ where: { userId: adminUser.id }, orderBy: { createdAt: "desc" } });
    expect(await t.prisma.notification.count()).toBeGreaterThan(before);
    expect(notes[0]).toMatchObject({ title: "2 imported customers need an MPRN or GPRN added or checked", link: "/activities" });

    const list = expectStatus(await admin.get("/customers?q=Aligned%20Gas%20Ltd"), 200).body;
    expect(list.items[0].contract).toMatchObject({ applicationStatus: "Clawback", country: "IE", termMonths: 24, status: "ended" });
  });

  it("adds a row matching two customers from the same import to the first, and flags them to merge", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Flogas Customers");
    ws.addRow(["Business name", "Contact number", "Email", "MPRN/GPRN", "Supplier", "Utility type", "Expiry date", "Contract term (years)", "Contract status"]);
    const expiry = irish(addMonths(TODAY, 18));
    ws.addRow(["Ajmal Traders", "0871231234", null, "10044400001", "Flogas", "Electricity", expiry, 2, "Accepted"]);
    ws.addRow(["Ajmal Traders", null, "ajmal@traders.ie", "10044400002", "Flogas", "Electricity", expiry, 2, "Accepted"]);
    ws.addRow(["Ajmal Traders", "0871231234", "ajmal@traders.ie", "10044400003", "Flogas", "Electricity", expiry, 2, "Accepted"]);
    const r = await migration.importCustomers(await readMasterSheet(Buffer.from(await wb.xlsx.writeBuffer())), { commit: true });
    expect(r.lines.map((l) => l.action)).toEqual(["created", "created", "created"]);
    expect(r.lines[2].warnings).toMatch(/Also matches Ajmal Traders \(Flogas Customers row 3\), created earlier in this import; added to Ajmal Traders \(Flogas Customers row 2\)/);
    const deals = await t.prisma.opportunity.findMany({ where: { companyName: "Ajmal Traders" }, orderBy: { number: "asc" }, select: { customerId: true } });
    expect(deals[2].customerId).toBe(deals[0].customerId);
  });

  it("attaches signed PDFs by meter number, file name or a manual match", async () => {
    const form = await PDFDocument.create();
    form.addPage();
    form.getForm().createTextField("supply_mprn").setText("10012345678");
    const files = [
      { name: "application form.pdf", buffer: Buffer.from(await form.save()) },
      { name: "Quay Bakery 10098765432.pdf", buffer: pdf("bakery") },
      { name: "scan001.pdf", buffer: pdf("scan") },
    ];
    const dry = await migration.importDocuments(files, { commit: false });
    expect(dry.map((l) => [l.file, l.action])).toEqual([
      ["application form.pdf", "attached"],
      ["Quay Bakery 10098765432.pdf", "attached"],
      ["scan001.pdf", "review"],
    ]);
    expect(await t.prisma.documentVersion.count()).toBe(0);

    const gas = await t.prisma.opportunity.findFirstOrThrow({ where: { importKey: { contains: "1234567:" } } });
    const lines = await migration.importDocuments(files, { commit: true, manual: new Map([["scan001.pdf", `UO-${String(gas.number).padStart(6, "0")}`]]) });
    expect(lines.map((l) => l.action)).toEqual(["attached", "attached", "attached"]);
    const items = await t.prisma.documentItem.findMany({ include: { versions: true, opportunity: true } });
    expect(items.map((i) => i.documentType)).toEqual(["application_form", "application_form", "application_form"]);
    expect(items.find((i) => i.versions[0].filename === "scan001.pdf")?.opportunityId).toBe(gas.id);
    expect(t.queue.jobs.filter((j) => j.name === "scan")).toHaveLength(3);

    expect((await migration.importDocuments(files, { commit: true })).map((l) => l.action)).toEqual(["exists", "exists", "exists"]);
  });
});
