/**
 * Where everything goes on the Flogas electricity Commercial Agreement Form and SEPA direct debit
 * mandate (654 × 901 pt, 2 pages). Every coordinate for this form lives here; `render.ts` decides
 * what goes in each box. Points are measured from the page's bottom-left corner, from the boxes and
 * labels pdf.js extracts from the supplier's PDF: a value starts just right of its printed label
 * and sits inside the printed box. docs/flogas-electricity.md lists the same mapping.
 *
 * A new revision of the supplier's PDF (a different SHA-256) needs measuring again and a new
 * `version`; generated versions record which layout they used.
 */

export interface Box {
  /** 0 = Commercial Agreement Form, 1 = SEPA direct debit mandate. */
  page: 0 | 1;
  x: number;
  y: number;
  w: number;
  h: number;
}

const p1 = (x: number, y: number, w: number, h: number): Box => ({ page: 0, x, y, w, h });
const p2 = (x: number, y: number, w: number, h: number): Box => ({ page: 1, x, y, w, h });
/** The printed tick boxes are 6.8 pt squares. */
const tick = (x: number, y: number): Box => p1(x, y, 6.8, 6.8);

/** Bottom edge of each row of the MPRN/MCC table on page 2 (22.7 pt rows). */
const METER_ROW_BOTTOMS = [317.5, 294.9, 272.2, 249.5, 226.8, 204.1, 181.5, 158.8, 136.1, 113.4, 90.8, 68.1];

export const FLOGAS_ELECTRICITY_LAYOUT = {
  workflow: "flogas_electricity",
  version: "2026-10-22.1",
  name: "Flogas electricity: Commercial Agreement Form + SEPA direct debit mandate",
  supplier: "Flogas",
  documentType: "application_form",
  /** SHA-256 of the supplier PDFs this layout was measured on. */
  sha256: ["ce44a25e157ba91ae6afc702db7b5d3df93d4e838162c940300a1720a2abd230"],
  pages: [
    { width: 654.283, height: 900.898 },
    { width: 654.283, height: 900.898 },
  ],

  /** One-line text values. */
  text: {
    // Page 1, left: to be completed by the customer
    legalName: p1(112, 719.5, 206, 16.5),
    tradingName: p1(106, 692.5, 212, 16.5),
    vatExemptNumber: p1(152, 482, 166, 13),
    businessType: p1(116, 409, 202, 16.5),
    companyRegVat: p1(140, 382, 178, 16.5),
    contactName: p1(148, 355.5, 170, 16.5),
    telephone: p1(115, 329, 203, 16.5),
    mobile: p1(102, 302, 216, 16.5),
    email: p1(87, 275, 231, 16.5),
    // "DURATION AT PREMISES: YEAR ___ MONTH ___ TERMS OF LEASE ___" and the landlord lines
    // (on the underscores after each label, baselines level with the label's)
    premisesYears: p1(163, 228.6, 18, 9),
    premisesMonths: p1(211, 228.6, 18, 9),
    leaseTerms: p1(288, 228.6, 30, 9),
    landlordName: p1(210, 217.2, 108, 9),
    landlordContact: p1(177, 205.7, 141, 9),
    // Unit rates, inside their printed boxes
    rate24hDay: p1(143, 119.3, 48.5, 9.7),
    rateNightSaverDay: p1(167.5, 106.4, 48.5, 9.7),
    rateNightSaverNight: p1(175, 93.4, 48.5, 9.7),
    // Page 1, right
    mprn: p1(342, 674, 186, 16),
    mccCode: p1(536, 674, 55, 16),
    existingAccount: p1(407, 631.5, 187, 17),
    readingDay: p1(380, 594.5, 214, 17),
    readingNight: p1(364, 569, 230, 17),
    readingWattless: p1(377, 544.5, 217, 17),
    readingDate: p1(399, 519.5, 195, 17),
    expectedChangeover: p1(449, 494.5, 145, 17),
    commitmentPeriod: p1(412, 469, 182, 17),
    signatoryName: p1(380, 347, 214, 19.5),
    signatoryPosition: p1(433, 322.5, 161, 17),
    agencyId: p1(416, 260.5, 178, 10),
    agencyName: p1(416, 245.5, 178, 10),
    agentName: p1(385, 177.5, 209, 14),
    flogasRepName: p1(406, 90, 181, 20),
    flogasActivationDate: p1(415, 63.5, 172, 16),
    // Page 2: SEPA direct debit mandate
    debtorName: p2(124, 692.5, 250, 19.5),
    mandateReference: p2(509, 692.5, 85, 19.5),
    iban: p2(139, 613.5, 455, 19.5),
    bic: p2(118, 585.5, 300, 19.5),
  },

  /** Text that flows across several printed lines (addresses). */
  lines: {
    supplyAddress: [p1(152, 669.5, 163, 11), p1(64, 649.8, 251, 11), p1(64, 630, 251, 11)],
    billingAddress: [p1(170, 597.8, 145, 11), p1(64, 578, 251, 11), p1(64, 558.3, 251, 11), p1(64, 538.5, 251, 11)],
    debtorAddress: [p2(137, 671.5, 457, 11), p2(67, 657, 527, 11), p2(67, 643, 527, 11)],
  },

  /** Tick boxes (an X is drawn in the box). */
  ticks: {
    entityCompany: tick(162.3, 518.4),
    entitySoleTrader: tick(239.2, 518.4),
    entityOther: tick(289.3, 518.4),
    vatExemptYes: tick(134, 503.7),
    vatExemptNo: tick(166.9, 503.7),
    priorityYes: tick(189.5, 467.3),
    priorityNo: tick(222.3, 467.3),
    ownsPremisesYes: tick(194.7, 241.2),
    ownsPremisesNo: tick(220.8, 241.2),
    sector24h: p1(92.1, 167.7, 13.9, 9.7),
    sectorNightSaver: p1(169.1, 167.7, 13.9, 9.7),
    sectorLvmd: p1(216, 167.7, 13.9, 9.7),
    pricingFixed: p1(85.1, 143.5, 22.4, 9.7),
    pricingVariable: p1(149.4, 143.5, 22.4, 9.7),
    requirementNewConnection: tick(400.9, 724.4),
    requirementCole: tick(441.5, 723.4),
    requirementRenewal: tick(490.2, 723.4),
    requirementReenergise: tick(407.1, 710.5),
    requirementChangeOfSupplier: tick(493, 710.5),
    existingCustomerYes: tick(471.6, 654.9),
    existingCustomerNo: tick(502.7, 654.9),
  },

  /** Signature images and the dates beside them. */
  signatures: {
    customer: p1(337, 427.5, 256, 23),
    customerDate: p1(360, 297.5, 234, 17),
    /** In the agency name / stamp box, below its label; only when the agent signs. */
    agent: p1(340, 205.5, 250, 30),
    mandate1: p2(113, 529.5, 310, 19.5),
    mandate1Date: p2(468, 529.5, 126, 19.5),
    mandate2: p2(113, 501, 310, 19.5),
    mandate2Date: p2(468, 501, 126, 19.5),
  },

  /** The MPRN/MCC and "Meter read: DAY/NIGHT" columns of the table on page 2. */
  meterRows: METER_ROW_BOTTOMS.map((bottom) => ({ mprn: p2(61, bottom + 1.5, 263, 19.5), reads: p2(330, bottom + 1.5, 263, 19.5) })),
} as const;

export type FlogasTextBox = keyof typeof FLOGAS_ELECTRICITY_LAYOUT.text;
export type FlogasLinesBox = keyof typeof FLOGAS_ELECTRICITY_LAYOUT.lines;
export type FlogasTickBox = keyof typeof FLOGAS_ELECTRICITY_LAYOUT.ticks;
