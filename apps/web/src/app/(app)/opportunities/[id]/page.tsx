"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, ChevronDown, CircleSlash, PartyPopper, RotateCcw, ShieldCheck, UserPlus } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { APPROVAL_LABELS, LEAD_SOURCE_LABELS, STAGES, type StageKey, applicableSupplierApplication, isEnergyService, stageIndex } from "@uo/shared";
import { ActivitiesTab } from "@/components/opportunity/activities";
import { CallButton } from "@/components/opportunity/call";
import { GateIssueList, gateIssueTarget, scrollToSection, splitTarget } from "@/components/opportunity/gate-issues";
import { TeamChatTab } from "@/components/opportunity/team-chat";
import { useRefreshOpportunity } from "@/components/opportunity/common";
import { DocumentsTab } from "@/components/opportunity/documents";
import { EnergyTab } from "@/components/opportunity/energy";
import { BordGaisTab } from "@/components/opportunity/bord-gais/bord-gais-tab";
import { FlogasTab } from "@/components/opportunity/flogas/flogas-tab";
import { FormsTab } from "@/components/opportunity/forms";
import { OverviewTab } from "@/components/opportunity/overview";
import { SignaturesTab } from "@/components/opportunity/signatures";
import { TimelineTab } from "@/components/opportunity/timeline";
import { WorldpayTab } from "@/components/opportunity/worldpay";
import { OutcomeBadge, ServiceBadge, UserSelect } from "@/components/domain";
import { Dialog, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, TabPanel, Tabs } from "@/components/ui/overlays";
import { Badge, Button, Card, Field, Input, IssueList, Skeleton, Textarea } from "@/components/ui/primitives";
import { ApiError, api } from "@/lib/api";
import { cn, date, ref, todayIso } from "@/lib/format";
import { useCan, useUser } from "@/lib/session";
import type { Workspace } from "@/lib/types";

function OpportunityWorkspace() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const chatOn = useUser().features.chat;
  const [tab, setTab] = useState(() => (params.get("tab") === "chat" && !chatOn ? "overview" : (params.get("tab") ?? "overview")));
  const { data: opp, isLoading, error } = useQuery({ queryKey: ["opportunity", id], queryFn: () => api.get<Workspace>(`/opportunities/${id}`) });
  const refresh = useRefreshOpportunity(id);

  const [dialog, setDialog] = useState<null | "lost" | "activate" | "approve" | "assign">(null);
  const [blocked, setBlocked] = useState<{ stage: string; issues: string[]; linked: boolean } | null>(null);
  const can = useCan();
  // The back office does the forms, checks and submission; sales sees the case and its progress.
  const backOffice = can("opportunity.submit");

  const move = useMutation({
    meta: { silent: true },
    mutationFn: (stage: StageKey) => api.post(`/opportunities/${id}/stage`, { stage }),
    onSuccess: refresh,
    onError: (e, stage) => {
      const err = e as ApiError;
      setBlocked({ stage: STAGES.find((s) => s.key === stage)!.name, issues: err.issues.length ? err.issues : [err.message], linked: err.issues.length > 0 });
    },
  });
  const reopen = useMutation({ mutationFn: () => api.post(`/opportunities/${id}/reopen`), onSuccess: refresh });
  const goTab = (v: string) => {
    setTab(v);
    const u = new URL(window.location.href);
    u.searchParams.set("tab", v);
    u.hash = "";
    window.history.replaceState(null, "", u.toString());
  };
  // A link from a blocked move on the Pipeline board can name a section ("…?tab=forms#case-submissions").
  const loaded = !!opp;
  useEffect(() => {
    if (loaded && window.location.hash) scrollToSection(window.location.hash.slice(1));
  }, [loaded]);

  if (error instanceof ApiError && error.status === 404) {
    return (
      <Card className="p-8 text-center">
        <p className="font-medium">Lead not found</p>
        <p className="mt-1 text-sm text-muted">It may belong to another salesperson, or the link is wrong.</p>
        <Button className="mt-4" variant="secondary" onClick={() => router.push("/opportunities")}>
          Back to leads
        </Button>
      </Card>
    );
  }
  if (isLoading || !opp) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-96" />
        <Skeleton className="h-16" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  const energy = isEnergyService(opp.serviceType);
  // A supplier's own form (Flogas or Bord Gáis electricity) only shows while it applies; its saved data is kept either way.
  const application = applicableSupplierApplication({ productInterest: opp.productInterest, serviceType: opp.serviceType, supplierName: opp.selectedSupplier?.name });
  const flogas = application === "flogas_electricity";
  const bordGais = application === "bord_gais_electricity";
  const gateTabs = { energy, flogas, bordGais };
  /** Where a blocked move's issue is fixed: its tab (and section), or the Approval dialog. */
  const goTo = (target: string) => {
    setBlocked(null);
    if (target === "approve") return opp.permissions.approve ? setDialog("approve") : goTab("overview");
    const { tab: to, section } = splitTarget(target);
    goTab(to);
    if (section) scrollToSection(section);
  };
  const activeTab = (tab === "flogas" && !flogas) || (tab === "bord-gais" && !bordGais) ? "overview" : tab;
  const open = opp.outcome === "open";
  const current = opp.stage.key;
  const nextStage = STAGES.find((s) => stageIndex(s.key) === stageIndex(current) + 1 && s.key !== "live_won" && s.key !== "renewal_scheduled");
  const canActivate = opp.permissions.activate && open && ["submitted", "compliance_query", "awaiting_confirmation"].includes(current);

  return (
    <>
      <Link href="/opportunities" className="mb-3 inline-flex min-h-6 items-center gap-1 py-1 text-sm text-muted hover:text-text">
        <ArrowLeft className="size-4" /> Leads
      </Link>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[clamp(1.375rem,1.1rem+1.1vw,1.75rem)] font-semibold leading-tight tracking-tight">{opp.name}</h1>
            <OutcomeBadge outcome={opp.outcome} />
            {opp.saleType === "renewal" && <Badge tone="accent">Renewal</Badge>}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <span>{ref(opp.number)}</span>
            <ServiceBadge service={opp.serviceType} />
            <span>{opp.customer ? <Link className="hover:underline" href={`/customers/${opp.customer.id}`}>{opp.customer.legalName}</Link> : opp.companyName ?? "No customer yet"}</span>
            <span>Salesperson: {opp.owner?.name ?? "Unassigned"}</span>
            <span>Source: {LEAD_SOURCE_LABELS[opp.leadSource]}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {open && opp.permissions.write && nextStage && (
            <Button onClick={() => move.mutate(nextStage.key)} loading={move.isPending}>
              <Check /> Move to {nextStage.name}
            </Button>
          )}
          <CallButton opp={opp} />
          {canActivate && (
            <Button variant="accent" onClick={() => setDialog("activate")}>
              <PartyPopper /> Activate
            </Button>
          )}
          {opp.permissions.approve && open && (
            <Button variant="secondary" onClick={() => setDialog("approve")}>
              <ShieldCheck /> Approval
            </Button>
          )}
          <Menu>
            <MenuTrigger asChild>
              <Button variant="secondary">
                More <ChevronDown />
              </Button>
            </MenuTrigger>
            <MenuContent>
              {open && opp.permissions.write && (
                <>
                  <MenuLabel>Move to stage</MenuLabel>
                  {STAGES.filter((s) => s.key !== current && s.key !== "live_won").map((s) => (
                    <MenuItem key={s.key} onSelect={() => move.mutate(s.key)}>
                      {s.name}
                    </MenuItem>
                  ))}
                  <MenuSeparator />
                </>
              )}
              {(opp.permissions.assign || (!opp.ownerId && open)) && (
                <MenuItem onSelect={() => setDialog("assign")}>
                  <UserPlus /> {opp.ownerId ? "Reassign" : "Assign"}
                </MenuItem>
              )}
              {open && opp.permissions.write && (
                <MenuItem danger onSelect={() => setDialog("lost")}>
                  <CircleSlash /> Mark as lost
                </MenuItem>
              )}
              {(opp.outcome === "lost" || (opp.outcome === "won" && opp.permissions.reopenCompleted)) && (
                <MenuItem onSelect={() => reopen.mutate()}>
                  <RotateCcw /> Reopen
                </MenuItem>
              )}
            </MenuContent>
          </Menu>
        </div>
      </div>

      <StageProgress current={current} outcome={opp.outcome} />

      {opp.outcome === "won" && (
        <div className="mb-4 rounded-lg border border-success/30 bg-success-soft px-4 py-3 text-sm text-success">
          Live since {date(opp.activationDate)}. {opp.renewalDate ? `Contract ends ${date(opp.renewalDate)}; a renewal lead is created automatically 120 days before.` : ""}
        </div>
      )}
      {opp.outcome === "lost" && (
        <div className="mb-4 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
          Lost on {date(opp.lostAt)}: {opp.lostReason}
        </div>
      )}
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        <Badge tone={opp.internalApproval === "approved" ? "success" : opp.internalApproval === "rejected" ? "danger" : opp.internalApproval === "pending" ? "warning" : "neutral"}>
          Internal approval: {APPROVAL_LABELS[opp.internalApproval]}
        </Badge>
        {opp.applicationStatus && <Badge tone="info">Application: {opp.applicationStatus}</Badge>}
        {opp.previousOpportunity && (
          <Link href={`/opportunities/${opp.previousOpportunity.id}`}>
            <Badge tone="neutral">Renews {ref(opp.previousOpportunity.number)}</Badge>
          </Link>
        )}
        {opp.renewals.map((r) => (
          <Link key={r.id} href={`/opportunities/${r.id}`}>
            <Badge tone="accent">Renewal {ref(r.number)}</Badge>
          </Link>
        ))}
      </div>

      <Tabs
        value={activeTab}
        onValueChange={goTab}
        tabs={[
          { value: "overview", label: "Overview" },
          energy ? { value: "energy", label: `Energy (${opp._count.sites} site${opp._count.sites === 1 ? "" : "s"})` } : { value: "worldpay", label: `Worldpay (${opp._count.merchantApps})` },
          ...(flogas ? [{ value: "flogas", label: "Flogas form" }] : []),
          ...(bordGais ? [{ value: "bord-gais", label: "Bord Gáis form" }] : []),
          { value: "documents", label: `Documents (${opp._count.documents})` },
          { value: "forms", label: backOffice ? "Back office" : "Case" },
          { value: "signatures", label: "Signatures" },
          { value: "activities", label: `Tasks (${opp._count.activities})` },
          { value: "timeline", label: "Timeline" },
          ...(chatOn ? [{ value: "chat", label: "Team chat" }] : []),
        ]}
      >
        <TabPanel value="overview">
          <OverviewTab opp={opp} onGoTo={setTab} />
        </TabPanel>
        {energy ? (
          <TabPanel value="energy">
            <EnergyTab opp={opp} />
          </TabPanel>
        ) : (
          <TabPanel value="worldpay">
            <WorldpayTab opp={opp} />
          </TabPanel>
        )}
        {flogas && (
          <TabPanel value="flogas">
            <FlogasTab opp={opp} />
          </TabPanel>
        )}
        {bordGais && (
          <TabPanel value="bord-gais">
            <BordGaisTab opp={opp} />
          </TabPanel>
        )}
        <TabPanel value="documents">
          <DocumentsTab opp={opp} />
        </TabPanel>
        <TabPanel value="forms">
          <FormsTab opp={opp} />
        </TabPanel>
        <TabPanel value="signatures">
          <SignaturesTab opp={opp} />
        </TabPanel>
        <TabPanel value="activities">
          <ActivitiesTab opp={opp} />
        </TabPanel>
        <TabPanel value="timeline">
          <TimelineTab opp={opp} />
        </TabPanel>
        {chatOn && (
          <TabPanel value="chat">
            <TeamChatTab opp={opp} />
          </TabPanel>
        )}
      </Tabs>

      <LostDialog id={id} open={dialog === "lost"} onClose={() => setDialog(null)} />
      <ActivateDialog id={id} open={dialog === "activate"} onClose={() => setDialog(null)} />
      <ApprovalDialog opp={opp} open={dialog === "approve"} onClose={() => setDialog(null)} />
      <AssignDialog opp={opp} open={dialog === "assign"} onClose={() => setDialog(null)} />
      <Dialog
        open={!!blocked}
        onOpenChange={(o) => !o && setBlocked(null)}
        title={`Can't move to ${blocked?.stage ?? ""} yet`}
        footer={
          blocked?.linked ? (
            <>
              <Button variant="secondary" onClick={() => setBlocked(null)}>
                Close
              </Button>
              <Button onClick={() => goTo(gateIssueTarget(blocked.issues[0], gateTabs))}>
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
            <GateIssueList issues={blocked.issues} tabs={gateTabs} onGo={goTo} />
          ) : (
            <IssueList issues={blocked.issues} title="This lead still needs:" />
          ))}
      </Dialog>
    </>
  );
}

function StageProgress({ current, outcome }: { current: StageKey; outcome: string }) {
  const idx = stageIndex(current);
  return (
    <div className="mb-4 overflow-x-auto" role="list" aria-label="Pipeline progress" tabIndex={0}>
      <div className="flex min-w-max gap-1">
        {STAGES.filter((s) => s.key !== "renewal_scheduled" || current === "renewal_scheduled").map((s) => {
          const i = stageIndex(s.key);
          const done = i < idx || (outcome === "won" && s.key === "live_won");
          const here = s.key === current;
          return (
            <div
              key={s.key}
              role="listitem"
              aria-current={here ? "step" : undefined}
              title={s.name}
              className={cn(
                "h-7 rounded-md px-2 text-xs font-medium leading-7 whitespace-nowrap",
                here ? "bg-primary text-primary-fg" : done ? "bg-primary-soft text-primary" : "bg-surface-2 text-muted",
                outcome === "lost" && here && "bg-danger text-white",
              )}
            >
              {s.name}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LostDialog({ id, open, onClose }: { id: string; open: boolean; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const refresh = useRefreshOpportunity(id);
  const m = useMutation({ mutationFn: () => api.post(`/opportunities/${id}/lost`, { reason }), onSuccess: () => (refresh(), onClose()) });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Mark as lost"
      description="The lead stays in the CRM under Lost and can be reopened."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!reason.trim()} loading={m.isPending} onClick={() => m.mutate()}>
            Mark as lost
          </Button>
        </>
      }
    >
      <Field label="Reason" required>
        {(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Stayed with current supplier on price" />}
      </Field>
    </Dialog>
  );
}

function ActivateDialog({ id, open, onClose }: { id: string; open: boolean; onClose: () => void }) {
  const [activationDate, setDate] = useState(todayIso());
  const [supplierReference, setRef] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const refresh = useRefreshOpportunity(id);
  const m = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post(`/opportunities/${id}/activate`, { activationDate, supplierReference: supplierReference || null }),
    onSuccess: () => (refresh(), onClose()),
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Record activation"
      description="The supply or service is live. The lead moves to Live / Won, keeps its salesperson and a renewal review is scheduled."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" loading={m.isPending} onClick={() => m.mutate()}>
            Activate
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Activation date" required>
          {(p) => <Input {...p} type="date" value={activationDate} onChange={(e) => setDate(e.target.value)} />}
        </Field>
        <Field label="Supplier / Worldpay reference" hint="Used if a contract doesn't already have one.">
          {(p) => <Input {...p} value={supplierReference} onChange={(e) => setRef(e.target.value)} />}
        </Field>
        <IssueList issues={issues} />
      </div>
    </Dialog>
  );
}

function ApprovalDialog({ opp, open, onClose }: { opp: Workspace; open: boolean; onClose: () => void }) {
  const [note, setNote] = useState("");
  const refresh = useRefreshOpportunity(opp.id);
  const m = useMutation({ mutationFn: (decision: "approved" | "rejected") => api.post(`/opportunities/${opp.id}/approval`, { decision, note: note || null }), onSuccess: () => (refresh(), onClose()) });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Internal approval"
      description={`Currently: ${APPROVAL_LABELS[opp.internalApproval]}`}
      footer={
        <>
          <Button variant="danger" loading={m.isPending && m.variables === "rejected"} onClick={() => m.mutate("rejected")}>
            Reject
          </Button>
          <Button loading={m.isPending && m.variables === "approved"} onClick={() => m.mutate("approved")}>
            Approve
          </Button>
        </>
      }
    >
      <IssueList issues={opp.gates.submitted.filter((i) => !i.startsWith("Internal approval"))} title="Still outstanding before submission:" />
      <Field label="Note (optional)" className="mt-4">
        {(p) => <Textarea {...p} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
    </Dialog>
  );
}

function AssignDialog({ opp, open, onClose }: { opp: Workspace; open: boolean; onClose: () => void }) {
  const me = useUser();
  const [ownerId, setOwner] = useState(opp.ownerId ?? "");
  const refresh = useRefreshOpportunity(opp.id);
  const m = useMutation({ mutationFn: (v: string | null) => api.post(`/opportunities/${opp.id}/assign`, { ownerId: v }), onSuccess: () => (refresh(), onClose()) });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={opp.permissions.assign ? "Assign salesperson" : "Take this lead"}
      footer={
        opp.permissions.assign ? (
          <Button loading={m.isPending} onClick={() => m.mutate(ownerId || null)}>
            Save
          </Button>
        ) : (
          <Button loading={m.isPending} onClick={() => m.mutate(me.id)}>
            Assign to me
          </Button>
        )
      }
    >
      {opp.permissions.assign ? <UserSelect value={ownerId} onChange={setOwner} includeUnassigned /> : <p className="text-sm">Assign this unassigned lead to yourself?</p>}
    </Dialog>
  );
}

export default function OpportunityPage() {
  return (
    <Suspense>
      <OpportunityWorkspace />
    </Suspense>
  );
}
