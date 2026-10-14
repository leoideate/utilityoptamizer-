"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card, CardHeader, Field, Input, IssueList, PageHeader } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/session";

export default function AccountPage() {
  const me = useUser();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [done, setDone] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
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
    mutationFn: () => api.post(`/admin/users/${me.id}/password`, { password }),
    onSuccess: () => (setPwDone(true), setPassword("")),
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title="Security" description={me.name} />
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
        <CardHeader title="Change password" description="At least 12 characters. You'll be signed out everywhere." />
        <div className="flex flex-wrap items-end gap-3 p-5">
          <Field label="New password" className="min-w-64 flex-1">
            {(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Button onClick={() => (setIssues([]), changePw.mutate())} loading={changePw.isPending} disabled={password.length < 12}>
            Change password
          </Button>
          {pwDone && <p className="w-full text-sm text-success">Password changed. Sign in again on your other devices.</p>}
        </div>
      </Card>
      <IssueList issues={issues} title="Please check:" />
    </div>
  );
}
