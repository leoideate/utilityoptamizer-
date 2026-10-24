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
    salesAgent: string | null;
  } | null;
}

/** The master sheet's columns, in its order. */
const COLUMNS = ["Business name", "Trading name", "Contact person", "Contact number", "Email", "MPRN/GPRN", "Supplier", "Utility type", "Product type", "Contract start", "Expiry date", "Contract status", "Sales agent"];
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
        description="Permanent customer records. Each can have many opportunities over time."
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
          <ul className="divide-y divide-border md:hidden">
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
                      {[c.contract.supplier, cap(c.contract.fuel), c.contract.meter, c.contract.endDate && `expires ${date(c.contract.endDate)}`].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  {(c.contactName || c.phone || c.email) && <p className="mt-0.5 truncate text-xs text-muted">{[c.contactName, c.phone ?? c.email].filter(Boolean).join(" · ")}</p>}
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block" tabIndex={0}>
            <table className="w-full min-w-[1500px] text-sm">
              <thead className="bg-surface-2 text-left text-muted">
                <tr>
                  {COLUMNS.map((h, i) => (
                    <th key={h} className={i === 0 ? "px-4 py-2.5 font-medium" : "px-3 py-2.5 font-medium"}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id} className="border-t border-border hover:bg-surface-2/60">
                    <td className="px-4 py-2.5">
                      <Link href={`/customers/${c.id}`} className="inline-block py-0.5 font-medium hover:underline">
                        {c.legalName}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5">{c.tradingName ?? "—"}</td>
                    <td className="px-3 py-2.5">{c.contactName ?? "—"}</td>
                    <td className="tabular px-3 py-2.5">{c.phone ?? "—"}</td>
                    <td className="px-3 py-2.5 text-muted">{c.email ?? "—"}</td>
                    <td className="tabular px-3 py-2.5">{c.contract?.meter ?? "—"}</td>
                    <td className="px-3 py-2.5">{c.contract?.supplier ?? "—"}</td>
                    <td className="px-3 py-2.5">{c.contract ? cap(c.contract.fuel) : "—"}</td>
                    <td className="px-3 py-2.5">{c.contract?.product ?? "—"}</td>
                    <td className="px-3 py-2.5">{date(c.contract?.startDate)}</td>
                    <td className="px-3 py-2.5">{date(c.contract?.endDate)}</td>
                    <td className="px-3 py-2.5">{c.contract ? cap(c.contract.status) : "—"}</td>
                    <td className="px-3 py-2.5">{c.contract?.salesAgent ?? "—"}</td>
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
