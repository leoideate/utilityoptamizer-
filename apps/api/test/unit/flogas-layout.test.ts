import { PDFDocument, StandardFonts } from "pdf-lib";
import { type FormField, flogasSigners } from "@uo/shared";
import { fillPdf } from "../../src/forms/pdf";
import { FLOGAS_ELECTRICITY_LAYOUT as L } from "../../src/supplier-applications/flogas-electricity/layout";
import { flogasLayoutFields, flowLines, renderFlogasElectricity } from "../../src/supplier-applications/flogas-electricity/render";
import { flogasDemo } from "../support/flogas";
import { png } from "../support/forms";

/** A blank stand-in for the Flogas PDF (same page size and count); the real one isn't in the repository. */
async function blankFlogasPdf() {
  const doc = await PDFDocument.create();
  for (const p of L.pages) doc.addPage([p.width, p.height]);
  return doc.save();
}

const overlaps = (a: FormField, b: FormField) => a.page === b.page && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("Flogas electricity layout", () => {
  const fields = flogasLayoutFields();

  it("keeps every box inside its page", () => {
    for (const f of fields) {
      const page = L.pages[f.page];
      expect({ id: f.id, inside: f.x >= 0 && f.y >= 0 && f.x + f.w <= page.width && f.y + f.h <= page.height }).toEqual({ id: f.id, inside: true });
    }
  });

  it("never lets two boxes overlap", () => {
    const clashes: string[] = [];
    fields.forEach((a, i) => fields.slice(i + 1).forEach((b) => overlaps(a, b) && clashes.push(`${a.id} / ${b.id}`)));
    expect(clashes).toEqual([]);
  });

  it("has unique field ids the template schema accepts", () => {
    expect(new Set(fields.map((f) => f.id)).size).toBe(fields.length);
    for (const f of fields) expect(f.id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
  });
});

describe("Flogas electricity: CRM data onto the form", () => {
  it("fills every box a complete application uses", async () => {
    const d = flogasDemo({ flogasRepName: "Flogas Rep", flogasActivationDate: "2026-11-20" });
    const r = await renderFlogasElectricity(d, flogasSigners(d));
    expect(r.issues).toEqual([]);
    const filled = new Set(Object.entries(r.values).filter(([, v]) => v !== false && v !== null && v !== undefined && v !== "").map(([k]) => k));
    const text = r.fields.filter((f) => f.kind === "text").map((f) => f.id);
    // Night Saver leaves the 24-hour rate blank; the debtor address needs two of its three lines.
    expect(text.filter((id) => !filled.has(id))).toEqual(["rate24hDay", "debtorAddress_3"]);
    expect(r.values).toMatchObject({
      legalName: "O'SULLIVAN & FITZGERALD HOSPITALITY GROUP LIMITED",
      tradingName: "THE HARBOURVIEW HOTEL & CONFERENCE CENTRE",
      companyRegVat: "654321 / IE6543210W",
      contactName: "SIOBHÁN NÍ FHLOINN-FITZGERALD",
      email: "siobhan.nifhloinn@harbourviewhotel.ie",
      premisesYears: "7",
      leaseTerms: "10 YEARS",
      mprn: "10012345670",
      mccCode: "MCC10",
      existingAccount: "GPRN 1234567 / ACC 900123",
      readingDay: "123456",
      readingNight: "65432",
      readingWattless: "1234",
      readingDate: "01/10/2026",
      expectedChangeover: "15/11/2026",
      commitmentPeriod: "24 MONTHS",
      rateNightSaverDay: "21.45",
      rateNightSaverNight: "12.37",
      iban: "IE29 AIBK 9311 5212 3456 78",
      bic: "AIBKIE2D",
      mandateReference: "FLG-MND-0004521",
      flogasActivationDate: "20/11/2026",
    });
  });

  it("ticks exactly the boxes the answers choose", async () => {
    const ticked = async (over: Parameters<typeof flogasDemo>[0]) => {
      const r = await renderFlogasElectricity(flogasDemo(over), ["customer"]);
      return Object.keys(L.ticks).filter((k) => r.values[k] === true);
    };
    expect(await ticked({})).toEqual(["entityCompany", "vatExemptYes", "priorityNo", "ownsPremisesNo", "sectorNightSaver", "pricingFixed", "requirementRenewal", "requirementChangeOfSupplier", "existingCustomerYes"]);
    expect(
      await ticked({
        legalEntity: "partnership",
        vatExempt: false,
        priorityCustomer: true,
        occupancyType: "owner_occupied",
        sector: "lvmd",
        priceType: "variable",
        requirements: ["new_connection", "change_of_legal_entity", "reenergise_meter"],
        existingFlogasCustomer: false,
      }),
    ).toEqual(["entityOther", "vatExemptNo", "priorityYes", "ownsPremisesYes", "sectorLvmd", "pricingVariable", "requirementNewConnection", "requirementCole", "requirementReenergise", "existingCustomerNo"]);
    // Unanswered yes/no questions leave both boxes empty rather than guessing.
    expect(await ticked({ legalEntity: null, vatExempt: null, priorityCustomer: null, occupancyType: null, sector: null, priceType: null, requirements: [], existingFlogasCustomer: null })).toEqual([]);
    expect(await ticked({ legalEntity: "sole_trader" })).toContain("entitySoleTrader");
  });

  it("leaves conditional boxes blank when their answer doesn't need them", async () => {
    const r = await renderFlogasElectricity(
      flogasDemo({ vatExempt: false, occupancyType: "owner_occupied", existingFlogasCustomer: false, billingSameAsSupply: true, directDebit: false, sector: "gp_24h", dayRateCent: 19.9 }),
      ["customer"],
    );
    for (const id of ["vatExemptNumber", "leaseTerms", "landlordName", "landlordContact", "existingAccount", "billingAddress_1", "debtorName", "iban", "bic", "debtorAddress_1", "mandateReference", "rateNightSaverDay"]) {
      expect({ id, value: r.values[id] }).toEqual({ id, value: undefined });
    }
    expect(r.values.rate24hDay).toBe("19.90");
    expect(r.fields.some((f) => f.id === "mandateSignature1")).toBe(false);
  });

  it("wraps addresses over the printed lines and keeps an Eircode together", async () => {
    const r = await renderFlogasElectricity(flogasDemo(), ["customer"]);
    const billing = [1, 2, 3, 4].map((i) => r.values[`billingAddress_${i}`]);
    expect(billing.join(" ")).toBe("ACCOUNTS PAYABLE DEPARTMENT, SECOND FLOOR, BLOCK C, CENTRAL PARK, LEOPARDSTOWN, DUBLIN 18, CO. DUBLIN, D18\u00a0R2T5");
    expect(billing.every((l) => typeof l === "string" && l.length > 0)).toBe(true);
    expect(r.values.supplyAddress_3).toMatch(/D12\u00a0X7Y9$/);
    expect(r.fields.find((f) => f.id === "supplyAddress_1")!.fontSize).toBeGreaterThanOrEqual(6);
  });

  it("reports an address too long for the form instead of clipping it", async () => {
    const long = "Very Long Street Name ".repeat(20);
    const r = await renderFlogasElectricity(flogasDemo({ supplyAddress: { line1: long, line2: null, city: "Cork", county: null, postcode: null } }), ["customer"]);
    expect(r.issues).toEqual(["The supply address is too long for the form. Shorten it."]);
    expect(r.values.supplyAddress_1).toBeUndefined();
  });

  it("flows text at the largest size that fits", async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const boxes = [{ page: 0 as const, x: 0, y: 0, w: 100, h: 10 }];
    expect(flowLines(font, "SHORT", boxes)).toEqual({ lines: ["SHORT"], size: 9 });
    expect(flowLines(font, "A LONGER LINE OF TEXT", boxes)!.size).toBeLessThan(9);
    expect(flowLines(font, "WAY TOO MUCH TEXT FOR A SINGLE NARROW LINE AT ANY SIZE", boxes)).toBeNull();
  });

  it("puts every meter on the page 2 table", async () => {
    const r = await renderFlogasElectricity(flogasDemo(), ["customer"]);
    expect(r.values.meterMprn_1).toBe("10012345670 / MCC10");
    expect(r.values.meterReads_1).toBe("123456 / 65432");
    expect(r.values.meterMprn_12).toBe("10012357891 / MCC02");
    const two = await renderFlogasElectricity(flogasDemo({ meters: flogasDemo().meters.slice(0, 2).map((m) => ({ ...m, night: null })) }), ["customer"]);
    expect(two.values.meterReads_2).toBe("123557");
    expect(two.values.meterMprn_3).toBeUndefined();
  });

  it("adds signature boxes only for the signers this application needs", async () => {
    const ids = async (signers: Parameters<typeof renderFlogasElectricity>[1], directDebit = true) =>
      (await renderFlogasElectricity(flogasDemo({ directDebit }), signers)).fields.filter((f) => f.kind === "signature" || f.kind === "signed_date").map((f) => `${f.id}:${f.signer}`);
    expect(await ids(["customer"])).toEqual(["customerSignature:customer", "customerDate:customer", "mandateSignature1:customer", "mandateDate1:customer"]);
    expect(await ids(["customer", "account_holder_2", "broker"])).toEqual([
      "customerSignature:customer",
      "customerDate:customer",
      "mandateSignature1:customer",
      "mandateDate1:customer",
      "mandateSignature2:account_holder_2",
      "mandateDate2:account_holder_2",
      "agentSignature:broker",
    ]);
    expect(await ids(["customer"], false)).toEqual(["customerSignature:customer", "customerDate:customer"]);
  });

  it("produces a two-page PDF that passes the quality check, signed and unsigned", async () => {
    const d = flogasDemo();
    const signers = flogasSigners(d);
    const r = await renderFlogasElectricity(d, signers);
    const template = await blankFlogasPdf();
    const unsigned = await fillPdf({ template, fields: r.fields, values: r.values, title: "test" });
    expect(unsigned.issues).toEqual([]);
    expect((await PDFDocument.load(unsigned.bytes)).getPageCount()).toBe(2);
    const sig = png(80, 20);
    const signed = await fillPdf({
      template,
      fields: r.fields,
      values: r.values,
      signatures: { customer: sig, account_holder_2: sig, broker: sig },
      signedDates: { customer: "22/10/2026", account_holder_2: "23/10/2026" },
      requireSignatures: true,
      title: "test",
    });
    expect(signed.issues).toEqual([]);
    const missing = await fillPdf({ template, fields: r.fields, values: r.values, signatures: { customer: sig }, requireSignatures: true, title: "test" });
    expect(missing.issues).toEqual(expect.arrayContaining(['"Direct debit mandate: second account holder\'s signature" has no signature.', '"Agent signature" has no signature.']));
  });

  it("reports text too long for its box", async () => {
    const r = await renderFlogasElectricity(flogasDemo({ landlordName: "Ballymount Property Holdings Designated Activity Company" }), ["customer"]);
    const filled = await fillPdf({ template: await blankFlogasPdf(), fields: r.fields, values: r.values, title: "test" });
    expect(filled.issues).toEqual(['The value for "Landlord / agent name" is too long for its box. Shorten it or widen the box in the template.']);
  });
});
