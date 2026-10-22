import type { FlogasAddress, FlogasElectricityData, FlogasIssue, FlogasSaveInput } from "@uo/shared";
import type { ApplicationVersion, ApplicationViewBase, BankEdit } from "../supplier-application/types";

/** GET /opportunities/:id/flogas-electricity */
export interface FlogasView extends ApplicationViewBase {
  data: FlogasElectricityData;
  issues: FlogasIssue[];
}
export type FlogasVersion = ApplicationVersion;
export type { BankEdit };

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const addr = (a: FlogasAddress) => ({ line1: a.line1, line2: a.line2, city: a.city, county: a.county, postcode: a.postcode });

/**
 * What to send when saving: only what the user changed, grouped by the record it belongs to.
 * The server writes each group to its CRM record and the Flogas-only answers to the application.
 */
export function savePayload(saved: FlogasElectricityData, d: FlogasElectricityData, bank: BankEdit | null, confirmIbanChange: boolean): FlogasSaveInput {
  const out: FlogasSaveInput = {};
  const pick = <K extends keyof FlogasElectricityData>(keys: K[]) => Object.fromEntries(keys.filter((k) => !same(saved[k], d[k])).map((k) => [k, d[k]]));

  const customer = pick(["legalName", "tradingName", "legalEntity", "vatExempt", "vatExemptNumber", "priorityCustomer", "businessType", "companyRegNumber", "vatNumber", "telephone"]);
  if (Object.keys(customer).length) out.customer = customer as FlogasSaveInput["customer"];
  const contact: Record<string, unknown> = {};
  if (!same(saved.contactFirstName, d.contactFirstName)) contact.firstName = d.contactFirstName ?? "";
  if (!same(saved.contactLastName, d.contactLastName)) contact.lastName = d.contactLastName;
  if (!same(saved.mobile, d.mobile)) contact.mobile = d.mobile;
  if (!same(saved.email, d.email)) contact.email = d.email;
  if (Object.keys(contact).length) out.contact = contact as FlogasSaveInput["contact"];
  if (!same(saved.supplyAddress, d.supplyAddress)) out.supplyAddress = addr(d.supplyAddress);
  if (!d.billingSameAsSupply && !same(saved.billingAddress, d.billingAddress)) out.billingAddress = addr(d.billingAddress);
  const premises = pick(["occupancyType", "occupiedSince", "leaseTerms", "landlordName", "landlordContact"]);
  if (Object.keys(premises).length) out.premises = premises as FlogasSaveInput["premises"];
  if (!same(saved.meters, d.meters) || !same(saved.readingDate, d.readingDate) || !same(saved.sector, d.sector)) {
    out.meters = d.meters.map((m) => ({ id: m.id, mprn: m.mprn, mccCode: m.mccCode, day: m.day, night: m.night, wattless: m.wattless }));
    out.readingDate = d.readingDate;
  }
  const contract: Record<string, unknown> = {};
  if (!same(saved.expectedChangeover, d.expectedChangeover)) contract.expectedChangeover = d.expectedChangeover;
  if (!same(saved.termMonths, d.termMonths)) contract.termMonths = d.termMonths;
  if (!same(saved.priceType, d.priceType)) contract.priceType = d.priceType;
  if (!same(saved.dayRateCent, d.dayRateCent)) contract.dayRateCent = d.dayRateCent;
  if (!same(saved.nightRateCent, d.nightRateCent)) contract.nightRateCent = d.nightRateCent;
  if (Object.keys(contract).length) out.contract = contract as FlogasSaveInput["contract"];
  if (bank && (bank.accountName.trim() || bank.iban.trim())) {
    out.bank = { accountName: bank.accountName.trim(), iban: bank.iban, bic: bank.bic.trim() || null };
    if (confirmIbanChange) out.confirmIbanChange = true;
  }
  if (!d.debtorAddressSameAsBilling && !same(saved.debtorAddress, d.debtorAddress)) out.debtorAddress = addr(d.debtorAddress);
  const answers = pick([
    "requirements",
    "billingSameAsSupply",
    "existingFlogasCustomer",
    "existingFlogasAccount",
    "sector",
    "directDebit",
    "debtorAddressSameAsBilling",
    "mandateReference",
    "secondAccountHolder",
    "signatoryName",
    "signatoryPosition",
    "agentSignature",
    "flogasRepName",
    "flogasActivationDate",
  ]);
  if (Object.keys(answers).length) out.answers = answers as FlogasSaveInput["answers"];
  return out;
}

/** The draft as validation sees it: newly typed bank details count as on file. */
export function forValidation(d: FlogasElectricityData, bank: BankEdit | null): FlogasElectricityData {
  if (!bank || !(bank.iban.trim() || bank.accountName.trim())) return d;
  return { ...d, iban: bank.iban.replace(/\s+/g, "").toUpperCase() || d.iban, debtorName: bank.accountName.trim() || d.debtorName, bankOnFile: d.bankOnFile || !!bank.iban.trim() };
}

export const isEmptyPayload = (p: FlogasSaveInput) => Object.keys(p).length === 0;
