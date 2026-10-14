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
  email: string | null;
  phone: string | null;
  vatNumber: string | null;
  createdAt: string;
  _count: { opps: number };
}

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
      <Input className="mb-4 max-w-md" type="search" placeholder="Search name, email, phone, VAT or company number" aria-label="Search customers" value={q} onChange={(e) => setQ(e.target.value)} />
      <Card className="overflow-hidden">
        {isLoading ? (
          <Skeleton className="m-4 h-48" />
        ) : !data?.items.length ? (
          <EmptyState icon={<Building2 />} title={debounced ? "No customers match" : "No customers yet"} />
        ) : (
          <div className="overflow-x-auto" tabIndex={0}>
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-surface-2 text-left text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Customer</th>
                  <th className="px-3 py-2.5 font-medium">Contact</th>
                  <th className="px-3 py-2.5 font-medium">VAT</th>
                  <th className="px-3 py-2.5 text-right font-medium">Opportunities</th>
                  <th className="px-4 py-2.5 font-medium">Since</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id} className="border-t border-border hover:bg-surface-2/60">
                    <td className="px-4 py-2.5">
                      <Link href={`/customers/${c.id}`} className="font-medium hover:underline">
                        {c.legalName}
                      </Link>
                      {c.tradingName && <span className="block text-xs text-muted">t/a {c.tradingName}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-muted">{c.email ?? c.phone ?? "—"}</td>
                    <td className="px-3 py-2.5">{c.vatNumber ?? "—"}</td>
                    <td className="tabular px-3 py-2.5 text-right">{c._count.opps}</td>
                    <td className="px-4 py-2.5">{date(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
