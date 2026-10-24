"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Inbox, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { SELECTABLE_SERVICE_TYPES, SERVICE_TYPE_LABELS, STAGES } from "@uo/shared";
import { OutcomeBadge, ServiceBadge, UserSelect } from "@/components/domain";
import { ImportLeadsButton } from "@/components/import-leads";
import { Badge, Button, Card, EmptyState, Input, PageHeader, Select, Skeleton } from "@/components/ui/primitives";
import { api, qs } from "@/lib/api";
import { cn, date, money, ref } from "@/lib/format";
import { useCan } from "@/lib/session";
import type { OpportunityRow, Page } from "@/lib/types";
import { VIEWS } from "@/lib/views";


const STORAGE_KEY = "uo-opportunity-filters";

function OpportunitiesList() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const can = useCan();
  const seesAll = can("opportunity.read_all");

  // Filters live in the URL (shareable); the last used set is remembered per browser.
  useEffect(() => {
    if (params.toString()) {
      try {
        localStorage.setItem(STORAGE_KEY, params.toString());
      } catch {
        /* storage unavailable */
      }
      return;
    }
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) router.replace(`${pathname}?${saved}`);
    } catch {
      /* storage unavailable */
    }
  }, [params, pathname, router]);

  const view = params.get("view") ?? (seesAll ? "all" : "my_open");
  const filters = { view, q: params.get("q") ?? "", serviceType: params.get("serviceType") ?? "", stage: params.get("stage") ?? "", ownerId: params.get("ownerId") ?? "", page: Number(params.get("page") ?? 1), pageSize: 25 };
  const setParam = (patch: Record<string, string | number>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === "") next.delete(k);
      else next.set(k, String(v));
    }
    if (!("page" in patch)) next.delete("page");
    router.replace(`${pathname}?${next.toString()}`);
  };
  const [search, setSearch] = useState(filters.q);
  useEffect(() => {
    const t = setTimeout(() => search !== filters.q && setParam({ q: search }), 300);
    return () => clearTimeout(t);
  });

  const query = qs(filters);
  const { data, isLoading } = useQuery({ queryKey: ["opportunities", query], queryFn: () => api.get<Page<OpportunityRow>>(`/opportunities${query}`), placeholderData: (p) => p });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageHeader
        title="Opportunities"
        description={VIEWS.find((v) => v.key === view)?.label}
        actions={
          <>
            {can("opportunity.create") && <ImportLeadsButton />}
            <Button asChild>
              <Link href="/opportunities/new">
                <Plus /> New opportunity
              </Link>
            </Button>
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <nav aria-label="Saved views">
          <Select className="lg:hidden" value={view} onChange={(e) => setParam({ view: e.target.value })} aria-label="Saved view">
            {VIEWS.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </Select>
          <ul className="hidden space-y-0.5 lg:block">
            {VIEWS.map((v) => (
              <li key={v.key}>
                <button
                  onClick={() => setParam({ view: v.key })}
                  aria-current={v.key === view ? "page" : undefined}
                  className={cn("w-full rounded-lg px-3 py-1.5 text-left text-sm text-muted hover:bg-surface-2 hover:text-text", v.key === view && "bg-primary-soft font-medium text-primary hover:bg-primary-soft hover:text-primary")}
                >
                  {v.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <Input className="col-span-2 sm:max-w-xs" type="search" placeholder="Search name, company, UO number…" aria-label="Search opportunities" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Select className="sm:w-auto" value={filters.serviceType} onChange={(e) => setParam({ serviceType: e.target.value })} aria-label="Service">
              <option value="">All services</option>
              {SELECTABLE_SERVICE_TYPES.map((k) => (
                <option key={k} value={k}>
                  {SERVICE_TYPE_LABELS[k]}
                </option>
              ))}
            </Select>
            <Select className="sm:w-auto" value={filters.stage} onChange={(e) => setParam({ stage: e.target.value })} aria-label="Stage">
              <option value="">All stages</option>
              {STAGES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </Select>
            {seesAll && (
              <div className="col-span-2 sm:w-auto">
                <UserSelect value={filters.ownerId} onChange={(v) => setParam({ ownerId: v })} />
              </div>
            )}
            {(filters.q || filters.serviceType || filters.stage || filters.ownerId) && (
              <Button
                variant="ghost"
                onClick={() => {
                  setSearch("");
                  setParam({ q: "", serviceType: "", stage: "", ownerId: "" });
                }}
              >
                Reset filters
              </Button>
            )}
          </div>

          <Card className="overflow-hidden">
            {isLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : !data?.items.length ? (
              <EmptyState icon={<Inbox />} title="Nothing here" action={view === "my_open" ? <Button asChild><Link href="/opportunities/new">Add your first lead</Link></Button> : undefined}>
                No opportunities match this view and filters. Try another view or reset the filters.
              </EmptyState>
            ) : (
              <>
              {/* Phones: one card per opportunity, everything visible without sideways scrolling. */}
              <ul className="divide-y divide-border md:hidden">
                {data.items.map((o) => (
                  <li key={o.id}>
                    <Link href={`/opportunities/${o.id}`} className="block px-4 py-3 active:bg-surface-2">
                      <div className="flex items-start justify-between gap-3">
                        <span className="min-w-0 font-medium">{o.name}</span>
                        <span className="tabular shrink-0 text-sm">{money(o.expectedRevenue)}</span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted">
                        {ref(o.number)} · {o.customer?.legalName ?? o.companyName ?? o.contactName ?? "No customer yet"}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                        <ServiceBadge service={o.serviceType} short />
                        {o.saleType === "renewal" && <Badge tone="accent">Renewal</Badge>}
                        {o.outcome === "open" ? <Badge>{o.stage.name}</Badge> : <OutcomeBadge outcome={o.outcome} />}
                        <span className="text-muted">{o.owner?.name ?? "Unassigned"}</span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto md:block" tabIndex={0}>
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="bg-surface-2 text-left text-muted">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Opportunity</th>
                      <th className="px-3 py-2.5 font-medium">Service</th>
                      <th className="px-3 py-2.5 font-medium">Stage</th>
                      <th className="px-3 py-2.5 font-medium">Salesperson</th>
                      <th className="px-3 py-2.5 text-right font-medium">Value</th>
                      <th className="px-4 py-2.5 font-medium">Follow-up</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((o) => (
                      <tr key={o.id} className="border-t border-border hover:bg-surface-2/60">
                        <td className="px-4 py-2.5">
                          <Link href={`/opportunities/${o.id}`} className="inline-block py-0.5 font-medium hover:underline">
                            {o.name}
                          </Link>
                          <div className="text-xs text-muted">
                            {ref(o.number)} · {o.customer?.legalName ?? o.companyName ?? o.contactName ?? "No customer yet"}
                            {o.saleType === "renewal" && (
                              <Badge tone="accent" className="ml-1.5">
                                Renewal
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <ServiceBadge service={o.serviceType} short />
                        </td>
                        <td className="px-3 py-2.5">{o.outcome === "open" ? o.stage.name : <OutcomeBadge outcome={o.outcome} />}</td>
                        <td className="px-3 py-2.5">{o.owner?.name ?? <span className="text-muted">Unassigned</span>}</td>
                        <td className="tabular px-3 py-2.5 text-right">{money(o.expectedRevenue)}</td>
                        <td className="px-4 py-2.5">{o.saleType === "renewal" && o.renewalDate ? `Renews ${date(o.renewalDate)}` : date(o.followUpDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </Card>
          {data && data.total > 0 && (
            <div className="flex items-center justify-between text-sm text-muted">
              <span>
                {data.total} opportunit{data.total === 1 ? "y" : "ies"}
              </span>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" disabled={filters.page <= 1} onClick={() => setParam({ page: filters.page - 1 })} aria-label="Previous page">
                  <ChevronLeft />
                </Button>
                <span>
                  Page {filters.page} of {pages}
                </span>
                <Button variant="secondary" size="sm" disabled={filters.page >= pages} onClick={() => setParam({ page: filters.page + 1 })} aria-label="Next page">
                  <ChevronRight />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default function OpportunitiesPage() {
  return (
    <Suspense>
      <OpportunitiesList />
    </Suspense>
  );
}
