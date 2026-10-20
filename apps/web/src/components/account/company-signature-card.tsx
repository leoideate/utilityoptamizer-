"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageUp, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type CompanySignature, DEFAULT_SIGNATURE_STYLE, renderSignature } from "@uo/shared";
import { Button, Card, CardHeader, Field, Input, IssueList, Skeleton, Textarea } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/session";
import { SignaturePreview } from "./signature-card";

const issuesOf = (e: unknown) => ((e as ApiError).issues?.length ? (e as ApiError).issues : [(e as ApiError).message]);

/** The company part of everyone's email signature: logo, company details and an optional disclaimer. */
export function CompanySignatureCard() {
  const qc = useQueryClient();
  const me = useUser();
  const q = useQuery({ queryKey: ["admin", "email-signature"], queryFn: () => api.get<CompanySignature>("/admin/settings/email-signature") });
  // The current logo URL comes with the person's own signature data.
  const mine = useQuery({ queryKey: ["account", "email-signature"], queryFn: () => api.get<{ logoUrl: string }>("/account/email-signature") });
  const [co, setCo] = useState<CompanySignature | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  useEffect(() => {
    if (q.data && !co) setCo(q.data);
  }, [q.data, co]);

  const refresh = () => (qc.invalidateQueries({ queryKey: ["admin", "email-signature"] }), qc.invalidateQueries({ queryKey: ["account", "email-signature"] }));
  const save = useMutation({ meta: { silent: true }, mutationFn: () => api.put("/admin/settings/email-signature", co), onSuccess: () => (setIssues([]), refresh()), onError: (e) => setIssues(issuesOf(e)) });
  const logo = useMutation({
    meta: { silent: true },
    mutationFn: (file: File | null) => {
      if (!file) return api.del<{ logoUrl: string }>("/admin/settings/email-signature/logo");
      const fd = new FormData();
      fd.append("file", file);
      return api.postForm<{ logoUrl: string }>("/admin/settings/email-signature/logo", fd);
    },
    onSuccess: () => (setIssues([]), refresh()),
    onError: (e) => setIssues(issuesOf(e)),
  });

  const preview = useMemo(
    () => (co && mine.data ? renderSignature({ enabled: true, fullName: me.name, jobTitle: "Job title", phone: null, mobile: "087 000 0000", email: null, extra: null, ...DEFAULT_SIGNATURE_STYLE }, co, { company: mine.data.logoUrl, own: null }) : null),
    [co, mine.data, me.name],
  );
  if (!co) {
    return (
      <Card>
        <CardHeader title="Company email signature" />
        <Skeleton className="m-5 h-32" />
      </Card>
    );
  }
  const set = <K extends keyof CompanySignature>(k: K, v: CompanySignature[K]) => setCo({ ...co, [k]: v });
  return (
    <Card>
      <CardHeader title="Company email signature" description="Everyone's signature starts from this. People can still change their own, including using their own picture." />
      <div className="space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Company name" required>
            {(p) => <Input {...p} value={co.companyName} onChange={(e) => set("companyName", e.target.value)} />}
          </Field>
          <Field label="Phone">{(p) => <Input {...p} type="tel" value={co.phone ?? ""} onChange={(e) => set("phone", e.target.value)} />}</Field>
          <Field label="Address" hint="One line per row." className="sm:col-span-2">
            {(p) => <Textarea {...p} rows={2} value={co.address ?? ""} onChange={(e) => set("address", e.target.value)} />}
          </Field>
          <Field label="Website">{(p) => <Input {...p} value={co.website ?? ""} onChange={(e) => set("website", e.target.value)} />}</Field>
          <Field label="General email">{(p) => <Input {...p} type="email" value={co.email ?? ""} onChange={(e) => set("email", e.target.value)} />}</Field>
          <Field label="Small print" hint="Optional, e.g. registered office and company number." className="sm:col-span-2">
            {(p) => <Textarea {...p} rows={2} value={co.disclaimer ?? ""} onChange={(e) => set("disclaimer", e.target.value)} />}
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-sm">
            <ImageUp className="size-4" aria-hidden />
            <span>{logo.isPending ? "Uploading…" : "Upload a different logo"}</span>
            <input type="file" accept="image/png,image/jpeg" className="sr-only" aria-label="Company logo (PNG or JPEG, up to 1 MB)" onChange={(e) => e.target.files?.[0] && logo.mutate(e.target.files[0])} />
          </label>
          <Button size="sm" variant="ghost" onClick={() => logo.mutate(null)}>
            <RotateCcw /> Use the letterhead logo
          </Button>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Preview (with your name)</p>
          {preview && <SignaturePreview html={preview.html} />}
        </div>
        <IssueList issues={issues} title="Please check:" />
        <div className="flex flex-wrap items-center gap-3">
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
          {save.isSuccess && <span className="text-sm text-success">Saved.</span>}
        </div>
      </div>
    </Card>
  );
}
