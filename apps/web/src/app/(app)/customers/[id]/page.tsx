"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Eye, GitMerge, Landmark, Lock, Plus } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { CustomerFields, type CustomerFormValues, emptyCustomer, formAddresses, needsHomeAddress, toCustomerPayload, toYesNo } from "@/components/customer-form";
import { OutcomeBadge, ServiceBadge } from "@/components/domain";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, IssueList, PageHeader, Skeleton } from "@/components/ui/primitives";
import { CONTACT_TITLES } from "@uo/shared";
import { type ApiError, api } from "@/lib/api";
import { date, isoDay, ref } from "@/lib/format";
import { useCan } from "@/lib/session";
import type { Page } from "@/lib/types";

interface Profile {
  id: string;
  legalName: string;
  tradingName: string | null;
  businessType: string | null;
  industry: string | null;
  companyRegNumber: string | null;
  vatRegistered: string | null;
  vatNumber: string | null;
  incorporationDate: string | null;
  countryOfIncorporation: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  advertisingMethod: string | null;
  legalEntity: string | null;
  employees: number | null;
  vatExempt: boolean | null;
  vatExemptNumber: string | null;
  carbonTaxExempt: boolean | null;
  charityNumber: string | null;
  priorityCustomer: boolean | null;
  paperlessBilling: boolean | null;
  marketingEmail: boolean | null;
  marketingPost: boolean | null;
  marketingPhone: boolean | null;
  marketingSms: boolean | null;
  active: boolean;
  mergedInto: { id: string; legalName: string } | null;
  addresses: { id: string; kind: string; line1: string; line2: string | null; city: string | null; county: string | null; postcode: string | null; country: string }[];
  contacts: Contact[];
  sites: { id: string; label: string | null; line1: string; meterPoints: { id: string; fuel: string; mprn: string | null; gprn: string | null }[] }[];
  bankAccounts: { id: string; ibanLast4: string; createdAt: string }[];
  /** Supply points this customer has occupied (change of entity history), including ones since taken over. */
  occupancies: { id: string; fromDate: string | null; recordedAt: string; site: { id: string; label: string | null; line1: string; customerId: string | null; meterPoints: { mprn: string | null; gprn: string | null }[] } }[];
  opportunities: { id: string; number: number; name: string; serviceType: "electricity"; saleType: string; outcome: "open"; stage: { name: string }; owner: { name: string } | null; createdAt: string }[];
  /** One line per meter and supplier: a customer can be with several suppliers, and change over time. */
  supplies: {
    id: string;
    fuel: "electricity" | "gas";
    meter: string | null;
    supplier: string | null;
    product: string | null;
    startDate: string | null;
    endDate: string | null;
    status: string;
    applicationStatus: string | null;
    opportunityId: string;
    opportunityNumber: number;
  }[];
  canReadBank: boolean;
}

interface Contact {
  id: string;
  title: string | null;
  firstName: string;
  lastName: string | null;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  isPrimary: boolean;
}

function toForm(p: Profile): CustomerFormValues {
  const a = p.addresses.find((x) => x.kind === "trading") ?? p.addresses.find((x) => x.kind !== "home");
  const home = p.addresses.find((x) => x.kind === "home");
  return {
    ...emptyCustomer,
    legalName: p.legalName,
    tradingName: p.tradingName ?? "",
    businessType: p.businessType ?? "",
    industry: p.industry ?? "",
    companyRegNumber: p.companyRegNumber ?? "",
    vatRegistered: p.vatRegistered ?? "",
    vatNumber: p.vatNumber ?? "",
    incorporationDate: isoDay(p.incorporationDate),
    countryOfIncorporation: p.countryOfIncorporation ?? "",
    website: p.website ?? "",
    phone: p.phone ?? "",
    email: p.email ?? "",
    advertisingMethod: p.advertisingMethod ?? "",
    legalEntity: p.legalEntity ?? "",
    employees: p.employees == null ? "" : String(p.employees),
    vatExempt: toYesNo(p.vatExempt),
    vatExemptNumber: p.vatExemptNumber ?? "",
    carbonTaxExempt: toYesNo(p.carbonTaxExempt),
    charityNumber: p.charityNumber ?? "",
    priorityCustomer: toYesNo(p.priorityCustomer),
    paperlessBilling: toYesNo(p.paperlessBilling),
    marketingEmail: toYesNo(p.marketingEmail),
    marketingPost: toYesNo(p.marketingPost),
    marketingPhone: toYesNo(p.marketingPhone),
    marketingSms: toYesNo(p.marketingSms),
    line1: a?.line1 ?? "",
    city: a?.city ?? "",
    county: a?.county ?? "",
    postcode: a?.postcode ?? "",
    homeLine1: home?.line1 ?? "",
    homeCity: home?.city ?? "",
    homeCounty: home?.county ?? "",
    homePostcode: home?.postcode ?? "",
  };
}

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["customer", id], queryFn: () => api.get<Profile>(`/customers/${id}`) });
  const form = useForm<CustomerFormValues>({ defaultValues: emptyCustomer });
  useEffect(() => {
    if (data) form.reset(toForm(data));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [issues, setIssues] = useState<string[]>([]);
  const [dialog, setDialog] = useState<null | "contact" | "bank" | "merge">(null);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [revealed, setRevealed] = useState<Record<string, { accountName: string; iban: string; bic: string | null }>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: ["customer", id] });
  const save = useMutation({
    meta: { silent: true },
    mutationFn: (v: CustomerFormValues) => {
      const payload = toCustomerPayload(v, false);
      // The API replaces the whole address list: send back the kinds this form doesn't edit (billing, registered…).
      const all = data?.addresses ?? [];
      const shownAsTrading = all.find((x) => x.kind === "trading") ?? all.find((x) => x.kind !== "home");
      const kept = all.filter((x) => x !== shownAsTrading && !(x.kind === "home" && needsHomeAddress(v.legalEntity))).map(({ id: _id, ...rest }) => rest);
      return api.patch(`/customers/${id}`, { ...payload, addresses: [...kept, ...formAddresses(v)] });
    },
    onSuccess: () => (setIssues([]), refresh()),
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  const reveal = useMutation({ mutationFn: (bankId: string) => api.get<{ id: string; accountName: string; iban: string; bic: string | null }>(`/bank-accounts/${bankId}`), onSuccess: (r) => setRevealed((x) => ({ ...x, [r.id]: r })) });

  if (isLoading || !data) return <Skeleton className="h-96" />;

  return (
    <>
      <Link href="/customers" className="mb-3 inline-flex min-h-6 items-center gap-1 py-1 text-sm text-muted hover:text-text">
        <ArrowLeft className="size-4" /> Customers
      </Link>
      <PageHeader
        title={data.legalName}
        description={[data.tradingName && `Trading as ${data.tradingName}`, data.companyRegNumber && `CRO ${data.companyRegNumber}`, data.vatNumber && `VAT ${data.vatNumber}`].filter(Boolean).join(" · ") || undefined}
        actions={
          <>
            {can("customer.merge") && !data.mergedInto && (
              <Button variant="secondary" onClick={() => setDialog("merge")}>
                <GitMerge /> Merge a duplicate
              </Button>
            )}
            <Button asChild>
              <Link href={`/opportunities/new?customerId=${data.id}&company=${encodeURIComponent(data.legalName)}`}>
                <Plus /> New lead
              </Link>
            </Button>
          </>
        }
      />
      {data.mergedInto && (
        <p className="mb-4 rounded-lg bg-warning-soft px-4 py-3 text-sm text-warning">
          This record was merged into <Link className="underline" href={`/customers/${data.mergedInto.id}`}>{data.mergedInto.legalName}</Link>. It's kept for history.
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          {data.supplies.length > 0 && (
            <Card>
              <CardHeader
                title={`Supplies and contracts (${data.supplies.length})`}
                description={(() => {
                  const suppliers = [...new Set(data.supplies.filter((s) => s.status !== "ended").map((s) => s.supplier).filter(Boolean))];
                  return suppliers.length > 1 ? `With ${suppliers.length} suppliers: ${suppliers.join(", ")}.` : "Every meter, its supplier and contract, current first.";
                })()}
              />
              <div className="overflow-x-auto" tabIndex={0}>
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="bg-surface-2 text-left text-muted">
                    <tr>
                      {["MPRN/GPRN", "Utility", "Supplier", "Product", "Start", "Expiry", "Status", "Deal"].map((h, i) => (
                        <th key={h} className={i === 0 ? "px-5 py-2.5 font-medium" : "px-3 py-2.5 font-medium"}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.supplies.map((s) => (
                      <tr key={s.id} className="border-t border-border">
                        <td className="tabular px-5 py-2.5">{s.meter ?? <span className="text-warning">Missing</span>}</td>
                        <td className="px-3 py-2.5 capitalize">{s.fuel}</td>
                        <td className="px-3 py-2.5">{s.supplier ?? "—"}</td>
                        <td className="px-3 py-2.5">{s.product ?? "—"}</td>
                        <td className="px-3 py-2.5">{date(s.startDate)}</td>
                        <td className="px-3 py-2.5">{date(s.endDate)}</td>
                        <td className="px-3 py-2.5">
                          <Badge tone={s.status === "live" ? "success" : s.status === "ended" ? "neutral" : "info"}>{s.applicationStatus ?? s.status.charAt(0).toUpperCase() + s.status.slice(1)}</Badge>
                        </td>
                        <td className="px-3 py-2.5">
                          <Link href={`/opportunities/${s.opportunityId}`} className="inline-block py-0.5 text-primary hover:underline">
                            {ref(s.opportunityNumber)}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          <Card>
            <CardHeader title={`Leads (${data.opportunities.length})`} description="Every sale and renewal for this customer, including completed ones." />
            {!data.opportunities.length ? (
              <EmptyState title="No leads yet" />
            ) : (
              <ul className="divide-y divide-border">
                {data.opportunities.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                    <div>
                      <Link href={`/opportunities/${o.id}`} className="inline-block py-0.5 font-medium hover:underline">
                        {o.name}
                      </Link>
                      <p className="text-xs text-muted">
                        {ref(o.number)} · {o.owner?.name ?? "Unassigned"} · {date(o.createdAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <ServiceBadge service={o.serviceType} short />
                      {o.saleType === "renewal" && <Badge tone="accent">Renewal</Badge>}
                      {o.outcome === "open" ? <Badge>{o.stage.name}</Badge> : <OutcomeBadge outcome={o.outcome} />}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader
              title="Business details"
              actions={
                can("customer.write") && (
                  <Button size="sm" disabled={!form.formState.isDirty} loading={save.isPending} onClick={form.handleSubmit((v) => save.mutate(v))}>
                    Save changes
                  </Button>
                )
              }
            />
            <fieldset disabled={!can("customer.write")} className="p-5">
              <CustomerFields form={form} />
              <div className="mt-4">
                <IssueList issues={issues} title="Please check:" />
              </div>
            </fieldset>
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Contacts"
              actions={
                can("customer.write") && (
                  <Button size="sm" variant="secondary" onClick={() => setDialog("contact")}>
                    <Plus /> Add
                  </Button>
                )
              }
            />
            <ul className="divide-y divide-border">
              {data.contacts.map((c) => (
                <li key={c.id} className="px-5 py-3 text-sm">
                  <p className="flex items-center gap-2 font-medium">
                    <span className="min-w-0 flex-1">
                      {[c.title, c.firstName, c.lastName].filter(Boolean).join(" ")} {c.isPrimary && <Badge tone="primary">Primary</Badge>}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setEditingContact(c)} aria-label={`Edit ${c.firstName}`}>
                      Edit
                    </Button>
                  </p>
                  {c.jobTitle && <p className="text-muted">{c.jobTitle}</p>}
                  <p className="text-muted">{[c.email, c.mobile, c.phone].filter(Boolean).join(" · ")}</p>
                </li>
              ))}
              {!data.contacts.length && <li className="px-5 py-4 text-sm text-muted">No contacts yet.</li>}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Supply sites" />
            <ul className="divide-y divide-border">
              {data.sites.map((s) => (
                <li key={s.id} className="px-5 py-3 text-sm">
                  <p className="font-medium">{s.label || s.line1}</p>
                  <p className="font-mono text-xs text-muted">{s.meterPoints.map((m) => m.mprn ?? m.gprn).filter(Boolean).join(", ") || "No meters"}</p>
                </li>
              ))}
              {!data.sites.length && <li className="px-5 py-4 text-sm text-muted">None yet.</li>}
            </ul>
            {!!data.occupancies?.length && (
              <div className="border-t border-border px-5 py-3 text-sm">
                <p className="mb-1 font-medium">Occupancy history</p>
                <ul className="space-y-0.5 text-xs text-muted">
                  {data.occupancies.map((o) => (
                    <li key={o.id}>
                      {o.site.label || o.site.line1} ({o.site.meterPoints.map((m) => m.mprn ?? m.gprn).filter(Boolean).join(", ") || "no meters"}): {o.fromDate ? `from ${date(o.fromDate)}` : "before the change of entity"}
                      {o.site.customerId !== data.id && " · since taken over by a new occupier"}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  Bank details <Lock className="size-4 text-muted" aria-label="Restricted" />
                </span>
              }
              actions={
                can("bank.write") && (
                  <Button size="sm" variant="secondary" onClick={() => setDialog("bank")}>
                    <Plus /> Add
                  </Button>
                )
              }
            />
            <ul className="divide-y divide-border">
              {data.bankAccounts.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-2 px-5 py-3 text-sm">
                  {revealed[b.id] ? (
                    <span>
                      {revealed[b.id].accountName}
                      <span className="block font-mono text-xs">{revealed[b.id].iban}</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Landmark className="size-4 text-muted" aria-hidden /> IBAN ending {b.ibanLast4}
                    </span>
                  )}
                  {data.canReadBank && !revealed[b.id] && (
                    <Button size="sm" variant="ghost" onClick={() => reveal.mutate(b.id)} title="Viewing is logged">
                      <Eye /> Show
                    </Button>
                  )}
                </li>
              ))}
              {!data.bankAccounts.length && <li className="px-5 py-4 text-sm text-muted">None recorded.</li>}
            </ul>
          </Card>
        </div>
      </div>
      {dialog === "contact" && <ContactDialog customerId={id} onClose={() => (setDialog(null), refresh())} />}
      {editingContact && <ContactDialog customerId={id} contact={editingContact} onClose={() => (setEditingContact(null), refresh())} />}
      {dialog === "bank" && <BankDialog customerId={id} onClose={() => (setDialog(null), refresh())} />}
      {dialog === "merge" && <MergeDialog target={data} onClose={() => (setDialog(null), refresh())} />}
    </>
  );
}

function ContactDialog({ customerId, contact, onClose }: { customerId: string; contact?: Contact; onClose: () => void }) {
  const { register, handleSubmit } = useForm({
    defaultValues: {
      title: contact?.title ?? "",
      firstName: contact?.firstName ?? "",
      lastName: contact?.lastName ?? "",
      jobTitle: contact?.jobTitle ?? "",
      email: contact?.email ?? "",
      phone: contact?.phone ?? "",
      mobile: contact?.mobile ?? "",
      isPrimary: contact?.isPrimary ?? false,
    },
  });
  const [issues, setIssues] = useState<string[]>([]);
  const m = useMutation({
    meta: { silent: true },
    mutationFn: (v: Record<string, unknown>) => {
      const body = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === "" ? null : x]));
      return contact ? api.patch(`/contacts/${contact.id}`, body) : api.post(`/customers/${customerId}/contacts`, body);
    },
    onSuccess: onClose,
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={contact ? "Edit contact" : "Add contact"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={m.isPending} onClick={handleSubmit((v) => m.mutate(v))}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title">
          {(p) => (
            <>
              <Input {...p} {...register("title")} list="contact-titles" placeholder="Mr, Ms, Dr…" />
              <datalist id="contact-titles">
                {CONTACT_TITLES.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label="First name" required>{(p) => <Input {...p} {...register("firstName")} />}</Field>
        <Field label="Last name">{(p) => <Input {...p} {...register("lastName")} />}</Field>
        <Field label="Job title">{(p) => <Input {...p} {...register("jobTitle")} />}</Field>
        <Field label="Email">{(p) => <Input {...p} type="email" {...register("email")} />}</Field>
        <Field label="Phone">{(p) => <Input {...p} type="tel" {...register("phone")} />}</Field>
        <Field label="Mobile">{(p) => <Input {...p} type="tel" {...register("mobile")} />}</Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-6 shrink-0 accent-[var(--primary)] lg:size-4" {...register("isPrimary")} /> Primary contact
        </label>
      </div>
      <div className="mt-4">
        <IssueList issues={issues} />
      </div>
    </Dialog>
  );
}

function BankDialog({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const [v, setV] = useState({ accountName: "", iban: "", bic: "" });
  const [issues, setIssues] = useState<string[]>([]);
  const m = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post(`/customers/${customerId}/bank-accounts`, { accountName: v.accountName, iban: v.iban.replace(/\s/g, ""), bic: v.bic || null }),
    onSuccess: onClose,
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add bank details"
      description="Stored encrypted. Only Finance, Compliance and administrators can view them in full."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={m.isPending} onClick={() => m.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Account name">{(p) => <Input {...p} autoComplete="off" value={v.accountName} onChange={(e) => setV({ ...v, accountName: e.target.value })} />}</Field>
        <Field label="IBAN">{(p) => <Input {...p} autoComplete="off" className="font-mono" value={v.iban} onChange={(e) => setV({ ...v, iban: e.target.value })} />}</Field>
        <Field label="BIC">{(p) => <Input {...p} autoComplete="off" value={v.bic} onChange={(e) => setV({ ...v, bic: e.target.value })} />}</Field>
        <IssueList issues={issues} />
      </div>
    </Dialog>
  );
}

function MergeDialog({ target, onClose }: { target: Profile; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [source, setSource] = useState<{ id: string; legalName: string } | null>(null);
  const hits = useQuery({ queryKey: ["customers", "merge", q], queryFn: () => api.get<Page<{ id: string; legalName: string; tradingName: string | null }>>(`/customers?q=${encodeURIComponent(q)}&pageSize=8`), enabled: q.length >= 2 });
  const m = useMutation({ mutationFn: () => api.post(`/customers/${target.id}/merge`, { sourceId: source!.id }), onSuccess: onClose });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Merge a duplicate into ${target.legalName}`}
      description="Leads, contacts, sites and documents move to this customer. The duplicate is kept, marked as merged."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!source} loading={m.isPending} onClick={() => m.mutate()}>
            Merge {source ? `“${source.legalName}”` : ""}
          </Button>
        </>
      }
    >
      <Input type="search" placeholder="Find the duplicate" aria-label="Find the duplicate" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <ul className="mt-3 divide-y divide-border">
        {hits.data?.items
          .filter((h) => h.id !== target.id)
          .map((h) => (
            <li key={h.id}>
              <label className="flex cursor-pointer items-center gap-2 py-2 text-sm">
                <input type="radio" name="merge-source" checked={source?.id === h.id} onChange={() => setSource(h)} className="accent-[var(--primary)]" />
                {h.legalName}
                {h.tradingName && <span className="text-muted">· {h.tradingName}</span>}
              </label>
            </li>
          ))}
      </ul>
    </Dialog>
  );
}
