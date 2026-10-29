"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Inbox, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { LEAD_SOURCE_LABELS, type LeadSource, SELECTABLE_SERVICE_TYPES, SERVICE_TYPE_LABELS, STAGES } from "@uo/shared";
import { OutcomeBadge, ServiceBadge, UserSelect, useSuppliers } from "@/components/domain";
import { BulkAssignBar } from "@/components/bulk-assign-bar";
import { CloseLeadBatchButton } from "@/components/close-lead-batch";
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
  const filters = {
    view,
    q: params.get("q") ?? "",
    serviceType: params.get("serviceType") ?? "",
    stage: params.get("stage") ?? "",
    ownerId: params.get("ownerId") ?? "",
    // Set by the dashboard's figures; shown as one line above the list.
    supplierId: params.get("supplierId") ?? "",
    outcome: params.get("outcome") ?? "",
    leadSource: params.get("leadSource") ?? "",
    dated: params.get("dated") ?? "",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    page: Number(params.get("page") ?? 1),
    pageSize: 25,
  };
  const suppliers = useSuppliers();
  const DATED = { created: "Created", won: "Won", lost: "Lost" } as const;
  const OUTCOME = { open: "Open", won: "Won", lost: "Lost" } as const;
  const drilled = [
    filters.dated && (filters.from || filters.to) ? `${DATED[filters.dated as keyof typeof DATED] ?? filters.dated} ${filters.from ? date(filters.from) : "…"} – ${filters.to ? date(filters.to) : "…"}` : filters.outcome && OUTCOME[filters.outcome as keyof typeof OUTCOME],
    filters.leadSource && `Source: ${LEAD_SOURCE_LABELS[filters.leadSource as LeadSource] ?? filters.leadSource}`,
    filters.supplierId && `Supplier: ${suppliers.data?.find((s) => s.id === filters.supplierId)?.name ?? "selected"}`,
  ].filter(Boolean);
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

  // Managers tick opportunities on this page and assign them in one go.
  const canAssign = can("opportunity.assign");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set()), [query]);
  const pageIds = data?.items.map((o) => o.id) ?? [];
  const allTicked = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const tick = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const tickAll = (on: boolean) => setSelected(on ? new Set(pageIds) : new Set());
  const nameOf = (id: string) => data?.items.find((o) => o.id === id)?.name ?? "Lead";

  return (
    <>
      <PageHeader
        title="Leads"
        description={VIEWS.find((v) => v.key === view)?.label}
        actions={
          <>
            {can("opportunity.close_batch") && <CloseLeadBatchButton />}
            {can("opportunity.create") && <ImportLeadsButton />}
            <Button asChild>
              <Link href="/opportunities/new">
                <Plus /> New lead
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
            <Input className="col-span-2 sm:max-w-xs" type="search" placeholder="Search name, company, UO number…" aria-label="Search leads" value={search} onChange={(e) => setSearch(e.target.value)} />
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
            {(filters.q || filters.serviceType || filters.stage || filters.ownerId || drilled.length > 0) && (
              <Button
                variant="ghost"
                onClick={() => {
                  setSearch("");
                  setParam({ q: "", serviceType: "", stage: "", ownerId: "", supplierId: "", outcome: "", leadSource: "", dated: "", from: "", to: "" });
                }}
              >
                Reset filters
              </Button>
            )}
          </div>
          {drilled.length > 0 && (
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">Showing:</span>
              {drilled.map((d) => (
                <Badge key={String(d)} tone="primary">
                  {d}
                </Badge>
              ))}
              {data && <span className="text-muted">· {data.total} deal{data.total === 1 ? "" : "s"}</span>}
              <button
                type="button"
                className="min-h-6 text-primary hover:underline"
                onClick={() => setParam({ supplierId: "", outcome: "", leadSource: "", dated: "", from: "", to: "" })}
              >
                Clear
              </button>
            </p>
          )}

          {canAssign && <BulkAssignBar ids={[...selected]} label={nameOf} onDone={() => setSelected(new Set())} onClear={() => setSelected(new Set())} />}

          <Card className="overflow-hidden">
            {isLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : !data?.items.length ? (
              <EmptyState icon={<Inbox />} title="Nothing here" action={view === "my_open" ? <Button asChild><Link href="/opportunities/new">Add your first lead</Link></Button> : undefined}>
                No leads match this view and filters. Try another view or reset the filters.
              </EmptyState>
            ) : (
              <>
              {/* Phones: one card per opportunity, everything visible without sideways scrolling. */}
              <ul className="divide-y divide-border md:hidden">
                {data.items.map((o) => (
                  <li key={o.id} className="flex items-start">
                    {canAssign && (
                      <input type="checkbox" className="ml-4 mt-3.5 size-6 shrink-0 accent-[var(--primary)]" checked={selected.has(o.id)} onChange={(e) => tick(o.id, e.target.checked)} aria-label={`Select ${o.name}`} />
                    )}
                    <Link href={`/opportunities/${o.id}`} className="block min-w-0 flex-1 px-4 py-3 active:bg-surface-2">
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
                      {canAssign && (
                        <th className="w-10 py-2.5 pl-4">
                          <input type="checkbox" className="size-6 accent-[var(--primary)] lg:size-4" checked={allTicked} onChange={(e) => tickAll(e.target.checked)} aria-label="Select all on this page" />
                        </th>
                      )}
                      <th className="px-4 py-2.5 font-medium">Lead</th>
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
                        {canAssign && (
                          <td className="py-2.5 pl-4">
                            <input type="checkbox" className="size-6 accent-[var(--primary)] lg:size-4" checked={selected.has(o.id)} onChange={(e) => tick(o.id, e.target.checked)} aria-label={`Select ${o.name}`} />
                          </td>
                        )}
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
                {data.total} lead{data.total === 1 ? "" : "s"}
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
