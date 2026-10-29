"use client";

import { useQuery } from "@tanstack/react-query";
import { Building2, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, Card, EmptyState, Input, PageHeader, Skeleton } from "@/components/ui/primitives";
import { api, qs } from "@/lib/api";
import { date } from "@/lib/format";
import type { Page } from "@/lib/types";

interface CustomerRow {
  id: string;
  legalName: string;
  tradingName: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  _count: { opps: number };
  /** The latest contract on a deal you can see. */
  contract: {
    supplier: string | null;
    fuel: "electricity" | "gas";
    meter: string | null;
    product: string | null;
    startDate: string | null;
    endDate: string | null;
    status: string;
    applicationStatus: string | null;
    country: string | null;
    /** Every supplier, utility and meter across the customer's contracts (latest first). */
    suppliers: string[];
    fuels: ("electricity" | "gas")[];
    meters: string[];
    termMonths: number | null;
    salesAgent: string | null;
  } | null;
}

/** The master sheet's columns, in its order. */
const COLUMNS = ["Business name", "Trading name", "Country", "Contact person", "Contact number", "Email", "MPRN/GPRN", "Supplier", "Utility type", "Product type", "Contract start", "Expiry date", "Contract term (years)", "Contract status", "Sales agent"];
const COLUMN_WIDTHS = [220, 180, 100, 160, 140, 200, 170, 160, 120, 160, 120, 120, 120, 150, 160];

function TableText({ value }: { value: string | null | undefined }) {
  return <span title={value ?? undefined} className="line-clamp-2 [overflow-wrap:anywhere]">{value ?? "—"}</span>;
}

const COUNTRIES: Record<string, string> = { IE: "Ireland", GB: "United Kingdom" };
/** The first meter, and how many more the customer has. */
const meterText = (meters: string[]) => (meters.length > 1 ? `${meters[0]} +${meters.length - 1} more` : (meters[0] ?? ""));
const years = (months: number | null | undefined) => (months ? String(Math.round((months / 12) * 10) / 10) : "—");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function CustomersPage() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => {
    const t = setTimeout(() => (setDebounced(q), setPage(1)), 300);
    return () => clearTimeout(t);
  }, [q]);
  const query = qs({ q: debounced, page, pageSize: 25 });
  const { data, isLoading } = useQuery({ queryKey: ["customers", query], queryFn: () => api.get<Page<CustomerRow>>(`/customers${query}`), placeholderData: (p) => p });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageHeader
        title="Customers"
        description="Permanent customer records. Each can have many leads over time."
        actions={
          <Button asChild>
            <Link href="/customers/new">
              <Plus /> New customer
            </Link>
          </Button>
        }
      />
      <Input className="mb-4 sm:max-w-md" type="search" placeholder="Search name, email, phone, MPRN/GPRN, VAT or company number" aria-label="Search customers" value={q} onChange={(e) => setQ(e.target.value)} />
      <Card className="overflow-hidden">
        {isLoading ? (
          <Skeleton className="m-4 h-48" />
        ) : !data?.items.length ? (
          <EmptyState icon={<Building2 />} title={debounced ? "No customers match" : "No customers yet"} />
        ) : (
          <>
          <ul className="divide-y divide-border [overflow-wrap:anywhere] md:hidden">
            {data.items.map((c) => (
              <li key={c.id}>
                <Link href={`/customers/${c.id}`} className="block px-4 py-3 active:bg-surface-2">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 font-medium">{c.legalName}</span>
                    <span className="shrink-0 text-xs text-muted">
                      {c._count.opps} opportunit{c._count.opps === 1 ? "y" : "ies"}
                    </span>
                  </div>
                  {c.tradingName && <p className="text-xs text-muted">t/a {c.tradingName}</p>}
                  {c.contract && (
                    <p className="mt-0.5 text-xs text-muted">
                      {[c.contract.suppliers.join(", "), c.contract.fuels.map(cap).join(" & "), meterText(c.contract.meters), c.contract.endDate && `expires ${date(c.contract.endDate)}`].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  {(c.contactName || c.phone || c.email) && <p className="mt-0.5 truncate text-xs text-muted">{[c.contactName, c.phone ?? c.email].filter(Boolean).join(" · ")}</p>}
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden max-h-[min(65vh,640px)] overflow-auto md:block" tabIndex={0} role="region" aria-label="Customer table — scroll for more columns and rows">
            <table className="w-[2280px] table-fixed border-separate border-spacing-0 text-sm [&_td]:border-b [&_td]:border-border [&_td]:align-top">
              <colgroup>{COLUMN_WIDTHS.map((width, i) => <col key={COLUMNS[i]} style={{ width }} />)}</colgroup>
              <thead className="bg-surface-2 text-left text-muted">
                <tr>
                  {COLUMNS.map((h, i) => (
                    <th key={h} scope="col" className={i === 0 ? "sticky left-0 top-0 z-30 border-r border-border bg-surface-2 px-4 py-2.5 font-medium" : "sticky top-0 z-20 bg-surface-2 px-3 py-2.5 font-medium"}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id} className="group hover:bg-surface-2/60">
                    <td className="sticky left-0 z-10 border-r border-border bg-surface px-4 py-2.5 group-hover:bg-surface-2">
                      <Link href={`/customers/${c.id}`} title={c.legalName} className="line-clamp-2 py-0.5 font-medium [overflow-wrap:anywhere] hover:underline">
                        {c.legalName}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5"><TableText value={c.tradingName ?? "—"} /></td>
                    <td className="px-3 py-2.5"><TableText value={c.contract?.country ? (COUNTRIES[c.contract.country] ?? c.contract.country) : "—"} /></td>
                    <td className="px-3 py-2.5"><TableText value={c.contactName ?? "—"} /></td>
                    <td className="tabular px-3 py-2.5"><TableText value={c.phone ?? "—"} /></td>
                    <td className="px-3 py-2.5 text-muted"><TableText value={c.email ?? "—"} /></td>
                    <td className="tabular px-3 py-2.5" title={c.contract?.meters.join(", ")}>
                      <TableText value={c.contract ? meterText(c.contract.meters) || "—" : "—"} />
                    </td>
                    <td className="px-3 py-2.5"><TableText value={c.contract?.suppliers.length ? c.contract.suppliers.join(", ") : "—"} /></td>
                    <td className="px-3 py-2.5"><TableText value={c.contract ? c.contract.fuels.map(cap).join(" & ") : "—"} /></td>
                    <td className="px-3 py-2.5"><TableText value={c.contract?.product ?? "—"} /></td>
                    <td className="px-3 py-2.5"><TableText value={date(c.contract?.startDate)} /></td>
                    <td className="px-3 py-2.5"><TableText value={date(c.contract?.endDate)} /></td>
                    <td className="tabular px-3 py-2.5"><TableText value={years(c.contract?.termMonths)} /></td>
                    <td className="px-3 py-2.5"><TableText value={c.contract ? (c.contract.applicationStatus ?? cap(c.contract.status)) : "—"} /></td>
                    <td className="px-3 py-2.5"><TableText value={c.contract?.salesAgent ?? "—"} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>
      {data && data.total > data.pageSize && (
        <div className="mt-4 flex items-center justify-end gap-2 text-sm text-muted">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
            <ChevronLeft />
          </Button>
          Page {page} of {pages}
          <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page">
            <ChevronRight />
          </Button>
        </div>
      )}
    </>
  );
}
