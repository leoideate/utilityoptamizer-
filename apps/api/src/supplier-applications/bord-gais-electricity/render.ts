import { PDFDocument, type PDFFont, StandardFonts } from "pdf-lib";
import {
  BORD_GAIS_COMMITMENTS,
  BORD_GAIS_DISCOUNT_CELLS,
  BORD_GAIS_ORG_TYPES,
  BORD_GAIS_RATE_COLUMNS,
  BORD_GAIS_RATE_ROWS,
  BORD_GAIS_REGISTERS,
  type ApplicationAddress,
  type BordGaisElectricityData,
  type FormField,
  type FormSignerRole,
  PRICE_TYPES,
  addressText,
  bordGaisBillingAddress,
  bordGaisConfirmationEnd,
  bordGaisMonthLabel,
  bordGaisContactName,
  needsHomeAddress,
  normalizeIdentifier,
  splitReading,
} from "@uo/shared";
import type { FillValue } from "../../forms/pdf";
import { flowLines } from "../flogas-electricity/render";
import { BGE_SIGNATURE_PDF_FIELDS, bgeFields, bgeSignatureFields, discountFieldId, rateFieldId, readingFieldId } from "./layout";

let helvetica: Promise<PDFFont> | null = null;
const measuringFont = () => (helvetica ??= PDFDocument.create().then((d) => d.embedFont(StandardFonts.Helvetica)));

const fmtDate = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : null);
const fmtCent = (n: number | null) => (n === null ? null : n.toFixed(2));
const upper = (s: string) => s.toLocaleUpperCase("en-IE");
/** An Eircode stays on one line when an address wraps. */
const keepEircode = (a: ApplicationAddress): ApplicationAddress => ({ ...a, postcode: a.postcode ? a.postcode.trim().replace(/\s+/g, "\u00a0") : null });

export interface RenderedBordGais {
  fields: FormField[];
  values: Record<string, FillValue>;
  /** The PDF's signature fields this version leaves alone (signers it doesn't have). */
  untouched: string[];
  issues: string[];
}

/** Maps the application onto the form's fields. Optional fields with no value are left blank. */
export async function renderBordGaisElectricity(d: BordGaisElectricityData, signers: FormSignerRole[]): Promise<RenderedBordGais> {
  const font = await measuringFont();
  const signatureFields = bgeSignatureFields(signers, d.directDebit);
  const fields = [...bgeFields(), ...signatureFields];
  const filled = new Set(signatureFields.map((f) => f.pdfField));
  const untouched = BGE_SIGNATURE_PDF_FIELDS.filter((f) => !filled.has(f));
  const values: Record<string, FillValue> = {};
  const issues: string[] = [];
  const text = (id: string, v: string | null | undefined) => {
    values[id] = v && v.trim() ? v.trim() : "";
  };
  const tick = (id: string, on: boolean) => {
    values[id] = on;
  };
  const flow = (ids: string[], a: ApplicationAddress, label: string) => {
    const boxes = ids.map((id) => fields.find((f) => f.id === id)!);
    for (const id of ids) values[id] = "";
    const fit = flowLines(font, upper(addressText(keepEircode(a))), boxes.map((b) => ({ page: 0 as const, x: b.x, y: b.y, w: b.w, h: b.h })));
    if (!fit) return void issues.push(`The ${label} is too long for the form. Shorten it.`);
    // The no-break space only kept the Eircode together while wrapping; fields take plain spaces.
    fit.lines.forEach((line, i) => (values[ids[i]] = line.replace(/\u00a0/g, " ")));
  };

  // Step 1: account holder
  text("account_legalName", d.legalName);
  text("account_tradingName", d.tradingName);
  text("account_holderName", d.accountHolderName ?? d.legalName);
  text("account_address", addressText(d.accountAddress));
  text("account_mainActivity", d.mainActivity);
  text("account_dateEstablished", fmtDate(d.dateEstablished));
  for (const t of BORD_GAIS_ORG_TYPES) tick(`account_type_${t}`, d.organisationType === t);
  text("account_croNumber", d.croNumber);
  text("account_employees", d.employees === null ? null : String(d.employees));
  // A company's form doesn't ask for anyone's home address.
  text("account_homeAddress", needsHomeAddress(d.organisationType) ? addressText(d.homeAddress) : null);
  text("contact_name", bordGaisContactName(d));
  text("contact_position", d.position);
  text("contact_email", d.email);
  text("contact_telephone", d.telephone);
  text("contact_mobile", d.mobile);

  // Premises and billing
  text("premises_siteName", d.siteName);
  flow(["premises_address_1", "premises_address_2"], d.supplyAddress, "supply address");
  text("premises_contactName", d.premisesContactName);
  text("premises_telephone", d.premisesTelephone);
  text("premises_fax", d.premisesFax);
  text("premises_email", d.premisesEmail);
  text("premises_mobile", d.premisesMobile);
  tick("premises_priorityCustomer", d.priorityCustomer === true);
  text("billing_contactName", d.billingContactName);
  flow(["billing_address_1", "billing_address_2", "billing_address_3"], bordGaisBillingAddress(d), "billing address");

  // Supply and meters
  text("supply_mprn", normalizeIdentifier(d.mprn));
  text("supply_mic", d.mic === null ? null : String(d.mic));
  text("supply_dgCode", d.dgCode);
  text("supply_voltage", d.voltage);
  text("supply_mcc", d.mcc);
  text("supply_profileClass", d.profileClass);
  text("supply_existingSupplier", d.existingSupplier);
  text("supply_annualConsumption", d.annualConsumptionKwh === null ? null : `${d.annualConsumptionKwh.toLocaleString("en-IE")} kWh`);
  d.meters.forEach((m, i) => {
    const meter = (i + 1) as 1 | 2;
    text(`meter${meter}_serial`, m.serial);
    for (const r of BORD_GAIS_REGISTERS) {
      const parts = splitReading(m.readings[r]);
      text(readingFieldId(meter, r, "whole"), parts?.whole);
      text(readingFieldId(meter, r, "tenth"), parts?.tenth);
    }
  });

  // Agreement and rates
  text("agreement_pricePlan", d.pricePlan);
  text("agreement_confirmationEndDate", bordGaisMonthLabel(bordGaisConfirmationEnd(d)));
  for (const p of PRICE_TYPES) tick(`agreement_rateType_${p}`, d.rateType === p);
  for (const m of BORD_GAIS_COMMITMENTS) tick(`agreement_commitment_${m}`, d.commitmentMonths === m);
  for (const row of BORD_GAIS_RATE_ROWS) for (const col of BORD_GAIS_RATE_COLUMNS) text(rateFieldId(row, col), fmtCent(d.rates[row][col]));
  // "Discount (selected variable price plans only)".
  for (const cell of BORD_GAIS_DISCOUNT_CELLS) text(discountFieldId(cell), d.rateType === "variable" && d.discounts[cell] !== null ? `${d.discounts[cell]}%` : null);
  for (let i = 1; i <= 3; i++) text(`discount_greyed_${i}`, null);

  // Declaration, marketing and agent
  text("declaration_name", d.signatoryName);
  tick("marketing_noEmail", d.marketing.email === false);
  tick("marketing_noPost", d.marketing.post === false);
  tick("marketing_noPhone", d.marketing.phone === false);
  tick("marketing_noSms", d.marketing.sms === false);
  tick("marketing_broader", d.broaderMarketing === true);
  text("agent_name", d.agentName);

  // SEPA direct debit (left blank unless paying by direct debit)
  text("directDebit_mandateReference", d.directDebit ? d.mandateReference : null);
  text("directDebit_iban", d.directDebit ? (d.iban?.replace(/\s+/g, "").toUpperCase() ?? null) : null);
  text("directDebit_bic", d.directDebit ? (d.bic?.replace(/\s+/g, "").toUpperCase() ?? null) : null);
  text("directDebit_accountHolder", d.directDebit ? d.bankAccountName : null);

  for (const f of fields) if (f.upper && typeof values[f.id] === "string") values[f.id] = upper(values[f.id] as string);
  return { fields, values, untouched, issues };
}
