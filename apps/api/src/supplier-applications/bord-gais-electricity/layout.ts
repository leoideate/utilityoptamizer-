/**
 * The Bord Gáis Energy "Business Electricity Customer Agreement Form" (BGE/BE/CAF/FVS/0618, one A4
 * page). The PDF has its own AcroForm fields, so the CRM fills those by name. This file is the
 * only place that knows the PDF's field names: everything else uses the stable CRM keys below.
 * docs/bord-gais-electricity.md lists the same mapping and the fields that needed a visual check.
 *
 * A new revision of the form (a different SHA-256) needs checking again and a new `version`.
 */
import {
  BORD_GAIS_RATE_COLUMNS,
  BORD_GAIS_RATE_COLUMN_LABELS,
  BORD_GAIS_RATE_ROWS,
  BORD_GAIS_RATE_ROW_LABELS,
  BORD_GAIS_REGISTERS,
  BORD_GAIS_REGISTER_LABELS,
  type BordGaisDiscountCell,
  type BordGaisRateColumn,
  type BordGaisRateRow,
  type BordGaisRegister,
  type FormField,
  type FormSignerRole,
} from "@uo/shared";

/** Every widget on the page: [x, y, width, height] in PDF points from the bottom-left, read from the PDF. */
export const BGE_WIDGETS: Record<string, [number, number, number, number]> = {
  "Meter serial No 1": [363.2, 542.9, 100, 13.3],
  "Meter serial No 2": [470.3, 542.9, 100.1, 13.3],
  "M": [45.1, 532.8, 240, 20.2],
  "undefined": [363.2, 526.9, 71.9, 13.3],
  "undefined_2": [447.7, 526.9, 14.3, 13.3],
  "undefined_3": [468.5, 526.9, 71.9, 13.3],
  "undefined_4": [553, 526.9, 14.3, 13.3],
  "undefined_5": [363.2, 510.8, 71.9, 13.4],
  "undefined_6": [447.7, 510.8, 14.3, 13.4],
  "undefined_7": [468.5, 510.8, 71.9, 13.4],
  "undefined_8": [553, 510.8, 14.3, 13.4],
  "MICRow1": [24.2, 492.1, 50.4, 16.8],
  "DG codeRow1": [76.7, 492.1, 50.3, 16.8],
  "VoltageRow1": [129, 492.1, 50.3, 16.8],
  "MCCRow1": [181.3, 492.1, 50.4, 16.8],
  "Profile classRow1": [233.8, 492.1, 50.3, 16.8],
  "undefined_9": [363.2, 494.9, 71.9, 13.3],
  "undefined_10": [447.7, 494.9, 14.3, 13.3],
  "undefined_11": [468.5, 494.9, 71.9, 13.3],
  "undefined_12": [553, 494.9, 14.3, 13.3],
  "Night storage": [363.2, 478.9, 71.9, 13.3],
  "undefined_13": [447.7, 478.9, 14.3, 13.3],
  "undefined_14": [468.5, 478.9, 71.9, 13.3],
  "undefined_15": [553, 478.9, 14.3, 13.3],
  "undefined_16": [363.2, 462.8, 71.9, 13.4],
  "undefined_17": [447.7, 462.8, 14.3, 13.4],
  "undefined_18": [468.5, 462.8, 71.9, 13.4],
  "undefined_19": [553, 462.8, 14.3, 13.4],
  "Fixed Energy Rate": [526.2, 433.3, 9, 9],
  "Variable Rate": [526.9, 422, 7.6, 7.8],
  "Fully Fixed Rate": [526.9, 410, 7.6, 7.8],
  "24hr rate Block 1Energy Rate": [65.2, 324.6, 29.9, 15.6],
  "24hr rate Block 2Energy Rate": [97, 324.6, 29.8, 15.6],
  "Day rate Block 1Energy Rate": [128.6, 324.6, 29.9, 15.6],
  "Day rate Block 2Energy Rate": [160.4, 324.6, 29.9, 15.6],
  "Night rateEnergy Rate": [192.2, 324.6, 29.9, 15.6],
  "Night storage rateEnergy Rate": [224, 324.6, 29.8, 15.6],
  "Summer day rateEnergy Rate": [255.7, 324.6, 29.9, 15.6],
  "Winter day rateEnergy Rate": [287.5, 324.6, 29.9, 15.6],
  "Standing chargeEnergy Rate": [319.3, 324.6, 29.9, 15.6],
  "24hr rate Block 1Nonenergy Rate": [65.2, 307.6, 29.9, 15.6],
  "24hr rate Block 2Nonenergy Rate": [97, 307.6, 29.8, 15.6],
  "Day rate Block 1Nonenergy Rate": [128.6, 307.6, 29.9, 15.6],
  "Day rate Block 2Nonenergy Rate": [160.4, 307.6, 29.9, 15.6],
  "Night rateNonenergy Rate": [192.2, 307.6, 29.9, 15.6],
  "Night storage rateNonenergy Rate": [224, 307.6, 29.8, 15.6],
  "Summer day rateNonenergy Rate": [255.7, 307.6, 29.9, 15.6],
  "Winter day rateNonenergy Rate": [287.5, 307.6, 29.9, 15.6],
  "Standing chargeNonenergy Rate": [319.3, 307.6, 29.9, 15.6],
  "24hr rate Block 1Fully Fixed Rate": [65.2, 290.6, 29.9, 15.5],
  "24hr rate Block 2Fully Fixed Rate": [97, 290.6, 29.8, 15.5],
  "Day rate Block 1Fully Fixed Rate": [128.6, 290.6, 29.9, 15.5],
  "Day rate Block 2Fully Fixed Rate": [160.4, 290.6, 29.9, 15.5],
  "Night rateFully Fixed Rate": [192.2, 290.6, 29.9, 15.5],
  "Night storage rateFully Fixed Rate": [224, 290.6, 29.8, 15.5],
  "Summer day rateFully Fixed Rate": [255.7, 290.6, 29.9, 15.5],
  "Winter day rateFully Fixed Rate": [287.5, 290.6, 29.9, 15.5],
  "Standing chargeFully Fixed Rate": [319.3, 290.6, 29.9, 15.5],
  "24hr rate Block 1Variable Rate": [65.2, 273.6, 29.9, 15.6],
  "24hr rate Block 2Variable Rate": [97, 273.6, 29.8, 15.6],
  "Day rate Block 1Variable Rate": [128.6, 273.6, 29.9, 15.6],
  "Day rate Block 2Variable Rate": [160.4, 273.6, 29.9, 15.6],
  "Night rateVariable Rate": [192.2, 273.6, 29.9, 15.6],
  "Night storage rateVariable Rate": [224, 273.6, 29.8, 15.6],
  "Summer day rateVariable Rate": [255.7, 273.6, 29.9, 15.6],
  "Winter day rateVariable Rate": [287.5, 273.6, 29.9, 15.6],
  "Standing chargeVariable Rate": [319.3, 273.6, 29.9, 15.6],
  "12 monthsYear 1 discount": [444.1, 315.5, 40.4, 20.5],
  "24 monthsYear 1 discount": [486.7, 315.5, 40.3, 20.5],
  "36 monthsYear 1 discount": [529.2, 315.5, 40.3, 20.5],
  "12 monthsYear 2 discount": [444.1, 293.5, 40.4, 20.4],
  "24 monthsYear 2 discount": [486.7, 293.5, 40.3, 20.4],
  "36 monthsYear 2 discount": [529.2, 293.5, 40.3, 20.4],
  "12 monthsYear 3 discount": [444.1, 271.6, 40.4, 20.4],
  "24 monthsYear 3 discount": [486.7, 271.6, 40.3, 20.4],
  "36 monthsYear 3 discount": [529.2, 271.6, 40.3, 20.4],
  "EMAIL": [81.5, 185.2, 9, 9],
  "POST": [150.7, 185.2, 9, 9],
  "PHONE including mobile": [284.6, 185.2, 8.9, 9],
  "SMS": [362.9, 185.2, 9, 9],
  "of products and services and those offered by other recommended companies which may be of interest I would like to receive this": [417, 166.3, 9, 9],
  "Address 2": [304.2, 611.2, 266.5, 13.6],
  "Address 1": [304.2, 625.1, 266.5, 13.6],
  "Address": [304.8, 721, 266.5, 13.1],
  "Check Box31": [381.3, 592, 18, 18],
  "Text37": [91.3, 476.9, 194.5, 13.2],
  "Text38": [148.9, 462.5, 136.9, 12.5],
  "Check Box39": [172.8, 408.6, 18, 18],
  "Check Box40": [245.8, 408.3, 18, 18],
  "Check Box41": [320.7, 408.3, 18, 18],
  "Check Box42": [395.7, 408.3, 18, 18],
  "Text43": [462.9, 167.6, 108.1, 18.4],
  "Date44_es_:signer:date": [478, 208.2, 90.8, 14.5],
  "Signature45_es_:signer:signature": [290.3, 208.2, 162.8, 13.8],
  "Text46": [50.1, 208.2, 209.6, 14.5],
  "Signature51_es_:signer:signature": [423.5, 65.9, 150, 17.4],
  "Signature52_es_:signer:signature": [430, 46.9, 143.5, 17.7],
  "Date53_es_:signer:date": [469.3, 29.2, 104.2, 16.8],
  "Text 6": [72.2, 755.8, 216, 12.8],
  "Text 61": [117.4, 742.7, 170.9, 12.8],
  "Text 62": [119.3, 729.2, 168.9, 12.8],
  "Text 63": [72.2, 717.2, 216, 12.8],
  "Text 64": [81.9, 704.3, 80.6, 12.8],
  "Date32_es_:signer:date": [232, 705.3, 56.4, 10.2],
  "Check Box 78": [85.8, 688.4, 14.1, 13.1],
  "Check Box 9": [164, 688.1, 14.1, 13.1],
  "Check Box 12": [235.9, 688.1, 14.1, 13.1],
  "Check Box 79": [86, 670.9, 14.1, 13.1],
  "Check Box 10": [163.9, 670.8, 14.1, 13.1],
  "Text 66": [224.7, 667.9, 63.2, 12.8],
  "Check Box 8": [86, 652.4, 14.1, 13.1],
  "Check Box 13": [164.3, 651.7, 14.1, 13.1],
  "Text 65": [94, 636.9, 196.3, 12.8],
  "Text33": [85.7, 623.2, 205, 12.8],
  "Text36": [186.2, 610.1, 104.5, 11.9],
  "Text34": [59.2, 610.1, 102.2, 11.2],
  "Text611": [192, 596.1, 98.6, 12.8],
  "Text35": [66.4, 597, 94.4, 11.5],
  "Text 16": [355, 749.1, 216, 12.8],
  "Text 26": [355, 735, 216, 12.8],
  "Text 36": [366.2, 707.4, 205.3, 12.8],
  "Text 46": [351.2, 693.3, 92.8, 12.8],
  "Text 666": [471.4, 693.4, 100, 12.8],
  "Text 56": [330.3, 679.8, 115.1, 12.8],
  "Text 76": [474.3, 678.8, 97.1, 12.8],
  "Text612": [362, 652.5, 208.7, 12.8],
  "Text613": [354.7, 639.3, 216, 12.8],
  "Text47": [242.8, 100.2, 127.1, 14.8],
  "Text48": [55, 63.2, 314.6, 14.1],
  "Text49": [55, 45.9, 94.7, 13.2],
  "Date50_es_:signer:date": [317.8, 27.9, 51.5, 13.8],
  "Text78": [23.6, 9.9, 346, 13.8],
};

const PDF_RATE_COLUMN: Record<BordGaisRateColumn, string> = {
  rate24h1: "24hr rate Block 1",
  rate24h2: "24hr rate Block 2",
  day1: "Day rate Block 1",
  day2: "Day rate Block 2",
  night: "Night rate",
  nightStorage: "Night storage rate",
  summerDay: "Summer day rate",
  winterDay: "Winter day rate",
  standingCharge: "Standing charge",
};
const PDF_RATE_ROW: Record<BordGaisRateRow, string> = { energy: "Energy Rate", nonEnergy: "Nonenergy Rate", fullyFixed: "Fully Fixed Rate", variable: "Variable Rate" };
export const rateFieldId = (row: BordGaisRateRow, column: BordGaisRateColumn) => `rate_${row}_${column}`;

/** Reading rows: meter 1 before and after the slash, then meter 2 before and after it. */
const READING_FIELDS: Record<BordGaisRegister, [string, string, string, string]> = {
  "24h": ["undefined", "undefined_2", "undefined_3", "undefined_4"],
  day: ["undefined_5", "undefined_6", "undefined_7", "undefined_8"],
  night: ["undefined_9", "undefined_10", "undefined_11", "undefined_12"],
  night_storage: ["Night storage", "undefined_13", "undefined_14", "undefined_15"],
  wattless: ["undefined_16", "undefined_17", "undefined_18", "undefined_19"],
};
export const readingFieldId = (meter: 1 | 2, register: BordGaisRegister, part: "whole" | "tenth") => `meter${meter}_${register}_${part}`;

const DISCOUNT_FIELD: Record<BordGaisDiscountCell, string> = {
  y1_12: "12 monthsYear 1 discount",
  y1_24: "24 monthsYear 1 discount",
  y1_36: "36 monthsYear 1 discount",
  y2_24: "24 monthsYear 2 discount",
  y2_36: "36 monthsYear 2 discount",
  y3_36: "36 monthsYear 3 discount",
};
export const discountFieldId = (cell: BordGaisDiscountCell) => `discount_${cell}`;
/** Greyed out on the form: a 12-month plan has no year 2 or 3, a 24-month plan no year 3. Always blank. */
export const GREYED_DISCOUNT_FIELDS = ["12 monthsYear 2 discount", "12 monthsYear 3 discount", "24 monthsYear 3 discount"];

const BROADER_MARKETING = "of products and services and those offered by other recommended companies which may be of interest I would like to receive this";

export const BGE_LAYOUT = {
  workflow: "bord_gais_electricity",
  version: "2026-10-23.1",
  name: "Bord Gáis electricity: Business Electricity Customer Agreement Form + SEPA mandate",
  supplier: "Bord Gáis Energy",
  documentType: "application_form",
  sha256: ["7ae07d501d0413ab6c9474aa0549bac2dafff7c0ab8149e7f4619863443a404c"],
  pages: [{ width: 595.276, height: 841.89 }],
} as const;

type Extra = Partial<Pick<FormField, "comb" | "upper" | "fontSize">>;
const at = (pdfField: string) => {
  const r = BGE_WIDGETS[pdfField];
  if (!r) throw new Error(`No widget named ${pdfField} on the Bord Gáis form`);
  return { x: r[0], y: r[1], w: r[2], h: r[3] };
};
const text = (id: string, label: string, pdfField: string, extra: Extra = {}): FormField => ({ id, label, kind: "text", page: 0, ...at(pdfField), source: null, pdfField, ...extra });
const tick = (id: string, label: string, pdfField: string): FormField => ({ id, label, kind: "check", page: 0, ...at(pdfField), source: null, pdfField });
/** Drawn on the page: the form prints a line for these but has no field. */
const drawn = (id: string, label: string, x: number, y: number, w: number, h: number): FormField => ({ id, label, kind: "text", page: 0, x, y, w, h, source: null });
const sign = (id: string, label: string, pdfField: string, signer: FormSignerRole): FormField => ({ id, label, kind: "signature", page: 0, ...at(pdfField), source: null, pdfField, signer });
const signedDate = (id: string, label: string, pdfField: string, signer: FormSignerRole, extra: Extra = {}): FormField => ({ id, label, kind: "signed_date", page: 0, ...at(pdfField), source: null, pdfField, signer, ...extra });
const U = { upper: true } as const;

/** Every field the CRM fills, by its stable CRM key. Signature boxes are added per version for its signers. */
export function bgeFields(): FormField[] {
  return [
    // Step 1: account holder details
    text("account_legalName", "Legal name", "Text 6", U),
    text("account_tradingName", "Trading as", "Text 61", U),
    text("account_holderName", "Account holder's name", "Text 62", U),
    text("account_address", "Account holder's address", "Text 63", U),
    text("account_mainActivity", "Main activity", "Text 64", U),
    // Named like an e-sign date tag, but it is the date the business was established.
    text("account_dateEstablished", "Date established", "Date32_es_:signer:date"),
    tick("account_type_limited_company", "Organisation type: Limited Co.", "Check Box 78"),
    tick("account_type_plc", "Organisation type: Plc", "Check Box 9"),
    tick("account_type_state_body", "Organisation type: State Body", "Check Box 12"),
    tick("account_type_co_operative", "Organisation type: Co-operative", "Check Box 79"),
    tick("account_type_charity_club", "Organisation type: Association", "Check Box 10"),
    tick("account_type_sole_trader", "Organisation type: Sole Trader", "Check Box 8"),
    tick("account_type_partnership", "Organisation type: Partnership", "Check Box 13"),
    text("account_croNumber", "CRO number", "Text 66", U),
    drawn("account_employees", "No. of employees", 256, 652.5, 32, 12),
    text("account_homeAddress", "Home address", "Text 65", U),
    text("contact_name", "Contact name", "Text33", U),
    text("contact_position", "Position", "Text34", U),
    text("contact_email", "Email", "Text36"),
    text("contact_telephone", "Telephone", "Text35"),
    text("contact_mobile", "Mobile", "Text611"),
    // Premises to be supplied
    text("premises_siteName", "Site name", "Text 16", U),
    text("premises_address_1", "Supply address, line 1", "Text 26", U),
    text("premises_address_2", "Supply address, line 2", "Address", U),
    text("premises_contactName", "Premises contact name", "Text 36", U),
    text("premises_telephone", "Premises telephone", "Text 46"),
    text("premises_fax", "Premises fax", "Text 666"),
    text("premises_email", "Premises email", "Text 56"),
    text("premises_mobile", "Premises mobile", "Text 76"),
    tick("premises_priorityCustomer", "Priority customer", "Check Box31"),
    // Address to send the bill to
    text("billing_contactName", "Billing contact name", "Text612", U),
    text("billing_address_1", "Billing address, line 1", "Text613", U),
    text("billing_address_2", "Billing address, line 2", "Address 1", U),
    text("billing_address_3", "Billing address, line 3", "Address 2", U),
    // Step 2: supply details
    text("supply_mprn", "MPRN", "M", { comb: 11 }),
    text("supply_mic", "MIC", "MICRow1"),
    text("supply_dgCode", "DG code", "DG codeRow1", U),
    text("supply_voltage", "Voltage", "VoltageRow1", U),
    text("supply_mcc", "MCC", "MCCRow1", U),
    text("supply_profileClass", "Profile class", "Profile classRow1", U),
    text("supply_existingSupplier", "Existing supplier", "Text37", U),
    text("supply_annualConsumption", "Estimated annual consumption", "Text38"),
    // Step 3: meter details
    text("meter1_serial", "Meter serial no. 1", "Meter serial No 1", { comb: 9, upper: true }),
    text("meter2_serial", "Meter serial no. 2", "Meter serial No 2", { comb: 9, upper: true }),
    ...BORD_GAIS_REGISTERS.flatMap((r) => {
      const [m1, m1t, m2, m2t] = READING_FIELDS[r];
      const name = BORD_GAIS_REGISTER_LABELS[r];
      return [
        text(readingFieldId(1, r, "whole"), `Meter 1 ${name} reading`, m1, { comb: 5 }),
        text(readingFieldId(1, r, "tenth"), `Meter 1 ${name} reading, after the slash`, m1t, { comb: 1 }),
        text(readingFieldId(2, r, "whole"), `Meter 2 ${name} reading`, m2, { comb: 5 }),
        text(readingFieldId(2, r, "tenth"), `Meter 2 ${name} reading, after the slash`, m2t, { comb: 1 }),
      ];
    }),
    // Step 4: agreement period and rates
    drawn("agreement_pricePlan", "Price plan name", 100, 430, 124, 12),
    drawn("agreement_confirmationEndDate", "Confirmation period end date", 366, 430, 68, 12),
    tick("agreement_rateType_fixed", "Fixed Energy Rate", "Fixed Energy Rate"),
    // The template prints a tick inside the Fully Fixed Rate box; cover it so the form never shows
    // Fully Fixed unless it's chosen (the field's own "X" draws above the cover).
    { id: "agreement_fullyFixed_printedTick", label: "Cover the tick printed in the Fully Fixed Rate box", kind: "text", page: 0, x: 527.4, y: 410.5, w: 6.6, h: 6.8, source: null, mask: true },
    // These two are text fields on the form; a tick is written as "X".
    tick("agreement_rateType_variable", "Variable Rate", "Variable Rate"),
    tick("agreement_rateType_fully_fixed", "Fully Fixed Rate", "Fully Fixed Rate"),
    tick("agreement_commitment_12", "Commitment: 12 months", "Check Box39"),
    tick("agreement_commitment_18", "Commitment: 18 months", "Check Box40"),
    tick("agreement_commitment_24", "Commitment: 24 months", "Check Box41"),
    tick("agreement_commitment_36", "Commitment: 36 months", "Check Box42"),
    ...BORD_GAIS_RATE_ROWS.flatMap((row) =>
      BORD_GAIS_RATE_COLUMNS.map((col) => text(rateFieldId(row, col), `${BORD_GAIS_RATE_ROW_LABELS[row]}: ${BORD_GAIS_RATE_COLUMN_LABELS[col]}`, `${PDF_RATE_COLUMN[col]}${PDF_RATE_ROW[row]}`)),
    ),
    ...(Object.keys(DISCOUNT_FIELD) as BordGaisDiscountCell[]).map((cell) => text(discountFieldId(cell), `Discount: year ${cell[1]}, ${cell.split("_")[1]} months`, DISCOUNT_FIELD[cell])),
    ...GREYED_DISCOUNT_FIELDS.map((f, i) => text(`discount_greyed_${i + 1}`, `Discount (greyed out): ${f}`, f)),
    // Customer declaration, marketing and agent
    text("declaration_name", "Declaration: name", "Text46", U),
    // Ticked when the customer does NOT want offers that way ("Please tick these boxes if you do not want to receive these offers").
    tick("marketing_noEmail", "No offers by email", "EMAIL"),
    tick("marketing_noPost", "No offers by post", "POST"),
    tick("marketing_noPhone", "No offers by phone (including mobile)", "PHONE including mobile"),
    tick("marketing_noSms", "No offers by SMS", "SMS"),
    // Ticked when the customer DOES want broader marketing ("I would like to receive this").
    tick("marketing_broader", "Would like broader marketing", BROADER_MARKETING),
    text("agent_name", "Agent's name", "Text43", U),
    // SEPA direct debit mandate (the IBAN, BIC and date boxes are printed but the fields aren't combed)
    text("directDebit_mandateReference", "Unique mandate reference", "Text47", U),
    text("directDebit_iban", "IBAN", "Text48", { comb: 36 }),
    text("directDebit_bic", "BIC", "Text49", { comb: 11 }),
    text("directDebit_accountHolder", "Bank account holder name", "Text78", U),
  ];
}

/** Signature and signed-date fields for the signers a version needs. */
export function bgeSignatureFields(signers: FormSignerRole[], directDebit: boolean): FormField[] {
  const out: FormField[] = [
    sign("customer_signature", "Customer declaration: signature", "Signature45_es_:signer:signature", "customer"),
    signedDate("customer_signatureDate", "Customer declaration: date", "Date44_es_:signer:date", "customer"),
  ];
  if (directDebit) {
    out.push(sign("directDebit_signature", "Mandate: signature", "Signature51_es_:signer:signature", "customer"));
    out.push(signedDate("directDebit_date", "Mandate: date (boxes)", "Date50_es_:signer:date", "customer", { comb: 6 }));
    out.push(signedDate("directDebit_signatureDate", "Mandate: date of signature", "Date53_es_:signer:date", "customer"));
    if (signers.includes("account_holder_2")) out.push(sign("directDebit_secondSignature", "Mandate: 2nd signature", "Signature52_es_:signer:signature", "account_holder_2"));
  }
  return out;
}

/** The PDF's signature and signing-date fields: always on the page, filled only when signed. */
export const BGE_SIGNATURE_PDF_FIELDS = [
  "Signature45_es_:signer:signature",
  "Date44_es_:signer:date",
  "Signature51_es_:signer:signature",
  "Signature52_es_:signer:signature",
  "Date50_es_:signer:date",
  "Date53_es_:signer:date",
];
