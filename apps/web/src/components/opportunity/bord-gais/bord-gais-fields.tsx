"use client";

import {
  BORD_GAIS_BILLING_SOURCES,
  BORD_GAIS_BILLING_SOURCE_LABELS,
  BORD_GAIS_COMMITMENTS,
  BORD_GAIS_DISCOUNT_CELLS,
  BORD_GAIS_ORG_TYPES,
  BORD_GAIS_ORG_TYPE_LABELS,
  BORD_GAIS_RATE_COLUMNS,
  BORD_GAIS_RATE_COLUMN_LABELS,
  BORD_GAIS_RATE_ROWS,
  BORD_GAIS_RATE_ROW_LABELS,
  BORD_GAIS_RATE_TYPE_LABELS,
  BORD_GAIS_REGISTERS,
  BORD_GAIS_REGISTER_LABELS,
  type BordGaisBillingSource,
  type BordGaisElectricityData,
  type BordGaisIssue,
  type BordGaisRegister,
  LEGAL_ENTITY_LABELS,
  type LegalEntity,
  PRICE_TYPES,
  type PriceType,
  RATE_ROW_FOR,
  bordGaisConfirmationEnd,
  bordGaisMonthEnd,
  bordGaisMonthLabel,
  discountCell,
  needsCroNumber,
  needsHomeAddress,
  rateUnit,
} from "@uo/shared";
import { Button, Card, CardHeader, Checkbox, Field, Input, Select } from "@/components/ui/primitives";
import { AddressFields, Num, Section, TabSummary, Text } from "../supplier-application/fields";
import type { BankEdit } from "../supplier-application/types";
import type { BordGaisView } from "./draft";

export interface TabProps {
  view: BordGaisView;
  d: BordGaisElectricityData;
  set: (patch: Partial<BordGaisElectricityData>) => void;
  /** The error for a field, once the user has asked to validate. */
  err: (path: string) => string | undefined;
  issues: BordGaisIssue[];
  ro: boolean;
}

// --- Account holder ---------------------------------------------------------------------

export function AccountTab({ view, d, set, err, issues, ro }: TabProps) {
  const noCustomerWrite = ro || !view.permissions.customerWrite;
  const typeOptions: LegalEntity[] = d.organisationType && !(BORD_GAIS_ORG_TYPES as readonly string[]).includes(d.organisationType) ? [...BORD_GAIS_ORG_TYPES, d.organisationType] : [...BORD_GAIS_ORG_TYPES];
  return (
    <div className="space-y-4">
      <TabSummary issues={issues} />
      {!ro && noCustomerWrite && <p className="text-sm text-muted">You can't change customer details; ask someone who can edit customers.</p>}
      <Section title="Account holder" description="Saved to the customer record, so every form and quote uses the same details.">
        <Text label="Legal name" required value={d.legalName} onChange={(v) => set({ legalName: v })} error={err("legalName")} disabled={noCustomerWrite} />
        <Text label="Trading as (if different)" value={d.tradingName} onChange={(v) => set({ tradingName: v })} disabled={noCustomerWrite} />
        <Text label="Account holder's name" value={d.accountHolderName} onChange={(v) => set({ accountHolderName: v })} disabled={ro} hint={view.answered.includes("accountHolderName") ? undefined : "The legal name until you change it."} />
        <Text label="Main business activity" maxLength={100} value={d.mainActivity} onChange={(v) => set({ mainActivity: v })} disabled={noCustomerWrite} />
        <Field label="Date established">{(p) => <Input {...p} type="date" disabled={noCustomerWrite} value={d.dateEstablished ?? ""} onChange={(e) => set({ dateEstablished: e.target.value || null })} />}</Field>
        <Field label="Organisation type" required error={err("organisationType")}>
          {(p) => (
            <Select {...p} disabled={noCustomerWrite} value={d.organisationType ?? ""} onChange={(e) => set({ organisationType: (e.target.value || null) as LegalEntity | null })}>
              <option value="">Choose…</option>
              {typeOptions.map((t) => (
                <option key={t} value={t}>
                  {(BORD_GAIS_ORG_TYPE_LABELS as Record<string, string>)[t] ?? `${LEGAL_ENTITY_LABELS[t]} (not on the Bord Gáis form)`}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {needsCroNumber(d.organisationType) && <Text label="CRO number" required maxLength={30} value={d.croNumber} onChange={(v) => set({ croNumber: v })} error={err("croNumber")} disabled={noCustomerWrite} />}
        <Num label="Number of employees" step="1" value={d.employees} onChange={(v) => set({ employees: v === null ? null : Math.round(v) })} disabled={noCustomerWrite} />
        <AddressFields legend="Account holder's address" required value={d.accountAddress} onChange={(a) => set({ accountAddress: a })} error={err("accountAddress")} disabled={noCustomerWrite} />
        {needsHomeAddress(d.organisationType) && <AddressFields legend="Home address" required value={d.homeAddress} onChange={(a) => set({ homeAddress: a })} error={err("homeAddress")} disabled={noCustomerWrite} />}
      </Section>
      <Section title="Contact" description="The customer's primary contact.">
        <Text label="First name" required maxLength={100} value={d.contactFirstName} onChange={(v) => set({ contactFirstName: v })} error={err("contactName")} disabled={noCustomerWrite} />
        <Text label="Surname" maxLength={100} value={d.contactLastName} onChange={(v) => set({ contactLastName: v })} disabled={noCustomerWrite} />
        <Text label="Position" maxLength={100} value={d.position} onChange={(v) => set({ position: v })} disabled={noCustomerWrite} />
        <Text label="Email" type="email" inputMode="email" value={d.email} onChange={(v) => set({ email: v })} error={err("email")} disabled={noCustomerWrite} hint="Email or telephone is needed." />
        <Text label="Telephone" type="tel" inputMode="tel" maxLength={40} value={d.telephone} onChange={(v) => set({ telephone: v })} disabled={noCustomerWrite} />
        <Text label="Mobile" type="tel" inputMode="tel" maxLength={40} value={d.mobile} onChange={(v) => set({ mobile: v })} disabled={noCustomerWrite} />
      </Section>
    </div>
  );
}

// --- Premises and billing ----------------------------------------------------------------

export function PremisesTab({ view, d, set, err, issues, ro }: TabProps) {
  const noCustomerWrite = ro || !view.permissions.customerWrite;
  const defaults = !view.answered.includes("premisesContact");
  return (
    <div className="space-y-4">
      <TabSummary issues={issues} />
      <Section title="Premises to be supplied">
        <Text label="Site name" maxLength={120} value={d.siteName} onChange={(v) => set({ siteName: v })} disabled={ro} />
        <Field label="Priority customer">
          {(p) => (
            <Select {...p} disabled={noCustomerWrite} value={d.priorityCustomer === null ? "" : d.priorityCustomer ? "yes" : "no"} onChange={(e) => set({ priorityCustomer: e.target.value === "" ? null : e.target.value === "yes" })}>
              <option value="">Not answered</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          )}
        </Field>
        <AddressFields legend="Supply address" required value={d.supplyAddress} onChange={(a) => set({ supplyAddress: a })} error={err("supplyAddress")} disabled={ro} />
        <Text label="Contact name" maxLength={200} value={d.premisesContactName} onChange={(v) => set({ premisesContactName: v })} disabled={ro} hint={defaults ? "The account contact until you change it." : undefined} />
        <Text label="Telephone" type="tel" inputMode="tel" maxLength={40} value={d.premisesTelephone} onChange={(v) => set({ premisesTelephone: v })} disabled={ro} />
        <Text label="Fax" type="tel" inputMode="tel" maxLength={40} value={d.premisesFax} onChange={(v) => set({ premisesFax: v })} disabled={ro} />
        <Text label="Email" type="email" inputMode="email" value={d.premisesEmail} onChange={(v) => set({ premisesEmail: v })} disabled={ro} />
        <Text label="Mobile" type="tel" inputMode="tel" maxLength={40} value={d.premisesMobile} onChange={(v) => set({ premisesMobile: v })} disabled={ro} />
      </Section>
      <Section title="Address to send the bill to">
        <Text label="Billing contact name" maxLength={200} value={d.billingContactName} onChange={(v) => set({ billingContactName: v })} disabled={ro} />
        <Field label="Send the bill to">
          {(p) => (
            <Select {...p} disabled={ro} value={d.billingSource} onChange={(e) => set({ billingSource: e.target.value as BordGaisBillingSource })}>
              {BORD_GAIS_BILLING_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {BORD_GAIS_BILLING_SOURCE_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {d.billingSource === "separate" && <AddressFields legend="Billing address" required value={d.billingAddress} onChange={(a) => set({ billingAddress: a })} error={err("billingAddress")} disabled={noCustomerWrite} />}
      </Section>
    </div>
  );
}

// --- Supply and meters ------------------------------------------------------------------

export function SupplyTab({ d, set, err, issues, ro }: TabProps) {
  const reading = (i: 0 | 1, r: BordGaisRegister, v: string) => {
    const meters = [...d.meters] as BordGaisElectricityData["meters"];
    meters[i] = { ...meters[i], readings: { ...meters[i].readings, [r]: v.trim() === "" ? null : v.trim() } };
    set({ meters });
  };
  const serial = (i: 0 | 1, v: string | null) => {
    const meters = [...d.meters] as BordGaisElectricityData["meters"];
    meters[i] = { ...meters[i], serial: v?.toUpperCase() ?? null };
    set({ meters });
  };
  return (
    <div className="space-y-4">
      <TabSummary issues={issues} />
      <Section title="Supply details" description="From a current electricity bill. Saved to the site's meter point.">
        <Text label="Customer MPRN" required inputMode="numeric" maxLength={20} value={d.mprn} onChange={(v) => set({ mprn: v })} error={err("mprn")} disabled={ro} hint="11 digits, starting 10" />
        <Num label="MIC (kVA)" value={d.mic} onChange={(v) => set({ mic: v })} disabled={ro} />
        <Text label="DG code" maxLength={10} value={d.dgCode} onChange={(v) => set({ dgCode: v })} disabled={ro} />
        <Text label="Voltage" maxLength={20} value={d.voltage} onChange={(v) => set({ voltage: v })} disabled={ro} />
        <Text label="MCC" maxLength={10} value={d.mcc} onChange={(v) => set({ mcc: v })} disabled={ro} />
        <Text label="Profile class" maxLength={10} value={d.profileClass} onChange={(v) => set({ profileClass: v })} disabled={ro} />
        <Text label="Existing supplier" required maxLength={120} value={d.existingSupplier} onChange={(v) => set({ existingSupplier: v })} error={err("existingSupplier")} disabled={ro} />
        <Num label="Estimated annual consumption (kWh)" required step="1" value={d.annualConsumptionKwh} onChange={(v) => set({ annualConsumptionKwh: v })} error={err("annualConsumptionKwh")} disabled={ro} />
      </Section>
      <Card>
        <CardHeader title="Meter details" description="Up to two meters on this MPRN. Type readings as shown on the meter, leading zeroes included; a digit after the point goes in the box after the slash." />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          {([0, 1] as const).map((i) => (
            <fieldset key={i} className="min-w-0 space-y-3">
              <legend className="mb-2 text-sm font-medium">Meter {i + 1}</legend>
              <Text label={`Meter serial number ${i + 1}`} required={i === 0} maxLength={9} value={d.meters[i].serial} onChange={(v) => serial(i, v)} error={err(`meters.${i}.serial`)} disabled={ro} hint="Up to 9 characters" />
              {BORD_GAIS_REGISTERS.map((r) => (
                <Field key={r} label={`${BORD_GAIS_REGISTER_LABELS[r]} reading`} error={err(`meters.${i}.readings.${r}`)}>
                  {(p) => <Input {...p} inputMode="decimal" maxLength={8} disabled={ro} value={d.meters[i].readings[r] ?? ""} onChange={(e) => reading(i, r, e.target.value.replace(/[^0-9.]/g, ""))} />}
                </Field>
              ))}
            </fieldset>
          ))}
          <Field label="Date of the readings" error={err("readingDate")} hint="A changed reading is saved as a new reading; earlier ones are kept.">
            {(p) => <Input {...p} type="date" disabled={ro} value={d.readingDate ?? ""} onChange={(e) => set({ readingDate: e.target.value || null })} />}
          </Field>
        </div>
      </Card>
    </div>
  );
}

// --- Agreement and rates ------------------------------------------------------------------

export function AgreementTab({ view, d, set, err, issues, ro }: TabProps) {
  const locked = ro || !!view.contract?.readOnly;
  const confirmation = bordGaisConfirmationEnd({ ...d, confirmationEndDate: null });
  const primary = d.rateType ? RATE_ROW_FOR[d.rateType] : null;
  const setRate = (row: (typeof BORD_GAIS_RATE_ROWS)[number], col: (typeof BORD_GAIS_RATE_COLUMNS)[number], v: string) => {
    const n = v === "" ? null : Number(v);
    if (n !== null && (!Number.isFinite(n) || n < 0)) return;
    set({ rates: { ...d.rates, [row]: { ...d.rates[row], [col]: n } } });
  };
  return (
    <div className="space-y-4">
      <TabSummary issues={issues} />
      {view.contract?.readOnly && <p className="text-sm text-muted">The electricity contract is live or ended and kept as history, so its terms can't change here.</p>}
      <Section title="Agreement period" description="Saved on the deal's electricity contract.">
        <Text label="Price plan name" required maxLength={120} value={d.pricePlan} onChange={(v) => set({ pricePlan: v })} error={err("pricePlan")} disabled={locked} />
        <Field label="Commitment period" required error={err("commitmentMonths")}>
          {(p) => (
            <Select {...p} disabled={locked} value={d.commitmentMonths ? String(d.commitmentMonths) : ""} onChange={(e) => set({ commitmentMonths: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Choose…</option>
              {BORD_GAIS_COMMITMENTS.map((m) => (
                <option key={m} value={m}>
                  {m} months
                </option>
              ))}
              {d.commitmentMonths && !(BORD_GAIS_COMMITMENTS as readonly number[]).includes(d.commitmentMonths) && <option value={d.commitmentMonths}>{d.commitmentMonths} months (not offered)</option>}
            </Select>
          )}
        </Field>
        <Field label="Rate type" required error={err("rateType")}>
          {(p) => (
            <Select {...p} disabled={locked} value={d.rateType ?? ""} onChange={(e) => set({ rateType: (e.target.value || null) as PriceType | null })}>
              <option value="">Choose…</option>
              {PRICE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {BORD_GAIS_RATE_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Confirmation period end (month and year)" hint={confirmation ? `Calculated: ${bordGaisMonthLabel(confirmation)}. Change it only if Bord Gáis gave a different month.` : "Calculated from the start date and commitment period when both are known."}>
          {(p) => <Input {...p} type="month" disabled={ro} value={d.confirmationEndDate?.slice(0, 7) ?? ""} onChange={(e) => set({ confirmationEndDate: e.target.value ? bordGaisMonthEnd(e.target.value) : null })} />}
        </Field>
      </Section>

      <Card>
        <CardHeader
          title="Your rates"
          description={primary ? `Unit rates in cent per kWh, standing charge in cent per day. The ${BORD_GAIS_RATE_ROW_LABELS[primary]} row is saved on the contract.` : "Unit rates in cent per kWh, standing charge in cent per day. Choose the rate type to save its row on the contract."}
        />
        <div className="space-y-2 p-5">
          {err("rates") && (
            <p className="text-xs text-danger" role="alert">
              {err("rates")}
            </p>
          )}
          <div className="min-w-0 overflow-x-auto" tabIndex={0}>
            <table className="w-full min-w-[880px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="px-1 py-2 font-medium">Rate</th>
                  {BORD_GAIS_RATE_COLUMNS.map((c) => (
                    <th key={c} className="px-1 py-2 font-medium">
                      {BORD_GAIS_RATE_COLUMN_LABELS[c]} <span className="font-normal">({rateUnit(c)})</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {BORD_GAIS_RATE_ROWS.map((row) => (
                  <tr key={row} className={row === primary ? "bg-primary-soft/40" : undefined}>
                    <th scope="row" className="px-1 py-1 text-left font-medium">
                      {BORD_GAIS_RATE_ROW_LABELS[row]}
                    </th>
                    {BORD_GAIS_RATE_COLUMNS.map((col) => (
                      <td key={col} className="px-1 py-1">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          inputMode="decimal"
                          aria-label={`${BORD_GAIS_RATE_ROW_LABELS[row]}: ${BORD_GAIS_RATE_COLUMN_LABELS[col]}`}
                          disabled={locked}
                          className="h-8 w-20 rounded-md border border-border bg-surface px-2 text-sm"
                          value={d.rates[row][col] ?? ""}
                          onChange={(e) => setRate(row, col, e.target.value)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      {d.rateType === "variable" && (
        <Card>
          <CardHeader title="Discount" description="Selected variable price plans only, as a percentage. A shorter commitment has no later years." />
          <div className="min-w-0 overflow-x-auto p-5" tabIndex={0}>
            <table className="min-w-[420px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="px-1 py-2 font-medium">Commitment period</th>
                  {[12, 24, 36].map((m) => (
                    <th key={m} className="px-1 py-2 font-medium">
                      {m} months
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[1, 2, 3].map((year) => (
                  <tr key={year}>
                    <th scope="row" className="px-1 py-1 text-left font-medium">
                      Year {year} discount
                    </th>
                    {[12, 24, 36].map((months) => {
                      const cell = BORD_GAIS_DISCOUNT_CELLS.find((c) => discountCell(c).year === year && discountCell(c).months === months);
                      return (
                        <td key={months} className="px-1 py-1">
                          {cell ? (
                            <input
                              type="number"
                              min={0}
                              max={100}
                              step="0.01"
                              inputMode="decimal"
                              aria-label={`Year ${year} discount, ${months} months (%)`}
                              disabled={ro}
                              className="h-8 w-20 rounded-md border border-border bg-surface px-2 text-sm"
                              value={d.discounts[cell] ?? ""}
                              onChange={(e) => {
                                const n = e.target.value === "" ? null : Number(e.target.value);
                                if (n === null || (Number.isFinite(n) && n >= 0 && n <= 100)) set({ discounts: { ...d.discounts, [cell]: n } });
                              }}
                            />
                          ) : (
                            <span className="text-muted" aria-label="Not applicable">
                              —
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// --- Declaration and marketing ------------------------------------------------------------

const PREFERENCES: [keyof BordGaisElectricityData["marketing"], string][] = [
  ["email", "Email"],
  ["post", "Post"],
  ["phone", "Phone (including mobile)"],
  ["sms", "SMS"],
];

export function DeclarationTab({ view, d, set, err, issues, ro }: TabProps) {
  const noCustomerWrite = ro || !view.permissions.customerWrite;
  return (
    <div className="space-y-4">
      <TabSummary issues={issues} />
      <Section title="Customer declaration" description="The customer signs online when the version is sent; the signature and date are added when they sign.">
        <Text label="Signatory name" required maxLength={200} value={d.signatoryName} onChange={(v) => set({ signatoryName: v })} error={err("signatoryName")} disabled={ro} hint={view.answered.includes("signatoryName") ? undefined : "The account contact until you change it."} />
        <Field label="Agent's name" hint="The deal's salesperson.">{(p) => <Input {...p} disabled value={d.agentName ?? "Unassigned"} />}</Field>
      </Section>
      <Card>
        <CardHeader title="Marketing" description="Saved on the customer. On the form, a box is ticked when the customer does NOT want offers that way." />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          {err("marketing") && (
            <p className="text-xs text-danger sm:col-span-2" role="alert">
              {err("marketing")}
            </p>
          )}
          {PREFERENCES.map(([k, label]) => (
            <Field key={k} label={`Offers by ${label.toLowerCase()}`}>
              {(p) => (
                <Select
                  {...p}
                  disabled={noCustomerWrite}
                  value={d.marketing[k] === null ? "" : d.marketing[k] ? "yes" : "no"}
                  onChange={(e) => set({ marketing: { ...d.marketing, [k]: e.target.value === "" ? null : e.target.value === "yes" } })}
                >
                  <option value="">Not asked</option>
                  <option value="yes">Happy to receive</option>
                  <option value="no">Does not want (ticked on the form)</option>
                </Select>
              )}
            </Field>
          ))}
          <Field label="Broader marketing (products of the wider group and other companies)" hint="On the form this box is ticked when the customer would like to receive it." className="sm:col-span-2">
            {(p) => (
              <Select {...p} disabled={ro} value={d.broaderMarketing === null ? "" : d.broaderMarketing ? "yes" : "no"} onChange={(e) => set({ broaderMarketing: e.target.value === "" ? null : e.target.value === "yes" })}>
                <option value="">Not asked</option>
                <option value="yes">Would like to receive (ticked on the form)</option>
                <option value="no">Does not want</option>
              </Select>
            )}
          </Field>
        </div>
      </Card>
    </div>
  );
}

// --- SEPA direct debit ----------------------------------------------------------------------

export function DebitTab({ view, d, set, err, issues, ro, bank, setBank, confirmIban, setConfirmIban }: TabProps & { bank: BankEdit | null; setBank: (b: BankEdit | null) => void; confirmIban: boolean; setConfirmIban: (v: boolean) => void }) {
  const canWrite = !ro && view.permissions.bankWrite;
  return (
    <div className="space-y-4">
      <TabSummary issues={issues} />
      <Card className="p-5">
        <Checkbox label="The customer pays by SEPA direct debit" checked={d.directDebit} disabled={ro} onChange={(e) => set({ directDebit: e.target.checked })} />
      </Card>
      {d.directDebit && (
        <>
          <Card>
            <CardHeader title="SEPA Direct Debit mandate" description="Printed on the form." />
            <dl className="grid gap-2 p-5 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted">Creditor</dt>
                <dd>Bord Gáis Energy, One Warrington Place, Dublin 2</dd>
              </div>
              <div>
                <dt className="text-muted">Creditor identifier</dt>
                <dd>IE43SDD300249</dd>
              </div>
              <div>
                <dt className="text-muted">Type of payment</dt>
                <dd>Recurrent payment</dd>
              </div>
            </dl>
          </Card>
          <Card>
            <CardHeader title="Bank or building society account" description="Restricted. Changing it saves a new bank account; the old one is kept." />
            <div className="space-y-4 p-5">
              {d.bankOnFile ? (
                view.permissions.bankRead ? (
                  <dl className="grid gap-2 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-muted">Account holder</dt>
                      <dd>{d.bankAccountName}</dd>
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
              {!bank && ["iban", "bic", "bankAccountName"].map((k) => err(k)).filter(Boolean).map((m) => (
                <p key={m} className="text-xs text-danger" role="alert">
                  {m}
                </p>
              ))}
              {canWrite && !bank && (
                <Button size="sm" variant="secondary" onClick={() => setBank({ accountName: "", iban: "", bic: "" })}>
                  {d.bankOnFile ? "Enter new bank details" : "Enter bank details"}
                </Button>
              )}
              {bank && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Account holder name" required error={err("bankAccountName")}>
                    {(p) => <Input {...p} autoComplete="off" maxLength={200} value={bank.accountName} onChange={(e) => setBank({ ...bank, accountName: e.target.value })} />}
                  </Field>
                  <Field label="IBAN" required error={err("iban")}>
                    {(p) => <Input {...p} autoComplete="off" spellCheck={false} maxLength={42} value={bank.iban} onChange={(e) => setBank({ ...bank, iban: e.target.value.toUpperCase() })} />}
                  </Field>
                  <Field label="BIC" required error={err("bic")}>
                    {(p) => <Input {...p} autoComplete="off" maxLength={11} value={bank.bic} onChange={(e) => setBank({ ...bank, bic: e.target.value.toUpperCase() })} />}
                  </Field>
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
            <Text label="Unique mandate reference" maxLength={35} value={d.mandateReference} onChange={(v) => set({ mandateReference: v })} disabled={ro} hint="To be completed by Bord Gáis Energy: normally left blank." />
            <div className="sm:col-span-2 space-y-3">
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
              <p className="text-sm text-muted">Each account holder signs online when the version is sent; the mandate dates are added when they sign.</p>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
