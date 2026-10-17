"use client";

import { type useForm } from "react-hook-form";
import { LEGAL_ENTITIES, LEGAL_ENTITY_LABELS, VAT_STATUSES } from "@uo/shared";
import { Field, Input, Select } from "@/components/ui/primitives";

/** "" = not asked, so forms leave both the Yes and the No box empty. */
type YesNo = "" | "yes" | "no";

export interface CustomerFormValues {
  legalName: string;
  tradingName: string;
  legalEntity: string;
  businessType: string;
  industry: string;
  companyRegNumber: string;
  vatRegistered: string;
  vatNumber: string;
  incorporationDate: string;
  countryOfIncorporation: string;
  employees: string;
  website: string;
  phone: string;
  email: string;
  advertisingMethod: string;
  vatExempt: YesNo;
  vatExemptNumber: string;
  carbonTaxExempt: YesNo;
  charityNumber: string;
  priorityCustomer: YesNo;
  paperlessBilling: YesNo;
  marketingEmail: YesNo;
  marketingPost: YesNo;
  marketingPhone: YesNo;
  marketingSms: YesNo;
  line1: string;
  city: string;
  county: string;
  postcode: string;
  homeLine1: string;
  homeCity: string;
  homeCounty: string;
  homePostcode: string;
}

export const emptyCustomer: CustomerFormValues = {
  legalName: "",
  tradingName: "",
  legalEntity: "",
  businessType: "",
  industry: "",
  companyRegNumber: "",
  vatRegistered: "",
  vatNumber: "",
  incorporationDate: "",
  countryOfIncorporation: "IE",
  employees: "",
  website: "",
  phone: "",
  email: "",
  advertisingMethod: "",
  vatExempt: "",
  vatExemptNumber: "",
  carbonTaxExempt: "",
  charityNumber: "",
  priorityCustomer: "",
  paperlessBilling: "",
  marketingEmail: "",
  marketingPost: "",
  marketingPhone: "",
  marketingSms: "",
  line1: "",
  city: "",
  county: "",
  postcode: "",
  homeLine1: "",
  homeCity: "",
  homeCounty: "",
  homePostcode: "",
};

const n = (v: string) => (v.trim() ? v.trim() : null);
const yn = (v: YesNo) => (v === "" ? null : v === "yes");
export const toYesNo = (v: boolean | null | undefined): YesNo => (v === true ? "yes" : v === false ? "no" : "");
/** Sole traders and partners give a home address on supplier forms. */
export const needsHomeAddress = (legalEntity: string) => legalEntity === "sole_trader" || legalEntity === "partnership";

/** The addresses the form edits (trading, and home for sole traders); other kinds are kept by the caller. */
export function formAddresses(v: CustomerFormValues) {
  return [
    ...(v.line1.trim() ? [{ kind: "trading", line1: v.line1.trim(), city: n(v.city), county: n(v.county), postcode: n(v.postcode), country: "IE" }] : []),
    ...(needsHomeAddress(v.legalEntity) && v.homeLine1.trim() ? [{ kind: "home", line1: v.homeLine1.trim(), city: n(v.homeCity), county: n(v.homeCounty), postcode: n(v.homePostcode), country: "IE" }] : []),
  ];
}

/** Shapes the form into the API's customer payload. */
export function toCustomerPayload(v: CustomerFormValues, withAddress = true) {
  const addresses = formAddresses(v);
  return {
    legalName: v.legalName.trim(),
    tradingName: n(v.tradingName),
    legalEntity: (v.legalEntity || null) as (typeof LEGAL_ENTITIES)[number] | null,
    businessType: n(v.businessType),
    industry: n(v.industry),
    companyRegNumber: n(v.companyRegNumber),
    vatRegistered: (v.vatRegistered || null) as "yes" | "no" | "pending" | null,
    vatNumber: n(v.vatNumber),
    incorporationDate: v.incorporationDate || null,
    countryOfIncorporation: n(v.countryOfIncorporation),
    employees: v.employees.trim() ? Number(v.employees) : null,
    website: n(v.website),
    phone: n(v.phone),
    email: n(v.email),
    advertisingMethod: n(v.advertisingMethod),
    vatExempt: yn(v.vatExempt),
    vatExemptNumber: v.vatExempt === "yes" ? n(v.vatExemptNumber) : null,
    carbonTaxExempt: yn(v.carbonTaxExempt),
    charityNumber: n(v.charityNumber),
    priorityCustomer: yn(v.priorityCustomer),
    paperlessBilling: yn(v.paperlessBilling),
    marketingEmail: yn(v.marketingEmail),
    marketingPost: yn(v.marketingPost),
    marketingPhone: yn(v.marketingPhone),
    marketingSms: yn(v.marketingSms),
    ...(withAddress && addresses.length ? { addresses } : {}),
  };
}

function YesNoSelect({ label, name, form, hint }: { label: string; name: keyof CustomerFormValues; form: ReturnType<typeof useForm<CustomerFormValues>>; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      {(p) => (
        <Select {...p} {...form.register(name)}>
          <option value="">Not asked</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </Select>
      )}
    </Field>
  );
}

export function CustomerFields({ form, address = true }: { form: ReturnType<typeof useForm<CustomerFormValues>>; address?: boolean }) {
  const { register, watch } = form;
  const vat = watch("vatRegistered");
  const vatExempt = watch("vatExempt");
  const website = watch("website");
  const entity = watch("legalEntity");
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Legal name" required className="sm:col-span-2">{(p) => <Input {...p} {...register("legalName")} />}</Field>
      <Field label="Trading name">{(p) => <Input {...p} {...register("tradingName")} />}</Field>
      <Field label="Legal entity" hint="Ticks the right box on supplier forms.">
        {(p) => (
          <Select {...p} {...register("legalEntity")}>
            <option value="">Not known</option>
            {LEGAL_ENTITIES.map((e) => (
              <option key={e} value={e}>
                {LEGAL_ENTITY_LABELS[e]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Main activity / business type">{(p) => <Input {...p} placeholder="e.g. Restaurant, Retail" {...register("businessType")} />}</Field>
      <Field label="Industry">{(p) => <Input {...p} {...register("industry")} />}</Field>
      <Field label="Company registration number" hint="CRO number">{(p) => <Input {...p} {...register("companyRegNumber")} />}</Field>
      <Field label="VAT registered">
        {(p) => (
          <Select {...p} {...register("vatRegistered")}>
            <option value="">Not known</option>
            {VAT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === "yes" ? "Yes" : s === "no" ? "No" : "Pending"}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {vat === "yes" && <Field label="VAT number" required>{(p) => <Input {...p} placeholder="IE1234567T" {...register("vatNumber")} />}</Field>}
      <Field label="Date established" hint="Incorporation date, or when the business started.">{(p) => <Input {...p} type="date" {...register("incorporationDate")} />}</Field>
      <Field label="Country of incorporation">{(p) => <Input {...p} maxLength={2} {...register("countryOfIncorporation")} />}</Field>
      <Field label="Number of employees">{(p) => <Input {...p} type="number" min={0} inputMode="numeric" {...register("employees")} />}</Field>
      <Field label="Registered charity number">{(p) => <Input {...p} {...register("charityNumber")} />}</Field>
      <Field label="Email">{(p) => <Input {...p} type="email" {...register("email")} />}</Field>
      <Field label="Phone">{(p) => <Input {...p} type="tel" {...register("phone")} />}</Field>
      <Field label="Website">{(p) => <Input {...p} {...register("website")} />}</Field>
      <Field label="Advertising method" hint={!website?.trim() ? "Needed for Worldpay when there's no website." : undefined}>
        {(p) => <Input {...p} {...register("advertisingMethod")} />}
      </Field>

      <h3 className="pt-2 text-sm font-semibold sm:col-span-2">For supplier forms</h3>
      <YesNoSelect form={form} name="vatExempt" label="VAT exempt" />
      {vatExempt === "yes" && <Field label="VAT exemption number">{(p) => <Input {...p} {...register("vatExemptNumber")} />}</Field>}
      <YesNoSelect form={form} name="carbonTaxExempt" label="Carbon tax exempt" />
      <YesNoSelect form={form} name="priorityCustomer" label="Priority customer" hint="Someone at the premises relies on life-support or medical equipment, or has special needs." />
      <YesNoSelect form={form} name="paperlessBilling" label="Paperless billing" />

      <h3 className="pt-2 text-sm font-semibold sm:col-span-2">Marketing preferences</h3>
      <p className="-mt-2 text-xs text-muted sm:col-span-2">What the customer agreed to. Supplier forms are ticked to match.</p>
      <YesNoSelect form={form} name="marketingEmail" label="Offers by email" />
      <YesNoSelect form={form} name="marketingPost" label="Offers by post" />
      <YesNoSelect form={form} name="marketingPhone" label="Offers by phone" />
      <YesNoSelect form={form} name="marketingSms" label="Offers by SMS" />

      {address && (
        <>
          <h3 className="pt-2 text-sm font-semibold sm:col-span-2">Trading address</h3>
          <Field label="Address" className="sm:col-span-2">{(p) => <Input {...p} {...register("line1")} />}</Field>
          <Field label="Town / city">{(p) => <Input {...p} {...register("city")} />}</Field>
          <Field label="County">{(p) => <Input {...p} {...register("county")} />}</Field>
          <Field label="Eircode / postcode">{(p) => <Input {...p} {...register("postcode")} />}</Field>
        </>
      )}
      {address && needsHomeAddress(entity) && (
        <>
          <h3 className="pt-2 text-sm font-semibold sm:col-span-2">Home address</h3>
          <Field label="Address" className="sm:col-span-2">{(p) => <Input {...p} {...register("homeLine1")} />}</Field>
          <Field label="Town / city">{(p) => <Input {...p} {...register("homeCity")} />}</Field>
          <Field label="County">{(p) => <Input {...p} {...register("homeCounty")} />}</Field>
          <Field label="Eircode / postcode">{(p) => <Input {...p} {...register("homePostcode")} />}</Field>
        </>
      )}
    </div>
  );
}
