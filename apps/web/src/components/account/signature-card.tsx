"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type CompanySignature, type EmailSignature, SIGNATURE_IMAGE_CHOICES, SIGNATURE_IMAGE_LABELS, type SignatureImageChoice, renderSignature } from "@uo/shared";
import { Button, Card, CardHeader, Checkbox, Field, Input, IssueList, Select, Skeleton, Textarea } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";

interface SignatureData {
  signature: EmailSignature;
  company: CompanySignature;
  logoUrl: string;
  ownImageUrl: string | null;
  preview: { html: string; text: string };
}

const issuesOf = (e: unknown) => ((e as ApiError).issues?.length ? (e as ApiError).issues : [(e as ApiError).message]);

/** Shows signature HTML built by the shared renderer, which escapes everything that was typed. */
export function SignaturePreview({ html }: { html: string }) {
  // The markup comes from renderSignature, which escapes every value.
  return <div className="overflow-x-auto rounded-lg border border-border bg-white p-4" tabIndex={0} aria-label="Signature preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Your email signature: starts from the company template, and you can change anything,
 * including using your own picture. It's added to email you send from the CRM.
 */
export function SignatureCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["account", "email-signature"], queryFn: () => api.get<SignatureData>("/account/email-signature") });
  const [sig, setSig] = useState<EmailSignature | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  useEffect(() => {
    if (q.data && !sig) setSig(q.data.signature);
  }, [q.data, sig]);

  const apply = (r: SignatureData) => (qc.setQueryData(["account", "email-signature"], r), setSig(r.signature), setIssues([]));
  const save = useMutation({ meta: { silent: true }, mutationFn: () => api.put<SignatureData>("/account/email-signature", sig), onSuccess: apply, onError: (e) => setIssues(issuesOf(e)) });
  const upload = useMutation({
    meta: { silent: true },
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.postForm<SignatureData>("/account/email-signature/image", fd);
    },
    onSuccess: (r) => apply({ ...r, signature: { ...(sig ?? r.signature), image: "own" } }),
    onError: (e) => setIssues(issuesOf(e)),
  });

  const preview = useMemo(() => (sig && q.data ? renderSignature(sig, q.data.company, { company: q.data.logoUrl, own: q.data.ownImageUrl }) : null), [sig, q.data]);
  if (!q.data || !sig) {
    return (
      <Card>
        <CardHeader title="Email signature" />
        <Skeleton className="m-5 h-32" />
      </Card>
    );
  }
  const set = <K extends keyof EmailSignature>(k: K, v: EmailSignature[K]) => setSig({ ...sig, [k]: v });
  const text = (k: "jobTitle" | "phone" | "mobile" | "email" | "extra") => sig[k] ?? "";

  return (
    <Card>
      <CardHeader title="Email signature" description="Added to email you send from the CRM. It starts from the company template; change anything you like." />
      <div className="space-y-4 p-5">
        <Checkbox label="Add my signature to email I send from the CRM" checked={sig.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required>
            {(p) => <Input {...p} value={sig.fullName} onChange={(e) => set("fullName", e.target.value)} />}
          </Field>
          <Field label="Job title">{(p) => <Input {...p} value={text("jobTitle")} onChange={(e) => set("jobTitle", e.target.value)} />}</Field>
          <Field label="Phone">{(p) => <Input {...p} type="tel" value={text("phone")} onChange={(e) => set("phone", e.target.value)} />}</Field>
          <Field label="Mobile">{(p) => <Input {...p} type="tel" value={text("mobile")} onChange={(e) => set("mobile", e.target.value)} />}</Field>
          <Field label="Email" className="sm:col-span-2">
            {(p) => <Input {...p} type="email" value={text("email")} onChange={(e) => set("email", e.target.value)} />}
          </Field>
          <Field label="Extra lines" hint="One per line, e.g. a qualification, opening hours or a short message." className="sm:col-span-2">
            {(p) => <Textarea {...p} rows={3} value={text("extra")} onChange={(e) => set("extra", e.target.value)} />}
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Picture">
            {(p) => (
              <Select {...p} value={sig.image} onChange={(e) => set("image", e.target.value as SignatureImageChoice)}>
                {SIGNATURE_IMAGE_CHOICES.filter((c) => c !== "own" || q.data.ownImageUrl).map((c) => (
                  <option key={c} value={c}>
                    {SIGNATURE_IMAGE_LABELS[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Upload my own picture" hint="A logo or photo, PNG or JPEG, up to 1 MB.">
            {(p) => (
              <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-sm">
                <ImageUp className="size-4" aria-hidden />
                <span>{upload.isPending ? "Uploading…" : q.data.ownImageUrl ? "Replace picture" : "Choose a picture"}</span>
                <input {...p} type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
              </label>
            )}
          </Field>
          {sig.image !== "none" && (
            <Field label={`Picture size (${sig.imageWidth} px wide)`}>
              {(p) => <input {...p} type="range" min={40} max={320} step={10} value={sig.imageWidth} onChange={(e) => set("imageWidth", Number(e.target.value))} className="h-6 w-full accent-[var(--primary)]" />}
            </Field>
          )}
          <Field label="Colour">
            {(p) => <input {...p} type="color" value={sig.accentColor} onChange={(e) => set("accentColor", e.target.value)} className="h-10 w-20 cursor-pointer rounded border border-border bg-transparent" />}
          </Field>
        </div>
        <Checkbox label={`Show the company details (${q.data.company.companyName}, address, phone)`} checked={sig.showCompany} onChange={(e) => set("showCompany", e.target.checked)} />

        <div className="space-y-2">
          <p className="text-sm font-medium">Preview</p>
          {preview && <SignaturePreview html={preview.html} />}
          {!sig.enabled && <p className="text-sm text-muted">Turned off: your email is sent without a signature.</p>}
        </div>
        <IssueList issues={issues} title="Please check:" />
        <div className="flex flex-wrap items-center gap-3">
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Save signature
          </Button>
          <Button variant="secondary" onClick={() => setSig(q.data.signature)}>
            Undo changes
          </Button>
          {save.isSuccess && <span className="text-sm text-success">Saved.</span>}
        </div>
      </div>
    </Card>
  );
}
