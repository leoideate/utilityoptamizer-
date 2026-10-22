import { type BordGaisElectricityData, EMPTY_ADDRESS, emptyRates } from "@uo/shared";

/**
 * A realistic, deliberately demanding Bord Gáis application: long names, both meters with every
 * register (leading zeroes and a digit after the slash), a full rate table and a joint account.
 */
export function bordGaisDemo(over: Partial<BordGaisElectricityData> = {}): BordGaisElectricityData {
  const rates = emptyRates();
  rates.energy = { rate24h1: null, rate24h2: null, day1: 21.45, day2: 19.9, night: 12.37, nightStorage: 10.05, summerDay: 20.5, winterDay: 22.75, standingCharge: 55.12 };
  rates.nonEnergy = { rate24h1: null, rate24h2: null, day1: 3.21, day2: 3.21, night: 1.84, nightStorage: 1.84, summerDay: 3.1, winterDay: 3.3, standingCharge: 12.5 };
  return {
    legalName: "O'Sullivan & Fitzgerald Hospitality Group Limited",
    tradingName: "The Harbourview Hotel & Conference Centre",
    accountHolderName: "O'Sullivan & Fitzgerald Hospitality Group Ltd",
    accountAddress: { line1: "Harbour Road", line2: null, city: "Howth", county: "Co. Dublin", postcode: "D13 X2Y3" },
    mainActivity: "Hotel",
    dateEstablished: "2009-06-15",
    organisationType: "limited_company",
    croNumber: "456789",
    employees: 85,
    homeAddress: { ...EMPTY_ADDRESS },
    contactFirstName: "Siobhán",
    contactLastName: "Ní Fhloinn",
    position: "Finance Director",
    email: "siobhan@harbourview.example",
    telephone: "01 832 1234",
    mobile: "087 123 4567",
    siteName: "The Harbourview Hotel",
    supplyAddress: { line1: "Harbour Road", line2: "West Pier", city: "Howth", county: "Co. Dublin", postcode: "D13 X2Y3" },
    premisesContactName: "Declan Fitzgerald",
    premisesTelephone: "01 832 9999",
    premisesFax: "01 832 9998",
    premisesEmail: "facilities@harbourview.example",
    premisesMobile: "086 765 4321",
    priorityCustomer: false,
    billingContactName: "Accounts Payable",
    billingSource: "separate",
    billingAddress: { line1: "Accounts Payable, Second Floor", line2: "Block C, Central Park", city: "Leopardstown", county: "Dublin 18", postcode: "D18 R2T5" },
    mprn: "10012345678",
    mprnFormatException: false,
    mic: 250,
    dgCode: "DG6",
    voltage: "MV",
    mcc: "MCC12",
    profileClass: "2",
    existingSupplier: "Electric Ireland",
    annualConsumptionKwh: 845000,
    meters: [
      { serial: "000123456", readings: { "24h": null, day: "01234.5", night: "00987", night_storage: "00456.7", wattless: "00012" } },
      { serial: "AB9876543", readings: { "24h": null, day: "54321", night: "00321.9", night_storage: null, wattless: null } },
    ],
    readingDate: "2026-10-01",
    pricePlan: "Business Fixed Energy 24",
    startDate: "2026-11-01",
    confirmationEndDate: null,
    commitmentMonths: 24,
    rateType: "fixed",
    rates,
    discounts: { y1_12: null, y1_24: null, y1_36: null, y2_24: null, y2_36: null, y3_36: null },
    signatoryName: "Siobhán Ní Fhloinn",
    marketing: { email: false, post: true, phone: false, sms: true },
    broaderMarketing: true,
    agentName: "Aamir Noshad",
    directDebit: true,
    mandateReference: "BGE-0004521",
    bankAccountName: "O'Sullivan & Fitzgerald Hospitality Group Ltd",
    iban: "IE29AIBK93115212345678",
    bic: "AIBKIE2D",
    bankOnFile: true,
    bicOnFile: true,
    ibanLast4: "5678",
    secondAccountHolder: { name: "Declan Fitzgerald", email: "declan@harbourview.example" },
    ...over,
  };
}

/** Checkboxes on the real form whose on-state is "On" (the others use "Yes"). */
const ON_STATE_ON = ["Fixed Energy Rate", "EMAIL", "POST", "PHONE including mobile", "SMS", "of products and services and those offered by other recommended companies which may be of interest I would like to receive this"];
/** Fields the real form defines as tick boxes; every other field is text. */
const CHECKBOXES = ["Check Box 78", "Check Box 9", "Check Box 12", "Check Box 79", "Check Box 10", "Check Box 8", "Check Box 13", "Check Box31", "Check Box39", "Check Box40", "Check Box41", "Check Box42", ...ON_STATE_ON];
/** Fields the real form leaves without a default appearance. */
const NO_DEFAULT_APPEARANCE = ["Address", "Address 1"];

/**
 * A stand-in for the Bord Gáis PDF (which isn't in the repository): one A4 page with all 132 fields
 * under their real names, rectangles and types, the same tick-box on-states and the same two fields
 * without a default appearance. `extraField` adds a field the CRM doesn't know about.
 */
export async function bordGaisStandInPdf(opts: { extraField?: string } = {}) {
  const { PDFDocument, PDFDict, PDFName } = await import("pdf-lib");
  const { BGE_WIDGETS } = await import("../../src/supplier-applications/bord-gais-electricity/layout");
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.276, 841.89]);
  const form = doc.getForm();
  const names = Object.keys(BGE_WIDGETS);
  if (opts.extraField) names.push(opts.extraField);
  for (const name of names) {
    const [x, y, width, height] = BGE_WIDGETS[name] ?? [20, 20, 50, 12];
    if (CHECKBOXES.includes(name)) {
      const box = form.createCheckBox(name);
      box.addToPage(page, { x, y, width, height });
      if (ON_STATE_ON.includes(name)) {
        // Rename the on-state "Yes" → "On" in the widget's appearances, as on the real form.
        const ap = box.acroField.getWidgets()[0].dict.lookup(PDFName.of("AP"), PDFDict);
        for (const key of ["N", "D"]) {
          const states = ap.lookupMaybe(PDFName.of(key), PDFDict);
          const yes = states?.get(PDFName.of("Yes"));
          if (states && yes) {
            states.set(PDFName.of("On"), yes);
            states.delete(PDFName.of("Yes"));
          }
        }
      }
    } else {
      const field = form.createTextField(name);
      field.addToPage(page, { x, y, width, height });
      if (NO_DEFAULT_APPEARANCE.includes(name)) field.acroField.dict.delete(PDFName.of("DA"));
    }
  }
  return Buffer.from(await doc.save());
}
