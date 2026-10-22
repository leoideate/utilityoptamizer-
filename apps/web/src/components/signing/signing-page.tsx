"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, FileX2, XCircle } from "lucide-react";
import { useRef, useState } from "react";
import { FORM_SIGNER_ROLE_LABELS, type FormSignerRole } from "@uo/shared";
import { Logo } from "@/components/brand";
import { PdfPage, toScreen, usePdf } from "@/components/forms/pdf-page";
import { Dialog } from "@/components/ui/overlays";
import { Button, Card, Checkbox, Field, Input, IssueList, Skeleton, Textarea } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { date } from "@/lib/format";
import { SignaturePad, type SignaturePadHandle } from "./signature-pad";

interface SigningView {
  formName: string;
  brokerName: string;
  signerName: string;
  role: FormSignerRole;
  expiresAt: string;
  boxes: { page: number; x: number; y: number; w: number; h: number }[];
  consentText: string;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6 sm:py-10">
      <Logo size={32} />
      {children}
    </main>
  );
}

/** The page a signer opens from their email: read the form, agree, draw a signature, sign. No CRM account needed. */
export function SigningPage({ token }: { token: string }) {
  const base = `/public/sign/${encodeURIComponent(token)}`;
  const view = useQuery({ queryKey: ["signing", token], queryFn: () => api.get<SigningView>(base), retry: false, staleTime: Infinity });
  const pdf = usePdf(view.data ? `${base}/document` : null);
  const pad = useRef<SignaturePadHandle>(null);
  const [typedName, setTypedName] = useState("");
  const [consent, setConsent] = useState(false);
  const [hasInk, setHasInk] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const decline = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post<{ declined: boolean }>(`${base}/decline`, { reason: reason.trim() || null }),
    onSettled: () => setDeclining(false),
    onError: (e) => {
      const err = e as ApiError;
      setIssues(err.status === 404 ? ["This signing link is no longer valid."] : err.issues?.length ? err.issues : [err.message]);
    },
  });
  const sign = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post<{ signed: boolean }>(base, { typedName, consent, signaturePng: pad.current?.toPng() }),
    onError: (e) => {
      const err = e as ApiError;
      setIssues(err.status === 404 ? ["This signing link is no longer valid. Ask the person who sent it for a new one."] : err.issues?.length ? err.issues : [err.message]);
    },
  });

  if (view.isLoading) {
    return (
      <Shell>
        <Skeleton className="h-40" />
      </Shell>
    );
  }
  if (view.isError || !view.data) {
    return (
      <Shell>
        <Card className="space-y-2 p-6">
          <FileX2 className="size-8 text-muted" aria-hidden />
          <h1 className="text-xl font-semibold">This signing link isn&apos;t valid</h1>
          <p className="text-muted">It may have expired, been replaced by a newer link, or already been used to sign. Ask the person who sent it to send you a new one.</p>
        </Card>
      </Shell>
    );
  }

  const v = view.data;
  if (sign.isSuccess) {
    return (
      <Shell>
        <Card className="space-y-2 p-6">
          <CheckCircle2 className="size-8 text-success" aria-hidden />
          <h1 className="text-xl font-semibold">Thank you, it&apos;s signed</h1>
          <p className="text-muted">
            Your signature for &ldquo;{v.formName}&rdquo; has been sent to {v.brokerName}. You can close this page.
          </p>
        </Card>
      </Shell>
    );
  }

  if (decline.isSuccess) {
    return (
      <Shell>
        <Card className="space-y-2 p-6">
          <XCircle className="size-8 text-muted" aria-hidden />
          <h1 className="text-xl font-semibold">You declined to sign</h1>
          <p className="text-muted">We&apos;ve let {v.brokerName} know. Nothing was signed, and this link no longer works. You can close this page.</p>
        </Card>
      </Shell>
    );
  }

  const pages = pdf.data?.numPages ?? 0;
  const ready = typedName.trim().length > 0 && consent && hasInk;
  return (
    <Shell>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Please sign: {v.formName}</h1>
        <p className="text-muted">
          {v.brokerName} has asked {v.signerName} to sign this form as the {FORM_SIGNER_ROLE_LABELS[v.role].toLowerCase()}. Read it below, then sign at the bottom of the page. This link expires on {date(v.expiresAt)}.
        </p>
      </div>

      <section aria-label="The form to sign" className="space-y-3">
        {!!v.boxes.length && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <span className="inline-block h-4 w-6 shrink-0 rounded border-2 border-primary bg-primary/15" aria-hidden /> Highlighted boxes show where your signature will be placed.
          </p>
        )}
        {pdf.isLoading && <Skeleton className="aspect-[1/1.41] w-full" />}
        {pdf.isError && <p className="text-danger">The form couldn&apos;t be shown. Reload the page to try again.</p>}
        {pdf.data &&
          Array.from({ length: pages }, (_, i) => (
            <PdfPage
              key={i}
              doc={pdf.data!}
              page={i}
              label={`Page ${i + 1} of ${pages}`}
              overlay={(vp) =>
                v.boxes
                  .filter((b) => b.page === i)
                  .map((b, n) => <div key={n} className="absolute rounded border-2 border-primary bg-primary/15" style={toScreen(vp, b)} aria-hidden />)
              }
            />
          ))}
      </section>

      <Card className="space-y-4 p-4 sm:p-6">
        <h2 className="text-lg font-semibold">Sign</h2>
        <IssueList issues={issues} title="Please check:" />
        <Field label="Your full name" required>
          {(p) => <Input {...p} autoComplete="name" value={typedName} onChange={(e) => setTypedName(e.target.value)} />}
        </Field>
        <div className="space-y-1">
          <p className="text-sm font-medium">Your signature</p>
          <SignaturePad ref={pad} label="Signature drawing area" onChange={setHasInk} />
        </div>
        <Checkbox label={v.consentText} checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button className="w-full sm:w-auto" disabled={!ready} loading={sign.isPending} onClick={() => (setIssues([]), sign.mutate())}>
            Sign the form
          </Button>
          <Button className="w-full sm:w-auto" variant="ghost" onClick={() => setDeclining(true)}>
            I don&apos;t want to sign
          </Button>
        </div>
        <Dialog
          open={declining}
          onOpenChange={setDeclining}
          title="Decline to sign?"
          description={`${v.brokerName} will be told you declined. The link stops working; they can send you a new one if something needs correcting.`}
          footer={
            <>
              <Button variant="secondary" onClick={() => setDeclining(false)}>
                Back
              </Button>
              <Button variant="danger" loading={decline.isPending} onClick={() => decline.mutate()}>
                Decline
              </Button>
            </>
          }
        >
          <Field label="Reason (optional)" hint="For example, a detail on the form is wrong.">
            {(p) => <Textarea {...p} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        </Dialog>
        <p className="text-xs text-muted">When you sign, we record your name, signature, the time, your IP address and browser, and a fingerprint of the exact form you saw, as evidence of the signature.</p>
      </Card>
    </Shell>
  );
}
