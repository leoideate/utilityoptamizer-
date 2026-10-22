"use client";

import { Plus, Trash2 } from "lucide-react";
import {
  FLOGAS_ENTITY_BOX_LABELS,
  FLOGAS_MAX_METERS,
  FLOGAS_REQUIREMENTS,
  FLOGAS_REQUIREMENT_LABELS,
  FLOGAS_SECTORS,
  FLOGAS_SECTOR_LABELS,
  type FlogasElectricityData,
  type FlogasIssue,
  type FlogasTab,
  LEGAL_ENTITIES,
  LEGAL_ENTITY_LABELS,
  type LegalEntity,
  type FlogasSector,
  durationAtPremises,
  flogasEntityBox,
  ownsPremises,
} from "@uo/shared";
import { Button, Card, CardHeader, Checkbox, CheckboxGroup, Field, Input, Select } from "@/components/ui/primitives";
import { AddressFields, Num, Section, TabSummary, Text, YesNo } from "../supplier-application/fields";
import type { BankEdit, FlogasView } from "./draft";

export interface TabProps {
  view: FlogasView;
  d: FlogasElectricityData;
  set: (patch: Partial<FlogasElectricityData>) => void;
  /** The error for a field, once the user has asked to validate. */
  err: (path: string) => string | undefined;
  /** This tab's issues, for the summary at its top (empty until validated). */
  issues: FlogasIssue[];
  ro: boolean;
}

// --- Customer & Business ---------------------------------------------------------------

export function CustomerTab({ view, d, set, err, issues, ro }: TabProps) {
  const noCustomerWrite = ro || !view.permissions.customerWrite;
  const owns = ownsPremises(d.occupancyType);
  const duration = durationAtPremises(d.occupiedSince);
  return (
    <div className="space-y-4">
      <TabSummary issues={issues} />
      {!ro && noCustomerWrite && <p className="text-sm text-muted">You can't change customer details; ask someone who can edit customers.</p>}
      <Section title="The customer" description="Saved to the customer record, so every form and quote uses the same details.">
        <Text label="Legal entity name" required value={d.legalName} onChange={(v) => set({ legalName: v })} error={err("legalName")} disabled={noCustomerWrite} />
        <Text label="Trading name" value={d.tradingName} onChange={(v) => set({ tradingName: v })} disabled={noCustomerWrite} />
        <Field label="Legal entity type" required error={err("legalEntity")} hint={d.legalEntity ? `Ticks "${FLOGAS_ENTITY_BOX_LABELS[flogasEntityBox(d.legalEntity)!]}" on the form.` : undefined}>
          {(p) => (
            <Select {...p} disabled={noCustomerWrite} value={d.legalEntity ?? ""} onChange={(e) => set({ legalEntity: (e.target.value || null) as LegalEntity | null })}>
              <option value="">Choose…</option>
              {LEGAL_ENTITIES.map((e) => (
                <option key={e} value={e}>
                  {LEGAL_ENTITY_LABELS[e]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Text label="Business type" required value={d.businessType} maxLength={100} onChange={(v) => set({ businessType: v })} error={err("businessType")} disabled={noCustomerWrite} hint="e.g. Bakery, hotel, office" />
        <Text label="Company registration (CRO) number" value={d.companyRegNumber} maxLength={30} onChange={(v) => set({ companyRegNumber: v })} error={err("companyRegNumber")} disabled={noCustomerWrite} required={flogasEntityBox(d.legalEntity) === "company" && !d.vatNumber} />
        <Text label="VAT number" value={d.vatNumber} maxLength={30} onChange={(v) => set({ vatNumber: v })} disabled={noCustomerWrite} />
        <YesNo label="VAT exempt" value={d.vatExempt} onChange={(v) => set({ vatExempt: v })} disabled={noCustomerWrite} />
        {d.vatExempt && <Text label="VAT exempt number" required maxLength={40} value={d.vatExemptNumber} onChange={(v) => set({ vatExemptNumber: v })} error={err("vatExemptNumber")} disabled={noCustomerWrite} />}
        <YesNo
          label="Priority / special needs"
          value={d.priorityCustomer}
          onChange={(v) => set({ priorityCustomer: v })}
          disabled={noCustomerWrite}
          hint="Is anyone at the supply address dependent on life support electrical medical equipment? Flogas sends a priority registration form if yes."
        />
      </Section>

      <Section title="Addresses">
        <AddressFields legend="Supply address" required value={d.supplyAddress} onChange={(a) => set({ supplyAddress: a })} error={err("supplyAddress")} disabled={ro} />
        <div className="sm:col-span-2">
          <Checkbox label="Bills go to the supply address" checked={d.billingSameAsSupply} disabled={ro} onChange={(e) => set({ billingSameAsSupply: e.target.checked })} />
        </div>
        {!d.billingSameAsSupply && <AddressFields legend="Billing address" required value={d.billingAddress} onChange={(a) => set({ billingAddress: a })} error={err("billingAddress")} disabled={noCustomerWrite} />}
      </Section>

      <Section title="Account contact" description="The customer's primary contact.">
        <Text label="First name" required value={d.contactFirstName} maxLength={100} onChange={(v) => set({ contactFirstName: v })} error={err("contactName")} disabled={noCustomerWrite} autoComplete="off" />
        <Text label="Surname" value={d.contactLastName} maxLength={100} onChange={(v) => set({ contactLastName: v })} disabled={noCustomerWrite} />
        <Text label="Telephone" type="tel" inputMode="tel" maxLength={40} value={d.telephone} onChange={(v) => set({ telephone: v })} disabled={noCustomerWrite} />
        <Text label="Mobile" type="tel" inputMode="tel" maxLength={40} value={d.mobile} onChange={(v) => set({ mobile: v })} disabled={noCustomerWrite} />
        <Text label="Email" required type="email" inputMode="email" value={d.email} onChange={(v) => set({ email: v })} error={err("email")} disabled={noCustomerWrite} />
      </Section>

      <Section title="The supply premises">
        <YesNo
          label="Does the customer own the supply premises?"
          required
          value={owns}
          error={err("occupancyType")}
          disabled={ro}
          onChange={(v) => set({ occupancyType: v === null ? null : v ? "owner_occupied" : d.occupancyType === "landlord_supply" ? "landlord_supply" : "rented" })}
        />
        <Field label="Moved in on" hint={duration ? `Printed as ${duration.years} year${duration.years === 1 ? "" : "s"} ${duration.months} month${duration.months === 1 ? "" : "s"}.` : "The form shows the years and months since."}>
          {(p) => <Input {...p} type="date" disabled={ro} value={d.occupiedSince ?? ""} onChange={(e) => set({ occupiedSince: e.target.value || null })} />}
        </Field>
        {owns === false && (
          <>
            <Text label="Terms of lease" value={d.leaseTerms} maxLength={40} onChange={(v) => set({ leaseTerms: v })} disabled={ro} hint="Short, e.g. 10 years: the box on the form is small." />
            <Text label="Landlord / agent name" required value={d.landlordName} onChange={(v) => set({ landlordName: v })} error={err("landlordName")} disabled={ro} />
            <Text label="Landlord / agent contact number" required type="tel" inputMode="tel" value={d.landlordContact} onChange={(v) => set({ landlordContact: v })} error={err("landlordContact")} disabled={ro} />
          </>
        )}
      </Section>
    </div>
  );
}

// --- Supply & Meter ---------------------------------------------------------------------

export function SupplyTab({ view, d, set, err, issues, ro }: TabProps) {
  const answered = (k: string) => view.answered.includes(k);
  const dayLabel = d.sector === "gp_24h" ? "24-hour reading" : "Day reading";
  const updateMeter = (i: number, patch: Partial<FlogasElectricityData["meters"][number]>) => set({ meters: d.meters.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  return (
    <div className="space-y-4">
      <TabSummary issues={issues} />
      <Card>
        <CardHeader title="Actual requirement" description={answered("requirements") ? undefined : "Suggested from the opportunity's supply changes and sale type until you change it."} />
        <div className="p-5">
          <CheckboxGroup legend="Tick what applies" options={FLOGAS_REQUIREMENTS} labels={FLOGAS_REQUIREMENT_LABELS} value={d.requirements} disabled={ro} onChange={(v) => set({ requirements: v })} />
          {err("requirements") && (
            <p className="mt-2 text-xs text-danger" role="alert">
              {err("requirements")}
            </p>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Meter points"
          description="The first row is the main supply on page 1; every row is listed in the MPRN/MCC table on page 2."
          actions={
            !ro && (
              <Button size="sm" variant="secondary" disabled={d.meters.length >= FLOGAS_MAX_METERS} onClick={() => set({ meters: [...d.meters, { id: null, mprn: null, mccCode: null, formatException: false, day: null, night: null, wattless: null }] })}>
                <Plus /> Add meter
              </Button>
            )
          }
        />
        <ol className="divide-y divide-border">
          {d.meters.map((m, i) => (
            <li key={m.id ?? `new-${i}`} className="space-y-3 px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">{i === 0 ? "Main supply" : `Meter ${i + 1}`}</p>
                {!ro && (
                  <Button size="sm" variant="ghost" disabled={d.meters.length <= 1} title={d.meters.length <= 1 ? "Keep at least one meter row." : m.id ? "Left off this application; the meter stays on the deal." : undefined} onClick={() => set({ meters: d.meters.filter((_, j) => j !== i) })}>
                    <Trash2 /> Remove
                  </Button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Text label="MPRN" required inputMode="numeric" maxLength={20} value={m.mprn} onChange={(v) => updateMeter(i, { mprn: v })} error={err(`meters.${i}.mprn`)} disabled={ro} hint="11 digits, starting 10" />
                <Text label="MCC code" maxLength={10} value={m.mccCode} onChange={(v) => updateMeter(i, { mccCode: v })} disabled={ro} />
                <Num label={dayLabel} step="1" value={m.day} onChange={(v) => updateMeter(i, { day: v })} disabled={ro} />
                {d.sector !== "gp_24h" && <Num label="Night reading" step="1" value={m.night} onChange={(v) => updateMeter(i, { night: v })} disabled={ro} />}
                {i === 0 && <Num label="Wattless reading" step="1" value={m.wattless} onChange={(v) => updateMeter(i, { wattless: v })} disabled={ro} />}
              </div>
            </li>
          ))}
        </ol>
        {err("meters") && (
          <p className="px-5 pb-4 text-xs text-danger" role="alert">
            {err("meters")}
          </p>
        )}
        <div className="grid gap-4 border-t border-border p-5 sm:grid-cols-2">
          <Field label="Date of reading" error={err("readingDate")} hint="A changed reading is saved as a new reading; earlier ones are kept.">
            {(p) => <Input {...p} type="date" disabled={ro} value={d.readingDate ?? ""} onChange={(e) => set({ readingDate: e.target.value || null })} />}
          </Field>
        </div>
      </Card>

      <Section title="Flogas account and dates">
        <YesNo label="Existing Flogas customer" value={d.existingFlogasCustomer} onChange={(v) => set({ existingFlogasCustomer: v })} disabled={ro} />
        {d.existingFlogasCustomer && <Text label="Existing account / GPRN number" maxLength={40} value={d.existingFlogasAccount} onChange={(v) => set({ existingFlogasAccount: v })} disabled={ro} />}
        <Field label="Expected changeover date">{(p) => <Input {...p} type="date" disabled={ro || !!view.contract?.readOnly} value={d.expectedChangeover ?? ""} onChange={(e) => set({ expectedChangeover: e.target.value || null })} />}</Field>
        <CommitmentField d={d} set={set} disabled={ro || !!view.contract?.readOnly} />
      </Section>
    </div>
  );
}

function CommitmentField({ d, set, disabled }: { d: FlogasElectricityData; set: TabProps["set"]; disabled: boolean }) {
  return <Num label="Commitment period (months)" step="1" value={d.termMonths} onChange={(v) => set({ termMonths: v === null ? null : Math.round(v) || null })} disabled={disabled} hint="Flogas takes 12 months unless stated." />;
}

// --- Pricing & Contract ----------------------------------------------------------------

export function PricingTab({ view, d, set, err, issues, ro }: TabProps) {
  const locked = ro || !!view.contract?.readOnly;
  return (
    <div className="space-y-4">
      <TabSummary issues={issues} />
      {view.contract?.readOnly && <p className="text-sm text-muted">The electricity contract is live or ended and kept as history, so its prices can't change here.</p>}
      <Section title="Sector and pricing" description="Prices are saved on the deal's electricity contract.">
        <Field label="Sector" required error={err("sector")} hint={view.answered.includes("sector") ? undefined : "Suggested from the contract's rates until you choose."}>
          {(p) => (
            <Select
              {...p}
              disabled={ro}
              value={d.sector ?? ""}
              onChange={(e) => {
                const sector = (e.target.value || null) as FlogasSector | null;
                set({ sector, ...(sector === "gp_24h" ? { nightRateCent: null } : {}) });
              }}
            >
              <option value="">Choose…</option>
              {FLOGAS_SECTORS.map((s) => (
                <option key={s} value={s}>
                  {FLOGAS_SECTOR_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Pricing" required={d.sector !== "lvmd"} error={err("priceType")}>
          {(p) => (
            <Select {...p} disabled={locked} value={d.priceType === "fully_fixed" ? "fully_fixed" : (d.priceType ?? "")} onChange={(e) => set({ priceType: (e.target.value || null) as FlogasElectricityData["priceType"] })}>
              <option value="">Choose…</option>
              <option value="fixed">Fixed</option>
              {d.priceType === "fully_fixed" && <option value="fully_fixed">Fixed (fully fixed)</option>}
              <option value="variable">Variable</option>
            </Select>
          )}
        </Field>
        {d.sector === "gp_24h" && <Num label="GP 24HR unit day rate (cent per kWh)" required value={d.dayRateCent} onChange={(v) => set({ dayRateCent: v })} error={err("dayRateCent")} disabled={locked} hint="Up to 2 decimal places, e.g. 21.45" />}
        {d.sector === "gp_night_saver" && (
          <>
            <Num label="GP Night Saver unit day rate (cent per kWh)" required value={d.dayRateCent} onChange={(v) => set({ dayRateCent: v })} error={err("dayRateCent")} disabled={locked} hint="Up to 2 decimal places" />
            <Num label="GP Night Saver unit night rate (cent per kWh)" required value={d.nightRateCent} onChange={(v) => set({ nightRateCent: v })} error={err("nightRateCent")} disabled={locked} hint="Up to 2 decimal places" />
          </>
        )}
        {d.sector === "lvmd" && <p className="text-sm text-muted sm:col-span-2">LVMD prices are as per the LVMD Energy Rates Contract, so no unit rates go on this form.</p>}
        <CommitmentField d={d} set={set} disabled={locked} />
      </Section>
    </div>
  );
}

// --- Direct Debit -------------------------------------------------------------------------

export function DebitTab({ view, d, set, err, issues, ro, bank, setBank, confirmIban, setConfirmIban }: TabProps & { bank: BankEdit | null; setBank: (b: BankEdit | null) => void; confirmIban: boolean; setConfirmIban: (v: boolean) => void }) {
  const canWrite = !ro && view.permissions.bankWrite;
  const billing = d.billingSameAsSupply ? "the supply address" : "the billing address";
  return (
    <div className="space-y-4">
      <TabSummary issues={issues} />
      <Card className="p-5">
        <Checkbox label="The customer pays by SEPA direct debit (page 2 of the form)" checked={d.directDebit} disabled={ro} onChange={(e) => set({ directDebit: e.target.checked })} />
      </Card>
      {d.directDebit && (
        <>
          <Card>
            <CardHeader title="Bank account" description="Restricted. Changing it saves a new bank account; the old one is kept." />
            <div className="space-y-4 p-5">
              {d.bankOnFile ? (
                view.permissions.bankRead ? (
                  <dl className="grid gap-2 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-muted">Debtor name</dt>
                      <dd>{d.debtorName}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">IBAN</dt>
                      <dd className="break-all">{d.iban}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">BIC</dt>
                      <dd>{d.bic ?? "—"}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="text-sm">Bank account ending {d.ibanLast4} is on file. Its details are restricted.</p>
                )
              ) : (
                <p className="text-sm text-muted">No bank account on file yet.</p>
              )}
              {err("iban") && !bank && (
                <p className="text-xs text-danger" role="alert">
                  {err("iban")}
                </p>
              )}
              {canWrite && !bank && (
                <Button size="sm" variant="secondary" onClick={() => setBank({ accountName: "", iban: "", bic: "" })}>
                  {d.bankOnFile ? "Enter new bank details" : "Enter bank details"}
                </Button>
              )}
              {bank && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Debtor (account holder) name" required error={err("debtorName")}>
                    {(p) => <Input {...p} autoComplete="off" maxLength={200} value={bank.accountName} onChange={(e) => setBank({ ...bank, accountName: e.target.value })} />}
                  </Field>
                  <Field label="IBAN" required error={err("iban")}>
                    {(p) => <Input {...p} autoComplete="off" spellCheck={false} maxLength={42} value={bank.iban} onChange={(e) => setBank({ ...bank, iban: e.target.value.toUpperCase() })} />}
                  </Field>
                  <Field label="BIC">{(p) => <Input {...p} autoComplete="off" maxLength={11} value={bank.bic} onChange={(e) => setBank({ ...bank, bic: e.target.value.toUpperCase() })} />}</Field>
                  {d.bankOnFile && <Checkbox className="sm:col-span-3" label="I've confirmed the new bank details with the customer" checked={confirmIban} onChange={(e) => setConfirmIban(e.target.checked)} />}
                  <div className="sm:col-span-3">
                    <Button size="sm" variant="ghost" onClick={() => (setBank(null), setConfirmIban(false))}>
                      Keep the details on file
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </Card>

          <Section title="Mandate">
            <div className="sm:col-span-2">
              <Checkbox label={`The debtor address is ${billing}`} checked={d.debtorAddressSameAsBilling} disabled={!canWrite} onChange={(e) => set({ debtorAddressSameAsBilling: e.target.checked })} />
            </div>
            {!d.debtorAddressSameAsBilling && <AddressFields legend="Debtor address (restricted)" required value={d.debtorAddress} onChange={(a) => set({ debtorAddress: a })} error={err("debtorAddress")} disabled={!canWrite} />}
            <Field label="Payment type">{(p) => <Input {...p} value="Recurrent" disabled />}</Field>
            <Text label="Unique mandate reference" maxLength={35} value={d.mandateReference} onChange={(v) => set({ mandateReference: v })} disabled={ro} hint="For Flogas office use: normally left blank." />
          </Section>

          <Card>
            <CardHeader title="Account holders' signatures" description="Each account holder signs online when the application is sent; the date is filled in when they sign." />
            <div className="space-y-4 p-5">
              <Checkbox
                label="Joint account: a second account holder signs the mandate too"
                checked={!!d.secondAccountHolder}
                disabled={ro}
                onChange={(e) => set({ secondAccountHolder: e.target.checked ? { name: null, email: null } : null })}
              />
              {d.secondAccountHolder && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Text label="Second account holder's name" required maxLength={120} value={d.secondAccountHolder.name} onChange={(v) => set({ secondAccountHolder: { ...d.secondAccountHolder!, name: v } })} error={err("secondAccountHolder.name")} disabled={ro} />
                  <Text label="Their email (for the signing link)" required type="email" inputMode="email" value={d.secondAccountHolder.email} onChange={(v) => set({ secondAccountHolder: { ...d.secondAccountHolder!, email: v } })} error={err("secondAccountHolder.email")} disabled={ro} />
                </div>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

export const TAB_ORDER: FlogasTab[] = ["customer", "supply", "pricing", "debit", "documents"];
