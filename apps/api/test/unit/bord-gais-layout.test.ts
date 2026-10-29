import { readFileSync } from "node:fs";
import { PDFCheckBox, PDFDocument, PDFName, PDFTextField } from "pdf-lib";
import { BORD_GAIS_REGISTERS, type BordGaisElectricityData, bordGaisSigners, formFieldSchema } from "@uo/shared";
import { fillAcroForm } from "../../src/forms/acroform";
import { BGE_SIGNATURE_PDF_FIELDS, BGE_WIDGETS, bgeFields, bgeSignatureFields } from "../../src/supplier-applications/bord-gais-electricity/layout";
import { renderBordGaisElectricity } from "../../src/supplier-applications/bord-gais-electricity/render";
import { bordGaisDemo, bordGaisStandInPdf } from "../support/bord-gais";
import { png } from "../support/forms";

// Filling a 132-field PDF takes a few seconds when the suite runs in parallel.
jest.setTimeout(30_000);

const render = (over: Partial<BordGaisElectricityData> = {}) => {
  const d = bordGaisDemo(over);
  return renderBordGaisElectricity(d, bordGaisSigners(d));
};
async function fill(over: Partial<BordGaisElectricityData> = {}, opts: { signed?: boolean; template?: Buffer } = {}) {
  const d = bordGaisDemo(over);
  const signers = bordGaisSigners(d);
  const r = await renderBordGaisElectricity(d, signers);
  const sig = png(80, 20);
  const filled = await fillAcroForm({
    template: opts.template ?? (await bordGaisStandInPdf()),
    fields: r.fields,
    values: r.values,
    untouched: r.untouched,
    title: "test",
    ...(opts.signed ? { signatures: Object.fromEntries(signers.map((s) => [s, sig])), signedDates: Object.fromEntries(signers.map((s) => [s, "23/10/2026"])), requireSignatures: true, flatten: true } : {}),
  });
  return { r, filled, doc: await PDFDocument.load(filled.bytes) };
}

describe("Bord Gáis electricity mapping", () => {
  const all = [...bgeFields(), ...bgeSignatureFields(["customer", "account_holder_2"], true)];

  it("maps every one of the 132 PDF fields exactly once", () => {
    const pdfFields = all.flatMap((f) => (f.pdfField ? [f.pdfField] : []));
    expect(new Set(pdfFields).size).toBe(pdfFields.length);
    expect(Object.keys(BGE_WIDGETS)).toHaveLength(132);
    expect([...pdfFields].sort()).toEqual(Object.keys(BGE_WIDGETS).sort());
    expect(BGE_SIGNATURE_PDF_FIELDS.every((f) => pdfFields.includes(f))).toBe(true);
  });

  it("uses stable, valid CRM keys and keeps every box on the page", () => {
    expect(new Set(all.map((f) => f.id)).size).toBe(all.length);
    for (const f of all) {
      expect(() => formFieldSchema.parse(f)).not.toThrow();
      expect(f.x >= 0 && f.y >= 0 && f.x + f.w <= 595.3 && f.y + f.h <= 841.9).toBe(true);
    }
  });
});

describe("Bord Gáis electricity: CRM values onto the form", () => {
  it("puts each value in its field", async () => {
    const { values, issues } = await render();
    expect(issues).toEqual([]);
    expect(values).toMatchObject({
      account_legalName: "O'SULLIVAN & FITZGERALD HOSPITALITY GROUP LIMITED",
      account_holderName: "O'SULLIVAN & FITZGERALD HOSPITALITY GROUP LTD",
      account_dateEstablished: "15/06/2009",
      account_type_limited_company: true,
      account_type_plc: false,
      account_croNumber: "456789",
      account_employees: "85",
      account_homeAddress: "", // a company's form doesn't take a home address
      contact_name: "SIOBHÁN NÍ FHLOINN",
      premises_contactName: "DECLAN FITZGERALD",
      premises_fax: "01 832 9998",
      billing_address_1: "ACCOUNTS PAYABLE, SECOND FLOOR, BLOCK",
      supply_mprn: "10012345678",
      supply_annualConsumption: "845,000 kWh",
      meter1_serial: "000123456",
      meter2_serial: "AB9876543",
      meter1_day_whole: "01234",
      meter1_day_tenth: "5",
      meter2_night_whole: "00321",
      meter2_night_tenth: "9",
      meter1_24h_whole: "",
      agreement_pricePlan: "Business Fixed Energy 24",
      agreement_confirmationEndDate: "Oct-2028",
      agreement_rateType_fixed: true,
      agreement_rateType_variable: false,
      agreement_commitment_24: true,
      rate_energy_day1: "21.45",
      rate_nonEnergy_standingCharge: "12.50",
      rate_variable_day1: "",
      directDebit_iban: "IE29AIBK93115212345678",
      directDebit_bic: "AIBKIE2D",
      directDebit_mandateReference: "BGE-0004521",
    });
  });

  it("keeps the form's meaning for marketing: the four boxes are opt-outs, the broader one an opt-in", async () => {
    const { values } = await render({ marketing: { email: false, post: true, phone: null, sms: false }, broaderMarketing: false });
    expect(values).toMatchObject({ marketing_noEmail: true, marketing_noPost: false, marketing_noPhone: false, marketing_noSms: true, marketing_broader: false });
    expect((await render({ broaderMarketing: true })).values.marketing_broader).toBe(true);
  });

  it("fills discounts only for a variable rate, never in the greyed-out cells", async () => {
    const discounts = { y1_12: 5, y1_24: 6, y1_36: 7, y2_24: 3, y2_36: 4, y3_36: 2 };
    expect((await render({ discounts })).values.discount_y1_12).toBe("");
    const variable = (await render({ rateType: "variable", discounts })).values;
    expect(variable).toMatchObject({ discount_y1_12: "5%", discount_y2_36: "4%", discount_y3_36: "2%", discount_greyed_1: "", discount_greyed_2: "", discount_greyed_3: "", agreement_rateType_variable: true });
  });

  it("prints the home address for a sole trader and leaves the mandate blank without direct debit", async () => {
    const sole = (await render({ organisationType: "sole_trader", homeAddress: { line1: "4 Oak Park", line2: null, city: "Naas", county: null, postcode: null } })).values;
    expect(sole).toMatchObject({ account_type_sole_trader: true, account_homeAddress: "4 OAK PARK, NAAS" });
    const noDd = await render({ directDebit: false });
    expect(noDd.values).toMatchObject({ directDebit_iban: "", directDebit_bic: "", directDebit_accountHolder: "", directDebit_mandateReference: "" });
    expect(noDd.fields.some((f) => f.pdfField === "Signature51_es_:signer:signature")).toBe(false);
    expect(noDd.untouched).toEqual(["Signature51_es_:signer:signature", "Signature52_es_:signer:signature", "Date50_es_:signer:date", "Date53_es_:signer:date"]);
  });

  it("reports an address too long for its lines", async () => {
    const { issues } = await render({ supplyAddress: { line1: "Very Long Street Name ".repeat(15), line2: null, city: "Cork", county: null, postcode: null } });
    expect(issues).toEqual(["The supply address is too long for the form. Shorten it."]);
  });
});

describe("Bord Gáis electricity: the filled PDF", () => {
  it("fills the PDF's own fields, keeps them fillable and shows every value", async () => {
    const { r, filled, doc } = await fill();
    expect(filled.issues).toEqual([]);
    const form = doc.getForm();
    expect(form.getFields()).toHaveLength(132);
    expect(doc.getPageCount()).toBe(1);
    for (const f of r.fields) {
      if (!f.pdfField || f.kind === "signature" || f.kind === "signed_date") continue;
      const field = form.getField(f.pdfField);
      const want = r.values[f.id];
      if (field instanceof PDFCheckBox) expect({ field: f.pdfField, on: field.isChecked() }).toEqual({ field: f.pdfField, on: want === true });
      else if (f.kind === "check") expect({ field: f.pdfField, text: (field as PDFTextField).getText() ?? "" }).toEqual({ field: f.pdfField, text: want ? "X" : "" });
      else expect({ field: f.pdfField, text: (field as PDFTextField).getText() ?? "" }).toEqual({ field: f.pdfField, text: want });
    }
  });

  it("ticks boxes with each box's own export value", async () => {
    const { doc } = await fill({ marketing: { email: false, post: true, phone: true, sms: true } });
    const as = (name: string) => (doc.getForm().getField(name) as PDFCheckBox).acroField.getWidgets()[0].dict.get(PDFName.of("AS"))?.toString();
    expect(as("EMAIL")).toBe("/On");
    expect(as("Fixed Energy Rate")).toBe("/On");
    expect(as("Check Box 78")).toBe("/Yes");
    expect(as("Check Box41")).toBe("/Yes");
    expect(as("POST")).toBe("/Off");
    expect(as("Check Box39")).toBe("/Off");
  });

  it("makes the IBAN, BIC and boxed date comb fields so each character sits in a printed box", async () => {
    const { doc } = await fill({}, {});
    const iban = doc.getForm().getTextField("Text48");
    expect([iban.isCombed(), iban.getMaxLength()]).toEqual([true, 36]);
    const bic = doc.getForm().getTextField("Text49");
    expect([bic.isCombed(), bic.getMaxLength()]).toEqual([true, 11]);
  });

  it("builds a flattened signed copy with the signatures and dates", async () => {
    const { filled, doc } = await fill({}, { signed: true });
    expect(filled.issues).toEqual([]);
    expect(doc.getForm().getFields()).toHaveLength(0);
    expect(doc.getPageCount()).toBe(1);
  });

  it("refuses a signed copy with a signature missing", async () => {
    const d = bordGaisDemo();
    const r = await renderBordGaisElectricity(d, bordGaisSigners(d));
    const filled = await fillAcroForm({ template: await bordGaisStandInPdf(), fields: r.fields, values: r.values, untouched: r.untouched, signatures: { customer: png(80, 20) }, requireSignatures: true, flatten: true, title: "t" });
    expect(filled.issues).toContain('"Mandate: 2nd signature" has no signature.');
  });

  it("catches a revision of the form with a field the CRM doesn't know", async () => {
    const { filled } = await fill({}, { template: await bordGaisStandInPdf({ extraField: "Text 999" }) });
    expect(filled.issues).toEqual(['The PDF has a field the CRM doesn\'t fill ("Text 999"). Check the form\'s layout.']);
  });

  it("reports values too long for their boxes instead of clipping them", async () => {
    const { filled } = await fill({ meters: [{ serial: "1234567890", readings: Object.fromEntries(BORD_GAIS_REGISTERS.map((r) => [r, null])) as never }, bordGaisDemo().meters[1]] });
    expect(filled.issues).toContain('"Meter serial no. 1" has room for 9 characters but the value has 10.');
  });

  // The real PDF isn't in the repository. With BORD_GAIS_PDF pointing at it, check the stand-in
  // still matches it field for field, and fill the real one too.
  const realPdf = process.env.BORD_GAIS_PDF;
  (realPdf ? it : it.skip)("matches the real Bord Gáis PDF (BORD_GAIS_PDF)", async () => {
    const real = await PDFDocument.load(readFileSync(realPdf!));
    const stand = await PDFDocument.load(await bordGaisStandInPdf());
    const describe = (doc: PDFDocument) =>
      doc
        .getForm()
        .getFields()
        .map((f) => `${f.getName()}:${f instanceof PDFCheckBox ? `check:${f.acroField.getOnValue()?.toString()}` : "text"}`)
        .sort();
    expect(describe(stand)).toEqual(describe(real));
    const { filled } = await fill({}, { template: readFileSync(realPdf!), signed: true });
    expect(filled.issues).toEqual([]);
  });
});
