"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, MoreHorizontal, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { BUSINESS_CATEGORY_LABELS, type BusinessCategory, SELECTABLE_SERVICE_TYPES, SERVICE_TYPE_LABELS, STAGES, type ServiceType, type StageKey } from "@uo/shared";
import { businessCategoryOptions } from "@/components/business-category";
import { ServiceBadge } from "@/components/domain";
import { GateIssueList, gateIssueTarget } from "@/components/opportunity/gate-issues";
import { Dialog, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/overlays";
import { Badge, Button, IssueList, PageHeader, Select, Skeleton } from "@/components/ui/primitives";
import { type ApiError, api, qs } from "@/lib/api";
import { cn, moneyCompact, ref, relative } from "@/lib/format";
import { useCan } from "@/lib/session";

interface Card {
  id: string;
  number: number;
  name: string;
  serviceType: ServiceType;
  saleType: string;
  outcome: string;
  expectedRevenue: number | null;
  stageEnteredAt: string;
  companyName: string | null;
  businessCategory: BusinessCategory | null;
  owner: { id: string; name: string } | null;
  customer: { legalName: string } | null;
}
interface Board {
  columns: { stage: { id: string; key: StageKey; name: string }; count: number; value: number; cards: Card[] }[];
}

function PipelineBoard() {
  const can = useCan();
  const router = useRouter();
  const qc = useQueryClient();
  const params = useSearchParams();
  const view = params.get("view") ?? (can("opportunity.read_all") ? "all" : "my_open");
  const service = params.get("serviceType") ?? "";
  const businessCategory = params.get("businessCategory") ?? "";
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    router.replace(`/pipeline?${next.toString()}`, { scroll: false });
  };
  const [dragging, setDragging] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ id: string; name: string; serviceType: ServiceType; stage: string; issues: string[]; linked: boolean } | null>(null);
  const query = qs({ view, serviceType: service, businessCategory });
  const { data, isLoading } = useQuery({ queryKey: ["board", query], queryFn: () => api.get<Board>(`/opportunities/board${query}`) });

  const move = useMutation({
    meta: { silent: true },
    mutationFn: ({ id, stage }: { id: string; stage: StageKey; name: string; serviceType: ServiceType }) => api.post(`/opportunities/${id}/stage`, { stage }),
    onError: (e, v) => {
      const err = e as ApiError;
      const linked = !!err.issues?.length;
      setBlocked({ id: v.id, name: v.name, serviceType: v.serviceType, stage: STAGES.find((s) => s.key === v.stage)!.name, issues: linked ? err.issues : [err.message], linked });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["board"] }),
  });

  // Cards don't carry the supplier; an issue naming a supplier's form means the deal has its tab.
  const blockedTabs = blocked && { energy: blocked.serviceType !== "merchant_services", flogas: blocked.issues.some((i) => /"Flogas/i.test(i)), bordGais: blocked.issues.some((i) => /"Bo(a)?rd G[aá]is/i.test(i)) };
  /** Opens the deal where a blocked move's issue is fixed (the Approval dialog's issue opens its Overview). */
  const goTo = (target: string) => blocked && router.push(`/opportunities/${blocked.id}?tab=${target === "approve" ? "overview" : target}`);

  const drop = (stage: StageKey) => {
    if (!dragging || !data) return;
    const card = data.columns.flatMap((c) => c.cards).find((c) => c.id === dragging);
    if (!card) return;
    if (stage === "live_won") {
      setBlocked({ id: card.id, name: card.name, serviceType: card.serviceType, stage: "Live / Won", issues: ["Open the lead and use Activate to record the activation date."], linked: false });
      return;
    }
    move.mutate({ id: card.id, stage, name: card.name, serviceType: card.serviceType });
    setDragging(null);
  };

  return (
    <>
      <PageHeader
        title="Pipeline"
        description="Drag a card to another stage, or use its menu. Requirements are checked when you move."
        actions={
          <>
            <div className="w-full sm:w-44">
            <Select className="w-auto" value={view} onChange={(e) => setFilter("view", e.target.value)} aria-label="Whose leads">
              <option value="my_open">My leads</option>
              <option value="all">{can("opportunity.read_all") ? "Everyone" : "Mine and unassigned"}</option>
              <option value="unassigned">Unassigned</option>
            </Select>
            </div>
            <div className="w-full sm:w-44">
            <Select className="w-auto" value={service} onChange={(e) => setFilter("serviceType", e.target.value)} aria-label="Service">
              <option value="">All services</option>
              {SELECTABLE_SERVICE_TYPES.map((k) => (
                <option key={k} value={k}>
                  {SERVICE_TYPE_LABELS[k]}
                </option>
              ))}
            </Select>
            </div>
            <div className="w-full sm:w-60">
            <Select className="w-auto" value={businessCategory} onChange={(e) => setFilter("businessCategory", e.target.value)} aria-label="Business Category">
              {businessCategoryOptions(true)}
            </Select>
            </div>
            <Button asChild>
              <Link href="/opportunities/new">
                <Plus /> New
              </Link>
            </Button>
          </>
        }
      />
      {isLoading || !data ? (
        <div className="flex gap-4 overflow-hidden">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-96 w-72 shrink-0" />
          ))}
        </div>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6" tabIndex={0}>
          <ol className="flex gap-3" aria-label="Pipeline stages">
            {data.columns.map((col) => (
              <li
                key={col.stage.id}
                className={cn("flex w-72 shrink-0 flex-col rounded-xl border border-border bg-surface-2/60", dragging && "border-dashed")}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => drop(col.stage.key)}
                aria-label={`${col.stage.name}: ${col.count} leads`}
              >
                <div className="flex items-baseline justify-between gap-2 px-3 py-2.5">
                  <h2 className="text-sm font-semibold">{col.stage.name}</h2>
                  <span className="tabular text-xs text-muted">
                    {col.count} · {moneyCompact(col.value)}
                  </span>
                </div>
                <ul className="flex min-h-24 flex-1 flex-col gap-2 px-2 pb-2">
                  {col.cards.map((c) => (
                    <li
                      key={c.id}
                      draggable={c.outcome === "open"}
                      onDragStart={() => setDragging(c.id)}
                      onDragEnd={() => setDragging(null)}
                      className={cn("rounded-lg border border-border bg-surface p-3 shadow-sm", c.outcome === "open" && "cursor-grab active:cursor-grabbing", dragging === c.id && "opacity-50")}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <Link href={`/opportunities/${c.id}`} className="-my-0.5 min-w-0 py-0.5 text-sm font-medium hover:underline">
                          {c.name}
                        </Link>
                        {c.outcome === "open" && <MoveMenu card={c} current={col.stage.key} onMove={(stage) => move.mutate({ id: c.id, stage, name: c.name, serviceType: c.serviceType })} />}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted">
                        {ref(c.number)} · {c.customer?.legalName ?? c.companyName ?? "No customer yet"}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <ServiceBadge service={c.serviceType} short />
                        <Badge>{c.businessCategory ? BUSINESS_CATEGORY_LABELS[c.businessCategory] : "Uncategorized"}</Badge>
                        {c.saleType === "renewal" && <Badge tone="accent">Renewal</Badge>}
                        {c.outcome === "won" && <Badge tone="success">Live</Badge>}
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs text-muted">
                        <span>{c.owner?.name ?? "Unassigned"}</span>
                        <span title="Time in this stage">{relative(c.stageEnteredAt)}</span>
                      </div>
                    </li>
                  ))}
                  {col.count > col.cards.length && (
                    <li className="px-1 text-center text-xs text-muted">
                      <Link className="inline-flex min-h-6 items-center hover:underline" href={`/opportunities${qs({ view, serviceType: service, businessCategory, stage: col.stage.key })}`}>
                        +{col.count - col.cards.length} more
                      </Link>
                    </li>
                  )}
                </ul>
              </li>
            ))}
          </ol>
        </div>
      )}
      <Dialog
        open={!!blocked}
        onOpenChange={(o) => !o && setBlocked(null)}
        title={`Can't move to ${blocked?.stage ?? ""}`}
        description={blocked?.name}
        footer={
          blocked?.linked ? (
            <>
              <Button variant="secondary" onClick={() => setBlocked(null)}>
                Close
              </Button>
              <Button onClick={() => goTo(gateIssueTarget(blocked.issues[0], blockedTabs!))}>
                Take me there <ArrowRight />
              </Button>
            </>
          ) : (
            <Button onClick={() => setBlocked(null)}>OK</Button>
          )
        }
      >
        {blocked &&
          (blocked.linked ? (
            <GateIssueList issues={blocked.issues} tabs={blockedTabs!} onGo={goTo} />
          ) : (
            <IssueList issues={blocked.issues} title="This lead still needs:" />
          ))}
      </Dialog>
    </>
  );
}

function MoveMenu({ card, current, onMove }: { card: Card; current: StageKey; onMove: (s: StageKey) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="-m-1.5 shrink-0 rounded p-1.5 text-muted hover:bg-surface-2" aria-label={`Move ${card.name}`}>
          <MoreHorizontal className="size-4" />
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>Move to stage</MenuLabel>
        {STAGES.filter((s) => s.key !== current && s.key !== "live_won").map((s) => (
          <MenuItem key={s.key} onSelect={() => onMove(s.key)}>
            {s.name}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

export default function PipelinePage() {
  return <Suspense fallback={<Skeleton className="h-96" />}><PipelineBoard /></Suspense>;
}
