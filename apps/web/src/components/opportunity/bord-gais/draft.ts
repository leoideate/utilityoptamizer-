import { type ApplicationAddress, BORD_GAIS_REGISTERS, type BordGaisElectricityData, type BordGaisIssue, type BordGaisSaveInput } from "@uo/shared";
import type { ApplicationViewBase, BankEdit } from "../supplier-application/types";

/** GET /opportunities/:id/bord-gais-electricity */
export interface BordGaisView extends ApplicationViewBase {
  data: BordGaisElectricityData;
  issues: BordGaisIssue[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const addr = (a: ApplicationAddress) => ({ line1: a.line1, line2: a.line2, city: a.city, county: a.county, postcode: a.postcode });

/**
 * What to send when saving: only what the user changed, grouped by the record it belongs to.
 * The server writes each group to its CRM record and the Bord Gáis-only answers to the application.
 */
export function savePayload(saved: BordGaisElectricityData, d: BordGaisElectricityData, bank: BankEdit | null, confirmIbanChange: boolean): BordGaisSaveInput {
  const out: BordGaisSaveInput = {};
  const changed = <K extends keyof BordGaisElectricityData>(k: K) => !same(saved[k], d[k]);
  const group = (pairs: [string, keyof BordGaisElectricityData, unknown][]) => Object.fromEntries(pairs.filter(([, k]) => changed(k)).map(([key, , v]) => [key, v]));

  const customer = group([
    ["legalName", "legalName", d.legalName ?? ""],
    ["tradingName", "tradingName", d.tradingName],
    ["legalEntity", "organisationType", d.organisationType],
    ["businessType", "mainActivity", d.mainActivity],
    ["incorporationDate", "dateEstablished", d.dateEstablished],
    ["companyRegNumber", "croNumber", d.croNumber],
    ["employees", "employees", d.employees],
    ["priorityCustomer", "priorityCustomer", d.priorityCustomer],
  ]);
  if (changed("marketing")) Object.assign(customer, { marketingEmail: d.marketing.email, marketingPost: d.marketing.post, marketingPhone: d.marketing.phone, marketingSms: d.marketing.sms });
  if (Object.keys(customer).length) out.customer = customer as BordGaisSaveInput["customer"];
  const contact = group([
    ["firstName", "contactFirstName", d.contactFirstName ?? ""],
    ["lastName", "contactLastName", d.contactLastName],
    ["jobTitle", "position", d.position],
    ["email", "email", d.email],
    ["phone", "telephone", d.telephone],
    ["mobile", "mobile", d.mobile],
  ]);
  if (Object.keys(contact).length) out.contact = contact as BordGaisSaveInput["contact"];
  if (changed("accountAddress")) out.accountAddress = addr(d.accountAddress);
  if (changed("homeAddress")) out.homeAddress = addr(d.homeAddress);
  if (d.billingSource === "separate" && changed("billingAddress")) out.billingAddress = addr(d.billingAddress);
  if (changed("supplyAddress")) out.supplyAddress = addr(d.supplyAddress);
  const site = group([
    ["siteName", "siteName", d.siteName],
    ["annualConsumptionKwh", "annualConsumptionKwh", d.annualConsumptionKwh],
  ]);
  if (Object.keys(site).length) out.site = site as BordGaisSaveInput["site"];
  const meter = group([
    ["mprn", "mprn", d.mprn],
    ["mic", "mic", d.mic],
    ["dgCode", "dgCode", d.dgCode],
    ["voltage", "voltage", d.voltage],
    ["mcc", "mcc", d.mcc],
    ["profileClass", "profileClass", d.profileClass],
  ]);
  if (saved.meters[0].serial !== d.meters[0].serial) meter.serial1 = d.meters[0].serial;
  if (saved.meters[1].serial !== d.meters[1].serial) meter.serial2 = d.meters[1].serial;
  if (Object.keys(meter).length) out.meter = meter as BordGaisSaveInput["meter"];
  if (changed("meters") || changed("readingDate")) {
    const readings = (i: 0 | 1) => Object.fromEntries(BORD_GAIS_REGISTERS.filter((r) => d.meters[i].readings[r] !== saved.meters[i].readings[r] || changed("readingDate")).map((r) => [r, d.meters[i].readings[r]]));
    out.readings = { meter1: readings(0), meter2: readings(1), readingDate: d.readingDate };
  }
  const contract = group([
    ["existingSupplier", "existingSupplier", d.existingSupplier],
    ["pricePlan", "pricePlan", d.pricePlan],
    ["commitmentMonths", "commitmentMonths", d.commitmentMonths],
    ["rateType", "rateType", d.rateType],
  ]);
  if (Object.keys(contract).length) out.contract = contract as BordGaisSaveInput["contract"];
  // The whole table: the server splits the rate type's row (contract) from the rest (application).
  if (changed("rates") || changed("rateType")) out.rates = d.rates;
  if (bank && (bank.accountName.trim() || bank.iban.trim())) {
    out.bank = { accountName: bank.accountName.trim(), iban: bank.iban, bic: bank.bic };
    if (confirmIbanChange) out.confirmIbanChange = true;
  }

  const answers: NonNullable<BordGaisSaveInput["answers"]> = {};
  if (changed("accountHolderName")) answers.accountHolderName = d.accountHolderName;
  if (["premisesContactName", "premisesTelephone", "premisesFax", "premisesEmail", "premisesMobile"].some((k) => changed(k as keyof BordGaisElectricityData))) {
    answers.premisesContact = { name: d.premisesContactName, telephone: d.premisesTelephone, fax: d.premisesFax, email: d.premisesEmail, mobile: d.premisesMobile };
  }
  if (changed("billingContactName")) answers.billingContactName = d.billingContactName;
  if (changed("billingSource")) answers.billingSource = d.billingSource;
  if (changed("confirmationEndDate")) answers.confirmationEndDate = d.confirmationEndDate;
  if (changed("discounts")) answers.discounts = d.discounts;
  if (changed("broaderMarketing")) answers.broaderMarketing = d.broaderMarketing;
  if (changed("signatoryName")) answers.signatoryName = d.signatoryName;
  if (changed("directDebit")) answers.directDebit = d.directDebit;
  if (changed("mandateReference")) answers.mandateReference = d.mandateReference;
  if (changed("secondAccountHolder")) answers.secondAccountHolder = d.secondAccountHolder;
  if (Object.keys(answers).length) out.answers = answers;
  return out;
}

/** The draft as validation sees it: newly typed bank details count as on file. */
export function forValidation(d: BordGaisElectricityData, bank: BankEdit | null): BordGaisElectricityData {
  if (!bank) return d;
  const iban = bank.iban.replace(/\s+/g, "").toUpperCase();
  const bic = bank.bic.replace(/\s+/g, "").toUpperCase();
  return {
    ...d,
    iban: iban || d.iban,
    bic: bic || d.bic,
    bankAccountName: bank.accountName.trim() || d.bankAccountName,
    bankOnFile: d.bankOnFile && !iban ? true : !!iban && !!bank.accountName.trim(),
    bicOnFile: d.bicOnFile && !bic ? true : !!bic,
  };
}

export const isEmptyPayload = (p: BordGaisSaveInput) => Object.keys(p).length === 0;
