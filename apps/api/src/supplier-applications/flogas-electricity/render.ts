import { PDFDocument, type PDFFont, StandardFonts } from "pdf-lib";
import {
  type FlogasAddress,
  type FlogasElectricityData,
  type FlogasRequirement,
  type FlogasSector,
  type FormField,
  type FormSignerRole,
  addressText,
  contactFullName,
  durationAtPremises,
  effectiveDebtorAddress,
  flogasEntityBox,
  isFixedPrice,
  ownsPremises,
} from "@uo/shared";
import type { FillValue } from "../../forms/pdf";
import { type Box, FLOGAS_ELECTRICITY_LAYOUT as L, type FlogasLinesBox, type FlogasTextBox, type FlogasTickBox } from "./layout";

/** How each box is named in quality-check messages and the template editor. */
const TEXT_LABELS: Record<FlogasTextBox, string> = {
  legalName: "Legal entity",
  tradingName: "Trading as",
  vatExemptNumber: "VAT exempt number",
  businessType: "Business type",
  companyRegVat: "Company reg / VAT no",
  contactName: "Account contact name",
  telephone: "Telephone no",
  mobile: "Mobile no",
  email: "Email",
  premisesYears: "Duration at premises: years",
  premisesMonths: "Duration at premises: months",
  leaseTerms: "Terms of lease",
  landlordName: "Landlord / agent name",
  landlordContact: "Landlord / agent contact no",
  rate24hDay: "GP 24 HR unit day rate",
  rateNightSaverDay: "GP Night Saver unit day rate",
  rateNightSaverNight: "GP Night Saver unit night rate",
  mprn: "MPRN no",
  mccCode: "MCC code",
  existingAccount: "Account / GPRN no",
  readingDay: "Meter reading: 24hrs / day",
  readingNight: "Meter reading: night",
  readingWattless: "Meter reading: wattless",
  readingDate: "Date of reading",
  expectedChangeover: "Date of expected changeover",
  commitmentPeriod: "Commitment period",
  signatoryName: "Signatory name",
  signatoryPosition: "Position held at company",
  agencyId: "Agency ID",
  agencyName: "Agency name",
  agentName: "Agent name",
  flogasRepName: "Flogas representative name",
  flogasActivationDate: "Date of activation",
  debtorName: "Debtor name",
  mandateReference: "Unique mandate reference",
  iban: "IBAN",
  bic: "BIC",
};
const LINES_LABELS: Record<FlogasLinesBox, string> = { supplyAddress: "Supply address", billingAddress: "Billing address", debtorAddress: "Debtor address" };
const TICK_LABELS: Record<FlogasTickBox, string> = {
  entityCompany: "Legal entity: company",
  entitySoleTrader: "Legal entity: sole trader",
  entityOther: "Legal entity: other",
  vatExemptYes: "VAT exempt: yes",
  vatExemptNo: "VAT exempt: no",
  priorityYes: "Priority / special needs: yes",
  priorityNo: "Priority / special needs: no",
  ownsPremisesYes: "Own the supply premises: yes",
  ownsPremisesNo: "Own the supply premises: no",
  sector24h: "Sector: GP 24HR",
  sectorNightSaver: "Sector: GP Night Saver",
  sectorLvmd: "Sector: LVMD",
  pricingFixed: "Pricing: fixed",
  pricingVariable: "Pricing: variable",
  requirementNewConnection: "Requirement: new connection",
  requirementCole: "Requirement: C.O.L.E.",
  requirementRenewal: "Requirement: renewal",
  requirementReenergise: "Requirement: re-energise meter",
  requirementChangeOfSupplier: "Requirement: change of supplier",
  existingCustomerYes: "Existing Flogas customer: yes",
  existingCustomerNo: "Existing Flogas customer: no",
};
const REQUIREMENT_TICK: Record<FlogasRequirement, FlogasTickBox> = {
  new_connection: "requirementNewConnection",
  change_of_legal_entity: "requirementCole",
  renewal: "requirementRenewal",
  reenergise_meter: "requirementReenergise",
  change_of_supplier: "requirementChangeOfSupplier",
};
const SECTOR_TICK: Record<FlogasSector, FlogasTickBox> = { gp_24h: "sector24h", gp_night_saver: "sectorNightSaver", lvmd: "sectorLvmd" };

/** Values printed in block capitals, as the form asks. */
const UPPER = new Set<FlogasTextBox>([
  "legalName",
  "tradingName",
  "vatExemptNumber",
  "businessType",
  "companyRegVat",
  "contactName",
  "leaseTerms",
  "landlordName",
  "mccCode",
  "existingAccount",
  "commitmentPeriod",
  "signatoryName",
  "signatoryPosition",
  "agencyId",
  "agencyName",
  "agentName",
  "flogasRepName",
  "debtorName",
  "mandateReference",
  "bic",
]);

const field = (id: string, label: string, kind: FormField["kind"], b: Box, extra: Partial<FormField> = {}): FormField => ({ id, label, kind, page: b.page, x: b.x, y: b.y, w: b.w, h: b.h, source: null, ...extra });

/** Every box on the form, for the template record and the template editor's view. */
export function flogasLayoutFields(): FormField[] {
  const out: FormField[] = [];
  for (const [k, b] of Object.entries(L.text)) out.push(field(k, TEXT_LABELS[k as FlogasTextBox], "text", b, UPPER.has(k as FlogasTextBox) ? { upper: true } : {}));
  for (const [k, boxes] of Object.entries(L.lines)) boxes.forEach((b, i) => out.push(field(`${k}_${i + 1}`, `${LINES_LABELS[k as FlogasLinesBox]}, line ${i + 1}`, "text", b)));
  for (const [k, b] of Object.entries(L.ticks)) out.push(field(k, TICK_LABELS[k as FlogasTickBox], "check", b));
  L.meterRows.forEach((r, i) => {
    out.push(field(`meterMprn_${i + 1}`, `MPRN/MCC, row ${i + 1}`, "text", r.mprn, { upper: true }));
    out.push(field(`meterReads_${i + 1}`, `Meter read day/night, row ${i + 1}`, "text", r.reads));
  });
  out.push(...signatureFields(["customer", "account_holder_2", "broker"], true));
  return out;
}

/** Signature and signed-date boxes for the signers this version needs. */
function signatureFields(signers: FormSignerRole[], directDebit: boolean): FormField[] {
  const S = L.signatures;
  const out: FormField[] = [];
  if (signers.includes("customer")) {
    out.push(field("customerSignature", "Signed by or on behalf of the customer", "signature", S.customer, { signer: "customer" }));
    out.push(field("customerDate", "Date signed by the customer", "signed_date", S.customerDate, { signer: "customer" }));
    if (directDebit) {
      out.push(field("mandateSignature1", "Direct debit mandate: signature", "signature", S.mandate1, { signer: "customer" }));
      out.push(field("mandateDate1", "Direct debit mandate: date", "signed_date", S.mandate1Date, { signer: "customer" }));
    }
  }
  if (directDebit && signers.includes("account_holder_2")) {
    out.push(field("mandateSignature2", "Direct debit mandate: second account holder's signature", "signature", S.mandate2, { signer: "account_holder_2" }));
    out.push(field("mandateDate2", "Direct debit mandate: second account holder's date", "signed_date", S.mandate2Date, { signer: "account_holder_2" }));
  }
  if (signers.includes("broker")) out.push(field("agentSignature", "Agent signature", "signature", S.agent, { signer: "broker" }));
  return out;
}

let helvetica: Promise<PDFFont> | null = null;
/** The font fillPdf writes with, for measuring wrapped lines. */
const measuringFont = () => (helvetica ??= PDFDocument.create().then((d) => d.embedFont(StandardFonts.Helvetica)));

/**
 * Splits text over several printed lines at the largest size (down to 6 pt) where every word fits.
 * Returns null when it can't fit even at 6 pt.
 */
export function flowLines(font: PDFFont, text: string, boxes: readonly Box[], maxSize = 9, minSize = 6): { lines: string[]; size: number } | null {
  // Only ordinary spaces break a line: an Eircode is joined with a no-break space by the caller.
  const words = text.split(/ +/).filter(Boolean);
  if (!words.length) return { lines: [], size: maxSize };
  for (let size = maxSize; size >= minSize; size -= 0.5) {
    const lines: string[] = [];
    let current = "";
    let ok = true;
    for (const word of words) {
      const room = (boxes[lines.length]?.w ?? 0) - 2;
      const next = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= room) {
        current = next;
        continue;
      }
      if (!current) {
        ok = false;
        break;
      }
      lines.push(current);
      current = word;
      if (lines.length >= boxes.length || font.widthOfTextAtSize(word, size) > boxes[lines.length].w - 2) {
        ok = false;
        break;
      }
    }
    if (ok && current) lines.push(current);
    if (ok && lines.length <= boxes.length) return { lines, size };
  }
  return null;
}

const fmtDate = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : null);
const fmtRate = (cent: number | null) => (cent === null ? null : cent.toFixed(2));
const fmtNumber = (n: number | null) => (n === null ? null : String(n));
/** IBANs are printed in groups of four, as on a bank statement. */
const fmtIban = (iban: string | null) => (iban ? iban.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ") : null);
const upper = (s: string) => s.toLocaleUpperCase("en-IE");
/** An Eircode (D18 R2T5) stays on one line when an address wraps. */
const keepEircode = (a: FlogasAddress): FlogasAddress => ({ ...a, postcode: a.postcode ? a.postcode.trim().replace(/\s+/g, "\u00a0") : null });

export interface RenderedForm {
  fields: FormField[];
  values: Record<string, FillValue>;
  /** Text that can't fit its box, named for the user. */
  issues: string[];
}

/**
 * Maps the application onto the form's boxes: the fields to draw (only the signature boxes this
 * application needs) and the value for each. Optional boxes with no value stay blank.
 */
export async function renderFlogasElectricity(d: FlogasElectricityData, signers: FormSignerRole[]): Promise<RenderedForm> {
  const font = await measuringFont();
  const fields = flogasLayoutFields().filter((f) => f.kind !== "signature" && f.kind !== "signed_date");
  fields.push(...signatureFields(signers, d.directDebit));
  const values: Record<string, FillValue> = {};
  const issues: string[] = [];
  const text = (k: FlogasTextBox, v: string | null | undefined) => {
    if (v && v.trim()) values[k] = v.trim();
  };
  const tickIf = (k: FlogasTickBox, on: boolean | null | undefined) => {
    values[k] = on === true;
  };
  const yesNo = (yes: FlogasTickBox, no: FlogasTickBox, v: boolean | null) => {
    tickIf(yes, v === true);
    tickIf(no, v === false);
  };
  const flow = (k: FlogasLinesBox, raw: string) => {
    const boxes = L.lines[k];
    const fit = flowLines(font, upper(raw.replace(/[ \t\r\n]+/g, " ")), boxes);
    if (!fit) {
      issues.push(`The ${LINES_LABELS[k].toLowerCase()} is too long for the form. Shorten it.`);
      return;
    }
    fit.lines.forEach((line, i) => {
      values[`${k}_${i + 1}`] = line;
      const f = fields.find((x) => x.id === `${k}_${i + 1}`)!;
      f.fontSize = fit.size;
    });
  };

  // Page 1, left: the customer
  text("legalName", d.legalName);
  text("tradingName", d.tradingName);
  flow("supplyAddress", addressText(keepEircode(d.supplyAddress)));
  // "Billing address (if different)": blank when bills go to the supply address.
  if (!d.billingSameAsSupply) flow("billingAddress", addressText(keepEircode(d.billingAddress)));
  const entity = flogasEntityBox(d.legalEntity);
  tickIf("entityCompany", entity === "company");
  tickIf("entitySoleTrader", entity === "sole_trader");
  tickIf("entityOther", entity === "other");
  yesNo("vatExemptYes", "vatExemptNo", d.vatExempt);
  if (d.vatExempt) text("vatExemptNumber", d.vatExemptNumber);
  yesNo("priorityYes", "priorityNo", d.priorityCustomer);
  text("businessType", d.businessType);
  text("companyRegVat", [d.companyRegNumber, d.vatNumber].filter((x) => x && x.trim()).join(" / "));
  text("contactName", contactFullName(d));
  text("telephone", d.telephone);
  text("mobile", d.mobile);
  text("email", d.email);
  const owns = ownsPremises(d.occupancyType);
  yesNo("ownsPremisesYes", "ownsPremisesNo", owns);
  const duration = durationAtPremises(d.occupiedSince);
  if (duration) {
    text("premisesYears", String(duration.years));
    text("premisesMonths", String(duration.months));
  }
  if (owns === false) {
    text("leaseTerms", d.leaseTerms);
    text("landlordName", d.landlordName);
    text("landlordContact", d.landlordContact);
  }
  for (const [s, k] of Object.entries(SECTOR_TICK)) tickIf(k, d.sector === s);
  const fixed = isFixedPrice(d.priceType);
  yesNo("pricingFixed", "pricingVariable", fixed);
  if (d.sector === "gp_24h") text("rate24hDay", fmtRate(d.dayRateCent));
  if (d.sector === "gp_night_saver") {
    text("rateNightSaverDay", fmtRate(d.dayRateCent));
    text("rateNightSaverNight", fmtRate(d.nightRateCent));
  }

  // Page 1, right: supply, meter and signatures
  for (const [r, k] of Object.entries(REQUIREMENT_TICK)) tickIf(k, d.requirements.includes(r as FlogasRequirement));
  const main = d.meters[0];
  text("mprn", main?.mprn);
  text("mccCode", main?.mccCode);
  yesNo("existingCustomerYes", "existingCustomerNo", d.existingFlogasCustomer);
  if (d.existingFlogasCustomer) text("existingAccount", d.existingFlogasAccount);
  text("readingDay", fmtNumber(main?.day ?? null));
  text("readingNight", fmtNumber(main?.night ?? null));
  text("readingWattless", fmtNumber(main?.wattless ?? null));
  if (d.meters.some((m) => m.day !== null || m.night !== null || m.wattless !== null)) text("readingDate", fmtDate(d.readingDate));
  text("expectedChangeover", fmtDate(d.expectedChangeover));
  text("commitmentPeriod", d.termMonths ? `${d.termMonths} months` : null);
  text("signatoryName", d.signatoryName);
  text("signatoryPosition", d.signatoryPosition);
  text("agencyId", d.agencyId);
  text("agencyName", d.agencyName);
  text("agentName", d.agentName);
  text("flogasRepName", d.flogasRepName);
  text("flogasActivationDate", fmtDate(d.flogasActivationDate));

  // Page 2: the mandate (only when paying by direct debit) and the meter table
  if (d.directDebit) {
    text("debtorName", d.debtorName);
    text("mandateReference", d.mandateReference);
    flow("debtorAddress", addressText(keepEircode(effectiveDebtorAddress(d))));
    text("iban", fmtIban(d.iban));
    text("bic", d.bic);
  }
  d.meters.slice(0, L.meterRows.length).forEach((m, i) => {
    text(`meterMprn_${i + 1}` as FlogasTextBox, [m.mprn, m.mccCode].filter((x) => x && x.trim()).join(" / "));
    text(`meterReads_${i + 1}` as FlogasTextBox, [m.day, m.night].filter((x) => x !== null).join(" / "));
  });

  // Block capitals for the boxes that ask for them (addresses are already upper-cased above).
  for (const f of fields) if (f.upper && typeof values[f.id] === "string") values[f.id] = upper(values[f.id] as string);
  return { fields, values, issues };
}
