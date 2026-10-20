"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { SignatureCard } from "@/components/account/signature-card";
import { Badge, Button, Card, CardHeader, Field, Input, IssueList, PageHeader } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { PROVIDER_LABELS, useMailboxes } from "@/lib/email";
import { relative } from "@/lib/format";
import { useUser } from "@/lib/session";

export default function AccountPage() {
  const me = useUser();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [done, setDone] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [pwDone, setPwDone] = useState(false);
  const start = useMutation({ mutationFn: () => api.post<{ secret: string; otpauthUrl: string }>("/auth/mfa/setup"), onSuccess: setSetup });
  const confirm = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post("/auth/mfa/confirm", { code }),
    onSuccess: () => (setDone(true), setSetup(null)),
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  const changePw = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post("/auth/password", { currentPassword: current, newPassword: password }),
    onSuccess: () => (setPwDone(true), setCurrent(""), setPassword("")),
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title="My account" description={me.name} />
      <Suspense>
        <MailboxCard />
      </Suspense>
      <PhoneCard />
      <SignatureCard />
      <Card>
        <CardHeader title="Two-factor authentication" description="Adds a 6-digit code from an authenticator app (Microsoft Authenticator, Google Authenticator…) when you sign in." />
        <div className="space-y-4 p-5 text-sm">
          {done ? (
            <p className="text-success">Two-factor authentication is on.</p>
          ) : !setup ? (
            <Button onClick={() => start.mutate()} loading={start.isPending}>
              Set up two-factor authentication
            </Button>
          ) : (
            <>
              <p>In your authenticator app, add an account using this key (or open the link on your phone):</p>
              <p className="rounded-lg bg-surface-2 p-3 font-mono text-base tracking-wider">{setup.secret.match(/.{1,4}/g)?.join(" ")}</p>
              <a className="text-primary underline" href={setup.otpauthUrl}>
                Open in authenticator app
              </a>
              <Field label="Enter the 6-digit code it shows">{(p) => <Input {...p} inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
              <Button onClick={() => (setIssues([]), confirm.mutate())} loading={confirm.isPending}>
                Turn on
              </Button>
            </>
          )}
        </div>
      </Card>
      <Card>
        <CardHeader title="Change password" description="At least 12 characters. Your other devices will be signed out." />
        <div className="flex flex-wrap items-end gap-3 p-5">
          <Field label="Current password" className="min-w-64 flex-1">
            {(p) => <Input {...p} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
          </Field>
          <Field label="New password" className="min-w-64 flex-1">
            {(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Button onClick={() => (setIssues([]), changePw.mutate())} loading={changePw.isPending} disabled={!current || password.length < 12}>
            Change password
          </Button>
          {pwDone && <p className="w-full text-sm text-success">Password changed. Sign in again on your other devices.</p>}
        </div>
      </Card>
      <IssueList issues={issues} title="Please check:" />
    </div>
  );
}

/** The user's own phone: click-to-call rings it first, then connects the customer. */
function PhoneCard() {
  const tel = useQuery({ queryKey: ["telephony"], queryFn: () => api.get<{ provider: string; bridged: boolean; myPhone: string | null }>("/telephony") });
  const [phone, setPhone] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => api.put<{ phone: string | null }>("/telephony/my-phone", { phone: phone?.trim() || null }),
    onSuccess: (r) => (setIssues([]), setPhone(r.phone ?? ""), tel.refetch()),
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  const value = phone ?? tel.data?.myPhone ?? "";
  return (
    <Card>
      <CardHeader
        title="My phone for calls"
        description={tel.data?.bridged ? "When you press Call, RingCentral rings this phone first, then connects you to the customer. Use your RingCentral desk phone, app or mobile number." : "Used when the phone system is connected. Until then, Call opens your device's dialler."}
      />
      <div className="flex flex-wrap items-end gap-3 p-5">
        <Field label="Phone number" className="min-w-64 flex-1" hint="e.g. 01 555 1234 or +353 87 123 4567">
          {(p) => <Input {...p} type="tel" autoComplete="tel" value={value} onChange={(e) => setPhone(e.target.value)} />}
        </Field>
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Save
        </Button>
        {save.isSuccess && <p className="w-full text-sm text-success">Saved.</p>}
        <div className="w-full">
          <IssueList issues={issues} title="Please check:" />
        </div>
      </div>
    </Card>
  );
}

const CONNECT_RESULTS: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Mailbox connected. Your email will appear under Email within a couple of minutes." },
  mailbox_wrong_address: { ok: false, text: "That mailbox isn't your CRM email address. Sign in to your own work mailbox and try again." },
  mailbox_cancelled: { ok: false, text: "Connecting was cancelled." },
  mailbox_expired: { ok: false, text: "That took too long, or was started in another browser. Try again." },
  mailbox_unavailable: { ok: false, text: "That kind of mailbox isn't set up for the CRM yet. Ask an administrator." },
  mailbox_failed: { ok: false, text: "The mailbox couldn't be connected. Try again, or ask an administrator if it keeps happening." },
};

/** Connect your own Outlook or Gmail: the CRM syncs your inbox and sent mail, and sends as you. */
function MailboxCard() {
  const qc = useQueryClient();
  const params = useSearchParams();
  const { data } = useMailboxes();
  const result = CONNECT_RESULTS[params.get("mailbox") ?? ""];
  const disconnect = useMutation({ mutationFn: (id: string) => api.del(`/mailboxes/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["mailboxes"] }) });
  const providers = (["microsoft", "google"] as const).filter((p) => data?.available[p] || data?.mailboxes.some((m) => m.provider === p));

  return (
    <Card id="mailbox">
      <CardHeader
        title="My mailbox"
        description="Connect your work email to see your inbox and sent mail in the CRM, send from your own address, and have emails with customers added to their deals."
      />
      <div className="space-y-4 p-5 text-sm">
        {result && <p className={result.ok ? "text-success" : "text-danger"} role="status">{result.text}</p>}
        {data && !providers.length && <p className="text-muted">Email isn't set up for the CRM yet. An administrator needs to connect Microsoft 365 or Google Workspace first.</p>}
        {providers.map((p) => {
          const box = data?.mailboxes.find((m) => m.provider === p);
          return (
            <div key={p} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{PROVIDER_LABELS[p]}</p>
                {box ? (
                  <p className="text-xs text-muted">
                    {box.address} · {box.lastSyncedAt ? `last checked ${relative(box.lastSyncedAt)}` : "first sync in progress"}
                  </p>
                ) : (
                  <p className="text-xs text-muted">Not connected</p>
                )}
              </div>
              {box?.status === "active" && <Badge tone="success">Connected</Badge>}
              {box?.status === "reauth_required" && <Badge tone="warning">Needs reconnecting</Badge>}
              {(!box || box.status === "reauth_required") && data?.available[p] && (
                <Button asChild size="sm">
                  {/* A full page navigation: the provider's sign-in page comes next. */}
                  <a href={`/api/mailboxes/${p}/connect`}>{box ? "Reconnect" : "Connect"}</a>
                </Button>
              )}
              {box && (
                <Button size="sm" variant="ghost" loading={disconnect.isPending} onClick={() => confirm(`Disconnect ${box.address}? Email already in the CRM stays on its deals.`) && disconnect.mutate(box.id)}>
                  Disconnect
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
