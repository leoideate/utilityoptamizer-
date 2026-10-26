"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { CAPABILITIES, DEFAULT_WORKFLOW_REMINDERS, RENEWAL_ROUTES, RENEWAL_ROUTE_LABELS, ROLES, ROLE_LABELS, type RenewalRoute, type Role, type WorkflowReminders } from "@uo/shared";
import { AssistantFeedbackReview } from "@/components/assistant/feedback-review";
import { CompanySignatureCard } from "@/components/account/company-signature-card";
import { DeleteLeadsCard } from "@/components/delete-leads";
import type { Supplier } from "@/components/domain";
import { Dialog, TabPanel, Tabs } from "@/components/ui/overlays";
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, IssueList, PageHeader, Select, Skeleton } from "@/components/ui/primitives";
import { type ApiError, api, qs } from "@/lib/api";
import { dateTime, relative } from "@/lib/format";
import { useCan, useUser } from "@/lib/session";
import type { Page } from "@/lib/types";

export default function AdminPage() {
  const can = useCan();
  const assistantOn = useUser().features.assistant;
  const tabs = [
    can("admin.users") && { value: "users", label: "Users & roles" },
    can("admin.pipeline") && { value: "suppliers", label: "Suppliers & pipeline" },
    can("admin.integrations") && { value: "integrations", label: "Integrations" },
    can("admin.retention") && { value: "retention", label: "Data retention" },
    can("admin.audit") && { value: "audit", label: "Audit log" },
    assistantOn && can("assistant.review") && { value: "assistant", label: "Assistant feedback" },
    { value: "security", label: "Security matrix" },
  ].filter(Boolean) as { value: string; label: string }[];
  const [tab, setTab] = useState(tabs[0]?.value ?? "security");
  return (
    <>
      <PageHeader title="Administration" />
      <Tabs value={tab} onValueChange={setTab} tabs={tabs}>
        <TabPanel value="users">
          <UsersAdmin />
        </TabPanel>
        <TabPanel value="suppliers">
          <SuppliersAdmin />
        </TabPanel>
        <TabPanel value="integrations">
          <IntegrationsAdmin />
        </TabPanel>
        <TabPanel value="retention">
          <div className="space-y-6">
            <RetentionAdmin />
            {can("opportunity.purge") && <DeleteLeadsCard />}
          </div>
        </TabPanel>
        <TabPanel value="audit">
          <AuditAdmin />
        </TabPanel>
        <TabPanel value="assistant">
          <AssistantFeedbackReview />
        </TabPanel>
        <TabPanel value="security">
          <SecurityMatrix />
        </TabPanel>
      </Tabs>
    </>
  );
}

function useAction(after?: () => void) {
  const [issues, setIssues] = useState<string[]>([]);
  const m = useMutation({
    meta: { silent: true },
    mutationFn: (fn: () => Promise<unknown>) => (setIssues([]), fn()),
    onSuccess: () => after?.(),
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  return { run: m.mutate, running: m.isPending, issues };
}

interface AdminUser {
  id: string;
  name: string;
  email: string;
  active: boolean;
  mfaEnabled: boolean;
  passwordLoginEnabled: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  roles: { role: Role }[];
}

function UsersAdmin() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.get<AdminUser[]>("/admin/users") });
  const [editing, setEditing] = useState<AdminUser | "new" | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "users"] });
  return (
    <Card>
      <CardHeader
        title="Users"
        description="Deactivating a user keeps their opportunities and history. Changing roles signs them out."
        actions={
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus /> Add user
          </Button>
        }
      />
      <div className="overflow-x-auto" tabIndex={0}>
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-surface-2 text-left text-muted">
            <tr>
              <th className="px-5 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Roles</th>
              <th className="px-3 py-2 font-medium">2FA</th>
              <th className="px-3 py-2 font-medium">Last sign-in</th>
              <th className="px-5 py-2" />
            </tr>
          </thead>
          <tbody>
            {data?.map((u) => (
              <tr key={u.id} className="border-t border-border">
                <td className="px-5 py-2">
                  <span className={u.active ? "font-medium" : "text-muted line-through"}>{u.name}</span>
                  <span className="block text-xs text-muted">{u.email}</span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {u.roles.map((r) => (
                      <Badge key={r.role}>{ROLE_LABELS[r.role]}</Badge>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {u.mfaEnabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
                  {!u.passwordLoginEnabled && <Badge className="ml-2">SSO only</Badge>}
                </td>
                <td className="px-3 py-2">
                  {u.lastLoginAt ? relative(u.lastLoginAt) : "Never"}
                  {u.lockedUntil && new Date(u.lockedUntil) > new Date() && <Badge tone="danger" className="ml-2">Locked</Badge>}
                </td>
                <td className="px-5 py-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(u)}>
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <UserDialog user={editing === "new" ? undefined : editing} onClose={() => (setEditing(null), refresh())} />}
    </Card>
  );
}

function UserDialog({ user, onClose }: { user?: AdminUser; onClose: () => void }) {
  const [v, setV] = useState({
    name: user?.name ?? "",
    email: user?.email ?? "",
    password: "",
    roles: user?.roles.map((r) => r.role) ?? (["salesperson"] as Role[]),
    active: user?.active ?? true,
    passwordLogin: user?.passwordLoginEnabled ?? true,
  });
  const { run, running, issues } = useAction(onClose);
  const save = () =>
    run(async () => {
      if (!user) return api.post("/admin/users", { name: v.name, email: v.email, password: v.password, roles: v.roles });
      // Only send passwordLogin when it changes: turning it off signs the user out.
      const passwordLogin = v.passwordLogin !== user.passwordLoginEnabled ? { passwordLogin: v.passwordLogin } : {};
      await api.patch(`/admin/users/${user.id}`, { name: v.name, roles: v.roles, active: v.active, ...passwordLogin });
      if (v.password) await api.post(`/admin/users/${user.id}/password`, { password: v.password });
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={user ? `Edit ${user.name}` : "Add user"}
      footer={
        <>
          {user?.mfaEnabled && (
            <Button variant="secondary" onClick={() => run(() => api.post(`/admin/users/${user.id}/mfa/disable`))}>
              Reset 2FA
            </Button>
          )}
          <Button loading={running} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">{(p) => <Input {...p} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
        <Field label="Email">{(p) => <Input {...p} type="email" disabled={!!user} value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />}</Field>
        <Field label={user ? "New password (optional)" : "Temporary password"} hint="At least 12 characters. Ask them to change it after signing in.">
          {(p) => <Input {...p} type="password" autoComplete="new-password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} />}
        </Field>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Roles</legend>
          <div className="grid grid-cols-2 gap-2">
            {ROLES.map((r) => (
              <Checkbox key={r} label={ROLE_LABELS[r]} checked={v.roles.includes(r)} onChange={(e) => setV({ ...v, roles: e.target.checked ? [...v.roles, r] : v.roles.filter((x) => x !== r) })} />
            ))}
          </div>
        </fieldset>
        {user && <Checkbox label="Active (can sign in)" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} />}
        {user && (
          <div>
            <Checkbox label="Allow password sign-in" checked={v.passwordLogin} onChange={(e) => setV({ ...v, passwordLogin: e.target.checked })} />
            <p className="mt-1 text-xs text-muted">Turn off to make this user sign in with single sign-on only. They're signed out and must use Microsoft or Google next time.</p>
          </div>
        )}
        <IssueList issues={issues} title="Please check:" />
      </div>
    </Dialog>
  );
}

function SuppliersAdmin() {
  const qc = useQueryClient();
  const suppliers = useQuery({ queryKey: ["suppliers", "all"], queryFn: () => api.get<Supplier[]>("/suppliers") });
  const stages = useQuery({ queryKey: ["stages"], queryFn: () => api.get<{ id: string; key: string; name: string; sequence: number; probability: number }[]>("/stages") });
  const [editing, setEditing] = useState<Supplier | "new" | null>(null);
  const sync = useAction(() => qc.invalidateQueries({ queryKey: ["stages"] }));
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader
          title="Suppliers"
          actions={
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus /> Add supplier
            </Button>
          }
        />
        <ul className="divide-y divide-border">
          {suppliers.data?.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 px-5 py-2.5 text-sm">
              <span>
                <span className={s.active ? "" : "text-muted line-through"}>{s.name}</span> <Badge>{s.kind === "energy" ? "Energy" : "Merchant"}</Badge>
                <span className="block text-xs text-muted">
                  {s.submissionEmail ?? "No submission email"}
                  {s.kind === "energy" &&
                    ` · renewals: ${RENEWAL_ROUTE_LABELS[s.renewalRoute ?? "full_form"].toLowerCase()}${s.monoCopyRequired ? " · black and white copies" : ""}${s.outgoingConsentRequired ? " · outgoing holder's consent" : ""}`}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                Edit
              </Button>
            </li>
          ))}
        </ul>
        {editing && <SupplierDialog supplier={editing === "new" ? undefined : editing} onClose={() => (setEditing(null), qc.invalidateQueries({ queryKey: ["suppliers"] }))} />}
      </Card>
      <Card>
        <CardHeader
          title="Pipeline stages"
          description="Stage order and rules are fixed; names can be changed. Syncing is safe to repeat."
          actions={
            <Button size="sm" variant="secondary" loading={sync.running} onClick={() => sync.run(() => api.post("/admin/stages/sync"))}>
              <RefreshCw /> Check stages
            </Button>
          }
        />
        <ol className="divide-y divide-border">
          {stages.data?.map((s, i) => (
            <StageRow key={s.id} index={i + 1} stage={s} />
          ))}
        </ol>
      </Card>
      <WorkflowReminderSettings />
    </div>
  );
}

/** Reminder and escalation intervals for renewals, submissions and corrections. */
function WorkflowReminderSettings() {
  const qc = useQueryClient();
  const saved = useQuery({ queryKey: ["admin", "workflow"], queryFn: () => api.get<WorkflowReminders>("/admin/settings/workflow") });
  const [v, setV] = useState<{ followUp: string; renewal: string; escalate: string } | null>(null);
  useEffect(() => {
    const s = saved.data ?? (saved.isError ? DEFAULT_WORKFLOW_REMINDERS : null);
    if (s && !v) setV({ followUp: String(s.submissionFollowUpDays), renewal: s.renewalReminderDays.join(", "), escalate: String(s.escalateAfterDays) });
  }, [saved.data, saved.isError, v]);
  const save = useAction(() => qc.invalidateQueries({ queryKey: ["admin", "workflow"] }));
  if (!v) return <Skeleton className="h-40" />;
  const days = v.renewal
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);
  return (
    <Card>
      <CardHeader title="Workflow reminders" description="When renewals, unanswered submissions and overdue workflow tasks create tasks or go to a manager." />
      <div className="space-y-3 p-5">
        <Field label="Chase an unanswered submission after (days)">
          {(p) => <Input {...p} inputMode="numeric" value={v.followUp} onChange={(e) => setV({ ...v, followUp: e.target.value })} />}
        </Field>
        <Field label="Renewal deadline tasks (days before the contract ends)" hint="Comma-separated, e.g. 90, 60, 30, 14">
          {(p) => <Input {...p} value={v.renewal} onChange={(e) => setV({ ...v, renewal: e.target.value })} />}
        </Field>
        <Field label="Escalate overdue workflow tasks to a manager after (days)">
          {(p) => <Input {...p} inputMode="numeric" value={v.escalate} onChange={(e) => setV({ ...v, escalate: e.target.value })} />}
        </Field>
        <IssueList issues={save.issues} />
        <div className="flex justify-end">
          <Button
            loading={save.running}
            onClick={() => save.run(() => api.put("/admin/settings/workflow", { submissionFollowUpDays: Number(v.followUp), renewalReminderDays: days, escalateAfterDays: Number(v.escalate) }))}
          >
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}

function StageRow({ index, stage }: { index: number; stage: { id: string; name: string; probability: number } }) {
  const [name, setName] = useState(stage.name);
  const { run, running } = useAction();
  return (
    <li className="flex items-center gap-2 px-5 py-2 text-sm">
      <span className="tabular w-6 text-muted">{index}</span>
      <Input aria-label={`Stage ${index} name`} className="h-8" value={name} onChange={(e) => setName(e.target.value)} />
      <span className="tabular w-12 text-right text-xs text-muted">{stage.probability}%</span>
      {name !== stage.name && (
        <Button size="sm" loading={running} onClick={() => run(() => api.patch(`/admin/stages/${stage.id}`, { name }))}>
          Save
        </Button>
      )}
    </li>
  );
}

function SupplierDialog({ supplier, onClose }: { supplier?: Supplier; onClose: () => void }) {
  const [v, setV] = useState({
    name: supplier?.name ?? "",
    kind: supplier?.kind ?? "energy",
    submissionEmail: supplier?.submissionEmail ?? "",
    active: supplier?.active ?? true,
    renewalRoute: supplier?.renewalRoute ?? ("full_form" as RenewalRoute),
    monoCopyRequired: supplier?.monoCopyRequired ?? false,
    outgoingConsentRequired: supplier?.outgoingConsentRequired ?? false,
    agencyId: supplier?.agencyId ?? "",
  });
  const { run, running, issues } = useAction(onClose);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={supplier ? "Edit supplier" : "Add supplier"}
      footer={
        <Button loading={running} onClick={() => run(() => (supplier ? api.patch(`/admin/suppliers/${supplier.id}`, v) : api.post("/admin/suppliers", v)))}>
          Save
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Name">{(p) => <Input {...p} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
        <Field label="Type">
          {(p) => (
            <Select {...p} value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as "energy" })}>
              <option value="energy">Energy supplier</option>
              <option value="merchant">Merchant services</option>
            </Select>
          )}
        </Field>
        <Field label="Submissions email" hint="Where “Send submission pack” emails applications.">
          {(p) => <Input {...p} type="email" value={v.submissionEmail} onChange={(e) => setV({ ...v, submissionEmail: e.target.value })} />}
        </Field>
        <Field label="Our agency ID" hint="Printed in the agency boxes on this supplier's forms.">
          {(p) => <Input {...p} value={v.agencyId} onChange={(e) => setV({ ...v, agencyId: e.target.value })} />}
        </Field>
        {v.kind === "energy" && (
          <fieldset className="space-y-2 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-medium">Workflow rules</legend>
            <Field label="A renewal needs">
              {(p) => (
                <Select {...p} value={v.renewalRoute} onChange={(e) => setV({ ...v, renewalRoute: e.target.value as RenewalRoute })}>
                  {RENEWAL_ROUTES.map((r) => (
                    <option key={r} value={r}>
                      {RENEWAL_ROUTE_LABELS[r]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Checkbox label="Submissions need black and white copies of signed forms" checked={v.monoCopyRequired} onChange={(e) => setV({ ...v, monoCopyRequired: e.target.checked })} />
            <Checkbox label="A change of entity needs the outgoing account holder's consent" checked={v.outgoingConsentRequired} onChange={(e) => setV({ ...v, outgoingConsentRequired: e.target.checked })} />
          </fieldset>
        )}
        <Checkbox label="Active" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} />
        <IssueList issues={issues} />
      </div>
    </Dialog>
  );
}

interface Job {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
}

/** How the brokerage is named on supplier forms. */
function BrokerCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "broker"], queryFn: () => api.get<{ companyName: string }>("/admin/settings/broker") });
  const [companyName, setCompanyName] = useState("");
  useEffect(() => {
    if (q.data) setCompanyName(q.data.companyName);
  }, [q.data]);
  const save = useAction(() => qc.invalidateQueries({ queryKey: ["admin", "broker"] }));
  return (
    <Card>
      <CardHeader title="Supplier forms" description="Agency boxes on supplier forms. Each supplier's agency ID is set under Suppliers." />
      <div className="flex flex-wrap items-end gap-4 p-5">
        <Field label="Broker company name" className="min-w-72 flex-1">
          {(p) => <Input {...p} value={companyName} onChange={(e) => setCompanyName(e.target.value)} />}
        </Field>
        <Button loading={save.running} onClick={() => save.run(() => api.put("/admin/settings/broker", { companyName }))}>
          Save
        </Button>
        <IssueList issues={save.issues} />
      </div>
    </Card>
  );
}

function IntegrationsAdmin() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["integrations", "status"], queryFn: () => api.get<Record<string, string | boolean>>("/integrations/status") });
  const [filter, setFilter] = useState("dead");
  const jobs = useQuery({ queryKey: ["admin", "jobs", filter], queryFn: () => api.get<Job[]>(`/admin/integration-jobs${filter ? `?status=${filter}` : ""}`) });
  const wp = useQuery({ queryKey: ["admin", "worldpay"], queryFn: () => api.get<{ submissionEmail: string | null; autoAssignLeads: boolean }>("/admin/settings/worldpay") });
  const [settings, setSettings] = useState({ submissionEmail: "", autoAssignLeads: true });
  useEffect(() => {
    if (wp.data) setSettings({ submissionEmail: wp.data.submissionEmail ?? "", autoAssignLeads: wp.data.autoAssignLeads });
  }, [wp.data]);
  const save = useAction(() => qc.invalidateQueries({ queryKey: ["admin", "worldpay"] }));
  const retry = useAction(() => qc.invalidateQueries({ queryKey: ["admin", "jobs"] }));
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Connections" description="Configured through environment variables on the server. Secrets are never shown here." />
        <dl className="grid gap-x-6 gap-y-2 p-5 text-sm sm:grid-cols-3">
          {Object.entries(status.data ?? {}).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2">
              <dt className="capitalize text-muted">{k.replace(/([A-Z])/g, " $1")}</dt>
              <dd>{typeof v === "boolean" ? <Badge tone={v ? "success" : "neutral"}>{v ? "Configured" : "Off"}</Badge> : <Badge>{v}</Badge>}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card>
        <CardHeader title="Settings" />
        <div className="flex flex-wrap items-end gap-4 p-5">
          <Field label="Worldpay submissions email" className="min-w-72 flex-1">
            {(p) => <Input {...p} type="email" value={settings.submissionEmail} onChange={(e) => setSettings({ ...settings, submissionEmail: e.target.value })} />}
          </Field>
          <Checkbox label="Automatically assign new unassigned leads" checked={settings.autoAssignLeads} onChange={(e) => setSettings({ ...settings, autoAssignLeads: e.target.checked })} />
          <Button loading={save.running} onClick={() => save.run(() => api.put("/admin/settings/worldpay", { submissionEmail: settings.submissionEmail || null, autoAssignLeads: settings.autoAssignLeads }))}>
            Save
          </Button>
          <IssueList issues={save.issues} />
        </div>
      </Card>
      <BrokerCard />
      <CompanySignatureCard />
      <Card>
        <CardHeader
          title="Outbound jobs"
          description="Emails, WhatsApp messages and submissions. Failed jobs retry automatically; dead jobs need attention."
          actions={
            <Select className="w-auto" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Status">
              <option value="dead">Dead (gave up)</option>
              <option value="failed">Retrying</option>
              <option value="pending">Pending</option>
              <option value="succeeded">Succeeded</option>
              <option value="">All</option>
            </Select>
          }
        />
        <ul className="divide-y divide-border">
          {jobs.data?.map((j) => (
            <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
              <span>
                <span className="font-medium">{j.kind}</span> <Badge tone={j.status === "dead" ? "danger" : j.status === "succeeded" ? "success" : "warning"}>{j.status}</Badge>
                <span className="block text-xs text-muted">
                  {j.attempts} attempt(s) · {dateTime(j.updatedAt)} {j.lastError && `· ${j.lastError}`}
                </span>
              </span>
              {(j.status === "dead" || j.status === "failed") && (
                <Button size="sm" variant="secondary" loading={retry.running} onClick={() => retry.run(() => api.post(`/admin/integration-jobs/${j.id}/retry`))}>
                  Retry
                </Button>
              )}
            </li>
          ))}
          {jobs.data && !jobs.data.length && <li className="px-5 py-6 text-center text-sm text-muted">Nothing here.</li>}
        </ul>
      </Card>
    </div>
  );
}

function RetentionAdmin() {
  const { data } = useQuery({ queryKey: ["admin", "retention"], queryFn: () => api.get<Record<string, number>>("/admin/retention") });
  const [v, setV] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    if (data) setV(data);
  }, [data]);
  const save = useAction();
  const run = useAction();
  const labels: Record<string, string> = {
    lostSensitiveDataMonths: "Erase sensitive documents & principal data this many months after a deal is lost",
    endedSensitiveDataMonths: "…and this many months after a live contract ends (with no renewal)",
    auditLogYears: "Keep audit-log entries for (years)",
    ocrScanDays: "Delete unconfirmed business-card scans after (days)",
    recordingMonths: "Delete call recordings after (months)",
  };
  if (!v) return <Skeleton className="h-48" />;
  return (
    <Card>
      <CardHeader title="Retention policy" description="Applied weekly. The policy never deletes opportunities, customers or timelines." />
      <div className="space-y-4 p-5">
        {Object.keys(labels).map((k) => (
          <Field key={k} label={labels[k]}>
            {(p) => <Input {...p} className="max-w-32" type="number" min={1} value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} />}
          </Field>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button loading={save.running} onClick={() => save.run(() => api.put("/admin/retention", v))}>
            Save policy
          </Button>
          <Button variant="secondary" loading={run.running} onClick={() => run.run(() => api.post("/admin/retention/run"))}>
            Apply now
          </Button>
        </div>
        <IssueList issues={[...save.issues, ...run.issues]} />
      </div>
    </Card>
  );
}

interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  actorName: string;
  ip: string | null;
  createdAt: string;
}

function AuditAdmin() {
  const [action, setAction] = useState("");
  const [page, setPage] = useState(1);
  const query = qs({ action, page, pageSize: 50 });
  const { data } = useQuery({ queryKey: ["admin", "audit", query], queryFn: () => api.get<Page<AuditRow>>(`/admin/audit-log${query}`) });
  return (
    <Card>
      <CardHeader
        title="Audit log"
        description="Append-only: entries can't be edited or deleted."
        actions={
          <Select className="w-auto" value={action} onChange={(e) => (setAction(e.target.value), setPage(1))} aria-label="Filter">
            <option value="">All actions</option>
            <option value="auth">Sign-ins</option>
            <option value="sensitive">Restricted data viewed</option>
            <option value="opportunity">Opportunities</option>
            <option value="customer">Customers</option>
            <option value="document">Documents</option>
            <option value="user">Users</option>
          </Select>
        }
      />
      <div className="overflow-x-auto" tabIndex={0}>
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-surface-2 text-left text-muted">
            <tr>
              <th className="px-5 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Who</th>
              <th className="px-3 py-2 font-medium">What</th>
              <th className="px-5 py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="whitespace-nowrap px-5 py-2">{dateTime(r.createdAt)}</td>
                <td className="px-3 py-2">
                  {r.actorName}
                  {r.ip && <span className="block text-xs text-muted">{r.ip}</span>}
                </td>
                <td className="px-3 py-2">{r.summary}</td>
                <td className="px-5 py-2 font-mono text-xs text-muted">{r.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > 50 && (
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <Button size="sm" variant="secondary" disabled={page * 50 >= data.total} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      )}
    </Card>
  );
}

function SecurityMatrix() {
  return (
    <Card>
      <CardHeader title="Who can do what" description="Enforced by the server on every request." />
      <div className="overflow-x-auto" tabIndex={0}>
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-surface-2 text-left text-muted">
            <tr>
              <th className="px-5 py-2 font-medium">Permission</th>
              {ROLES.map((r) => (
                <th key={r} className="px-2 py-2 text-center font-medium">
                  {ROLE_LABELS[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(CAPABILITIES).map(([cap, roles]) => (
              <tr key={cap} className="border-t border-border">
                <td className="px-5 py-1.5 font-mono text-xs">{cap}</td>
                {ROLES.map((r) => (
                  <td key={r} className="px-2 py-1.5 text-center">
                    {(roles as readonly string[]).includes(r) ? <span aria-label="yes">✓</span> : <span className="text-muted" aria-label="no">·</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
