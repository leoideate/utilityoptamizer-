"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Button, Card, CardHeader, Checkbox, IssueList, Select, Skeleton } from "@/components/ui/primitives";
import { ApiError, api } from "@/lib/api";
import { cn, dateTime } from "@/lib/format";

interface Line {
  tab: string;
  line: number;
  action: "created" | "exists" | "skipped";
  business: string;
  customer: string;
  detail: string;
  warnings: string;
}
interface Summary {
  rows: number;
  created: number;
  exists: number;
  skipped: number;
  statuses: Record<string, number>;
  suppliersToCreate: string[];
  unmatchedAgents: string[];
  renewalsSoon: number;
  meterChecks: number;
  ignoredColumns: string[];
}
interface Run {
  id: string;
  mode: "dry_run" | "import";
  status: "running" | "done" | "failed";
  filename: string;
  options: { allowFormatExceptions: boolean; createSuppliers: boolean; agents: Record<string, string | null> };
  summary: Summary | null;
  lines?: Line[] | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}
interface User {
  id: string;
  name: string;
  email: string;
  active: boolean;
}

const failure = (e: unknown) => (e instanceof ApiError ? (e.issues.length ? e.issues : [e.message]) : ["Something went wrong. Try again."]);
const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/** A likely user for a sheet name: the one whose name is the sheet name or its first name ("Abdullah Liaqat" → "Abdullah"). */
function suggest(name: string, users: User[]): string | null {
  const n = name.trim().toLowerCase();
  const exact = users.filter((u) => u.name.trim().toLowerCase() === n);
  if (exact.length === 1) return exact[0].id;
  const first = users.filter((u) => u.name.trim().toLowerCase() === n.split(/\s+/)[0]);
  return first.length === 1 ? first[0].id : null;
}

/**
 * Administration → Import customers. Upload the master sheet, read the dry run's report, choose a
 * user for each sales agent the CRM doesn't know, then import. Runs happen on the server in the
 * background; this polls until each finishes.
 */
export function ImportCustomers() {
  const qc = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<File | null>(null);
  const [allowFormatExceptions, setAllowFormatExceptions] = useState(true);
  const [createSuppliers, setCreateSuppliers] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Record<string, string | null>>({});
  const [confirming, setConfirming] = useState(false);
  const [filter, setFilter] = useState<"all" | "skipped" | "warnings">("all");

  const users = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.get<User[]>("/admin/users") });
  const active = useMemo(() => (users.data ?? []).filter((u) => u.active), [users.data]);
  const history = useQuery({ queryKey: ["admin", "imports"], queryFn: () => api.get<Run[]>("/admin/imports") });
  const run = useQuery({
    queryKey: ["admin", "imports", runId],
    queryFn: () => api.get<Run>(`/admin/imports/${runId}`),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 2000 : false),
  });
  const r = run.data;

  useEffect(() => {
    if (r?.status !== "running") qc.invalidateQueries({ queryKey: ["admin", "imports"], exact: true });
  }, [r?.status, qc]);
  // Pre-fill each unknown agent with the likely user, once the dry run reports them.
  useEffect(() => {
    if (r?.mode !== "dry_run" || r.status !== "done" || !r.summary) return;
    setAgents((prev) => Object.fromEntries(r.summary!.unmatchedAgents.map((name) => [name, name in prev ? prev[name] : suggest(name, active)])));
  }, [r?.id, r?.status, r?.mode, r?.summary, active]);

  const dryRun = useMutation({
    meta: { silent: true },
    mutationFn: () => {
      const fd = new FormData();
      fd.append("file", chosen!);
      fd.append("allowFormatExceptions", String(allowFormatExceptions));
      fd.append("createSuppliers", String(createSuppliers));
      return api.postForm<Run>("/admin/imports", fd);
    },
    onSuccess: (x) => (setRunId(x.id), setAgents({})),
  });
  const commit = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post<Run>(`/admin/imports/${r!.id}/import`, { allowFormatExceptions: r!.options.allowFormatExceptions, createSuppliers: r!.options.createSuppliers, agents }),
    onSuccess: (x) => (setConfirming(false), setRunId(x.id)),
  });

  const lines = (r?.lines ?? []).filter((l) => (filter === "skipped" ? l.action === "skipped" : filter === "warnings" ? !!l.warnings : true));
  const download = () => {
    const rows = [["Tab", "Row", r!.mode === "import" ? "Result" : "Would be", "Business", "Customer", "Detail", "Warnings"], ...(r!.lines ?? []).map((l) => [l.tab, l.line, l.action, l.business, l.customer, l.detail, l.warnings])];
    const url = URL.createObjectURL(new Blob(["﻿" + rows.map((x) => x.map(csvCell).join(",")).join("\r\n")], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${r!.mode === "import" ? "import" : "dry-run"}-report.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Import customers"
          description="Bring in existing customers from the master sheet. Each row becomes a customer with a won deal and its contract. A dry run comes first and changes nothing; importing again never creates duplicates."
        />
        <div className="space-y-4 px-5 pb-5">
          <div className="flex flex-wrap items-center gap-3">
            <input ref={file} type="file" accept=".xlsx" className="sr-only" tabIndex={-1} aria-label="Master sheet" onChange={(e) => setChosen(e.target.files?.[0] ?? null)} />
            <Button variant="secondary" onClick={() => file.current?.click()}>
              <FileSpreadsheet /> {chosen ? "Change sheet" : "Choose sheet (.xlsx)"}
            </Button>
            {chosen && <span className="min-w-0 truncate text-sm">{chosen.name}</span>}
          </div>
          <div className="flex flex-col gap-1">
            <Checkbox label="Import non-standard MPRN/GPRNs (each gets a task to check it)" checked={allowFormatExceptions} onChange={(e) => setAllowFormatExceptions(e.target.checked)} />
            <Checkbox label="Add suppliers the CRM doesn't have yet" checked={createSuppliers} onChange={(e) => setCreateSuppliers(e.target.checked)} />
          </div>
          <Button disabled={!chosen} loading={dryRun.isPending} onClick={() => dryRun.mutate()}>
            <Upload /> Run dry run
          </Button>
          {dryRun.error && <IssueList issues={failure(dryRun.error)} title="The sheet couldn't be checked:" />}
        </div>
      </Card>

      {runId && (
        <Card>
          <CardHeader
            title={r ? `${r.mode === "import" ? "Import" : "Dry run"}: ${r.filename}` : "Loading…"}
            description={r?.status === "running" ? "Working through the sheet. This can take a few minutes for a large sheet; you can leave this page and come back." : r?.finishedAt ? `Finished ${dateTime(r.finishedAt)}.` : undefined}
            actions={r?.status === "done" && <Button size="sm" variant="ghost" onClick={download}><Download /> Download report</Button>}
          />
          <div className="space-y-4 px-5 pb-5 text-sm">
            {(!r || r.status === "running") && <Skeleton className="h-24" />}
            {r?.status === "failed" && <IssueList issues={[r.error ?? "The run failed."]} title="It stopped:" />}
            {r?.status === "done" && r.summary && (
              <>
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    [r.mode === "import" ? "Imported" : "Would import", r.summary.created],
                    ["Already imported", r.summary.exists],
                    ["Skipped", r.summary.skipped],
                    ["Meter numbers to fix", r.summary.meterChecks],
                  ].map(([k, v]) => (
                    <div key={k} className="rounded-[var(--md-sys-shape-corner-small)] bg-surface-2 p-3">
                      <dt className="text-xs text-muted">{k}</dt>
                      <dd className="tabular text-xl font-semibold">{v}</dd>
                    </div>
                  ))}
                </dl>
                <p className="text-muted">
                  Statuses in the sheet: {Object.entries(r.summary.statuses).map(([s, n]) => `${s} (${n})`).join(", ")}. Renewal reminders start for {r.summary.renewalsSoon} contract{r.summary.renewalsSoon === 1 ? "" : "s"} ending within 120 days.
                </p>
                {r.summary.suppliersToCreate.length > 0 && (
                  <IssueList
                    issues={[`Suppliers not in the CRM: ${r.summary.suppliersToCreate.join(", ")}. ${r.options.createSuppliers ? "They'll be added." : "Their rows are skipped: add them under Suppliers & pipeline, or tick \"Add suppliers\" and run again."}`]}
                    title="Suppliers:"
                  />
                )}

                {r.mode === "dry_run" && r.summary.unmatchedAgents.length > 0 && (
                  <div className="space-y-2">
                    <p className="font-medium">Salespeople the CRM doesn&apos;t know by these names</p>
                    <p className="text-muted">Choose who each sheet name is. Add missing people under Users &amp; roles first, then reload this page to see them here.</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {r.summary.unmatchedAgents.map((name) => (
                        <Select key={name} fieldLabel={name} value={agents[name] ?? ""} onChange={(e) => setAgents({ ...agents, [name]: e.target.value || null })}>
                          <option value="">Leave unassigned</option>
                          {active.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name} ({u.email})
                            </option>
                          ))}
                        </Select>
                      ))}
                    </div>
                  </div>
                )}

                {r.mode === "dry_run" && r.summary.created > 0 && (
                  <Button onClick={() => setConfirming(true)}>Import {r.summary.created} rows</Button>
                )}
                {r.mode === "import" && (
                  <p className="text-success">
                    Done. Imported customers are under Customers; meter numbers to fix are tasks for an administrator, who has been notified.
                  </p>
                )}

                <div className="flex flex-wrap gap-2" role="group" aria-label="Show rows">
                  {(["all", "skipped", "warnings"] as const).map((f) => (
                    <Button key={f} size="sm" variant={filter === f ? "secondary" : "ghost"} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                      {f === "all" ? "All rows" : f === "skipped" ? "Skipped" : "With warnings"}
                    </Button>
                  ))}
                </div>
                <div className="overflow-x-auto" tabIndex={0}>
                  <table className="w-full min-w-[900px] text-left">
                    <thead className="text-xs text-muted">
                      <tr>
                        {["Row", "Result", "Business", "Customer", "Detail", "Warnings"].map((h) => (
                          <th key={h} className="py-2 pr-3 font-medium">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {lines.slice(0, 300).map((l) => (
                        <tr key={`${l.tab}-${l.line}`} className="border-t border-border align-top">
                          <td className="tabular py-2 pr-3">{l.line}</td>
                          <td className="py-2 pr-3">
                            <Badge tone={l.action === "skipped" ? "warning" : l.action === "exists" ? "neutral" : "success"}>{l.action === "created" ? (r.mode === "import" ? "Imported" : "Import") : l.action === "exists" ? "Already in" : "Skip"}</Badge>
                          </td>
                          <td className="py-2 pr-3">{l.business}</td>
                          <td className="py-2 pr-3 text-muted">{l.customer}</td>
                          <td className="py-2 pr-3">{l.detail}</td>
                          <td className={cn("py-2 text-muted", l.warnings && "text-warning")}>{l.warnings}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {lines.length > 300 && <p className="text-xs text-muted">Showing 300 of {lines.length} rows. Download the report for all of them.</p>}
              </>
            )}
          </div>
        </Card>
      )}

      {!!history.data?.length && (
        <Card>
          <CardHeader title="Recent runs" />
          <ul className="divide-y divide-border text-sm">
            {history.data.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                <button type="button" className="min-h-6 text-left text-primary hover:underline" onClick={() => setRunId(h.id)}>
                  {h.mode === "import" ? "Import" : "Dry run"} · {h.filename}
                </button>
                <span className="text-xs text-muted">
                  {dateTime(h.createdAt)} · {h.status === "done" && h.summary ? `${h.summary.created} ${h.mode === "import" ? "imported" : "to import"}, ${h.summary.skipped} skipped` : h.status}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {confirming && r && (
        <Dialog
          open
          onOpenChange={(o) => !o && setConfirming(false)}
          title={`Import ${r.summary!.created} rows into the CRM?`}
          description="Each becomes a customer with a won deal and its contract. Deals can't be deleted afterwards, so make sure the database has a recent backup. Running the import again later skips rows already in."
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button loading={commit.isPending} onClick={() => commit.mutate()}>
                Import now
              </Button>
            </>
          }
        >
          <ul className="ml-5 list-disc space-y-1 text-sm">
            <li>{Object.values(agents).filter(Boolean).length} of {r.summary!.unmatchedAgents.length} unknown salespeople matched to a user; the rest are left unassigned.</li>
            <li>{r.summary!.meterChecks} meter numbers to fix become tasks for an administrator.</li>
            <li>Renewal reminders start for {r.summary!.renewalsSoon} contracts ending soon.</li>
          </ul>
          {commit.error && <IssueList issues={failure(commit.error)} title="The import didn't start:" />}
        </Dialog>
      )}
    </div>
  );
}
