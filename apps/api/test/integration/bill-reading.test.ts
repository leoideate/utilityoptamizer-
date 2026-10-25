import type { BillReading } from "@uo/shared";
import { DOCUMENT_READER, type DocumentReader } from "../../src/ai/document-reader";
import { type TestApp, createTestApp, expectStatus, pdf, userAndClient } from "../support/app";
import { createOpportunity } from "../support/fixtures";

const reading: BillReading = {
  readable: true,
  customerName: "Test Trading Ltd",
  supplyAddress: { line1: "Unit 4, Harbour Road", line2: null, city: "Howth", county: "Dublin", postcode: "D13 X2Y4" },
  fuel: "electricity",
  mprn: "10012345678",
  gprn: null,
  meterNumber: "123456789",
  supplierName: "Electric Ireland",
  accountNumber: "9001234567",
  billDate: "2026-09-03",
  periodStart: "2026-07-01",
  periodEnd: "2026-08-31",
  tariffName: "Business Standard",
  dayRate: 0.2814,
  nightRate: 0.1512,
  gasRate: null,
  standingChargePerDay: 0.6523,
  usageKwh: 2410,
  annualConsumptionKwh: null,
  mic: null,
  readings: [{ register: "Day", value: "045123", readingDate: "2026-08-31", readingType: "actual" }],
  notes: null,
};

class FakeReader implements DocumentReader {
  readonly model = "claude-haiku-5-5";
  configured = true;
  files: { size: number; mimeType: string }[] = [];
  async readBill(file: Buffer, mimeType: string) {
    this.files.push({ size: file.length, mimeType });
    return reading;
  }
  async readCard(): Promise<never> {
    throw new Error("not used");
  }
}

const reader = new FakeReader();
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp([{ provide: DOCUMENT_READER, useValue: reader }]);
});
afterAll(() => t.close());

async function billVersion(client: Awaited<ReturnType<typeof userAndClient>>["client"], documentType = "energy_bill") {
  const opp = await createOpportunity(client, "electricity");
  const item = expectStatus(await client.post(`/opportunities/${opp}/documents`, { documentType }), 201).body;
  expectStatus(await client.upload(`/documents/${item.id}/versions`, pdf("bill"), "bill.pdf", "application/pdf"), 201);
  const v = await t.prisma.documentVersion.findFirstOrThrow({ where: { itemId: item.id } });
  return { opp, itemId: item.id as string, versionId: v.id };
}

describe("reading an energy bill with AI", () => {
  it("returns the suggested values, saves nothing, and audits the read without the values", async () => {
    const { client } = await userAndClient(t, ["salesperson"]);
    const { opp, itemId, versionId } = await billVersion(client);
    const res = expectStatus(await client.post(`/document-versions/${versionId}/read-bill`), 200);
    expect(res.body).toMatchObject({ versionId, documentItemId: itemId, model: "claude-haiku-5-5", reading: { mprn: "10012345678", supplierName: "Electric Ireland" } });
    expect(reader.files.at(-1)).toMatchObject({ mimeType: "application/pdf" });

    expect(await t.prisma.supplySite.count({ where: { opportunityId: opp } })).toBe(0);
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "document.ai_read", entityId: itemId } });
    expect(JSON.stringify(audit.data)).not.toContain("10012345678");
  });

  it("only reads energy bills, and only for people who can edit the deal", async () => {
    const { client } = await userAndClient(t, ["salesperson"]);
    const other = await userAndClient(t, ["salesperson"]);
    const { versionId } = await billVersion(client);
    expectStatus(await other.client.post(`/document-versions/${versionId}/read-bill`), 404);

    const loa = await billVersion(client, "letter_of_authority");
    const res = expectStatus(await client.post(`/document-versions/${loa.versionId}/read-bill`), 422);
    expect(res.body.issues).toEqual(["Only energy bills can be read this way."]);
  });

  it("says when AI reading isn't set up", async () => {
    const { client } = await userAndClient(t, ["salesperson"]);
    const { versionId } = await billVersion(client);
    reader.configured = false;
    try {
      const res = expectStatus(await client.post(`/document-versions/${versionId}/read-bill`), 422);
      expect(res.body.issues[0]).toMatch(/isn't set up yet/);
    } finally {
      reader.configured = true;
    }
  });
});
