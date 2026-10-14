"use client";

import { type useForm } from "react-hook-form";
import { VAT_STATUSES } from "@uo/shared";
import { Field, Input, Select } from "@/components/ui/primitives";

export interface CustomerFormValues {
  legalName: string;
  tradingName: string;
  businessType: string;
  industry: string;
  companyRegNumber: string;
  vatRegistered: string;
  vatNumber: string;
  incorporationDate: string;
  countryOfIncorporation: string;
  website: string;
  phone: string;
  email: string;
  advertisingMethod: string;
  line1: string;
  city: string;
  county: string;
  postcode: string;
}

export const emptyCustomer: CustomerFormValues = {
  legalName: "",
  tradingName: "",
  businessType: "",
  industry: "",
  companyRegNumber: "",
  vatRegistered: "",
  vatNumber: "",
  incorporationDate: "",
  countryOfIncorporation: "IE",
  website: "",
  phone: "",
  email: "",
  advertisingMethod: "",
  line1: "",
  city: "",
  county: "",
  postcode: "",
};

const n = (v: string) => (v.trim() ? v.trim() : null);

/** Shapes the form into the API's customer payload. */
export function toCustomerPayload(v: CustomerFormValues, withAddress = true) {
  return {
    legalName: v.legalName.trim(),
    tradingName: n(v.tradingName),
    businessType: n(v.businessType),
    industry: n(v.industry),
    companyRegNumber: n(v.companyRegNumber),
    vatRegistered: (v.vatRegistered || null) as "yes" | "no" | "pending" | null,
    vatNumber: n(v.vatNumber),
    incorporationDate: v.incorporationDate || null,
    countryOfIncorporation: n(v.countryOfIncorporation),
    website: n(v.website),
    phone: n(v.phone),
    email: n(v.email),
    advertisingMethod: n(v.advertisingMethod),
    ...(withAddress && v.line1.trim() ? { addresses: [{ kind: "trading", line1: v.line1.trim(), city: n(v.city), county: n(v.county), postcode: n(v.postcode), country: "IE" }] } : {}),
  };
}

export function CustomerFields({ form, address = true }: { form: ReturnType<typeof useForm<CustomerFormValues>>; address?: boolean }) {
  const { register, watch } = form;
  const vat = watch("vatRegistered");
  const website = watch("website");
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Legal name" required className="sm:col-span-2">{(p) => <Input {...p} {...register("legalName")} />}</Field>
      <Field label="Trading name">{(p) => <Input {...p} {...register("tradingName")} />}</Field>
      <Field label="Business type">{(p) => <Input {...p} placeholder="e.g. Limited company, Sole trader" {...register("businessType")} />}</Field>
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
      <Field label="Incorporation date">{(p) => <Input {...p} type="date" {...register("incorporationDate")} />}</Field>
      <Field label="Country of incorporation">{(p) => <Input {...p} maxLength={2} {...register("countryOfIncorporation")} />}</Field>
      <Field label="Email">{(p) => <Input {...p} type="email" {...register("email")} />}</Field>
      <Field label="Phone">{(p) => <Input {...p} type="tel" {...register("phone")} />}</Field>
      <Field label="Website">{(p) => <Input {...p} {...register("website")} />}</Field>
      <Field label="Advertising method" hint={!website?.trim() ? "Needed for Worldpay when there's no website." : undefined}>
        {(p) => <Input {...p} {...register("advertisingMethod")} />}
      </Field>
      {address && (
        <>
          <h3 className="pt-2 text-sm font-semibold sm:col-span-2">Trading address</h3>
          <Field label="Address" className="sm:col-span-2">{(p) => <Input {...p} {...register("line1")} />}</Field>
          <Field label="Town / city">{(p) => <Input {...p} {...register("city")} />}</Field>
          <Field label="County">{(p) => <Input {...p} {...register("county")} />}</Field>
          <Field label="Eircode / postcode">{(p) => <Input {...p} {...register("postcode")} />}</Field>
        </>
      )}
    </div>
  );
}
